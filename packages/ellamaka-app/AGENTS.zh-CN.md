---
name: ellamaka-app 代理规则
description: 基于 SolidJS、Vite 和 Tailwind CSS 构建的 ellamaka Web UI 前端
---

# 代理开发规则

## 权威参考

- 项目设计：`../../docs/DESIGN.md`
- Workbench 设计：`../../docs/DESIGN-workbench.md`
- Desktop 设计：`../../docs/DESIGN-desktop.md` —— Electron 承载方式与共享 sidecar/PTY 生命周期的权威来源。
- 父级规则：`../../AGENTS.md`
- 后端规则：`../opencode/AGENTS.md`
- Desktop 包规则：`../ellamaka-desktop/AGENTS.md` —— 协同修改 renderer 与桌面壳层前必须阅读。

## 架构与目录

执行链：Vite dev server → SolidJS SPA → `@opencode-ai/sdk` → backend（`packages/opencode`）HTTP/WS API。

### Desktop 集成边界

`ellamaka-app` 同时服务浏览器 Workbench 与由 `ellamaka-desktop` 承载的 `/workbench` renderer。Electron 负责原生窗口、preload API 和本地 sidecar 生命周期；本包负责共享的 Workbench 布局、交互与 PTY 客户端生命周期。平台集成、Desktop 启动/路由、macOS 窗口壳层、sidecar 就绪状态，或 PTY 创建/探测/重连/释放语义的变更都属于跨包工作：修改任一侧前必须阅读 `../../docs/DESIGN-desktop.md` 和 `../ellamaka-desktop/AGENTS.md`，并保持 Web 与 Desktop 相同的 PTY 所有权契约。

| 目录 | 职责 |
|---|---|
| `src/app.tsx` / `src/entry.tsx` | 应用根组件、路由装配与 Vite 挂载入口 |
| `src/pages/` | 路由页面组件 |
| `src/pages/workbench/` | Workbench 专属实现，遵循本文件第 5 节的强制边界 |
| `src/components/` | 可复用 UI 组件 |
| `src/context/` | SolidJS context 定义；`global-sync/` 内是 SSE 事件处理与状态对账 |
| `src/utils/` | 纯工具函数 |
| `src/i18n/` | 国际化文案与 locale 配置 |
| `e2e/` | Playwright e2e 测试 |
| `script/` | 构建、检查与开发辅助脚本；`check-workbench-boundaries.ts` 是 Workbench 边界静态门禁 |

## 开发命令

| 场景 | 命令 | 何时 |
|---|---|---|
| 开发服务 | `bun run dev` | 本地前端开发；需先启动 backend |
| 构建 | `bun run build` | 生产构建 |
| 类型检查 | `bun run typecheck` | 修改 TypeScript 后 |
| 单元测试 | `bun run test:unit --force-exit` | 修改组件、hook 或 util 后 |
| e2e 测试 | `bun run test:e2e` | 修改页面、路由或用户流程后 |
| Workbench 边界检查 | `bun run check:workbench-boundaries` | 任何 `src/pages/workbench/` 变更后 |
| Workbench lint | `bun run lint:workbench` | Workbench 代码质量检查 |

单元测试必须通过 `bun run test:unit`（或 `test:ci`）运行，禁止裸跑 `bun test`。该脚本附加 `--conditions=browser --preload ./happydom.ts`；缺少 browser condition 时，`solid-js/web` 会被解析到 server 构建，而 server 构建缺少 `virtua/solid` 所 import 的 `use` 导出，组件测试文件会在模块加载阶段全部失败。

前后端开发验证: `./scripts/dev.sh help`

## 实现规则

