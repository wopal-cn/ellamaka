---
name: ellamaka-app agent rules
description: Ellamaka App 长期有效的 SolidJS 界面、状态、异步与验证规则
---

# Agent Development Rules

## Canonical References

- [项目规范](../../AGENTS.md)
- [Workbench 设计](../../docs/DESIGN-workbench.md)
- [Desktop 设计](../../docs/DESIGN-desktop.md)；renderer/壳层协同改动时同时阅读 [Desktop 包规范](../ellamaka-desktop/AGENTS.md)。
- 涉及后端行为时阅读 [opencode 包规范](../opencode/AGENTS.md)。
- Workbench 状态与交互的详细契约由 DESIGN-workbench 拥有；下面的规则是无需翻阅设计文档即可照做的工作约束。

## Architecture and Directories

ellamaka-app 是 Browser/Desktop 共用的 renderer，通过生成的 SDK 与 Ellamaka Server 通信；Electron 原生壳层、凭证和 sidecar 进程归 ellamaka-desktop。

| 路径 | 职责 |
|---|---|
| src/app.tsx、src/entry.tsx | App 入口和路由组合 |
| src/pages/workbench/ | Workbench 状态、Action、Runtime 健康、Space 查询和 renderer PTY 客户端 |
| src/pages/session/ | 共用 Session 与聊天呈现 |
| src/context/ | Server/SDK Provider 和服务端事件同步 |
| src/components/ | 跨页面复用的 UI 组件 |

核心归属事实：

- WorkbenchStore 拥有持久化布局和绑定引用；view-store 负责 hydration/persistence context。两者都不拥有 Server 资源。
- Session/消息是 Server 事实，在前端以只读 projection 呈现。只持久化 UI 布局和恢复连接所需引用，不保存 Server 记录的副本。
- WorkbenchActions 是跨 Store、SDK 请求和 PTY 资源操作的边界。Store 只管理同步状态，组件负责表达用户意图。
- SpaceScope 表示 General 或一个 Space；panel directory 决定 SDK/文件/会话请求的工作目录。两者不是同一身份；禁止根据空路径或假值推断 General。
- 恢复或隐藏的 Space Tab 只是保存的 UI 状态，不表示要启动 Runtime。未知传输失败不能视为资源已删除；普通断连也不等于用户显式关闭资源。
- PTY 进程由 Server/sidecar 所有。Renderer 中保存的 PTY ID 只是重连提示，不证明进程仍然存在。

## Development Commands

| Scenario | Command | When |
|---|---|---|
| 开发服务 | bun run dev | 本地前端开发；需先启动 backend |
| 构建 | bun run build | 生产构建 |
| 类型检查 | bun run typecheck | 修改 TypeScript 后 |
| 单元测试 | bun run test:unit --force-exit | 修改组件、hook 或工具后 |
| E2E 测试 | bun run test:e2e | 修改路由或用户流程后 |
| Workbench 边界检查 | bun run check:workbench-boundaries | 修改 Workbench 后 |
| Workbench lint | bun run lint:workbench | 修改 Workbench 后 |
| CSS lint | bun run lint:css | 修改 CSS 后 |
| 前后端联调帮助 | ./scripts/dev.sh help | 集成开发 |

单元测试必须用包脚本（它设置 browser condition 与 happy-dom preload）；直接跑 `bun test` 会解析到错误的 SolidJS renderer。Typecheck 走 `tsgo -b`，不要直接运行 `tsc`。

## Implementation Rules

- Server 通信使用生成 SDK，不手写 fetch contract。
- `packages/ui` 永远不为 Workbench 表现层改动。适配只发生在 ellamaka-app 内：组件 wrapper、扩展点（`FileComponentProvider`、`ThemeProvider.registerTheme`）和 scoped CSS 覆盖。
- 扩展 upstream 的 Session、command、Dialog、navigation 流程时，用 adapter、callback 或小的注入点；绝不把整段 upstream 流程复制进本包。
- 区分权威状态、派生状态、持久化状态和临时 UI 状态；不要持久化服务端投影。
- 跨 owner 操作统一经过 WorkbenchActions。组件不得自行协调多个 Store、SDK 调用或 PTY 清理。
- 共享 Session/组件不得依赖 Workbench 内部；需要扩展时通过 adapter 或 callback。
- SDK Provider 绑定到所属 directory。scope、directory 或 Server identity 改变后，拒绝旧请求的迟到结果。
- 区分传输失败与服务端明确的 not-found；结果未知时保留重连状态。
- 资源生命周期服从真实用户意图：切换视图或普通断连不代表要删除后端资源。
- SolidJS context/hook 必须在 Provider 所属的同步初始化阶段获取，不在异步回调中调用。
- 只有当前可见输入可以恢复 Prompt 焦点；保留隐藏 Panel 草稿和用户选择。
- 高频流/事件只更新其所属状态，不因重连刷新无关树或 Panel。
- SSE 事件：`server.connected` 只恢复传输、**不触发全局刷新**；只有 `global.disposed` 触发全量对账。改 SSE 处理时要验证：重连后 UI 状态保留，且 `global.disposed` 仍能刷新。
- Canvas 渲染必须使用整数 `devicePixelRatio`。若按 `width = cssSize * dpr` + `ctx.scale(dpr)` 计算，dpr 非整数时会产生网格条纹（Electron 缩放会加剧）。`Terminal` 组件已做取整——不得移除；任何新 canvas 路径（直接用 `<canvas>` 或新终端渲染库）也必须先取整再传给渲染器。
- 使用设计 token 和可访问语义。为框架或 renderer 生成的 DOM 编写样式前先检查实际 DOM；私有 renderer API 通过隔离 adapter 使用，并对结构变化安全失败。
- 可恢复的本地错误进入诊断通道，不要因其摧毁仍可用的 Workbench。

### Workbench Chat Styling

以下规则适用于改动 `src/index.css` 中影响 `src/pages/session/` 聊天区块的部分。每条都对应一次真实回归——照做，不要重新推导：

- **改 CSS 前先看渲染后的真实 DOM。** 聊天记录由自建的 `WorkbenchMarkdown` 和工具块组件在运行时生成；不得凭记忆或只读 `packages/ui` CSS 写覆盖——先在运行中的 Workbench 读取实际 `computedStyle`/盒结构，再定位真实选择器。
- **只用设计 token**（`var(--background-base)`、`var(--surface-*)`、`var(--border-*)`、`var(--text-*)`），不硬编码颜色或间距。硬编码值无法跟随主题；token 若与页面背景同色会渲染成“看不见”。
- **`!important` 仅用于覆盖 upstream 内联样式**（如 shiki 的 `style="background-color:..."`）或第三方卡片外观，且必须带注释说明原因。
- **hover 才出现的滚动条必须预留 gutter**（`scrollbar-gutter: stable`），否则 hover 会改变布局导致跳动。
- **交付前自验**：`bun run lint:css`（0 error）、`bun run typecheck`、相关组件测试，并对运行中的 Workbench 截图确认。

## Testing

- 在真实 Store/Provider/Action/组件边界遵循 TDD；可在 SDK 传输边界使用受控 fake。
- 修改生命周期逻辑时，验证迟到响应、scope/Server 变化、重连、隐藏 Panel、显式关闭和资源清理。
- Workbench 改动运行边界检查、browser-condition 单元测试和 typecheck；CSS 改动还需跑 CSS lint。GUI 观察结果与自动化证据分开报告。

## User-Supplied Rules

- 适用时始终并行使用工具。
