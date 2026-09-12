# Claude Code 架构分析报告

> **版本**: 2.1.88 | **规模**: 1884 个 TS/TSX 文件, 512,664 行代码
> **运行时**: Bun + React 19 + 自定义 Ink fork | **分析日期**: 2026-04-02
> **来源**: 2026-03-31 npm source map 泄露事件，经 R2 存储桶直接获取

---

## 目录

1. [项目概览]#项目概览
2. [启动链路]#启动链路
3. [分层架构]#分层架构
4. [核心子系统]#核心子系统
5. [UI 架构]#ui-架构
6. [扩展体系]#扩展体系
7. [Feature Flags]#feature-flags
8. [设计模式总结]#设计模式总结
9. [附录：完整文件清单]#附录完整文件清单

---

## 项目概览

### 项目定位

Claude Code 是 Anthropic 官方的 CLI 工具，允许用户在终端中与 Claude 交互，完成代码编辑、命令执行、代码搜索和复杂工作流编排。它是目前最成熟的 Agentic CLI 系统之一。

### 技术栈

| 分类 | 技术 |
|------|------|
| 运行时 | [Bun](https://bun.sh) >= 1.1 |
| 语言 | TypeScript (strict) |
| 终端 UI | React 19 + 自定义 Ink fork |
| CLI 框架 | Commander.js 13 (extra-typings) |
| Schema 验证 | Zod v3 / Zod v4 |
| 代码搜索 | ripgrep |
| 协议 | MCP SDK, LSP, WebSocket |
| API | Anthropic SDK + Bedrock SDK + Vertex SDK + Foundry SDK |
| 遥测 | OpenTelemetry 2.x + GrowthBook + Datadog |
| 认证 | OAuth 2.0 + PKCE + JWT + macOS Keychain |
| 布局引擎 | 纯 TypeScript Yoga Layout 实现 |

### 目录结构

```
src/
├── entrypoints/       # 多入口：CLI / SDK / MCP Server / Headless
├── main.tsx           # 主 CLI 入口（Commander.js 参数解析）
├── QueryEngine.ts     # 核心 Agentic 循环引擎
├── Tool.ts            # 工具类型系统定义
├── tools.ts           # 工具注册表
├── commands.ts        # 命令注册表
├── context.ts         # 系统/用户上下文构建
├── setup.ts           # 运行环境初始化
├── query.ts           # LLM 查询编排
├── ink.ts             # Ink 渲染层公共 API
│
├── tools/             # 工具实现（43 个子目录）
├── commands/          # 命令实现（100+ 个）
├── services/          # 后端服务层（36 个子服务）
├── components/        # UI 组件（~146 文件）
├── screens/           # 全屏 UI（REPL / Doctor / Resume）
├── hooks/             # React Hooks（82 文件）
├── state/             # 全局状态管理
├── context/           # React Context Providers
├── plugins/           # 插件系统
├── skills/            # 技能系统（17 个内建技能）
├── coordinator/       # 多代理协调器
├── bridge/            # IDE / Claude.ai 桥接（31 文件）
├── schemas/           # Zod Schema 定义
├── migrations/        # 配置迁移（11 个）
├── memdir/            # 持久化记忆系统
├── types/             # 共享类型定义
├── utils/             # 工具函数库
├── ink/               # 自定义 Ink fork（48 文件）
├── keybindings/       # 快捷键系统（14 文件）
├── vim/               # Vim 模式（5 文件）
├── voice/             # 语音交互
├── remote/            # 远程会话管理
├── server/            # 本地 SDK 连接服务
├── bootstrap/         # 启动状态初始化
├── entrypoints/sdk/   # Agent SDK 公共 API 类型
└── entrypoints/       # 多入口点
```

---

## 启动链路

### 完整启动流程

```
Process Start
  │
  ├─ cli.tsx :: main()  ← 真正的进程入口（303 行）
  │   ├─ 零导入快速路径：
  │   │   ├─ --version / -v / -V            → 打印版本并退出（零导入）
  │   │   ├─ --dump-system-prompt           → 渲染系统提示并退出
  │   │   ├─ --claude-in-chrome-mcp         → Chrome MCP 服务器模式
  │   │   ├─ --chrome-native-host           → Chrome Native Messaging
  │   │   ├─ --computer-use-mcp             → 计算机使用 MCP
  │   │   ├─ --daemon-worker=<kind>         → 守护进程工作子进程
  │   │   ├─ remote-control / bridge / sync → 桥接模式
  │   │   ├─ daemon                         → 长驻守护进程
  │   │   ├─ ps / logs / attach / kill      → 会话管理
  │   │   ├─ new / list / reply             → 模板任务
  │   │   ├─ environment-runner              → 无头 BYOC 运行器
  │   │   ├─ self-hosted-runner             → 无头自托管运行器
  │   │   └─ --tmux --worktree              → Tmux worktree 执行
  │   │
  │   ├─ 顶层副作用（零函数调用开销）：
  │   │   ├─ COREPACK_ENABLE_AUTO_PIN = '0'
  │   │   └─ CCR 环境：--max-old-space-size=8192
  │   │
  │   └─ 兜底路径：
  │       ├─ startCapturingEarlyInput()
  │       ├─ Set --bare → CLAUDE_CODE_SIMPLE=1
  │       └─ 动态 import('main.tsx') → cliMain()
  │
  ├─ main.tsx 模块求值  ← 重模块，~200 行 import
  │   ├─ profileCheckpoint('main_tsx_entry')
  │   ├─ startMdmRawRead()          ← 并行：MDM 子进程（plutil/reg query）
  │   └─ startKeychainPrefetch()    ← 并行：macOS Keychain 读取
  │
  ├─ main.tsx :: main()（4684 行）
  │   │
  │   ├─ 1. Windows 安全：NoDefaultCurrentDirectoryInExePath=1
  │   ├─ 2. initializeWarningHandler()
  │   ├─ 3. SIGINT / exit 处理器注册
  │   ├─ 4. 深度链接处理（cc:// URL scheme、macOS URL scheme）
  │   ├─ 5. argv 重写（assistant [sessionId]、ssh <host>）
  │   │
  │   ├─ 6. Commander.js CLI 参数解析
  │   │     模型 / 权限模式 / worktree / tmux / print / resume /
  │   │     continue / system-prompt / append-system-prompt /
  │   │     output-format / json-schema / max-turns / max-budget-usd /
  │   │     thinking / debug / bare / init / maintenance ...
  │   │
  │   ├─ 7. init()  ← entrypoints/init.ts（memoize，仅执行一次，340 行）
  │   │   ├─ enableConfigs()
  │   │   ├─ applySafeConfigEnvironmentVariables()
  │   │   ├─ applyExtraCACertsFromConfig()
  │   │   ├─ setupGracefulShutdown()
  │   │   ├─ [async 并行]
  │   │   │   ├─ initialize1PEventLogging()     ← 首方分析
  │   │   │   ├─ populateOAuthAccountInfoIfNeeded()  ← OAuth 缓存
  │   │   │   ├─ initJetBrainsDetection()       ← IDE 检测
  │   │   │   └─ detectCurrentRepository()      ← Git 仓库检测
  │   │   ├─ initializeRemoteManagedSettingsLoadingPromise()
  │   │   ├─ initializePolicyLimitsLoadingPromise()
  │   │   ├─ recordFirstStartTime()
  │   │   ├─ configureGlobalMTLS()
  │   │   ├─ configureGlobalAgents()
  │   │   ├─ preconnectAnthropicApi()  ← 预热 TCP + TLS 连接
  │   │   ├─ [async] Upstream proxy 初始化（CCR 环境）
  │   │   ├─ setShellIfWindows()
  │   │   ├─ 注册 LSP Manager 清理
  │   │   ├─ 注册 Session Team 清理
  │   │   └─ ensureScratchpadDir()（如果启用）
  │   │
  │   ├─ 8. setup(cwd, permissionMode, ...)  ← setup.ts（477 行）
  │   │   ├─ Node.js 版本检查（>= 18）
  │   │   ├─ switchSession()（如果自定义 session ID）
  │   │   ├─ startUdsMessaging()（非 bare 模式）
  │   │   ├─ captureTeammateModeSnapshot()（swarms 模式）
  │   │   ├─ 终端备份恢复（iTerm2 / Terminal.app，交互模式）
  │   │   ├─ setCwd(cwd)  ★ 必须在所有依赖 cwd 的操作之前
  │   │   ├─ captureHooksConfigSnapshot()
  │   │   ├─ initializeFileChangedWatcher()
  │   │   ├─ Worktree 创建（如果 --worktree）
  │   │   ├─ [async 并行]
  │   │   │   ├─ initSessionMemory()
  │   │   │   ├─ getCommands(getProjectRoot())  ← 预取
  │   │   │   ├─ loadPluginHooks() + 热重载设置
  │   │   │   ├─ initSinks()（错误日志 + 分析）
  │   │   │   ├─ 归因 hooks / 会话文件访问 hooks / 团队记忆 watcher
  │   │   │   └─ prefetchApiKeyFromApiKeyHelperIfSafe()
  │   │   ├─ logEvent('tengu_started', {})
  │   │   ├─ 检查 release notes（非 bare）
  │   │   └─ 安全检查（--dangerously-skip-permissions: root/sudo/Docker）
  │   │
  │   ├─ 9. 信任对话框（如果需要）
  │   │   └─ initializeTelemetryAfterTrust()
  │   │       ├─ 等待远程管理设置（如果适用）
  │   │       ├─ applyExtraConfigEnvironmentVariables()
  │   │       └─ doInitializeTelemetry()  ← 懒加载 ~400KB OTel 模块
  │   │
  │   ├─ 10. 交互模式 → launchRepl()  → REPL.tsx（Ink TUI）
  │   └─ 11. 无头模式 → QueryEngine  → query() Agentic Loop
  │
  └─ REPL / QueryEngine
      ├─ getTools(permissionContext)     → 内建工具列表
      ├─ assembleToolPool(ctx, mcpTools) → 内建 + MCP 工具合并
      ├─ fetchSystemPromptParts()       → 系统 + 用户上下文
      └─ Agentic Loop：API 调用 → 工具执行 → API 调用 ...
```

### 启动性能优化

| 优化策略 | 实现细节 |
|----------|----------|
| **并行预取** | MDM 读取、Keychain 读取、API 预连接在模块求值期间并行执行，覆盖 ~135ms 求值时间 |
| **快速路径分流** | `--version` 等简单命令零导入直接返回，不加载任何子系统 |
| **动态导入** | `main.tsx` 通过 `await import()` 延迟加载，避免快速路径的模块开销 |
| **懒加载重模块** | OpenTelemetry（~400KB）、gRPC、analytics、feature-gated 子系统通过 `import()` 延迟 |
| **Memoize** | `init()` 通过 `lodash-es/memoize` 保证全局只执行一次 |
| **预连接** | `preconnectAnthropicApi()` 在 REPL 启动前完成 TCP + TLS 握手 |

---

## 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│                        Entrypoints                         │
│    cli.tsx → main.tsx → init.ts / mcp.ts / agentSdkTypes   │
├─────────────────────────────────────────────────────────────┤
│                      Screens (UI)                          │
│          REPL.tsx (5006行) / Doctor.tsx / Resume.tsx       │
├─────────────────────────────────────────────────────────────┤
│                   Components (UI)                          │
│   Message / Spinner / Diff / Permission / Dialog / Input   │
│           146 文件 · 基于 Ink (React 19) 自定义 fork        │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │   Query      │  │   Tools      │  │   Commands      │   │
│  │   Engine     │  │   System     │  │   System        │   │
│  │  (Agentic    │  │  (43 工具    │  │  (100+ 命令     │   │
│  │   Loop)      │  │   接口驱动)  │  │   7 层来源)    │   │
│  └──────────────┘  └──────────────┘  └─────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│                      Services                              │
│  api · mcp · oauth · lsp · compact · analytics · plugins   │
│           SessionMemory · extractMemories · voice           │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │   State      │  │   Plugins    │  │   Skills        │   │
│  │  (全局状态    │  │   系统       │  │   系统          │   │
│  │  ~150 字段)  │  │  (marketplace│  │  (inline/fork   │   │
│  │             │  │   + 内建)    │  │   17 内建)       │   │
│  └──────────────┘  └──────────────┘  └─────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│   Hooks · Context · Keybindings · Vim · Voice · Migrations  │
├─────────────────────────────────────────────────────────────┤
│             Ink Fork (React Reconciler)                     │
│  自定义渲染器 · Yoga 布局引擎 · ANSI 处理 · 事件分发 · BiDi  │
└─────────────────────────────────────────────────────────────┘
```

---

## 核心子系统

### Query Engine — Agentic 循环

**核心文件**: `QueryEngine.ts`（1295 行）+ `query.ts`

QueryEngine 是 Claude Code 的心脏，管理一次会话的完整生命周期。单实例模式，`submitMessage()` 启动新的交互轮次。

```typescript
type QueryEngineConfig = {
  cwd: string
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  agents: AgentDefinition[]
  canUseTool: CanUseToolFn
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  initialMessages?: Message[]
  readFileCache: FileStateCache
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  jsonSchema?: Record<string, unknown>
  verbose?: boolean
}
```

**执行流程**:

```
submitMessage(prompt, options)
  → async generator yielding SDKMessage
    ├─ 包装 canUseTool 以跟踪权限拒绝
    ├─ 解析模型和 thinking 配置
    ├─ fetchSystemPromptParts()    // 构建系统提示
    └─ 进入 agentic loop (query())
        ├─ queryModel()            // 调用 Anthropic API（流式）
        │   ├─ 构建 tool schemas（含 defer_loading for MCP）
        │   ├─ Prompt caching（ephemeral + 1h TTL）
        │   ├─ Thinking/extended thinking 配置
        │   ├─ Effort / fast mode / advisor model
        │   ├─ Beta headers（AFK / cache editing / context mgmt ...）
        │   └─ 反蒸馏假工具注入
        ├─ 解析 tool_use blocks
        ├─ toolExecution.ts         // 权限检查 + 工具执行
        ├─ autoCompactIfNeeded()    // 上下文压力管理
        └─ 循环直到 stop_reason = end_turn
```

**API 客户端** (`services/api/`) 支持 4 个 Provider：

| Provider | SDK | 环境变量 |
|----------|-----|----------|
| Anthropic Direct | `@anthropic-ai/sdk` | 默认 |
| AWS Bedrock | `@anthropic-ai/bedrock-sdk` | `CLAUDE_CODE_USE_BEDROCK` |
| Google Vertex AI | `@anthropic-ai/vertex-sdk` | `CLAUDE_CODE_USE_VERTEX` |
| Azure Foundry | `@anthropic-ai/foundry-sdk` | `CLAUDE_CODE_USE_FOUNDRY` |

**重试机制** (`services/api/withRetry.ts`):

- 指数退避 + 抖动（base 500ms, max 32s）
- 529 过载：最多 3 次重试后触发模型降级
- 429 限流：企业用户重试，普通用户不重试
- 401/403：自动刷新 Auth Token
- 持久（无人值守）模式：心跳 keep-alive yields

### Tool System — 工具系统

**核心文件**: `Tool.ts`（792 行）+ `tools.ts`（389 行）+ `src/tools/`（43 子目录）

#### 接口设计

工具采用**纯结构化接口**，无类继承：

```typescript
type Tool<Input, Output, Progress> = {
  // 核心成员
  name: string
  aliases?: string[]
  inputSchema: Input           // Zod schema
  inputJSONSchema?: ToolInputJSONSchema  // MCP 直接 JSON Schema
  outputSchema?: z.ZodType<unknown>
  call(args, context, canUseTool, parentMessage, onProgress?): Promise<ToolResult<Output>>
  description(input, options): Promise<string>

  // 发现机制
  searchHint?: string
  shouldDefer?: boolean        // 延迟加载（需 ToolSearch 发现）
  alwaysLoad?: boolean

  // 生命周期
  isEnabled(): boolean
  isConcurrencySafe(input): boolean
  isReadOnly(input): boolean
  isDestructive?(input): boolean
  interruptBehavior?(): 'cancel' | 'block'

  // 权限
  checkPermissions(input, ctx): PermissionResult
  validateInput?(input): ValidationResult
  requiresUserInteraction?(): boolean

  // 渲染（12 个方法）
  renderToolUseMessage(...)
  renderToolResultMessage?(...)
  renderToolUseProgressMessage?(...)
  // ...更多渲染方法

  // MCP
  isMcp?: boolean
  mcpInfo?: MCPToolInfo
}
```

`buildTool(def)` 工厂函数为 7 个常用方法填充安全默认值：

| 方法 | 默认值 |
|------|--------|
| `isEnabled()` | `true` |
| `isConcurrencySafe()` | `false`（保守假设不安全） |
| `isReadOnly()` | `false`（保守假设会写入） |
| `isDestructive()` | `false` |
| `checkPermissions()` | `{ behavior: 'allow' }` |
| `toAutoClassifierInput()` | `''`（跳过分类器） |
| `userFacingName()` | `name` |

#### 完整工具清单

| # | 工具名 | 分类 | 描述 |
|---|--------|------|------|
| 1 | Agent | 核心执行 | 生成子代理（fork/background/remote），支持并行任务执行 |
| 2 | AskUserQuestion | 交互 | 向用户呈现多选问题（可选预览） |
| 3 | Bash | 核心执行 | Shell 命令执行，沙箱化，sed-edit 解析，语义分类 |
| 4 | Brief | 交互 | 发送主动/普通消息（可选文件附件） |
| 5 | Config | 配置 | 获取/设置 Claude Code 配置（ant-only） |
| 6 | EnterPlanMode | 规划 | 切换到规划模式 |
| 7 | EnterWorktree | 工作隔离 | 创建 git worktree 进行隔离开发 |
| 8 | ExitPlanMode | 规划 | 退出规划模式，进入实现阶段 |
| 9 | ExitWorktree | 工作隔离 | 退出 worktree |
| 10 | Edit | 文件操作 | 精确字符串替换编辑，生成 diff |
| 11 | Read | 文件操作 | 读取文件/目录，支持 offset/limit、图片/PDF/notebook |
| 12 | Write | 文件操作 | 创建或覆写文件 |
| 13 | Glob | 搜索 | 快速文件模式匹配（替代 find） |
| 14 | Grep | 搜索 | ripgrep 正则内容搜索 |
| 15 | ListMcpResources | MCP | 列出 MCP 服务器可用资源 |
| 16 | LSP | 开发 | LSP 集成（hover/definition/references/symbols） |
| 17 | MCPTool | MCP | MCP 服务器工具通用代理 |
| 18 | McpAuth | MCP | 未认证 MCP 服务器的 OAuth 触发伪工具 |
| 19 | NotebookEdit | 文件操作 | Jupyter notebook 单元格编辑 |
| 20 | PowerShell | 核心执行 | Windows PowerShell（BashTool 同架构） |
| 21 | ReadMcpResource | MCP | 读取 MCP 服务器特定资源 URI |
| 22 | RemoteTrigger | 云端 | CRUD 和执行远程云端触发器 |
| 23 | REPL | 内部 | 透明包装器，委托给内部工具（ant-only） |
| 24 | CronCreate | 定时 | 创建定时/一次性 cron 任务 |
| 25 | CronList | 定时 | 列出所有 cron 任务 |
| 26 | CronDelete | 定时 | 删除 cron 任务 |
| 27 | SendMessage | 团队 | 代理间消息传递（邮箱/协调） |
| 28 | Skill | 技能 | 加载并执行技能定义 |
| 29 | Sleep | 内部 | 暂停执行（Kairos/proactive feature-gated） |
| 30 | StructuredOutput | 输出 | 返回验证后的结构化 JSON（SDK/非交互） |
| 31 | TaskCreate | 任务 | 创建任务（TodoV2） |
| 32 | TaskGet | 任务 | 获取单个任务详情 |
| 33 | TaskList | 任务 | 列出所有任务 |
| 34 | TaskOutput | 任务 | 获取后台任务输出（可选阻塞等待） |
| 35 | TaskStop | 任务 | 停止运行中的后台任务 |
| 36 | TaskUpdate | 任务 | 更新任务状态/主题/描述/阻塞关系 |
| 37 | TeamCreate | 团队 | 创建多代理团队（leader + worker） |
| 38 | TeamDelete | 团队 | 解散团队 |
| 39 | TodoWrite | 任务 | 会话级任务清单（旧版） |
| 40 | ToolSearch | MCP | 关键词搜索延迟加载的工具 |
| 41 | WebFetch | Web | 获取 URL 内容并提取/总结 |
| 42 | WebSearch | Web | 通过 Anthropic 内置搜索 API 进行网络搜索 |

**Feature-gated 工具**（不在 `src/tools/` 目录，通过条件编译引入）：

Monitor, WebBrowser, Workflow, SendUserFile, PushNotification, SubscribePR, Tungsten, SuggestBackgroundPR, OverflowTest, CtxInspect, TerminalCapture, Snip, ListPeers, VerifyPlanExecution, TestingPermission 等 15+ 个。

#### 工具注册与发现

**无自动发现**，工具通过静态导入手动组装：

```
getAllBaseTools()
  → 返回 ~30 个内建工具的扁平数组
  → 条件展开：feature flags、环境变量、isEnabled()
  → 部分懒加载以打破循环依赖（TeamCreate, TeamDelete, SendMessage）

getTools(permissionContext)
  → getAllBaseTools()
  → 过滤特殊工具（ListMcpResources, ReadMcpResource, SyntheticOutput）
  → filterToolsByDenyRules()（移除全局拒绝的工具）
  → REPL 模式：隐藏 REPL_ONLY_TOOLS
  → isEnabled() 过滤

assembleToolPool(permissionContext, mcpTools)  ← 唯一真相源
  → getTools(permissionContext)（内建工具）
  → filterToolsByDenyRules(mcpTools)（MCP 工具）
  → 各分区按名称排序（prompt cache 稳定性）
  → uniqBy('name')（内建工具优先于同名 MCP 工具）
  → 返回合并、去重后的数组
```

**工具过滤常量**（`constants/tools.ts`）：

| 常量 | 作用 |
|------|------|
| `ALL_AGENT_DISALLOWED_TOOLS` | 所有子代理禁止的工具 |
| `ASYNC_AGENT_ALLOWED_TOOLS` | 异步后台代理允许的工具 |
| `COORDINATOR_MODE_ALLOWED_TOOLS` | 仅 Agent, TaskStop, SendMessage, SyntheticOutput |
| `IN_PROCESS_TEAMMATE_ALLOWED_TOOLS` | 加上 Task CRUD, SendMessage, Cron |

**延迟加载机制**：工具标记 `shouldDefer: true` 后，API payload 中发送 `defer_loading: true`。模型必须先调用 `ToolSearchTool` 查询并加载延迟工具才能使用。

#### 权限系统

```
hasPermissionsToUseTool()
  ├─ 'allow' → 直接执行（可能修改输入）
  ├─ 'deny'  → 阻止并返回消息
  └─ 'ask'   → resolveAsk()
      │
      ├─ swarmWorker handler（swarm 工作者）
      │   ├─ 尝试 bash 分类器自动审批
      │   ├─ 转发给 leader 通过邮箱审批
      │   └─ 显示 pendingWorkerRequest 指示器
      │
      ├─ coordinator handler（协调器工作者）
      │   ├─ 尝试 permission hooks（快速，本地）
      │   ├─ 尝试 bash 分类器（慢速，推理）
      │   └─ 兜底：交互式对话框
      │
      └─ interactive handler（主代理，REPL）
          ├─ 推送 ToolUseConfirm 到 UI 队列
          └─ 4 路竞速（createResolveOnce() 原子决策）：
              ├─ 用户交互（终端 UI）
              ├─ Bridge（claude.ai CCR 远程审批）
              ├─ 通道中继（Telegram/iMessage via MCP）
              └─ Permission hooks（异步）
```

**权限决策日志**：所有决策记录到 Statsig 分析事件 + OTel 遥测 + 代码编辑 OTel 计数器。

### Command System — 命令系统

**核心文件**: `commands.ts`（754 行）+ `src/commands/`（100+ 命令）

#### 命令类型

```typescript
type Command =
  | PromptCommand    // 发送内容给 LLM 作为 prompt
  | LocalCommand     // 在 CLI 进程中本地执行（懒加载模块）
```

#### 命令来源（7 层，按优先级合并）

1. **Bundled Skills** — 编译内联的技能命令
2. **Built-in Plugin Skills** — 内建插件提供的技能
3. **Skill 目录** — `.claude/skills/` 磁盘加载
4. **Workflow 命令** — `.claude/workflows/`（feature-gated）
5. **Plugin 命令** — Marketplace 插件提供
6. **Plugin Skills** — 插件技能
7. **Built-in 命令** — `COMMANDS()` 数组（~80 个）

#### 完整命令清单

| 分类 | 命令 |
|------|------|
| **会话管理** | `resume`, `session`, `compact`, `clear`, `rewind`, `export`, `summary`, `rename`, `tag`, `share`, `copy` |
| **Git & 代码审查** | `commit`, `commit-push-pr`, `review`, `ultrareview`, `security-review`, `autofix-pr`, `pr_comments`, `branch`, `diff` |
| **模型 & Effort** | `model`, `effort`, `plan`, `fast`, `ultraplan` |
| **配置** | `config`, `settings`, `keybindings`, `theme`, `color`, `output-style`, `permissions`, `hooks`, `vim`, `env`, `rate-limit-options`, `privacy-settings` |
| **记忆 & 上下文** | `memory`, `context`, `files`, `add-dir`, `thinkback`, `thinkback-play`, `ctx_viz` |
| **IDE 集成** | `ide`, `desktop`, `mobile`, `chrome` |
| **MCP & 插件** | `mcp`, `plugin`, `reload-plugins`, `skills` |
| **远程 & 桥接** | `bridge`, `remote-env`, `remote-setup`, `teleport` |
| **认证 & 账户** | `login`, `logout`, `install-github-app`, `install-slack-app`, `upgrade`, `passes` |
| **代理/团队** | `agents`, `tasks`, `btw`, `issue`, `bughunter`, `advisor`, `peers`, `fork`, `buddy` |
| **诊断 & 调试** | `doctor`, `heapdump`, `debug-tool-call`, `ant-trace`, `perf-issue`, `break-cache`, `mock-limits`, `terminalSetup`, `statusline` |
| **信息** | `help`, `stats`, `cost`, `usage`, `insights`, `release-notes`, `version` |
| **语音** | `voice`（feature-gated: `VOICE_MODE`） |
| **Feature-gated** | `proactive`, `brief`, `assistant`, `torch`, `subscribe-pr`, `force-snip`, `workflows`, `onboarding`, `sandbox-toggle` |

### Services 层

**36 个子服务**，按职责分类：

#### API 客户端 (`services/api/`)

| 文件 | 职责 |
|------|------|
| `client.ts` | 创建 Anthropic SDK 客户端，4 provider 路由，自定义 headers |
| `claude.ts` | `queryModel()` / `queryModelWithStreaming()` — 主查询函数（~1500 行） |
| `withRetry.ts` | 异步生成器重试循环（指数退避 + 过载检测 + 模型降级） |
| `errors.ts` | 错误分类与用户消息映射（1207 行） |
| `bootstrap.ts` | API 启动初始化 |
| `logging.ts` | API 请求/响应日志 |
| `usage.ts` | Token 使用量提取与成本追踪 |
| `grove.ts` | 后端分析 API 客户端 |
| `promptCacheBreakDetection.ts` | Prompt cache 断裂检测 |

#### MCP 集成 (`services/mcp/`)

| 文件 | 职责 |
|------|------|
| `client.ts` | 连接 MCP 服务器，6 种传输类型 |
| `types.ts` | Zod 校验配置 Schema |
| `config.ts` | 多源配置加载（enterprise > user > project > local > plugin > claude.ai） |
| `MCPConnectionManager.tsx` | React Context 连接管理 |
| `auth.ts` | MCP OAuth + PKCE 认证 |
| `InProcessTransport.ts` | 进程内 MCP 服务器传输 |
| `SdkControlTransport.ts` | SDK 托管 MCP 服务器桥接传输 |

**6 种传输类型**:

| 传输 | 协议 | 用途 |
|------|------|------|
| `stdio` | stdin/stdout | 本地子进程 |
| `sse` | Server-Sent Events | 远程服务器 |
| `http` | Streamable HTTP | 新 HTTP 规范 |
| `ws` | WebSocket | 实时连接 |
| `claudeai-proxy` | HTTPS + OAuth | Claude.ai 代理 |
| `sdk` / `in-process` | 内存 | SDK 托管 / 进程内 |

#### OAuth 认证 (`services/oauth/`)

完整 OAuth 2.0 + PKCE 流程：
- `OAuthService` 编排：本地 HTTP 回调服务器 → PKCE → 浏览器/手动 → Token 交换 → Profile 获取
- Token 刷新支持 scope 扩展
- Profile 缓存（~700 万请求/天节省）

#### LSP 集成 (`services/lsp/`)

- `LSPClient` — 基于 `vscode-jsonrpc` 的客户端，支持延迟初始化
- `LSPServerManager` — 多服务器管理，按文件扩展名路由
- `LSPDiagnosticRegistry` — 多服务器诊断收集
- `--bare` 模式下跳过 LSP

#### Context 压缩 (`services/compact/`)

**四级压缩策略**：

| 级别 | 触发 | 方式 | 成本 |
|------|------|------|------|
| **micro-compact** | 持续 | 替换旧工具结果为截断版本 | 零 API 调用 |
| **session memory** | 接近阈值 | 用提取的记忆裁剪消息 | 零 API 调用 |
| **partial-compact** | 方向性压缩 | LLM 总结一侧，保留另一侧 | 1 次 API 调用 |
| **full compact** | 阈值触发 | 完整 LLM 总结 + 附件生成 | 1 次 API 调用 |

- **阈值**: 有效上下文窗口 - 13K tokens
- **熔断器**: 连续 3 次失败后停止
- **附件**: compact 后生成 file state、plan state、skill state、deferred tools delta、MCP instructions delta

#### 其他服务

| 服务 | 职责 |
|------|------|
| `analytics/` | GrowthBook feature flags + Datadog + OTel 遥测 + 事件日志 |
| `tools/` | `toolExecution.ts`（1745 行）— 工具执行引擎 + 权限 + 假设性 bash 分类器 |
| `SessionMemory/` | 从对话提取结构化记忆，用于轻量压缩 |
| `AgentSummary/` | 代理任务完成摘要生成 |
| `extractMemories/` | 从对话自动提取记忆 |
| `voice.ts` | Push-to-talk 语音输入（CoreAudio/ALSA + STT 流式） |
| `vcr.ts` | VCR 测试夹具（录制 API → JSON → 回放） |
| `settingsSync/` | 跨设备设置同步 |
| `teamMemorySync/` | 团队级记忆同步 |
| `remoteManagedSettings/` | IT 管理员远程设置（企业） |
| `policyLimits/` | 限流策略处理 |
| `PromptSuggestion/` | Prompt 建议生成 |
| `tips/` | 提示系统 |
| `notifier.ts` | 通知分发 |
| `preventSleep.ts` | 系统休眠阻止 |
| `tokenEstimation.ts` | Token 计数估算 |

---

## UI 架构

### 渲染管线

```
src/ink.ts → ThemeProvider → src/ink/root.ts → Ink Root
                                              → React Reconciler（自定义 fork）
                                              → Terminal Renderer
                                              → Yoga Layout Engine
                                              → ANSI 输出
```

`src/ink/` 是深度修改的 Ink fork（48 文件），包含：
- 自定义 React Reconciler
- 终端渲染器（screen.ts）
- Yoga-based 布局引擎
- ANSI 处理（Ansi.tsx）
- 文本测量
- 事件分发（键盘/点击/焦点）
- BiDi 双向文本支持

### 组件树

```
<App>
  → FpsMetricsProvider
    → StatsProvider
      → AppStateProvider          ← 自定义 Store + useSyncExternalStore
        → MailboxProvider
          → VoiceProvider（条件）
            → <REPL>              ← 5006 行单体组件
```

### 组件分类（~146 文件）

| 分类 | 核心文件 | 规模 |
|------|----------|------|
| **消息渲染** | Message (79KB), Messages (147KB), VirtualMessageList (148KB), MessageSelector (115KB) | ~34 文件 |
| **输入** | PromptInput/ (21 文件), TextInput, VimTextInput, SearchBox | ~25 文件 |
| **Diff/代码** | StructuredDiff, FileEditToolDiff, HighlightedCode, Markdown, MarkdownTable | ~8 文件 |
| **权限** | permissions/ — PermissionRequest, WorkerPendingPermission 等 | ~30 文件 |
| **对话框** | BridgeDialog (34KB), GlobalSearch, MCPServer, ModelPicker, ThemePicker | ~15 文件 |
| **状态/Spinner** | StatusLine (49KB), Spinner (87KB), Stats (152KB), AgentProgressLine | ~20 文件 |
| **设置** | Settings/ (6 文件), OutputStylePicker, EffortCallout, ThinkingToggle | ~10 文件 |
| **MCP** | mcp/ — ElicitationDialog, server configs, resource browsing | ~13 文件 |
| **任务/代理** | TaskListV2, tasks/ (12 文件), teams/, agents/ (14 文件) | ~30 文件 |
| **设计系统** | ThemeProvider, ThemedBox/Text, Dialog, FuzzyPicker, ListItem, Tabs, ProgressBar | ~16 文件 |

### Screen 层

| Screen | 规模 | 职责 |
|--------|------|------|
| `REPL.tsx` | 5006 行（~895KB） | 主交互屏幕，单体组件处理所有 REPL 逻辑 |
| `Doctor.tsx` | ~73KB | 诊断/排错屏幕 |
| `ResumeConversation.tsx` | ~59KB | 会话恢复选择器 |

### State 管理

**自定义轻量 Store**，非 Redux/Zustand：

```typescript
type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: () => void) => () => void
}
```

**AppStateStore**（569 行）— 单体状态对象 ~150 个字段：

| 状态域 | 关键字段 |
|--------|----------|
| **设置 & 模型** | model, effort, permissionMode, thinkingConfig |
| **任务** | `tasks: { [taskId: string]: TaskState }`, agentNameRegistry |
| **MCP** | clients, tools, commands, resources |
| **插件** | enabled[], disabled[], errors[], installationStatus |
| **通知** | notificationQueue, elicitationQueue |
| **远程** | bridgeConnection, webSocketStatus |
| **团队** | teammate/companion state, swarm mode |

React 集成：`useSyncExternalStore`（React 18 外部 Store 模式），`onChangeAppState` 回调处理副作用。

### Keybindings 系统

`src/keybindings/`（14 文件）：
- Zod schema 校验 `keybindings.json`
- 18 个上下文：Global, Chat, Autocomplete, Confirmation, Vim Normal, Vim Insert ...
- 用户自定义 + 保留快捷键 + 冲突验证

### Vim 模式

`src/vim/`（5 文件）：
- 完整 Vim 状态机：INSERT / NORMAL 模式
- 操作符（d/c/y）、动作（f/F/t/T）、文本对象
- 计数前缀支持

---

## 扩展体系

### Plugin 系统

```
builtinPlugins.ts → 内建插件注册（ID: {name}@builtin）
                    ↓ 用户可通过 /plugin UI 启用/禁用