- 后端通信通过 `@opencode-ai/sdk`；禁止组件裸调 fetch 到 backend。
- 类型检查使用 `tsgo -b`，禁止直接运行 `tsc`。
- 上游共享代码优先通过 adapter、callback 或小型注入点扩展，禁止复制整段 Session、命令、Dialog 或导航流程。
- SSE 事件处理：`server.connected` 仅恢复传输，**不触发全局刷新**；只有 `global.disposed` 触发全量对账。改 SSE 事件处理时必须验证：重连后 UI 状态保留、`global.disposed` 仍触发全量刷新。
- SSE 事件按类型分级处理：高频属性变更（标题、消息流）由对应组件局部处理；结构性事件（`session.created`/`session.deleted`/带 `timeArchived` 的 `session.updated`）才触发 SessionTree 刷新。禁止用 SSE 事件触发无关 Panel 或树级重载。
- Canvas 渲染必须使用整数 `devicePixelRatio`。ghostty-web（及任何 `canvas.width = cssSize * dpr` + `ctx.scale(dpr)` 模式的 canvas 渲染器）在非整数 dpr 下，浏览器会把 canvas 物理像素截断为整数，而 context scale 仍用原始小数，导致合成器对 canvas 纹理做亚像素重采样，产生按字符单元格周期排列的网格条纹。Electron 窗口缩放（如 110%）会使 `window.devicePixelRatio = nativeDpr × zoomFactor` 变成非整数（如 2.2），必然触发此问题。`Terminal` 组件已对 `renderer.devicePixelRatio` 做整数化处理，禁止移除该修复；新增任何 canvas 渲染路径（直接用 `<canvas>` 或引入新终端渲染库）同样必须将传给渲染器的 dpr 取整。

## 工作台强制边界

本节适用于 `src/pages/workbench/` 内全部代码，也适用于为了 Workbench 修改 `src/components/`、`src/context/` 和 `src/pages/session/` 时产生的适配代码。

实施优先级固定为：

1. 保持服务端资源和数据真相正确。
2. 保持 General、Space、Panel 和 Session 身份不串位。
3. 保持单一状态所有者和单一事务入口。
4. 最后处理展示、交互和样式。

### 状态所有权

每类状态只能有一个权威所有者。缓存、投影和持久化副本不得反向覆盖权威数据。

| 状态 | 权威所有者 | Workbench 可保存内容 | 禁止事项 |
|---|---|---|---|
| Session 标题、目录、时间、状态 | 服务端 Session Projection | 内存只读投影、`boundSessionId` 引用 | 持久化完整 Session；由 UI 伪造 Session；用本地旧字段覆盖服务端结果 |
| Space、Tab、Panel 布局 | `WorkbenchStore` | Tab、Panel、activePanel、viewMode、slotState、必要的重连提示 | Store 内调用 SDK、释放 PTY、导航或弹 Toast |
| PTY 进程是否存在 | 后端 PTY registry | `PtyManager` 运行时句柄；布局中的 PTY ID 只能作为重连提示 | 用 UI 布尔值表示进程存活；只隐藏 UI 不释放明确关闭的 PTY |
| 插件、MCP、LSP、配置加载结果 | directory-bound SDK/同步层 | 当前 directory 的内存投影 | 持久化列表；跨 directory 复用结果；只比较数量不核对来源路径 |
| 瞬时提示和弹窗 | Workbench UI 状态 | 短生命周期、不可持久化状态 | 写入领域 Store；让提示状态参与业务判断 |

`sessionStore` 对 UI 只读。只有 Session Projection adapter 和 SSE reconciliation 可以写入；组件、Dialog、命令处理器和 Workbench Action 都不能伪造或直接修改服务端字段。

### 身份与目录作用域

General 不是空路径的别名。业务边界必须使用显式可辨识类型表达作用域：

```ts
type SpaceScope =
  | { kind: "general" }
  | { kind: "space"; name: string; path: string }
```

- 禁止用 `if (spacePath)`、`if (!spacePath)` 或 `path || fallback` 判断 General 与 Space。
- 为 General 作用域构建会话或面板载荷时，禁止求值路径假值降级表达式（如 `path || fallback` 或 `sessionDirectory || spacePath`）。General 的规范路径固定为 `""`，但作用域辨识必须始终检查 `scope.kind === "general"`。
- 禁止把 `spaceName`、`panel.directory` 或 falsy 字符串当作 Space 主键。
- `SpaceScope` 决定会话归属和插件组合；`panel.directory` 决定 Panel 内 SDK、文件、终端和会话请求的工作目录，两者不能互换。
- General 只加载全局插件、全局 MCP 和全局配置，不得继承最近访问 Space 的目录状态。
- Space 加载全局能力与本 Space 定义能力的并集，验收时必须核对每个来源的完整路径。
- 从路由、localStorage 或服务端读取字符串后，必须在边界处转换为 `SpaceScope`；内部代码不得继续传播"空字符串代表 General"的隐式契约。

