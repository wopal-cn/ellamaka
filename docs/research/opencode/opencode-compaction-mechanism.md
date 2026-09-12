# OpenCode Compaction 机制研究报告

> 研究日期：2026-04-09
> 源码版本：opencode `7daea69e`
> 研究方法：源码追踪（compaction.ts / prompt.ts / message-v2.ts / processor.ts / overflow.ts）

---

## 核心结论

Compaction 不是子 session，而是同一 session 内的内联处理。它把当前会话的全部消息历史喂给一个无工具的 compaction agent，生成摘要后存回同一 session。下次循环时通过 `filterCompacted` 截断旧历史，只保留摘要及之后的消息。

---

## 整体架构

### 三阶段协作

```
┌─────────────────────────────────────────────────────────────────────┐
│  prompt.ts runLoop() — 主循环                                       │
│                                                                     │
│  while (true) {                                                     │
│    ① msgs = filterCompactedEffect(sessionID)                        │
│       → 从 DB 读取消息，遇到 compaction 边界截断                     │
│                                                                     │
│    ② 检测到 compaction part 或 token overflow                       │
│       → compaction.create()  写 compaction 消息到 DB                │
│       → compaction.process() 生成摘要                               │
│                                                                     │
│    ③ 正常对话                                                        │
│       → instruction.system()  每轮从磁盘读 AGENTS.md 等             │
│       → toModelMessages(msgs)  消息转模型格式                       │
│       → processor.process({ system, messages, tools })              │
│                                                                     │
│    ④ 循环末尾                                                        │
│       → compaction.prune()  异步裁剪旧工具输出                      │
│  }                                                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 触发条件

| 触发方式 | 入口 | 说明 |
|----------|------|------|
| 自动触发 | `prompt.ts:1376-1383` / `prompt.ts:1506-1514` | 见下方详细触发路径 |
| 手动触发 | TUI `/compact` 命令 → `session.compact` | 用户主动执行 |
| API 触发 | `POST /session/{id}/compact` | 编程触发 |

### 自动触发的两条路径

**路径 A：正常响应后主动检测**（最常见）

```
prompt.ts runLoop 主循环，每次 API 调用完成后：
  1. processor 返回，lastFinished 有 token 统计
  2. 检测 lastFinished.summary !== true && isOverflow(tokens, model)
  3. 若溢出 → compaction.create(写入 compaction 标记)
  4. 下一轮 loop 检测到 compaction part → compaction.process(生成摘要)
```

**路径 B：processor 处理过程中被动检测**

```
processor.ts:388-397，API 响应 finish 事件处理：
  1. API 返回 token usage
  2. 检测 !summary && isOverflow(cfg, tokens, model)
  3. 若溢出 → 设置 needsCompaction = true
  4. processor.process() 返回 "compact"
  5. runLoop 检测 result === "compact" → compaction.create(写入标记)
  6. 下一轮 loop 执行 compaction.process()
```

**本质区别**：路径 A 是 runLoop 主动检查，路径 B 是 processor 在处理流式响应过程中发现溢出提前标记。两条路径最终都经过 `create() → process()` 流程。

overflow 判定（`overflow.ts`）：

```typescript
// 前置检查
if (cfg.compaction?.auto === false) return false  // 关闭自动压缩
if (context === 0) return false                   // context 为 0 的模型不触发

// 可用空间 = limit.input - reserved（默认 20K）
//   或 context - maxOutputTokens
// 实际用量 = input + output + cache.read + cache.write
return 实际用量 >= 可用空间
```

---

## Compaction 执行流程

### create — 写 compaction 消息

`compaction.ts:349-372`

```
写入一条 user message + 一个 compaction part 到 DB
  → user message 记录当前 agent、model、时间
  → compaction part 标记 auto（自动/手动）和 overflow
```

这一步只是写入标记，不执行压缩。

### process — 生成摘要

`compaction.ts:141-347`

```
输入：
  - messages: WithParts[]（filterCompacted 后的消息流）
  - parentID: 触发 compaction 的 user message ID
  - sessionID: 当前 session

步骤：
  1. 从 messages 找到 parentID 对应的 user message
  2. overflow 时做 replay 截断（找上一个非 compaction 的 user message）
  3. 获取 compaction agent 和 model
  4. plugin trigger "experimental.session.compacting" 允许自定义 prompt
  5. structuredClone(messages) 深拷贝
  6. plugin trigger "experimental.chat.messages.transform" 允许改消息
  7. toModelMessagesEffect(msgs, model, { stripMedia: true })
     → 转模型格式，去除所有媒体文件
  8. 创建 assistant message（mode: "compaction", summary: true）
  9. processor.process({
       messages: [...全部历史转换后的模型消息, { role: "user", content: 摘要 prompt }],
       tools: {},        // 空！禁止调用工具
       system: [],       // 空！不注入系统提示词
     })
  10. 处理结果：
      - "continue" → 发布 Compacted 事件，继续循环
      - "compact" → 摘要也失败了（context 仍然太大），标记 error
