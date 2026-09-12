# Claude Agent SDK 架构研究报告

> **分析日期**: 2026-04-03
> **文档来源**: https://platform.claude.com/docs/en/agent-sdk （28 页完整抓取）
> **本地存档**: `docs/scraped/claude-agent-sdk/`
> **SDK 包**: `claude-agent-sdk-python` (Python) / `@anthropic-ai/claude-agent-sdk` (TypeScript)

---

## 定位与本质

Claude Agent SDK（前身为 Claude Code SDK）是 Claude Code CLI 核心引擎的**可编程封装**。它将 Claude Code 的自主 agent loop、内置工具、权限系统、会话管理全部暴露为 Python / TypeScript API。

**关键事实**：SDK 内部捆绑了一个 Claude Code CLI 实例作为子进程运行。SDK 不是对 Claude API 的简单封装，而是直接复用了 Claude Code 的完整执行引擎。

| 维度 | Claude Code CLI | Claude Agent SDK |
|------|----------------|-----------------|
| **定位** | 交互式终端 Agent 工具 | 可嵌入应用的 Agent 引擎 |
| **接口** | TUI（Ink + React） | `query()` async iterator |
| **目标用户** | 开发者在终端中使用 | 开发者构建 AI 应用 |
| **系统提示词** | 完整 Claude Code 提示词 | 默认最小化，可选 preset |
| **文件系统设置** | 自动加载 | 默认不加载，需显式配置 |
| **运行环境** | 本地终端 | 容器 / 云 / CI / 本地 |

---

## 核心架构：Agent Loop

### 循环模型

```
┌─────────────────────────────────────────────────────────┐
│                    Your Application                       │
│                                                         │
│   query(prompt, options) ──► async message stream        │
│                                                         │
│  ┌────────────────────────────────────────────────┐     │
│  │               Agent Loop Engine                 │     │
│  │                                                │     │
│  │  ① SystemPrompt + ToolDefs + History            │     │
│  │           ↓                                    │     │
│  │  ② Claude 评估 → 文本输出 / Tool Calls          │     │
│  │           ↓                                    │     │
│  │  ③ [Hooks 拦截] → 权限检查 → 执行 Tools         │     │
│  │           ↓                                    │     │
│  │  ④ Tool Results 回喂 Claude                     │     │
│  │           ↓                                    │     │
│  │  ⑤ 循环直到无 Tool Call → ResultMessage          │     │
│  └────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
```

每个 turn = 一次 Claude 输出（含 tool calls）+ 工具执行 + 结果回传。循环在 Claude 产出无 tool call 的纯文本响应时结束。

### 消息流

```
SystemMessage(init)           ← 会话元数据、session_id
    ↓
AssistantMessage × N turns    ← 每轮 Claude 输出（文本 + tool_use blocks）
    ↓                         ← [可选] StreamEvent 流式事件
UserMessage × N               ← 工具执行结果回传
    ↓
ResultMessage                 ← 最终结果 + 费用 + 终止原因
```

### 消息类型

| 类型 | 含义 | 关键字段 |
|------|------|----------|
| `SystemMessage` | 会话生命周期事件 | `subtype`: `init` / `compact_boundary` |
| `AssistantMessage` | 每轮 Claude 响应 | `content[]`: TextBlock + ToolUseBlock |
| `UserMessage` | 工具执行结果 | `content[]`: ToolResultBlock |
| `StreamEvent` | 原始 API 流式事件 | `event.type`: `content_block_delta` 等 |
| `ResultMessage` | 最终结果 | `result`, `total_cost_usd`, `usage`, `num_turns`, `session_id` |

### 终止原因（ResultMessage.subtype）

| subtype | 含义 | `result` 可用？ |
|---------|------|----------------|
| `success` | 任务正常完成 | ✅ |
| `error_max_turns` | 达到 turn 上限 | ❌ |
| `error_max_budget_usd` | 达到预算上限 | ❌ |
| `error_during_execution` | 执行中断（API 错误等） | ❌ |
| `error_max_structured_output_retries` | 结构化输出验证失败 | ❌ |