### 依赖方向与共享边界

唯一允许的主依赖方向为：

```text
UI 组件 -> WorkbenchActions -> Store / PtyManager / directory-bound SDK / Projection adapter
```

- UI 组件只负责渲染、收集用户意图和调用 Action，不得自行拼接多步领域事务。
- 一个组件不得在同一操作中写两个 Store，也不得先写 Store 再直接调用 SDK 或 `PtyManager`。
- `WorkbenchStore` 只能执行同步、纯状态变更，不得 import SDK、`PtyManager`、router、Toast 或 Dialog。
- 所有跨状态所有者的操作必须进入 `WorkbenchActions`，包括 load、replace、fork、bind、unbind、closePanel、closeSpace 和 createSession。
- 依赖方向单向：`src/components/` 与 `src/pages/session/` 的共享代码不得反向依赖 Workbench 内部。Workbench 需要扩展共享组件时，通过 adapter 或 callback 注入能力，不在共享组件上暴露 `panelID`、`spacePath`、`spaceName` 等 Workbench 专属参数。
- 共享组件通过 `onCompleted`、`onForked` 等通用回调返回结果；Workbench adapter 再调用 Action。
- 迁移期兼容 adapter 必须位于 Workbench 目录，写明 owner、删除条件和对应 Plan Task，不得让新调用者继续依赖旧入口。

### 目录 SDK 与上下文

- 每个 Panel 子树只能消费与该 Panel `directory` 绑定的一个权威 `SDKProvider`。
- StatusPopover、TopBar 等 Workbench 全局表面必须通过当前活动 `SpaceScope` 和活动 Panel selector 获得目录上下文，不能读取最后挂载 Panel 的 Context。
- 目录 client 只能由明确 Provider 或 Action 注入，组件不直接创建。
- Provider 的创建位置、所有者和销毁时机必须固定，禁止通过嵌套 Provider 修复状态串位。
- directory 改变时，旧目录请求的异步结果不得写入新目录投影。
- 插件、MCP 和配置状态必须以规范化 directory 为 key；不得使用组件挂载顺序或当前可见性作为作用域依据。

### 命令作用域

- Workbench 全局命令只允许在 Workbench Shell 注册一次。
- 命令执行时必须从权威 selector 读取活动 `SpaceScope`、Panel 和 Session，不能闭包捕获某个 Panel 挂载时的 props。
- 隐藏、keep-alive 或非活动 Panel 不得注册同名全局命令，也不得替换活动 Panel 的注册。
- 不支持的命令不注册，禁止用空函数占位后让命令看似可用。
- 共享 Session 命令只接受通用 action adapter，不得扩展 Workbench 专属参数污染共享接口。

### 事务、异步竞态与 PTY 生命周期

跨 Store、SDK 和 PTY 的操作不是数据库原子事务。`WorkbenchActions` 必须显式实现一致性边界：

1. 校验 `SpaceScope`、Panel、Session 和 directory 前置条件。
2. 为 Panel 操作分配 generation 或取消令牌。
3. 执行资源释放和 SDK 副作用。
4. 确认操作仍是最新 generation 后，一次性提交 Store 状态。
5. 失败时清理本次新建资源，并保持或恢复可解释的旧状态。

- close、unbind 和 dispose 必须幂等，重复调用不能误杀新资源。
- Panel 关闭或 directory 切换后晚到的 PTY、Session、插件或 MCP 请求结果必须丢弃；晚到 PTY 仍需释放。
- Context hook、Store hook 和 router hook 必须在组件同步初始化阶段取得，禁止在 Promise、timer 或事件回调内部重新调用 hook。
- Action 不能依赖组件是否可见；隐藏 Panel 与可见 Panel 使用相同生命周期契约。
- 每个 Action 测试必须覆盖成功、失败、重复调用和 stale async result。

