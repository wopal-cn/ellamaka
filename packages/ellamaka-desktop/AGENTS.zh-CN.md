---
name: ellamaka-desktop
description: Ellamaka Electron 桌面应用 — 基于 OpenCode packages/desktop 的 v1.15.13 基线
---

# Agent 开发规则

## 上游基线

- **来源**：OpenCode `packages/desktop`，提交 `385cb694419f98103af0e8fc6187ddcbcbb6eecb`（v1.15.13）
- **Electron**：41.2.1
- **同步策略**：仅选择性回移安全/生命周期修复。不进行跨版本整体升级。所有变更通过 `git diff` 对照基线跟踪。

## 架构

```
Electron Main Process
├── Window Manager（BrowserWindow 生命周期）
├── Sidecar Manager（packages/opencode node 运行时）
└── IPC Handler Registry
          │ IPC
Electron Preload（最小化、可验证的桌面 API）
          │
ellamaka-app Renderer（SolidJS SPA）
          │ HTTP / WebSocket
Ellamaka sidecar（packages/opencode/build-node.ts）
├── PTY Session Registry
├── 断连宽限回收器（10 秒）
└── PTY / TUI 进程
```

### 状态所有权

| 状态 | 所有者 | 生命周期 |
|-------|-------|-----------|
| Panel 布局、PTY ID 提示 | `ellamaka-app` / `localStorage` | 跨刷新、跨应用启动 |
| PTY Session、subscriber、Grace 计时器 | Ellamaka sidecar | 当前 sidecar 运行期 |
| PTY/TUI 操作系统进程 | Ellamaka sidecar | 当前 sidecar 运行期 |
| Sidecar 连接凭据 | Electron Main Process | 当前应用进程 |

### PTY 生命周期规则

- 最后一个 WebSocket subscriber 断开 → 10 秒 Grace → 自动终止
- Grace 内重连 → 取消计时器，复用原 PTY
- 显式 Panel/Space 关闭 → 立即终止（不等待 Grace）
- 应用退出 → Main Process 停止 sidecar → sidecar finalizer 终止全部 PTY 及子进程
- Renderer 崩溃 → sidecar 保持 PTY 在 Grace 期间存活；Renderer 可重连

## 开发命令

所有命令从 `packages/ellamaka-desktop/` 运行。

| 命令 | 用途 |
|---------|---------|
| `bun test --preload ./electron-mock.ts --force-exit src` | 运行测试（需 electron mock） |
| `bun run typecheck` | TypeScript 类型检查（`tsgo -b`） |
| `bun run build` | Vite + electron-vite 构建 → `out/` |
| `bun run package:mac` | macOS 未签名开发版 DMG/ZIP → `dist/` |

构建前置步骤：
```bash
# 先构建 sidecar
cd ../opencode && bun script/build-node.ts
# 构建桌面应用
cd ../ellamaka-desktop && bun run build
```

## 品牌

- 应用名称：Ellamaka（productName）
- Bundle ID：`ai.ellamaka.desktop.dev`（开发）、`ai.ellamaka.desktop`（生产）
- 协议：`ellamaka://`
- 设置存储：`ellamaka.settings`
- 认证：Basic auth `ellamaka:<password>`
- 服务名称：`ellamaka server`

## 关键文件

| 文件 | 角色 |
|------|------|
| `src/main/index.ts` | Main Process 入口 — 应用生命周期、窗口创建、sidecar 编排 |
| `src/main/sidecar.ts` | Sidecar worker 线程 — 服务监听/停止 |
| `src/main/server.ts` | Sidecar 启动、健康检查、环境配置 |
| `src/main/ipc.ts` | IPC handler 注册 |
| `src/main/constants.ts` | Channel、store key 常量 |
| `src/preload/index.ts` | Context bridge — ElectronAPI → `window.api` |
| `src/renderer/index.tsx` | Renderer 入口 — 平台设置、路由、sidecar 连接 |
| `electron-builder.config.ts` | 打包配置（未签名 macOS 开发构建） |
| `electron.vite.config.ts` | Vite 配置（main/preload/renderer 构建） |