---

## 与 Claude Code CLI 的关系

### 共享引擎架构

```
              ┌──────────────────────────┐
              │    Claude Code CLI       │
              │  (交互式终端工具)          │
              └──────────┬───────────────┘
                         │ 共享同一引擎
                         ▼
              ┌──────────────────────────┐
              │   Agent Loop Engine      │
              │  ┌────────────────────┐  │
              │  │ System Prompt       │  │
              │  │ Tool Definitions    │  │
              │  │ Permission System   │  │
              │  │ Context Management  │  │
              │  │ Session Persistence │  │
              │  │ Hooks System        │  │
              │  └────────────────────┘  │
              └──────────┬───────────────┘
                         │ 封装为 API
                         ▼
              ┌──────────────────────────┐
              │    Claude Agent SDK      │
              │  (Python / TypeScript)   │
              │                          │
              │  query() → async stream  │
              │  ClaudeSDKClient (多轮)  │
              └──────────────────────────┘
```

### 能力共享矩阵

| 能力 | CLI | SDK | 备注 |
|------|-----|-----|------|
| Agent Loop 引擎 | ✅ | ✅ | 同一个引擎 |
| 内置工具集 | ✅ | ✅ | Read/Edit/Write/Bash/Glob/Grep/WebSearch/WebFetch |
| 权限系统（6 种模式） | ✅ | ✅ | default/acceptEdits/dontAsk/plan/auto/bypassPermissions |
| Hooks 机制 | ✅ | ✅ | 文件系统 hooks + 编程回调 |
| MCP Server 连接 | ✅ | ✅ | stdio/HTTP/SSE + in-process |
| Skills | ✅ | ✅ | 需 settingSources |
| Slash Commands | ✅ | ✅ | 需 settingSources |
| Subagents | ✅ | ✅ | 编程定义 + 文件系统定义 |
| Session 持久化 | ✅ | ✅ | JSONL 文件 |
| CLAUDE.md / Rules | ✅ | ✅ | 需 settingSources |
| Plugins | ✅ | ✅ | 编程加载 |
| File Checkpointing | ✅ | ✅ | 文件快照与回滚 |
| Tool Search | ✅ | ✅ | 按需加载工具定义 |
| Todo Tracking | ✅ | ✅ | 内置 TodoWrite 工具 |
| Structured Output | ✅ | ✅ | JSON Schema 约束输出 |
| Streaming | ✅ | ✅ | 输入（async generator）+ 输出（StreamEvent） |

### 关键差异

| 维度 | CLI | SDK |
|------|-----|-----|
| **系统提示词** | 完整 Claude Code 提示词（代码风格、安全指令等） | **默认最小化**（仅工具指令），需 `preset: "claude_code"` 启用完整版 |
| **文件系统设置** | 自动从 `.claude/` 和 `~/.claude/` 加载 | **默认不加载**，需显式 `settingSources: ["user", "project", "local"]` |
| **Auto Memory** | `~/.claude/projects/<p>/memory/` 跨会话持久化 | ❌ CLI 独占功能 |
| **Agent Teams** | 多 Claude Code 实例协调，共享任务列表 | ❌ CLI 独占功能 |
| **Output Styles** | `/output-style` 命令切换 | 通过 settingSources 加载文件 |
| **Session 管理** | 自动 | Python: `ClaudeSDKClient` 自动；TS: `continue: true` 或手动 `resume` |

---

## 工具体系

### 工具层次

```
                    ┌─────────────────────────────┐
                    │       Claude 可调用的工具       │
                    └──────────┬──────────────────┘
                               │
           ┌───────────────────┼───────────────────┐
           │                   │                   │
    ┌──────▼──────┐    ┌──────▼──────┐    ┌──────▼──────┐
    │  内置工具     │    │  MCP 工具    │    │  自定义工具   │
    │  (bundled)  │    │  (external) │    │  (in-process)│
    └─────────────┘    └─────────────┘    └─────────────┘
```