```

### 摘要 Prompt 模板

`compaction.ts:189-217`，固定模板结构：

```
Provide a detailed prompt for continuing our conversation above.
...
---
## Goal
## Instructions
## Discoveries
## Accomplished
## Relevant files / directories
---
```

可通过 `experimental.session.compacting` 插件 hook 替换或追加 context。

---

## 上下文清理机制

### 消息级截断（filterCompacted）

`message-v2.ts:903-918`

遍历方向：**从最新到最旧**。

| 遇到什么 | 动作 |
|----------|------|
| assistant message 且 `summary: true` 且 `finish` 且无 `error` | 标记其 `parentID` 为已完成 |
| user message 且有 `compaction` part 且其 ID 在已完成集合中 | **break — 截断** |
| 其他 | 继续收集 |

```
DB 中的完整消息流：
  u1 → a1 → u2 → a2 → u3(compaction) → a3(summary) → u4 → a4
                                    ↑
                              截断边界

filterCompacted 返回：
  a3(summary) → u4 → a4
```

**效果**：u1/a1/u2/a2/u3 全部消失，a3 成为新的对话起点。

### 摘要消息如何变成模型输入

`toModelMessagesEffect`（`message-v2.ts:576-812`）：

| 消息类型 | 转换方式 |
|----------|---------|
| compaction user message | 替换为固定文本 `"What did we do so far?"` |
| summary assistant message | 正常转换 text parts（摘要正文） |
| compaction 之后的消息 | 正常转换 |
| subtask user message | 替换为固定文本 `"The following tool was executed by the user"` |

### 工具输出裁剪（prune）

`compaction.ts:93-139`

在 compact 完成后的下一个循环末尾**异步执行**。

```
常量：
  PRUNE_PROTECT = 40,000 tokens   // 保护阈值
  PRUNE_MINIMUM = 20,000 tokens   // 最低回收门槛
  PRUNE_PROTECTED_TOOLS = ["skill"]  // 永远保护的工具

从最新往回扫：
  最近 2 轮（turns < 2）→ 跳过，不参与计算
  2 轮之前 → 开始累计 token
    - total <= PRUNE_PROTECT → 不裁剪
    - total > PRUNE_PROTECT → 标记为 toPrune
    - 遇到 skill 工具 → 跳过（永远保护）
    - 遇到已 compacted 的 → 停止扫描

执行条件：pruned（可回收量） > PRUNE_MINIMUM
```

**标记 compacted 后的效果**（`message-v2.ts:718-719`）：

| 字段 | 正常值 | compacted 后 |
|------|--------|-------------|
| output | 完整工具输出文本 | `"[Old tool result content cleared]"` |
| attachments | 图片等附件 | `[]`（清空） |
| input | 工具调用参数 | **保留** |

### 清理总结

| 层级 | 清理了什么 | 保留了什么 |
|------|-----------|-----------|
| **消息级** | compact 边界之前的所有消息 | summary 消息 + 之后的所有消息 |
| **工具输出级** | 距今 >2 轮且累计 token > 40K 的 output 和 attachments | 工具调用 input、最近 2 轮全部内容、skill 工具输出 |
| **媒体级** | compact 时 stripMedia=true 去掉所有图片/文件 | 替换为 `[Attached mime: filename]` 占位符 |
| **指令文件** | 无（每轮从文件系统重新读取） | AGENTS.md / CLAUDE.md 等始终完整 |

### prune 举例

```
a3(summary) → u4 → a4(read:2K, bash:3K) → u5 → a5(edit:1K) → u6 → a6(bash:5K, write:8K)
                                ↑                                          ↑
                           >2轮前                                      最近2轮

情况 A（a4 总计 5K < 40K）：全部保留，不 prune
情况 B（假设 a4 输出很大：read:30K, bash:25K = 55K > 40K）：
  → read(30K) 不裁剪（累计 30K < 40K）
  → bash(25K) 被裁剪（累计 55K > 40K），前提：25K > 20K 最低门槛
