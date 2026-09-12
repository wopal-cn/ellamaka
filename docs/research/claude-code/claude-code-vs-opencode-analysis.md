# Claude Code vs OpenCode 设计差异分析

> **分析日期**: 2026-04-02
> **Claude Code 版本**: v2.1.88（泄露源码）
> **OpenCode 版本**: 7daea69e（DeepWiki 索引）
> **分析来源**: `docs/research/claude-code/architecture-analysis.md` + `docs/research/opencode/deep-docs/`

---

## 定位与理念

| 维度 | Claude Code | OpenCode |
|------|------------|----------|
| **定位** | Anthropic 官方 CLI，为 Claude 模型深度优化 | 开源替代品，Provider 无关的通用 Agent 引擎 |
| **许可证** | 闭源（泄露） | MIT 开源 |
| **核心模型** | 仅 Anthropic Claude（4 Provider 变体） | 75+ Provider（OpenAI, Anthropic, Google, 本地模型...） |
| **设计哲学** | 深度垂直集成，极致性能优化 | 水平可扩展，模块化组合 |

---

## 架构对比

### 整体架构

| 维度 | Claude Code | OpenCode |
|------|------------|----------|
| **架构模式** | 单体应用（1902 文件扁平 `src/`） | Monorepo（15+ packages，清晰边界） |
| **运行时** | Bun（深度绑定 `bun:bundle` feature flags） | Bun（可选 Node 兼容） |
| **UI 框架** | 自定义 Ink fork（48 文件）+ React 19 + Yoga 布局 | `@opentui/core` + SolidJS |
| **API 层** | 无独立 HTTP API，内建 SDK Server | Hono HTTP Server + OpenAPI + SSE + SDK |
| **存储** | JSON 文件（会话/配置） | SQLite（Drizzle ORM）+ JSON（二进制数据） |
| **事件系统** | React 状态驱动 + 自定义 Store（~150 字段） | Bus/GlobalBus 事件总线 + SSE 推送 |
| **代码规模** | 512,664 行（单包） | 分散在 15+ packages |

### 启动链路

| 维度 | Claude Code | OpenCode |
|------|------------|----------|
| **入口** | `cli.tsx`（303 行零导入快速路径）→ `main.tsx`（4684 行）→ `init()` → `setup()` | `index.ts` → `Server.Default()` → Hono app |
| **启动优化** | 极致：并行预取 MDM/Keychain/API 连接、懒加载 OTel、快速路径零导入、memoize init | 常规：数据库迁移 → 配置加载 → 服务器启动 → 实例初始化 |
| **启动深度** | ~10 步深度初始化链（安全检查/IDE 检测/Git 检测/终端恢复...） | 线性 5 步（日志 → 迁移 → 配置 → 实例 → 服务器） |

---

## 核心子系统对比

### Agentic 循环

| 维度 | Claude Code | OpenCode |
|------|------------|----------|
| **引擎** | `QueryEngine`（1295 行）单实例，async generator 流式输出 | `SessionPrompt.loop()`（~600 行）状态机驱动 |
| **工具执行** | `toolExecution.ts`（1745 行）— 含假设性 bash 分类器 | `ToolRegistry.execute()` — 直接调用，tree-sitter 解析 bash |
| **上下文压缩** | 4 级：micro-compact → session memory → partial → full | 单一 compaction：LLM 总结 + prune 旧消息 |
| **预算控制** | `maxBudgetUsd` + `maxTurns` + token 计数 | `maxTurns` + compaction 阈值 |
| **模型降级** | 529 过载 → 3 次重试 → 自动降级 | Provider 错误 → 直接报错 |

### 工具系统

| 维度 | Claude Code | OpenCode |
|------|------------|----------|
| **工具数量** | 43 个（+ 15+ feature-gated） | 17 个内建 + MCP/Plugin 动态注册 |
| **接口设计** | 纯结构化接口 `Tool<I,O,P>`（12+ 渲染方法，无类继承） | `Tool.define()` 工厂函数，简洁 `execute` 回调 |
| **文件安全** | `checkPermissions()` 返回行为枚举 | `FileTime` 时间戳校验 + `withLock()` 信号量 |
| **编辑策略** | 精确字符串替换 + 语义 diff | 9 种回退策略（Levenshtein/缩进/空白/多匹配...） |
| **延迟加载** | `shouldDefer` + `ToolSearch` 二阶段发现 | 无延迟加载，全部注册 |
| **Prompt Cache** | 工具按名称排序保证缓存稳定性 | 无缓存优化设计 |
| **MCP 工具** | 6 种传输类型（stdio/sse/http/ws/proxy/in-process） | stdio + SSE，通过 `mcp-read`/`mcp-prompt` 代理 |

### 权限系统