### 内置工具一览

| 类别 | 工具 | 功能 |
|------|------|------|
| **文件操作** | `Read`, `Edit`, `Write` | 读取、修改、创建文件 |
| **搜索** | `Glob`, `Grep` | 按模式查找文件、正则搜索内容 |
| **执行** | `Bash` | 运行 shell 命令、脚本、git 操作 |
| **Web** | `WebSearch`, `WebFetch` | 搜索网页、抓取页面内容 |
| **发现** | `ToolSearch` | 动态发现并按需加载工具（避免预加载所有定义） |
| **编排** | `Agent`, `Skill`, `AskUserQuestion`, `TodoWrite` | 生成子代理、调用技能、向用户提问、任务追踪 |

### 工具权限链

工具调用前按以下顺序检查：

```
① Hooks → 可 allow / deny / modify
② Deny Rules (disallowed_tools) → 匹配则拒绝（即使在 bypassPermissions 下）
③ Permission Mode → 决定未匹配工具的处理策略
④ Allow Rules (allowed_tools) → 匹配则批准
⑤ canUseTool Callback → 最终兜底
```

### 工具并行执行

- **只读工具**（Read, Glob, Grep, MCP readOnly）→ 可并行
- **写操作**（Edit, Write, Bash）→ 串行执行
- **自定义工具** → 默认串行，标注 `readOnlyHint: true` 后可并行

### 自定义工具（In-Process MCP Server）

自定义工具通过 SDK 内置的 in-process MCP Server 暴露，统一了工具协议：

```python
# Python 示例
@tool("get_temperature", "Get temperature at location", {"latitude": float, "longitude": float})
async def get_temperature(args):
    # ... 业务逻辑 ...
    return {"content": [{"type": "text", "text": f"Temperature: {temp}°F"}]}

server = create_sdk_mcp_server(name="weather", version="1.0.0", tools=[get_temperature])
```

工具结果支持多种内容类型：
- `text` — 文本
- `image` — Base64 编码图片（Claude 作为视觉输入处理）
- `resource` — URI 标识的内容块

---

## 扩展机制

### 扩展机制全景

| 机制 | 定义方式 | 调用方式 | 上下文隔离 | 适用场景 |
|------|----------|----------|-----------|----------|
| **Custom Tools** | `@tool()` / `tool()` → in-process MCP | Claude 自动选择 | ❌ 共享 | 应用逻辑、API 封装 |
| **MCP Servers** | `mcpServers` 参数 / `.mcp.json` | Claude 自动选择 | ✅ 独立进程 | 数据库、GitHub、Slack |
| **Subagents** | `agents` 参数 / `.claude/agents/` | Claude 自动委派或 prompt 指定 | ✅ 独立会话 | 隔离上下文、并行任务 |
| **Skills** | `.claude/skills/<name>/SKILL.md` | Claude 自主触发 | ❌ 共享（内容按需加载） | 可复用工作流 |
| **Plugins** | `.claude-plugin/plugin.json` 包 | `plugins` 选项加载 | — | 可分发的扩展集合 |
| **Hooks** | 编程回调 / settings.json shell 命令 | SDK 事件驱动 | ❌ 进程内 | 拦截、审计、修改 |

### Subagents 详解

子代理是独立的 agent 实例，拥有**全新会话上下文**，只有最终摘要返回给父级。

**继承关系**：

| 子代理获得 | 子代理不获得 |
|-----------|------------|
| 自己的 system prompt + Agent tool prompt | 父级对话历史 |
| 项目 CLAUDE.md（通过 settingSources） | 父级 system prompt |
| 工具定义（继承或 tools 子集） | Skills（除非显式列出） |

**定义方式**：

