# OpenCode Session、Agent 与消息机制

## 核心概念关系

```
Project
  └── Session (对话容器)
        ├── Message (消息)
        │     └── Part (片段: text/file/tool/reasoning)
        └── Agent (角色定义)
              ├── permission (权限规则)
              ├── model (默认模型)
              └── prompt (系统提示词)
```

---

## Session（会话）

**定位**：对话的持久化容器，存储在 SQLite 数据库中

**核心字段**：
- `id` - 会话标识
- `projectID` - 所属项目
- `parentID` - 父会话（用于 subagent 场景）
- `title` - 会话标题
- `permission` - 会话级权限覆盖

**生命周期**：
- `POST /session` 创建
- `DELETE /session/{id}` 删除
- 子 Session 通过 `Task` 工具创建（parentID 指向父 Session）

---

## Agent（代理/角色）

**定位**：定义 AI 的行为模式，不是运行时实例

**三种模式**：
| Mode | 用途 | 示例 |
|------|------|------|
| `primary` | 主代理，用户直接交互 | `build`, `plan` |
| `subagent` | 子代理，被 Task 工具调用 | `explore`, `general` |
| `all` | 两种场景都可用 | 自定义代理 |

**核心配置**：
- `permission` - 权限规则集（允许/拒绝/询问）
- `model` - 默认模型（可选）
- `prompt` - 系统提示词模板
- `steps` - 最大循环步数

**内置 Agent**：
- `build` - 默认代理，执行工具
- `plan` - 计划模式，禁止编辑
- `explore` - 快速探索代码库
- `general` - 通用研究任务
- `title` / `summary` / `compaction` - 隐藏的系统代理

---

## Message & Part（消息结构）

**Message 类型**：
- `user` - 用户消息
- `assistant` - 助手响应

**Part 类型**（消息片段）：

| Type | 用途 | 关键字段 |
|------|------|----------|
| `text` | 文本内容 | `text`, `synthetic` |
| `file` | 文件/图片 | `url`, `mime`, `filename` |
| `tool` | 工具调用 | `tool`, `callID`, `state` |
| `reasoning` | 推理过程 | `text`, `metadata` |
| `agent` | @agent 引用 | `name` |
| `subtask` | 子任务定义 | `prompt`, `agent`, `model` |
| `step-start/finish` | 步骤边界 | `snapshot`, `tokens` |

**Tool State 状态机**：
```
pending → running → completed/error
```

---

## 发送消息的方式

### HTTP API

**同步发送（等待响应）**：
```
POST /session/{id}/message
Body: { parts: [...], agent?: string, model?: {...} }
Response: MessageV2.WithParts (流式 JSON)
```

**异步发送（立即返回）**：
```
POST /session/{id}/prompt_async
Response: 204 No Content
```

**发送命令（带参数模板）**：
```
POST /session/{id}/command
Body: { command: string, arguments: string }
```

**执行 Shell**：
```
POST /session/{id}/shell
Body: { command: string, agent: string }
```

### 消息内容类型

**文本**：
```json
{ "type": "text", "text": "你的问题" }
```

**文件**：
```json
{ "type": "file", "url": "file:///path/to/file", "mime": "text/plain" }
```

**图片**：
```json
{ "type": "file", "url": "data:image/png;base64,...", "mime": "image/png" }
```

**@Agent 引用**：
```json
{ "type": "agent", "name": "explore" }
```

**Subtask（创建子任务）**：
```json
{
  "type": "subtask",
  "agent": "explore",
  "prompt": "搜索所有 API 端点",
  "description": "探索 API",
  "model": { "providerID": "anthropic", "modelID": "claude-3-5-sonnet" }
}
```

---

## Agent 如何回复

### 响应模式

**流式（Stream）**：
- 默认模式，通过 Bus Event 实时推送
- 每个 Part 更新触发 `message.part.updated` 事件
- 文本增量触发 `message.part.delta` 事件