| 维度 | Claude Code | OpenCode |
|------|------------|----------|
| **架构** | 3 层 handler（swarm/coordinator/interactive），4 路竞速原子决策 | `PermissionNext` 规则引擎，allow/deny/ask 模式匹配 |
| **竞速决策** | `createResolveOnce()` — 用户/Bridge/通道中继/Hooks 竞速 | 单一 `ask()` — 串行等待用户或 auto-approve |
| **自动审批** | bash 语义分类器（推理级自动审批） | `always` 规则模式匹配（前缀匹配） |
| **远程审批** | Claude.ai Bridge + Telegram/iMessage 中继 | 无远程审批 |
| **审计** | Statsig + OTel 全量决策日志 | 无审计设计 |

### 命令/技能系统

| 维度 | Claude Code | OpenCode |
|------|------------|----------|
| **命令数量** | 100+ 命令，7 层来源合并 | ~10 内建 + 配置目录 + MCP prompts + Skills |
| **技能系统** | 17 内建 + 目录扫描 + MCP 技能 + 插件技能，inline/fork 两种执行模式 | markdown + YAML frontmatter，`skill` 工具加载 |
| **变量替换** | 无（命令是 PromptCommand 或 LocalCommand） | `$ARGUMENTS` / `$1` / `$2` 模板替换 |

### 扩展体系

| 维度 | Claude Code | OpenCode |
|------|------------|----------|
| **插件系统** | Marketplace 插件 + 内建插件（ID: `{name}@builtin`），提供 Skills + Hooks + MCP | npm 包 / 本地文件，提供 Tools + Hooks + Shell env |
| **Hook 系统** | 28 个生命周期事件，3 种执行模式（shell/prompt/async），条件表达式 | 5 个 hook 点（beforeTool/afterTool/event/shellEnv/providerOptions） |
| **Plugin Hook** | `PreToolUse`/`PostToolUse`/`SessionStart`/`FileRead`/`SubAgentStart` 等 | `tool.execute.before`/`tool.execute.after`/`event`/`shell.env`/`provider.options` |

### 多代理/团队

| 维度 | Claude Code | OpenCode |
|------|------------|----------|
| **子代理** | Agent 工具：fork/background/remote，独立上下文 | Task 工具：SubtaskPart 写入 → 主循环检测 → 子 session |
| **团队** | TeamCreate/TeamDelete，leader + worker 协调，邮箱消息传递 | 无团队概念 |
| **协调器** | coordinator 模式（swarm worker），权限分层 | agent 模式：primary/subagent/all |

---

## 各自设计优势

### Claude Code 优势

| 优势 | 说明 |
|------|------|
| **极致启动性能** | 并行预取覆盖模块加载时间、快速路径零导入、memoize init、TCP/TLS 预热 — 毫秒级冷启动 |
| **上下文压缩领先** | 4 级压缩（micro/session memory/partial/full），零 API 成本的 micro-compact，附件携带 compact delta |
| **权限系统成熟** | 4 路竞速原子决策、bash 语义分类器、远程审批链（Bridge/中继）、全量审计日志 |
| **工具深度** | 43 个工具（含团队/定时/远程/cron/语音/浏览器），12+ 渲染方法，prompt cache 排序优化 |
| **多代理编排** | 团队创建/解散、leader-worker 协调、邮箱消息传递、swarm 模式、fork/background/remote 三种子代理 |
| **MCP 传输多样性** | 6 种传输类型（含 in-process 和 proxy），延迟加载 MCP 工具 |
| **Feature Flags 工程** | `bun:bundle` 构建时死代码消除，15+ flags 控制功能裁剪 |
| **UI 深度定制** | 自定义 Ink fork（48 文件）、Yoga 布局、BiDi 支持、Vim 模式、18 个快捷键上下文 |
| **Provider 优化** | 专为 Claude 深度优化（thinking/extended thinking/prompt caching/反蒸馏假工具） |
| **Hook 丰富度** | 28 个生命周期事件，3 种执行模式，条件表达式，prompt 类型支持 LLM 评估 |

### OpenCode 优势

| 优势 | 说明 |
|------|------|
| **Provider 无关** | 75+ LLM 提供商，不绑定任何单一厂商，真正的选择自由 |
| **开放架构** | MIT 许可、Monorepo 清晰边界、OpenAPI 规范、SDK 独立包 |
| **客户端-服务器分离** | 内建 HTTP Server + SDK，支持本地/远程模式，VS Code/Web/Desktop 多客户端共享后端 |
| **事件驱动** | Bus/GlobalBus 事件总线 + SSE 推送，UI 与后端完全解耦 |
| **持久化成熟** | SQLite + Drizzle ORM，支持 JSON→SQLite 自动迁移，比 JSON 文件更可靠 |
| **多实例隔离** | `Instance.state()` 模式，单进程多项目实例，数据库/配置/会话完全隔离 |
| **文件安全精细** | `FileTime` 时间戳校验 + `withLock()` 信号量，防止并发竞态和过期编辑 |
| **编辑鲁棒性** | 9 种回退策略（Levenshtein/缩进/空白/多匹配），比 Claude Code 精确匹配更容错 |
| **配置层次** | 6 级配置优先级（远程→全局→自定义→项目→目录→内联），层级清晰 |
| **多客户端统一** | TUI + Web + Tauri Desktop + Electron Desktop + VS Code + Zed + Slack 共享同一后端 |
| **Console SaaS** | 内建管理平台（Console），支持会话共享、团队协作、Stripe 付费 |
| **LSP 深度集成** | 自动下载 LSP 服务器、项目根检测、诊断实时推送、代码格式化 |