PluginInstallationManager → 后台安装、依赖解析、marketplace diff
                    ↓
Plugin 提供：
  ├─ Skills    ← 技能命令
  ├─ Hooks     ← 生命周期钩子
  └─ MCP Servers ← 额外工具/资源
```

### Skill 系统

```
bundledSkills.ts → 17 个内建技能
  batch / claudeApi / claudeApiContent / claudeInChrome /
  debug / index / keybindings / loop / loremIpsum /
  remember / scheduleRemoteAgents / simplify / skillify /
  stuck / updateConfig / verify / verifyContent
                    ↓
loadSkillsDir.ts → .claude/skills/ 目录扫描
  作用域：project / user / team
                    ↓
mcpSkillBuilders → 从 MCP 工具元数据生成技能
                    ↓
SkillTool 执行：
  ├─ inline → 展开到当前对话上下文
  └─ fork   → 子代理独立上下文执行
```

### Hook 系统

**28 个生命周期事件**，Zod 校验：

| 事件类型 | 示例 |
|----------|------|
| **工具** | PreToolUse, PostToolUse |
| **会话** | SessionStart, PreCompact, PostCompact |
| **通知** | Notification |
| **权限** | PermissionRequest |
| **子代理** | SubAgentStart, SubAgentStop |
| **代理** | AgentStarted, AgentCompleted |
| **设置** | SettingsChanged |
| **文件** | FileRead, FileWrite, FileEdit |

**3 种执行方式**：

| 方式 | 说明 |
|------|------|
| `shell` | Shell 命令执行 |
| `prompt` | LLM 评估（返回 JSON） |
| `async` | 异步 shell（后台执行） |

**配置选项**：`if` 条件（权限规则语法）、`shell`、`timeout`、`async`、`asyncRewake`、`once`

---

## Feature Flags

通过 Bun 的 `bun:bundle` feature flags 在构建时进行死代码消除：

```typescript
import { feature } from 'bun:bundle'
const voiceCommand = feature('VOICE_MODE')
  ? require('./commands/voice/index.js').default
  : null