**PTY 生命周期与 effect 竞态防护**（高频回归点，必须严格遵守）：

- `view-registry` 中 TUI 视图的 `createEffect` 守卫只依赖 `ctx.panel.viewMode`，禁止 AND 多个状态字段。`viewMode !== "tui"` 时立即 return。
- 修改 `viewMode` 和 `tuiPtyId` 必须在同一个 SolidJS `batch` 内完成，且**先切 `viewMode` 到 `chat` 再清 `tuiPtyId`**。反过来会触发 effect 在中间状态（viewMode=tui + tuiPtyId=undefined）创建新 PTY。
- 修改 `splitTerminal` 和 `splitPtyId` 同样必须在一个 `batch` 内完成，且**先关闭 `splitTerminal` 再清 `splitPtyId`**，禁止让创建 effect 观察到 `splitTerminal=true + splitPtyId=undefined`。
- PTY 断连探测必须区分 `alive | dead | unknown`：只有服务端明确返回 404 才能判定 `dead` 并清状态；`Failed to fetch`、超时和其他传输错误一律视为 `unknown`，保留 PTY ID，等待 Terminal 重连或 sidecar generation 对账。
- TUI 进程正常退出场景：后端 `proc.onExit` 已自动清理 session，前端 `exitTui` **不发 DELETE 请求**，只清本地状态（viewMode + tuiPtyId + ptyManager 内存），避免 404 PtyNotFoundError。
- 用户主动关闭场景（`closePanel`/`unbindPanel`）：先同步清 PTY 状态（切 chat + 清 tui/term/split 三个 ptyId + 关 split terminal），再 `await disposePanel`，最后 `removePanel`/`commitSessionUnbinding`。先清状态让 effect 守卫提前 return，避免 await 期间触发 PTY 重建。
- PTY dispose 对 404 PtyNotFoundError 视为幂等成功（后端已清理），仍清本地状态，不报错。
- **PTY 状态与事件实时同步（Invariants）**：`panel.tuiPtyId` 必须与后端的 PTY 真实生命周期保持绝对同步。任何全局 PTY 销毁事件（`pty.deleted` / SSE 事件 / 离线 Grace Reap / 终端 exit）发生时，即使面板处在后台（`viewMode !== "tui"`），前端全局事件监听器与 Store 也必须即时擦除对应的 `tuiPtyId`，严禁在 Header 上残留虚假的蓝色激活高亮。
- **TUI 后台保活与用户自主掌控（Keepalive Invariants）**：`tui` 视图在面板切至后台（如 `viewMode === "chat"`）、Tab 切换或网页后台时，只要 `panel.tuiPtyId` 存在，`view-registry` 必须维持 `<Terminal>` 组件在隐藏 DOM 节点（`display: none`）中挂载并保持 WebSocket 连接在线保活。严禁在切视角时误卸载 `<Terminal>` 或误清 `tuiPtyId`。只有在用户显式点击关闭 TUI、关闭面板、关闭 Tab 或终端内部子进程 `exit` 退出时，方可销毁连接与清理状态。
- 每个 PTY 生命周期 action 的测试必须覆盖：成功路径 + **effect 不重建 PTY** + stale generation + 后端已清理时的幂等性。

### 持久化规则

允许持久化：

- Space、Tab 和 Panel 布局。
- activePanel、viewMode、slotState 等恢复界面所需状态。
- PTY ID 重连提示，但它不是进程存活真相。

禁止持久化：

- 完整 Session、服务端标题或消息副本。
- 插件、MCP、LSP 和 directory 配置结果。
- 瞬时提示、请求中状态和错误 Toast。
- 可从服务端或 directory SDK 重新投影的数据。

持久化 schema 必须有版本和显式迁移。读取旧数据时只能迁移布局字段，不能把历史投影重新注入服务端领域状态。

