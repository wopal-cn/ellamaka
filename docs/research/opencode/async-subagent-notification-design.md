# OpenCode 异步子 Agent 通知机制研究

> **状态**：草稿 | **日期**：2026-03-27
> **关联**：`docs/research/opencode/opencode-session-agent-messaging.md`

---

## 问题陈述

### 现状：阻塞等待模型

OpenCode 当前的 Task Tool 采用**同步阻塞**模式：

```
主 Agent loop → task(prompt, agent) → 写入 SubtaskPart
    → loop 检测到 pending SubtaskPart
    → 创建子 Session（parentID）
    → 等待子 Session 执行完成
    → 聚合结果回父 loop
    → 继续
```

**问题**：
- 主 Agent 在子任务执行期间**完全阻塞**，无法并行处理其他事务
- 子 Agent 无法在执行中途汇报进度
- 多个子任务只能串行或全部阻塞等待
- 主 Agent 无法在等待期间响应用户新消息

### 目标：异步通知模型

```
主 Agent loop → spawn(prompt, agent) → 立即返回 "任务已启动"
    → 继续处理其他事务（不阻塞）
                            ↓
                    子 Agent 独立执行
                            ↓ 完成
                    事件总线发布通知
                            ↓
                    主 Agent 收到通知（等同 user message 触发）
                            ↓
                    主 Agent 新一轮 loop 处理结果
```

---

## 业界方案调研

### Nanobot：MessageBus 注入模式

**实现位置**：`nanobot/agent/subagent.py`

**核心机制**：

```python
# spawn 时立即返回，不阻塞
async def spawn(self, task, label, ...):
    bg_task = asyncio.create_task(self._run_subagent(...))
    return f"Subagent [{label}] started (id: {task_id})."

# 子任务完成后，通过 MessageBus 注入 system message
async def _announce_result(self, task_id, label, task, result, origin, status):
    announce_content = f"""[Subagent '{label}' {status_text}]
Task: {task}
Result: {result}
Summarize this naturally for the user."""
    msg = InboundMessage(
        channel="system",
        sender_id="subagent",
        chat_id=f"{origin['channel']}:{origin['chat_id']}",
        content=announce_content,
    )
    await self.bus.publish_inbound(msg)
```

**主 Agent 侧**：`AgentLoop.run()` 长驻轮询 `MessageBus`（asyncio.Queue，1s 超时），自然拾取子 Agent 注入的消息。

**优点**：
- 实现极简，改动最小
- 天然支持多子任务并行
- 子结果像新消息一样触发主 Agent 思考

**缺点**：
- 主 Agent 无法区分"用户消息"和"子 Agent 通知"
- 无结构化结果传递（纯文本拼接）
- 子 Agent 间无法互相通信

### OpenCode 当前：SubtaskPart 阻塞模式

**实现位置**：`packages/opencode/src/tool/task.ts` + `packages/opencode/src/session/prompt.ts`

**核心机制**：

```
TaskTool.execute() → 写入 SubtaskPart（不执行）
    → loop 检测 pending SubtaskPart[]
    → 为每个 SubtaskPart 创建子 Session
    → await 子 Session 执行
    → 收集结果
    → 继续 loop
```

**优点**：
- Session 层级结构清晰（parentID 树）
- 子 Session 有独立权限、独立 compaction
- 结果结构化聚合

**缺点**：
- 完全阻塞主 loop
- 子任务无法在执行中途通知
- 并行子任务也需全部完成后才能继续

### 其他参考

| 项目 | 模式 | 特点 |
|------|------|------|
| Claude Code (task tool) | 同步阻塞 | 子任务完成后结果回填 |
| CrewAI | 异步 + Agent 间消息 | 支持 Agent 间直接通信 |
| AutoGen | 异步 + 消息队列 | 多 Agent 对话，支持广播 |
| LangGraph | 图编排 + 通道 | 子图完成后通过 Channel 传递状态 |

---

## 设计方案

### 方案 A：事件注入 + Session.prompt()（推荐）

**核心思路**：子 Agent 完成后通过事件总线通知，监听器调用 `SessionPrompt.prompt()` 将结果作为新消息注入父 Session。

**架构**：