```

| Flag | 功能 | 状态 |
|------|------|------|
| `PROACTIVE` | 主动模式（自动触发） | 实验性 |
| `KAIROS` | AI 伴侣 / 主动助手 | 实验性 |
| `BRIDGE_MODE` | IDE / Claude.ai 桥接 | 已发布 |
| `DAEMON` | 长驻守护进程 | 实验性 |
| `VOICE_MODE` | 语音交互 | 实验性 |
| `AGENT_TRIGGERS` | 自动触发代理 | 实验性 |
| `MONITOR_TOOL` | 监控工具 | 内部 |
| `COORDINATOR_MODE` | 多代理协调 | 实验性 |
| `WORKFLOW_SCRIPTS` | 工作流脚本 | 实验性 |
| `CHICAGO_MCP` | 内部 MCP | 内部 |
| `ABLATION_BASELINE` | 消融基线 | 测试 |
| `DUMP_SYSTEM_PROMPT` | 系统提示导出 | 调试 |
| `WEB_BROWSER_TOOL` | 内置浏览器 | 实验性 |
| `TERMINAL_PANEL` | 终端面板 | 实验性 |
| `HISTORY_SNIP` | 历史裁剪 | 实验性 |
| `UDS_INBOX` | Unix Domain Socket 邮箱 | 实验性 |

未启用的功能在构建时被完全剥离，不增加产物体积。

---

## 设计模式总结

| 模式 | 实现方式 | 目的 |
|------|----------|------|
| **并行预取** | 启动时 MDM/Keychain/API 并行执行 | 覆盖模块求值时间 |
| **懒加载** | 重模块 deferred import() | 减少启动延迟 |
| **快速路径** | `cli.tsx` 零导入分流 | 简单命令即时返回 |
| **静态注册** | 工具/命令手动导入组装 | 可预测、可审计 |
| **结构化接口** | Tool/Command 用 type 而非 class | 灵活组合、类型安全 |
| **工厂默认值** | `buildTool()` 填充 7 个安全默认 | 减少模板代码 |
| **竞速决策** | 权限 4 路竞速 + `createResolveOnce()` | 原子决策、无竞态 |
| **Prompt Cache 友好** | 工具按名称排序 | 稳定 breakpoint |
| **分级压缩** | micro → memory → partial → full | 渐进式上下文管理 |
| **Feature Gate 剥离** | `bun:bundle` 编译时移除 | 零运行时开销 |
| **Memoize** | `init()` 全局单次执行 | 避免重复初始化 |
| **VCR 测试** | 录制 API → JSON → 回放 | 确定性测试 |
| **单体组件** | REPL.tsx 5006 行 | 减少跨组件状态传递复杂度 |
| **自定义 Store** | 轻量泛型 Store | 无外部依赖、useSyncExternalStore |

---

## 附录：完整文件清单

### src/ 顶层文件

```
main.tsx              # 主 CLI 入口（Commander.js 参数解析，4684 行）
QueryEngine.ts        # 核心 Agentic 循环引擎（1295 行）
Tool.ts               # 工具类型系统定义（792 行）
tools.ts              # 工具注册表（389 行）
commands.ts           # 命令注册表（754 行）
context.ts            # 系统/用户上下文构建
setup.ts              # 运行环境初始化（477 行）
query.ts              # LLM 查询编排
ink.ts                # Ink 渲染层公共 API
history.ts            # 会话历史管理
cost-tracker.ts       # Token 成本追踪
costHook.ts           # 成本 Hook
Task.ts               # 任务类型定义
tasks.ts              # 任务工具函数
dialogLaunchers.tsx   # 对话框启动器
interactiveHelpers.tsx # 交互辅助
replLauncher.tsx      # REPL 启动器
projectOnboardingState.ts # 项目引导状态
tsconfig.json         # TypeScript 配置
globals.d.ts          # 全局类型声明
```

### 关键子系统文件统计

| 子系统 | 文件数 | 核心文件 |
|--------|--------|----------|
| `src/entrypoints/` | ~15 | cli.tsx, init.ts, mcp.ts, agentSdkTypes.ts |
| `src/entrypoints/sdk/` | ~8 | coreSchemas.ts (1710行), controlSchemas.ts (663行) |
| `src/tools/` | ~50 (43子目录) | AgentTool, BashTool, FileEditTool, FileReadTool |
| `src/commands/` | ~80 | commit, review, compact, config, mcp |
| `src/services/` | ~60 | api/, mcp/, compact/, tools/ |
| `src/components/` | ~146 | Message, Spinner, StatusLine, permissions/ |
| `src/screens/` | ~3 | REPL.tsx (5006行), Doctor.tsx, Resume.tsx |
| `src/hooks/` | ~82 | toolPermission/, notifs/, useTypeahead |
| `src/state/` | ~8 | AppStateStore.ts (569行), store.ts, selectors.ts |
| `src/ink/` | ~48 | ink.tsx (252KB), reconciler.ts, renderer.ts |
| `src/bridge/` | ~31 | bridgeMain.ts, bridgeMessaging.ts, sessionRunner.ts |
| `src/plugins/` | ~5 | builtinPlugins.ts, loadPluginsDir.ts |
| `src/skills/` | ~25 | bundledSkills.ts, loadSkillsDir.ts, bundled/ |
| `src/keybindings/` | ~14 | keybindings.ts, parser.ts, matcher.ts |
| `src/vim/` | ~5 | vimMode.ts |
| `src/memdir/` | ~8 | memory.ts, findRelevantMemories.ts |
| `src/migrations/` | ~11 | 各种配置迁移 |
| `src/utils/` | ~80 | auth, config, git, settings, permissions, swarm |
| `src/types/` | ~15 | messages, commands, plugins, IDs |
| `src/bootstrap/` | ~3 | state.ts (1577行) |

### 代码规模分布（估算）

| 模块 | 估算行数 | 占比 |
|------|----------|------|
| REPL.tsx | ~5,000 | ~1% |
| QueryEngine.ts + query.ts | ~2,500 | ~0.5% |
| services/api/ | ~5,000 | ~1% |
| services/mcp/ | ~4,000 | ~0.8% |
| services/compact/ | ~3,000 | ~0.6% |
| services/tools/ (toolExecution.ts) | ~2,000 | ~0.4% |
| components/ (UI) | ~80,000 | ~15.6% |
| ink/ (fork) | ~15,000 | ~2.9% |
| tools/ (43 工具) | ~30,000 | ~5.9% |
| commands/ (100+ 命令) | ~25,000 | ~4.9% |
| hooks/ | ~30,000 | ~5.9% |
| bridge/ | ~8,000 | ~1.6% |
| utils/ | ~25,000 | ~4.9% |
| 其他 | ~308,000 | ~60% |
| **总计** | **512,664** | **100%** |

---

> 本报告基于 Claude Code v2.1.88 源码分析生成，仅供技术研究参考。
> 源码版权归 Anthropic 所有。