Workbench Chat 的模型选择按 Session 隔离。用户显式选择是当前 Session 的权威模型，不得被 Agent 默认模型、隐藏 Panel 挂载或受控选择器的同值回调覆盖；没有显式选择时，解析顺序固定为最后一条可见用户消息的模型、Agent 默认模型、可用模型兜底。同值 Agent 更新必须幂等，不得产生模型持久化写入。

### 核心设计约束

以下约束源自 Workbench 设计文档（`../../docs/DESIGN-workbench.md`），是架构稳定性的基石，开发时必须遵守。完整设计意图与交互流程见设计文档。

- **派生状态不另存副本**：TUI 存活标记、Split Terminal 进程高亮、Session 绑定状态、目录健康指示等均从权威字段派生（如 `panel.tuiPtyId`、`panel.splitPtyId`、`boundSessionId`），不得在 UI 层另存重复标记。
- **视图切换不释放 PTY**：TUI ↔ Chat ↔ Context 切换、Split Terminal 收起/展开，只切换可见性，不销毁 PTY 进程或 WebSocket subscriber。PTY 释放只发生在 Panel 关闭、Space Tab 关闭或 Session 解绑场景。
- **水合门控**：`wb.ready()` 是唯一的 Workbench Bootstrap Gate。水合完成前不渲染 Workspace、不创建 PTY、不处理副作用事件；水合完成后挂载当前 Space 并探测其持久化的 PTY ID。其他恢复的 Space 在首次访问时按需挂载。
- **按需 Space Keep-Alive**：恢复 Tab 布局不代表需要加载运行环境。首次只挂载当前 Space；其他 Space 首次访问时挂载，此后保留其 Panel，直到用户显式关闭。非当前已挂载 Space 用 `position: absolute; visibility: hidden; inert` 隐藏，禁止 `display: none`（Ghostty 尺寸会归零）。已激活 Panel 切到后台必须保留草稿、滚动位置与终端连接。
- **运行环境加载条件**：只有 Panel 中已打开或新建的会话才加载目录能力。空 Panel、Tab 布局、会话树行、运行/未读指示及通知元数据均为被动读取，不得创建会发出请求的目录状态或加载插件。空间文件浏览与预览使用 Root 级文件读取，不使用会话 instance。空 Panel 不提供目录能力状态，但服务健康状态始终独立可用。
- **重连加载边界**：从 `localStorage` 恢复时只挂载并恢复当前 Space。页面不刷新而后端/sidecar 重启时，只允许当前可见 Space（其中正在显示的所有 Panel）对账会话并恢复 PTY 连接；隐藏 keep-alive Space 只保留 DOM、草稿和重连提示，不得重新创建 directory instance、加载插件或重连 PTY，直到用户切回该 Space。
- **SSE 事件分级**：高频属性变更（标题、消息流）由对应组件局部处理；结构性事件（`session.created`/`session.deleted`/带 `timeArchived` 的 `session.updated`）才触发 SessionTree 刷新。`message.part.*` 只更新对应 PanelChat。
- **CLI 不可用降级**：CLI 缺失/损坏/版本不兼容时，保留 General Session、Chat、TUI 和 PTY，暂停 Space Control；修复操作由用户在诊断中心点击确认，恢复后自动重新探测，不重启 sidecar。
- **离线输入隔离**：`runtime.status === "offline"` 时，Shell 在顶层显示连接保护遮罩并将工作台表面设为 `inert`，阻断所有用户输入。恢复连接后自动解除隔离并保留当前现场。
- **错误不抛 ErrorBoundary**：局部非阻塞错误（如 `locations` 接口拉取失败）严禁抛出至面板 ErrorBoundary 导致崩溃卸载。错误统一进入诊断队列，由状态栏居中显示并提供重试/清除入口。
- **PTY 资源键**：PTY 由 `spacePath + panelId + resourceKind`（`tui`/`term`/`split`）唯一标识。PTY ID 作为重连提示持久化，但进程存活真相归 sidecar PTY Session Registry，前端使用前必须探测。
- **Canvas 网格缝隙补偿**：Ghostty 在分数 WebView 缩放下逐行、逐格填充会暴露透明像素缝。补偿必须集中在 `terminal-scrollbar.ts` 的 Renderer adapter 中，仅向右/下覆盖一个物理像素；禁止用全局背景纹理、Panel CSS 或写死 DPR 掩盖。
- **终端 IME 预编辑**：Ghostty 的隐藏 textarea 只负责接收输入和定位候选窗；composition 期间的拼音等 preedit 文本必须由 `<Terminal>` 的光标锚定 overlay 显示，并在 `compositionend` / `blur` 清除。不得解除 textarea 的裁切后直接把它当可见编辑器。
- **单 Tab 互斥**：`WorkbenchSingletonGuard` 通过 Web Locks API 获取独占锁，第二个 Tab 打开时显示提示页不初始化。Tab 关闭时浏览器自动释放锁。
- **Chat 焦点所有权**：只有当前 Space Tab 的活动 Chat Panel 可以自动聚焦或恢复 Prompt 焦点。隐藏、keep-alive 或非活动 Panel 必须通过通用 callback 放弃共享输入组件的焦点恢复；Panel 切换不得清除消息文本选择、终端焦点或用户已放置的编辑器光标。

