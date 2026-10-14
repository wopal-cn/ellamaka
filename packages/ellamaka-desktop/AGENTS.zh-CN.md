---
name: ellamaka-desktop rules
description: Ellamaka Desktop 长期有效的 Electron 壳层、IPC、sidecar 归属与验证规则
---

# Agent Development Rules

## Canonical References

- [项目规范](../../AGENTS.md)
- [Desktop 设计](../../docs/DESIGN-desktop.md)
- 修改 renderer/壳层边界时同时参考 [App 规范](../ellamaka-app/AGENTS.md)。

## Architecture and Directories

ellamaka-desktop 是共用 ellamaka-app renderer 的 Electron 宿主。Main 拥有原生应用/窗口和 sidecar 进程生命周期；Server sidecar 拥有 Runtime API 与 PTY 进程。

| 路径 | 职责 |
|---|---|
| src/main/ | 应用/窗口生命周期、sidecar 监管、IPC 注册、原生凭证和更新 |
| src/preload/ | 暴露给 renderer 的最小 allowlisted API |
| src/renderer/ | Desktop 入口、路由、平台 adapter 和共用 App 加载 |
| packages/ellamaka-app/ | Browser/Desktop 共用 UI 和 renderer 持有的布局状态 |
| packages/opencode/ | Server sidecar 实现、Session 与 PTY 资源归属 |

请遵守这些归属事实：

- Renderer 使用与 Browser 相同的认证 Server/SDK 接口；原生系统能力经类型化 preload bridge。
- Sidecar 凭证由 Main 进程保管，不写入 renderer 状态、localStorage、URL、日志或崩溃数据。
- Renderer 刷新/socket 断开、显式关闭 Panel/Space、应用退出是不同生命周期事件。普通断连允许重连；显式资源关闭由 Server 处理；应用退出时停止 sidecar 和其子进程。
- Workbench 布局和 PTY 重连引用归共用 App。PTY ID 只是提示，sidecar 才是进程事实来源。
- OpenCode upstream 只作选择性修复参考；Ellamaka release identity 和打包宿主行为必须从 Ellamaka 制品验证。
- 品牌/身份常量：productName `Ellamaka`；bundle id dev `ai.ellamaka.desktop.dev` / prod `ai.ellamaka.desktop`；protocol `ellamaka://`；settings store `ellamaka.settings`；service name `ellamaka server`。
- upstream 基线：Electron 壳层以 OpenCode `packages/desktop`（v1.15.13 基线）为选择性 backport 参考，只回移安全/生命周期修复，不做整版本升级；改动以对基线的 git diff 追踪。

## Development Commands

从 packages/ellamaka-desktop/ 运行。

| Scenario | Command | When |
|---|---|---|
| 测试 | bun test --preload ./electron-mock.ts --force-exit src | Main/preload/renderer 逻辑 |
| 类型检查 | bun run typecheck | 修改 TypeScript 后 |
| 构建 | bun run build | 修改 Desktop 后 |
| macOS 开发包 | bun run package:mac | 检查打包和资源路径 |
| 联调帮助 | ./scripts/dev.sh help | 跨包 GUI 验证 |

修改 sidecar 代码后，Desktop 构建前先运行 bun script/build-node.ts 构建 opencode sidecar。

## Implementation Rules

- 校验 IPC 输入并保持 preload 方法 allowlisted。Renderer 不得取得任意 Node、filesystem 或 process 权限。
- 区分进程退出、传输断开和 renderer 重载；普通 UI cleanup 不销毁后端资源。
- 应用退出前等待 sidecar 和子进程清理完成；生命周期操作应幂等。
- 凭证留在可信进程边界内，不进入日志或 renderer 持久状态。
- 在构建应用中检查资源路径和更新 metadata；开发态路径不足以证明打包正确。

## Testing

- 生命周期单元测试使用 Electron mock 并遵循 TDD。
- 在目标操作系统验证平台生命周期和打包；其他系统构建不能替代目标系统退出/安装验证。
- GUI/native 行为使用真实 CDP 或平台运行验证，不能由单元测试观察的结果单独报告。

## User-Supplied Rules

（无）