```
┌─────────────────────────────────────────────┐
│                Event Bus                     │
│                                             │
│  subtask.completed ──────────────────────┐   │
│                                         │   │
└─────────────────────────────────────────│───┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────┐
│  SubtaskNotifier (新模块)                         │
│                                                  │
│  Bus.subscribe("subtask.completed", handler)     │
│                                                  │
│  handler(event):                                 │
│    SessionPrompt.prompt(parentSessionID, {       │
│      parts: [announceMessage]                    │
│    })                                            │
└─────────────────────────────────────────────────┘
```

**实现要点**：

1. **新增事件类型** `subtask.completed`：
   ```typescript
   BusEvent.define("subtask.completed", {
     parentSessionID: SessionID,
     taskID: string,
     agent: string,
     prompt: string,
     result: string,
     status: "ok" | "error",
     duration: number,
   });
   ```

2. **修改 TaskTool.execute()**：
   ```typescript
   // 不写 SubtaskPart，直接发起异步子 Session
   async execute(input, ctx) {
     const taskID = generateID();
     const childSession = await Session.create({
       parentID: ctx.sessionID,
       title: `Subtask: ${input.prompt.slice(0, 50)}`,
     });

     // 后台执行，不 await
     runChildSession(childSession.id, input).then((result) => {
       Bus.publish("subtask.completed", {
         parentSessionID: ctx.sessionID,
         taskID,
         agent: input.agent || "build",
         prompt: input.prompt,
         result: result.finalContent,
         status: result.stopReason === "error" ? "error" : "ok",
         duration: Date.now() - startTime,
       });
     });

     return `Subtask started (id: ${taskID}). You'll be notified when it completes.`;
   }
   ```

3. **新增 SubtaskNotifier**（监听 + 注入）：
   ```typescript
   class SubtaskNotifier {
     init() {
       Bus.subscribe("subtask.completed", (event) => {
         const announceContent = [
           `[Subtask '${event.agent}' ${event.status === "ok" ? "completed" : "failed"}]`,
           `\nTask: ${event.prompt}`,
           `\nResult:\n${event.result}`,
           `\nSummarize this for the user. Keep it brief.`,
         ].join("\n");

         SessionPrompt.prompt(event.parentSessionID, {
           parts: [{ type: "text", text: announceContent }],
         });
       });
     }
   }
   ```

**改动量评估**：

| 文件 | 改动 |
|------|------|
| `tool/task.ts` | 改 execute() 为异步发起 |
| `session/prompt.ts` | loop 不再处理 SubtaskPart（或兼容两种模式） |
| 新增 `subtask/notify.ts` | 事件监听 + 消息注入 |

### 方案 B：SubtaskPart async 标志

**核心思路**：保持现有 SubtaskPart 机制，增加 `async` 字段区分阻塞/非阻塞。

```typescript
// SubtaskPart 扩展
interface SubtaskPart {
  prompt: string;
  agent: string;
  async?: boolean;  // 新增：true = 不等待完成
  taskID?: string;  // 新增：用于关联完成事件
}

// loop 中的处理
if (subtask.async) {
  spawnAsync(subtask);  // 发起但不等待
  continue;              // 立即继续 loop
}
// sync subtask 保持原有阻塞行为
```

**优点**：向后兼容，sync/async 共存。
**缺点**：loop 逻辑复杂度增加；结果回传仍需方案 A 的事件机制。

### 方案 C：共享 Channel 模式（远期）

**核心思路**：引入命名 Channel，Agent 可以 publish/subscribe：

```typescript
// 子 Agent 完成后
Channel.publish("task-results", { taskID, result });

// 主 Agent 提前订阅
Channel.subscribe("task-results", (msg) => { ... });
```

**优点**：最灵活，支持多 Agent 间任意通信。
**缺点**：改动量大，偏离 OpenCode 现有架构。

---

## 方案 A 详细设计

### 通知消息格式

子 Agent 完成后注入父 Session 的消息需要精心设计，确保主 Agent 能正确理解和处理：

```markdown
[Subtask 'build' completed successfully]

Task: Implement user authentication module
Duration: 45s

Result:
Created `src/auth/auth.py` with login/logout endpoints
Added tests in `tests/test_auth.py` (12 tests passing)
Updated `requirements.txt` with new dependencies