**同步等待**：
- `prompt()` 返回 Promise，等待最终响应
- 内部仍是流式处理，只是等待完成

### 事件订阅（SSE）

**全局事件流**：
```
GET /global/event
Accept: text/event-stream
```

**关键事件**：

| Event | 触发时机 |
|-------|----------|
| `session.created` | Session 创建 |
| `session.updated` | Session 更新 |
| `session.status` | Session 状态变更（idle/busy/retry） |
| `message.updated` | Message 创建/更新 |
| `message.part.updated` | Part 更新 |
| `message.part.delta` | 文本增量（流式） |
| `session.error` | 发生错误 |
| `question.asked` | Agent 提出问题（非交互模式必需） |
| `question.replied` | 问题已回答 |
| `question.rejected` | 问题被拒绝 |
| `permission.asked` | 权限请求（非交互模式必需） |
| `todo.updated` | Todo 列表变更 |
| `file.edited` | 文件被编辑 |
| `pty.created/exited` | PTY 进程生命周期 |

### Question 事件机制（非交互模式核心）

**场景**：当 Agent 需要用户选择时（如 `question` 工具），在非交互模式下通过 SSE 通知外部控制器。

**事件结构**：
```typescript
// question.asked 事件
{
  type: 'question.asked',
  properties: {
    id: string,           // requestID，用于回复
    sessionID: string,    // 提问的 Session
    questions: Array<{
      question: string,   // 完整问题
      header: string,     // 简短标签（max 30 chars）
      options: Array<{
        label: string,    // 选项显示文本
        description: string
      }>,
      multiple?: boolean  // 是否多选
    }>,
    tool?: {
      messageID: string,
      callID: string
    }
  }
}
```

**回复方式**：
```typescript
// 通过 HTTP API 回复
POST /question/reply
{
  requestID: string,
  answers: Array<Array<string>>  // 对应每个 question 的选中 label
}
```

**工作流**：
```
Wopal 订阅 SSE
    ↓
收到 question.asked 事件
    ↓
解析 questions 内容
    ↓
决策（自动或人工）
    ↓
调用 question.reply API
```

**关键发现**：
- SSE 事件包含**完整问题内容**，无需轮询 `question.list`
- `question.reply` 只在收到事件后调用，效率高
- 适用于 Agent 在后台运行时需要交互的场景

### 处理流程

```
用户输入
    ↓
创建 User Message + Parts
    ↓
SessionPrompt.loop() 启动处理循环
    ↓
LLM.stream() 调用模型
    ↓
流式输出 → 更新 Parts → 发布 Events
    ↓
Tool 调用 → 更新 ToolPart 状态
    ↓
完成 → finish reason 判断是否继续循环
```

---

## Subagent（子代理）机制

### 调用方式

**方式一：用户 @ 引用**
```
用户消息包含 { type: "agent", name: "explore" }
→ 系统注入提示词调用 Task 工具
```

**方式二：模型主动调用 Task 工具**
```
模型决策 → 调用 task 工具
→ 创建子 Session（parentID = 当前 Session）
→ 在子 Session 中运行指定 Agent
→ 返回结果给父 Session
```

### Task 工具参数

```
{
  subagent_type: "explore",    // Agent 名称
  prompt: "搜索 API 端点",      // 任务描述
  description: "探索 API",      // 简短标题
  task_id: "xxx"               // 可选，恢复已有任务
}
```

### 隔离机制

- 子 Session 有独立的 message 历史
- 权限继承自父 Agent + 配置覆盖
- 默认禁用 `todowrite/todoread`
- 可配置禁用 `task` 工具（防止嵌套）

---

## SDK 使用示例

### JavaScript/TypeScript SDK