---

## 各自设计劣势

### Claude Code 劣势

| 劣势 | 说明 |
|------|------|
| **厂商锁定** | 仅支持 Anthropic 模型，4 Provider 变体仍是 Claude |
| **闭源不可控** | 用户无法修改核心行为，依赖 Anthropic 更新节奏 |
| **单体架构** | 1902 文件扁平 `src/`，无包边界，模块耦合度高 |
| **存储脆弱** | JSON 文件存储会话/配置，无事务保证，大项目下可能性能瓶颈 |
| **UI 单体** | `REPL.tsx` 5006 行单体组件，难以独立测试和维护 |
| **状态膨胀** | AppState ~150 个字段的单体状态对象，状态管理复杂度高 |
| **无 HTTP API** | 没有独立的 REST/SSE API 层，外部客户端只能通过 SDK Server 或 Bridge |
| **过度工程** | Feature flags、遥测、分析等基础设施占比高，对开源社区贡献门槛大 |
| **启动链过长** | ~10 步初始化链（IDE 检测/Git 检测/终端恢复...），非核心场景启动开销大 |

### OpenCode 劣势

| 劣势 | 说明 |
|------|------|
| **压缩策略简单** | 单一 LLM 总结压缩，无 micro-compact（零 API 成本）和 session memory 层 |
| **权限系统薄弱** | 无 bash 语义分类器、无远程审批、无竞速决策、无审计日志 |
| **工具数量少** | 17 个内建工具 vs Claude Code 的 43+，缺少定时/远程/团队/语音等 |
| **Hook 事件少** | 5 个 hook 点 vs Claude Code 的 28 个，缺少文件/会话/子代理级粒度 |
| **无多代理编排** | 无团队概念、无协调器模式、无 swarm、子代理机制较简单 |
| **MCP 传输受限** | 仅 stdio + SSE，缺 in-process/http/ws/proxy 传输 |
| **无缓存优化** | 工具注册无排序优化，prompt cache 不稳定 |
| **Provider 适配浅** | 75+ Provider 但多数通过 Vercel AI SDK 统一层，缺乏深度优化（如 thinking/prompt caching） |
| **编辑可预测性差** | 9 种回退策略虽然鲁棒，但可能导致非预期的编辑结果（模糊匹配风险） |
| **命令系统弱** | ~10 个内建命令 vs 100+，缺乏 Git/代码审查/诊断/配置管理等深度命令 |

---

## 设计哲学差异

```
Claude Code                          OpenCode
┌────────────────────┐              ┌────────────────────┐
│  垂直整合          │              │  水平可扩展         │
│  深度优化 Claude   │              │  Provider 无关      │
│  极致性能/安全     │              │  开放架构           │
│  企业级功能        │              │  社区驱动           │
│                    │              │                    │
│  代价：            │              │  代价：            │
│  • 厂商锁定        │              │  • 功能深度不足     │
│  • 闭源不可控      │              │  • 安全机制薄弱     │
│  • 架构耦合        │              │  • 缺乏企业特性     │
│  • 学习曲线陡      │              │  • Provider 适配浅  │
└────────────────────┘              └────────────────────┘
```

**一句话**：Claude Code 是为 Claude 量身打造的「特制铠甲」——紧密、坚固、但只适合一个骑士；OpenCode 是开源社区的「万能工具箱」——灵活、开放、但每件工具都不够精。

---

## 对 WopalSpace 的启示

| Claude Code 可借鉴 | OpenCode 可借鉴 |
|-------------------|----------------|
| 4 级上下文压缩策略 | 客户端-服务器分离架构 |
| 4 路竞速权限决策 | SQLite 持久化 + Drizzle ORM |
| `FileTime` 文件安全（来自 OpenCode） | 事件总线 + SSE 推送 |
| 多代理编排（团队/协调器） | Monorepo 清晰包边界 |
| 延迟加载 MCP 工具（ToolSearch） | 多实例隔离（Instance.state） |
| 28 个生命周期 Hook | OpenAPI 规范 + SDK 生成 |
| Prompt Cache 工具排序 | 6 级配置优先级 |

> **核心取舍**：WopalSpace 作为 Agent 空间基因包，应取 Claude Code 的「深度」和 OpenCode 的「开放」，避免两者的极端。