```python
AgentDefinition(
    description="Expert code review specialist",
    prompt="You are a code review specialist...",
    tools=["Read", "Grep", "Glob"],      # 工具限制
    model="opus",                         # 模型覆盖
    skills=["security-audit"],            # 可用技能
    mcpServers=["github"],               # 可用 MCP
)
```

**限制**：子代理不能嵌套（不能生成自己的子代理）。

### Hooks 详解

Hooks 是类型化的回调函数，在 agent 生命周期的特定点触发。

**可用事件**：

| 事件 | Python | TypeScript | 触发时机 |
|------|--------|------------|----------|
| `PreToolUse` | ✅ | ✅ | 工具调用前（可阻止/修改） |
| `PostToolUse` | ✅ | ✅ | 工具执行后 |
| `PostToolUseFailure` | ✅ | ✅ | 工具执行失败 |
| `UserPromptSubmit` | ✅ | ✅ | 用户 prompt 提交 |
| `Stop` | ✅ | ✅ | Agent 执行停止 |
| `SubagentStart` | ✅ | ✅ | 子代理启动 |
| `SubagentStop` | ✅ | ✅ | 子代理完成 |
| `PreCompact` | ✅ | ✅ | 上下文压缩前 |
| `PermissionRequest` | ✅ | ✅ | 权限对话框 |
| `Notification` | ✅ | ✅ | Agent 状态消息 |
| `SessionStart` | ❌ | ✅ | 会话初始化 |
| `SessionEnd` | ❌ | ✅ | 会话终止 |

**回调输出**：

| 字段 | 作用 |
|------|------|
| `{}` (空) | 允许操作继续 |
| `hookSpecificOutput.permissionDecision: "deny"` | 阻止操作 |
| `hookSpecificOutput.permissionDecision: "allow"` | 批准操作 |
| `hookSpecificOutput.updatedInput` | 修改工具输入 |
| `systemMessage` | 注入消息到对话（Claude 可见） |

**注意**：多个 hook 时 `deny` 优先级高于 `ask` 高于 `allow`。

### Skills

Skills 是基于文件系统的可复用能力包，以 `SKILL.md` 文件定义。

```
.claude/skills/<skill-name>/
└── SKILL.md    # YAML frontmatter (description) + Markdown 指令
```

**关键特性**：
- 启动时只加载描述摘要，完整内容按需加载（节省上下文）
- Claude 根据描述自主决定何时调用
- 必须通过文件系统定义（无编程 API）
- 需 `settingSources` + `allowedTools: ["Skill"]` 启用

### Plugins