### 测试与验收证据

Workbench 行为变更严格执行 RED、GREEN、REFACTOR：

- 修 bug 前先写能复现该 bug 的失败测试，测试名称描述用户可见行为。
- 优先使用真实 Store、Provider、Action 和组件组合；只在 SDK 传输边界使用可控 fake，禁止 mock 掉正在验证的状态所有权。
- typecheck、静态 `rg` 和插件数量只能作为辅助证据，不能代替行为测试和路径核对。
- directory 状态验收必须断言插件和 MCP 的规范化完整路径及来源，不得只断言数量。
- 测试必须覆盖 `General -> Space A -> Space B -> General` 往返，确保 General 只含全局能力，Space 为全局与本 Space 能力的并集。
- 测试必须覆盖多 Panel、隐藏 Space、fork、命令目标、Session Projection 重连、PTY 关闭和晚到异步结果。
- PTY 生命周期 action 的测试见 [事务、异步竞态与 PTY 生命周期](#56-transactions-async-races-and-pty-lifecycle)。
- 回归测试在修复前必须确认真实失败原因，修复后必须重新运行；不能把 harness error 误判为业务 RED。

最小验证链（所有 Workbench 变更必须通过）：

```bash
bun run check:workbench-boundaries
bun run test:unit --force-exit
bun run typecheck
```

### 修改纪律与禁止模式

- 修改前先写出本次行为的状态所有者、输入作用域和唯一事务入口；无法回答时不得开始改代码。
- 一个补丁只解决一个可验证行为。router 重建、命令注册、fork 绑定和 Store 重构必须分开验证，禁止打包成"顺手修复"。
- 发现现有代码违反本规范时，允许通过兼容 adapter 和显式技术债清单渐进迁移，但禁止新增或扩大债务。
- 不得重写、回滚或格式化与当前任务无关的未提交修改。

以下模式出现即视为阻断问题：

- 用字符串真假或假值降级表达式（`path || fallback`、`if (spacePath)`）判断 General 或 Space。
- 在 UI 组件或独立 helper 中自行拼装多步会话树加载或面板替换流程，而非调用统一的 `WorkbenchActions` 事务入口。
- Workbench 共享操作同时写多个 Store。
- 组件直接编排 `Store + SDK + PtyManager`。
- Store 内包含网络、PTY、router、Dialog 或 Toast 副作用。
- 共享组件 import Workbench Store 或 Workbench Context。
- 在异步回调中调用 Context hook 或 Store hook。
- 每个 Panel 重复注册同名全局命令。
- 隐藏 Panel 通过挂载顺序成为当前命令或 directory 状态所有者。
- 持久化完整 Session 或 directory 能力列表。
- 用静态匹配通过、typecheck 通过或数量一致宣称功能正确。

## 用户补充规则

- 适用时始终并行使用工具。