Summarize this naturally for the user. Keep it brief (1-2 sentences).
Do not mention technical details like "subagent" or task IDs.
```

**设计原则**：
- 结构化头部（便于解析和日志）
- 包含原始任务描述（上下文恢复）
- 包含执行结果（主 Agent 据此汇报）
- 包含尾部指令（引导主 Agent 的行为）
- 不暴露实现细节（用户感知层面）

### 并发控制

| 场景 | 行为 |
|------|------|
| 多个子任务同时运行 | 各自独立完成后分别通知 |
| 父 Session 空闲时收到通知 | 触发新一轮 loop |
| 父 Session 正在执行时收到通知 | 排队等待当前 loop 结束 |
| 子任务执行出错 | 通知 status="error"，主 Agent 决定是否重试 |
| 父 Session 已关闭 | 通知被丢弃或持久化待恢复 |

### 兼容性考虑

**与现有 sync 模式共存**：

```typescript
// TaskTool 支持两种模式
async execute(input, ctx) {
  if (input.async) {
    // 异步模式：发起后立即返回
    return this.spawnAsync(input, ctx);
  } else {
    // 同步模式：写入 SubtaskPart（现有行为）
    return this.spawnSync(input, ctx);
  }
}
```

**与 Plugin Hook 兼容**：

```typescript
// 子任务完成时仍然触发 hook
Bus.publish("subtask.completed", event);
// SubtaskNotifier 处理注入前，先走 hook
Plugin.trigger("subtask.completed", { event }, { action: "allow" });
```

**与权限系统兼容**：

子 Session 创建时继承父 Session 的权限规则（现有行为不变）。

### 主 Agent 系统提示词补充

异步模式下，主 Agent 的系统提示词需要增加对子任务通知的理解：

```markdown
## Subtask Notifications
You may receive messages from completed subtasks. These appear as:
[Subtask 'agent-name' completed/failed]
Summarize the result for the user. If the task failed, suggest next steps.
You can have multiple subtasks running concurrently.
```

---

## 对 WopalSpace 的启示

### 当前 WopalSpace 架构适配

WopalSpace 基于 OpenCode 内核，Fae 作为子 Agent 通过 `wopal_task` 委派。当前模式：

```
Wopal → wopal_task(fae, prompt) → 同步等待 → 返回结果
```

已有问题（记录在 MEMORY.md）：
- `wopal_task` 方式委派 fae 经常超时、结果不可控
- SSE 超时风险
- 长任务无法中途汇报

### 异步通知模式的应用

```
Wopal → spawn(fae, prompt) → 立即返回 "任务已启动"
                              ↓
                        Fae 独立执行
                              ↓ 完成
                        事件通知 Wopal
                              ↓
                        Wopal 新一轮 loop 处理
```

**与现有 wopal_task 的关系**：
- `wopal_task` 可保留用于短任务（< 2min）
- 新增 `spawn` 用于长任务（研究、实现、重构）
- 两套机制共存，按任务类型选择

### 进阶能力

异步通知模式解锁的进阶场景：

| 场景 | 描述 |
|------|------|
| **并行研究** | 同时 spawn 多个 fae 研究不同方向，结果逐个回报 |
| **执行 + 监控** | 主 Agent 继续与用户对话，同时子任务在后台执行 |
| **任务链** | 子 Agent A 完成后通知触发子 Agent B |
| **进度汇报** | 子 Agent 在关键节点发布 progress 事件 |

---

## 风险与待研究

| 风险 | 说明 | 缓解措施 |
|------|------|----------|
| 上下文污染 | 子任务结果作为新消息注入，增加主 Agent 上下文 | 控制通知消息长度；主 Agent 只输出摘要 |
| 消息风暴 | 大量子任务同时完成导致通知堆积 | 排队机制 + 合并通知 |
| 状态不一致 | 主 Agent 在处理通知时又有新用户消息 | 优先级队列（用户消息 > 子任务通知） |
| 子任务失控 | 异步子任务无超时控制 | 子 Session 复用现有 compaction + max iterations |
| 向后兼容 | 现有 sync subtask 用户依赖阻塞行为 | 默认 sync，显式 opt-in async |

---

## 结论

**方案 A（事件注入 + Session.prompt()）是最优选择**：
- 改动最小，与 OpenCode 现有架构高度兼容
- Nanobot 已验证此模式可行
- 解锁并行子任务、非阻塞执行等核心能力
- 可与现有 sync 模式共存，渐进迁移

**下一步**：
1. 在 OpenCode 上做 PoC：修改 TaskTool + 添加 SubtaskNotifier
2. 验证并发场景和边界条件
3. 设计 WopalSpace 的 spawn API
4. 评估是否需要引入 Channel 概念（远期）