Plugins 是可分发的扩展包，可包含多种扩展类型：

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json          # 清单文件（必需）
├── skills/                   # Agent Skills
│   └── my-skill/SKILL.md
├── agents/                   # 自定义代理
│   └── specialist.md
├── hooks/                    # 事件处理器
│   └── hooks.json
└── .mcp.json                # MCP Server 定义
```

通过 `plugins: [{ type: "local", path: "./my-plugin" }]` 加载。

---

## 会话与上下文管理

### 会话模型

```
Session (JSONL on disk)
├── ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
├── continue       → 恢复最近会话
├── resume(id)     → 恢复指定会话
└── fork(id)       → 分叉为新会话（原会话不变）
```

**多轮对话 API**：

| SDK | 方式 |
|-----|------|
| Python | `ClaudeSDKClient` — 自动管理 session_id |
| TypeScript (V1) | `continue: true` — 恢复最近会话 |
| TypeScript (V2 preview) | `createSession()` — session 对象 + send/stream |

### 上下文窗口消耗

| 来源 | 加载时机 | 影响 |
|------|----------|------|
| System Prompt | 每次请求 | 固定小成本 |
| CLAUDE.md | 会话启动（settingSources） | 全量但 prompt cached |
| 工具定义 | 每次请求 | 每个 schema 占上下文；ToolSearch 按需加载 |
| 对话历史 | 跨 turn 累积 | 随 turn 增长 |
| Skill 描述 | 会话启动 | 短摘要；完整内容按需加载 |

### 自动压缩（Compaction）

上下文接近极限时，SDK 自动摘要旧历史：

- 触发后发出 `compact_boundary` 消息
- CLAUDE.md 内容**不受影响**（每轮重新注入）
- 可通过 CLAUDE.md 中的指令指导压缩保留策略
- `PreCompact` hook 可在压缩前执行自定义逻辑

### 上下文优化策略

| 策略 | 效果 |
|------|------|
| 子代理隔离 | 子代理完整历史不进入父级，只返回摘要 |
| Tool Search | 工具定义按需加载，不预占上下文 |
| `effort: "low"` | 减少 routine 任务 token 消耗 |
| `tools` 限制 | 移除不需要的内置工具定义 |

---

## 权限系统

### 权限模式

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| `default` | 未匹配工具触发 canUseTool 回调 | 自定义审批流 |
| `acceptEdits` | 自动批准文件编辑，其他按默认规则 | 可信开发环境 |
| `dontAsk` | 未预批准的工具直接拒绝 | 无头 agent |
| `bypassPermissions` | 所有允许的工具直接执行（deny 规则仍有效） | 容器 / CI |
| `plan` | 不执行工具，只生成计划 | 代码审查 |
| `auto` (TS only) | 模型分类器自动批准/拒绝 | 自主 agent + 安全护栏 |

### 工具名匹配规则

内置工具直接使用名称（`"Read"`, `"Bash"`）。MCP 工具使用命名空间格式：

```
mcp__{server_name}__{tool_name}
```

支持通配符：`"mcp__github__*"` 批准某 server 所有工具。

---

## 系统提示词

### 三种定制方式

| 方式 | 持久性 | 适用场景 |
|------|--------|----------|
| **CLAUDE.md** | 文件级，跨会话 | 项目约定、团队共享 |
| **systemPrompt append** | 会话级 | 在完整预设上追加 |
| **自定义 systemPrompt** | 会话级 | 完全控制行为 |

**默认行为**：SDK 使用**最小系统提示词**（仅工具指令），不包含 Claude Code 的编码指南和风格指令。需要完整行为时使用 `preset: "claude_code"`。

**注意**：`preset: "claude_code"` 不会自动加载 CLAUDE.md，必须同时设置 `settingSources`。

---

## 输入/输出模式

### 输入模式

| 模式 | 特性 | 适用场景 |
|------|------|----------|
| **Streaming Input** (推荐) | 持久交互会话，支持图片、中断、消息队列 | 交互式应用 |
| **Single Message** | 一次性 prompt，通过 session resume 实现多轮 | Lambda、无状态环境 |

### 输出流式

启用 `includePartialMessages` / `include_partial_messages` 后接收原始 API 流式事件（`StreamEvent`），可实时显示文本和工具调用进度。

**限制**：
- 启用 `max_thinking_tokens` 时 StreamEvent 不触发
- Structured Output 只出现在最终 ResultMessage

---

## 部署架构

### 运行时要求

- Python 3.10+ / Node.js 18+
- Node.js（SDK 捆绑的 Claude Code CLI 需要）
- 出站 HTTPS 到 `api.anthropic.com`
- 推荐：1GiB RAM, 5GiB 磁盘, 1 CPU

### 部署模式

| 模式 | 特征 | 适用场景 |
|------|------|----------|
| **Ephemeral** | 每任务一个容器，完成后销毁 | Bug 修复、翻译、数据处理 |
| **Long-Running** | 持久容器，多 Agent 进程 | Email Agent、Site Builder |
| **Hybrid** | 临时容器 + 状态恢复 | 项目管理、深度研究 |
| **Single Container** | 多 Agent 共享容器 | 模拟、对抗博弈 |

### 沙箱化

SDK 支持**编程式沙箱配置**（TypeScript `sandboxSettings`），可控制：
- 进程隔离
- 资源限制
- 网络控制
- 临时文件系统

推荐沙箱提供商：Modal、Cloudflare Sandboxes、E2B、Fly Machines、Daytona。

---

## 与 OpenCode 的对比启示

| 维度 | Claude Agent SDK | OpenCode |
|------|-----------------|----------|
| **引擎来源** | 捆绑 Claude Code CLI 子进程 | 独立实现 |
| **工具协议** | 全面 MCP 标准化（含自定义工具） | MCP 支持 + 自定义工具 |
| **扩展分发** | Plugins（文件系统包） | Plugins（代码包，npm 风格） |
| **权限系统** | 6 种模式 + deny 规则 + hooks 链 | permission 配置 + auto-reject |
| **子代理** | 编程定义 + 文件系统，独立会话 | Task 工具，有限隔离 |
| **流式输出** | StreamEvent（原始 API 事件） | Part delta（text/reasoning/tool） |
| **会话持久化** | JSONL 文件 | SQLite |
| **Provider** | 仅 Anthropic（含 Bedrock/Vertex/Foundry） | 75+ Provider |
| **开源** | ❌ | ✅ MIT |

### 对 WopalSpace 的参考价值

1. **settingSources 设计** — CLI 自动加载一切、SDK 默认不加载任何东西的分层控制模式值得借鉴
2. **工具统一 MCP 协议** — 自定义工具也通过 in-process MCP Server 暴露，消除了工具协议碎片
3. **子代理作为上下文管理手段** — 不是函数调用，而是独立会话 + 独立工具集 + 独立模型的完整隔离
4. **Hooks 类型化回调** — 比 OpenCode 的 plugin hook 更结构化（typed input/output + matcher + 决策链）
5. **Tool Search** — 大量工具时按需加载定义，避免上下文浪费
6. **Streaming Input** — async generator 作为 prompt 输入，支持中途图片上传和中断

---

## 附录：文档索引

| 文档 | 内容 |
|------|------|
| `overview.md` | SDK 概览、安装、能力总览 |
| `quickstart.md` | 快速入门（bug 修复 agent） |
| `agent-loop.md` | Agent Loop 核心机制、消息类型、工具执行 |
| `claude-code-features.md` | settingSources、CLAUDE.md、Skills、Hooks |
| `sessions.md` | 会话管理（continue/resume/fork） |
| `permissions.md` | 权限模式、allow/deny 规则 |
| `hooks.md` | Hooks 事件、回调、匹配器 |
| `subagents.md` | 子代理定义、继承、调用 |
| `custom-tools.md` | 自定义工具（in-process MCP） |
| `mcp.md` | MCP Server 连接（stdio/HTTP/SSE） |
| `skills.md` | Skills 文件系统定义与使用 |
| `plugins.md` | Plugin 包结构与加载 |
| `streaming-output.md` | 输出流式（StreamEvent） |
| `streaming-vs-single-mode.md` | 输入模式对比 |
| `modifying-system-prompts.md` | 系统提示词定制 |
| `hosting.md` | 部署架构与模式 |
| `secure-deployment.md` | 安全加固 |
| `file-checkpointing.md` | 文件快照与回滚 |
| `cost-tracking.md` | 费用追踪 |
| `structured-outputs.md` | 结构化输出（JSON Schema） |
| `tool-search.md` | 工具按需加载 |
| `slash-commands.md` | 斜杠命令 |
| `user-input.md` | 用户审批与输入处理 |
| `todo-tracking.md` | Todo 列表 |
| `python.md` | Python SDK API 参考（101K） |
| `typescript.md` | TypeScript SDK API 参考（73K） |
| `typescript-v2-preview.md` | TS V2 预览（session-based API） |
| `claude-code-features.md` | Claude Code 文件系统特性 |
| `migration-guide.md` | 从 Claude Code SDK 迁移 |