```

---

## System Prompt 与 Compact 的关系

### 每轮重建，不存储在消息历史中

`prompt.ts:1501-1507`，runLoop 每次迭代固定执行：

```typescript
const [skills, env, instructions, modelMsgs] = yield* Effect.all([
  SystemPrompt.skills(agent),       // 读取 skill 文件
  SystemPrompt.environment(model),  // 读取环境信息（pwd, date, shell...）
  instruction.system(),             // 读取 AGENTS.md, CLAUDE.md, config.instructions
  MessageV2.toModelMessages(msgs),  // 消息转模型格式
])
const system = [...env, ...(skills ? [skills] : []), ...instructions]
```

**System prompt 每轮从磁盘重建**，不走消息历史，compact 不影响它。

### 指令文件发现范围（instruction.ts）

| 来源 | 查找逻辑 |
|------|---------|
| 项目级 | 从工作目录向上 findUp AGENTS.md / CLAUDE.md / CONTEXT.md，首个匹配即停 |
| 全局级 | `~/.config/opencode/AGENTS.md` 或 `~/.claude/CLAUDE.md` |
| 配置级 | `opencode.jsonc` 的 `instructions` 字段（支持文件路径和 HTTP URL） |
| 邻近级 | `Instruction.resolve()` 在 agent 读取文件时，沿目录树向上附带附近指令文件 |

---

## 模型选择

### Compaction Agent 的模型

`compaction.ts:179-182`：

```typescript
const agent = yield* agents.get("compaction")
const model = agent.model
  ? yield* provider.getModel(agent.model.providerID, agent.model.modelID)
  : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
```

优先使用 `config.agent.compaction.model`，未配置则回退到触发 compaction 的用户消息所用模型。

### 配置方式

**唯一途径**：`opencode.jsonc`

```jsonc
{
  "agent": {
    "compaction": {
      "model": "openai/gpt-4o-mini"  // provider-id/model-id
    }
  }
}
```

`AgentConfig` 还支持 `temperature`、`prompt`（覆盖默认摘要模板）、`variant` 等字段。

### 其他 compaction 相关配置

| 配置 | 作用 | 方式 |
|------|------|------|
| `compaction.auto` | 关闭自动 compact | `opencode.jsonc` 或 `OPENCODE_DISABLE_AUTOCOMPACT=1` |
| `compaction.prune` | 关闭工具输出裁剪 | `opencode.jsonc` 或 `OPENCODE_DISABLE_PRUNE=1` |
| `compaction.reserved` | compact 缓冲 token 数 | `opencode.jsonc` |
| `experimental.session.compacting` | 自定义 compact prompt | 插件 hook |

**插件 hook 不可更换模型**，只暴露 `context: string[]` 和 `prompt?: string`。

---

## TUI 上下文占用显示延迟问题

### 现象

执行 `/compact` 后，TUI 显示的上下文占用不会立刻降低，要等到下一轮 API 调用后才会显示明显下降。

### 原因

TUI 的上下文占用来自 `assistantMessage.tokens`，由每次 API 调用后 provider 返回的 `usage` 写入。

```
时间线：
  1. 正常对话 → API 返回 usage → TUI 显示 150K
  2. /compact → compaction.process() 调用 API 生成摘要
     → 这次 API 的 input 仍然是全部历史（~150K）
     → TUI 仍然显示 ~150K
  3. compact 完成，filterCompacted 截断旧消息
     → 但此时无新 API 调用，无新 usage 数据
  4. 用户发下一条消息 → API 调用
     → input 只有 summary + 新消息 ≈ 10K
     → TUI 才显示 ~10K
```

本质：**compact 本身的 API 调用必须读入全部历史才能生成摘要**，所以这次调用的 token 统计仍然是"满"的。

---

## 关键源码索引

| 文件 | 关键行 | 职责 |
|------|--------|------|
| `compaction.ts` | 1-428 | Compaction 全部逻辑：create / process / prune / isOverflow |
| `prompt.ts` | 1337-1565 | runLoop 主循环，调度 compaction |
| `message-v2.ts` | 576-812 | toModelMessagesEffect — 消息转模型格式 |
| `message-v2.ts` | 903-918 | filterCompacted — 消息级截断 |
| `message-v2.ts` | 718-719 | compacted 工具输出的占位符替换 |
| `processor.ts` | 260-312 | token 统计记录和 overflow 检测 |
| `overflow.ts` | 1-22 | isOverflow 判定 |
| `instruction.ts` | 37-52 | extract — 跳过 compacted 的已加载文件路径 |
| `agent.ts` | 188-202 | compaction 内置 agent 定义 |
| `agent.ts` | 240-263 | config.agent 配置合并到 agent |