```typescript
import { client } from '@opencode-ai/sdk'

// 创建 Session
const session = await client.session.create()

// 发送消息（同步等待）
const response = await client.session.prompt({
  path: { id: session.id },
  body: {
    parts: [{ type: 'text', text: '解释这个函数' }],
    agent: 'build'
  }
})

// 订阅事件流
const eventStream = await client.global.event()
for await (const event of eventStream.stream) {
  if (event.type === 'message.part.delta') {
    process.stdout.write(event.properties.delta)
  }
}

// 调用 Subagent
await client.session.prompt({
  path: { id: session.id },
  body: {
    parts: [{
      type: 'subtask',
      agent: 'explore',
      prompt: '找到所有测试文件',
      description: '探索测试'
    }]
  }
})
```

---

## 关键设计要点

### 并发控制
- 每个 Session 有一个 `AbortController`
- 同时只能有一个 prompt 在处理
- 新请求会排队等待或抛出 `BusyError`

### 消息压缩（Compaction）
- 当 token 超限时自动触发
- 将历史消息压缩为摘要
- 用户可手动触发 `POST /session/{id}/summarize`

### 权限系统
- Agent 级 + Session 级规则合并
- 规则格式：`{ permission, action, pattern }`
- action: `allow` / `deny` / `ask`

### 指定 Agent/模型
- 每条 User Message 可指定 `agent` 和 `model`
- 模型格式：`{ providerID, modelID }`
- 不指定则使用 Agent 默认配置或上次使用的模型

---

## 源码位置参考

| 模块 | 路径 |
|------|------|
| Session | `src/session/index.ts` |
| Message/Part | `src/session/message-v2.ts` |
| Prompt 处理 | `src/session/prompt.ts` |
| 处理器（流式） | `src/session/processor.ts` |
| Agent 定义 | `src/agent/agent.ts` |
| Task 工具 | `src/tool/task.ts` |
| Bus 事件 | `src/bus/index.ts` |
| HTTP 路由 | `src/server/routes/session.ts` |
| SDK 生成 | `packages/sdk/js/src/gen/` |

---

## 完整 Part 类型列表

| Type | 说明 | 关键字段 |
|------|------|----------|
| `text` | 文本内容 | `text`, `synthetic`, `ignored`, `time` |
| `file` | 文件/图片 | `url`, `mime`, `filename`, `source` |
| `tool` | 工具调用 | `tool`, `callID`, `state` |
| `reasoning` | 推理过程 | `text`, `metadata`, `time` |
| `agent` | Agent 引用 | `name`, `source` |
| `subtask` | 子任务定义 | `agent`, `prompt`, `description`, `model` |
| `step-start` | 步骤开始 | `snapshot` |
| `step-finish` | 步骤结束 | `reason`, `snapshot`, `cost`, `tokens` |
| `snapshot` | 快照 | `snapshot` |
| `patch` | 文件变更 | `hash`, `files` |
| `retry` | 重试记录 | `attempt`, `error`, `time` |
| `compaction` | 压缩标记 | `auto`, `overflow` |

### FilePartSource（文件来源）

| Type | 说明 | 关键字段 |
|------|------|----------|
| `file` | 文件系统 | `path`, `text` |
| `symbol` | LSP 符号 | `path`, `range`, `name`, `kind`, `text` |
| `resource` | MCP 资源 | `clientName`, `uri`, `text` |

### Tool State 完整定义

```typescript
type ToolState =
  | { status: "pending", input: object, raw: string }
  | { status: "running", input: object, title?: string, metadata?: object, time: { start: number } }
  | { status: "completed", input: object, output: string, title: string, metadata: object, time: { start, end, compacted? }, attachments?: FilePart[] }
  | { status: "error", input: object, error: string, metadata?: object, time: { start, end } }
```

### OutputFormat（输出格式）

```typescript
type OutputFormat =
  | { type: "text" }
  | { type: "json_schema", schema: object, retryCount?: number }
```

---

## 错误类型

| Error | 说明 |
|-------|------|
| `OutputLengthError` | 输出长度超限 |
| `AbortedError` | 用户中断 |
| `StructuredOutputError` | 结构化输出失败 |
| `AuthError` | API 认证失败 |
| `APIError` | API 调用错误 |
| `ContextOverflowError` | 上下文溢出 |