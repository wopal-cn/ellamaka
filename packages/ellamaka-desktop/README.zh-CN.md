---
name: ellamaka-desktop
description: Ellamaka Electron 桌面应用 — 基于 OpenCode packages/desktop 的 v1.15.13 基线
---

# ellamaka-desktop

## 上游基线

- **来源**：OpenCode `packages/desktop`，提交 [`385cb694419f98103af0e8fc6187ddcbcbb6eecb`](https://github.com/anomalyco/opencode/commit/385cb694419f98103af0e8fc6187ddcbcbb6eecb)（v1.15.13）
- **Electron**：41.2.1
- **同步策略**：仅选择性回移安全/生命周期修复。不进行跨版本整体升级。所有变更通过 `git diff` 对照基线跟踪。

## 运行架构

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
Ellamaka Sidecar（packages/opencode/build-node.ts）
├── PTY Session Registry
├── 断连宽限回收器（10 秒）
└── PTY / TUI 进程
```

### 核心设计原则

Electron 是"薄壳"——只负责窗口管理和 sidecar 生命周期。所有 PTY、TUI、Session 管理都在 sidecar 内。Renderer 与浏览器版 Workbench 使用完全相同的 PTY 逻辑。

### 各层职责

| 层 | 职责 |
|---|---|
| **Main Process** | 创建窗口、启动/停止 sidecar、持有 sidecar 连接凭据。应用退出时终止 sidecar 及全部子进程 |
| **Preload** | 暴露最小化 IPC 接口（窗口、文件选择、菜单、更新、sidecar 初始化）。Renderer 启用 context isolation，不启用 Node integration |
| **Renderer** | 即 `@wopal/ellamaka-app` 的 `/workbench` 路由。通过 `PlatformProvider` 获得 `platform: "desktop"`，用于文件选择、菜单、更新和系统集成 |
| **Sidecar** | 从 `packages/opencode` 构建的 node 运行时。只监听 loopback，每次启动生成临时认证凭据。负责 PTY 创建、探测、重连、Grace 回收和显式删除 |

### 与 ellamaka-app Workbench 的关系

Workbench 不知道自己在浏览器还是 Electron 中运行。它通过 `PlatformProvider` 获得平台适配能力：

| 能力 | 浏览器 | Electron |
|------|--------|----------|
| 文件选择 | 浏览器原生 | 通过 Preload IPC |
| 菜单 | 无 | Electron 原生菜单 |
| 更新 | 无 | Electron updater |
| PTY 生命周期 | 完全相同 | 完全相同 |

PTY 创建、探测、重连、删除逻辑完全共享，不因平台分叉。Electron Renderer 只增加桌面平台适配层，不维护独立的 PTY 所有权副本。

### 状态所有权

| 状态 | 权威所有者 | 生命周期 |
|------|-----------|----------|
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

### Sidecar 启动流程

```
Electron Main Process (src/main/index.ts)
        │
        ▼
  src/main/server.ts
        │
        ├─ 1. 计算 sidecar 路径（packages/opencode/build-node.ts 构建产物）
        ├─ 2. 生成随机端口 + 临时认证凭据 (ellamaka:<random-password>)
        ├─ 3. 设置环境变量：WOPAL_HOME、端口、密码
        ├─ 4. 启动 sidecar 子进程
        ├─ 5. 健康检查轮询：GET /api/health
        └─ 6. 凭据通过 Preload IPC 交给 Renderer
               │
               ▼
        Renderer 获取 URL + 凭据后：
        ├─ 创建 API client（HTTP Basic Auth）
        ├─ 连接 WebSocket（PTY）
        └─ 订阅 SSE（实时事件）
```

## 开发命令

所有命令从 `packages/ellamaka-desktop/` 运行。

| 命令 | 用途 |
|------|------|
| `bun test --preload ./electron-mock.ts --force-exit src` | 运行测试（需 electron mock） |
| `bun run typecheck` | TypeScript 类型检查（`tsgo -b`） |
| `bun run build` | Vite + electron-vite 构建 → `out/` |
| `bun run package:mac` | macOS 未签名开发版 DMG/ZIP → `dist/` |

## 构建步骤

```bash
# 1. 先构建 sidecar（必须）
cd ../opencode && bun script/build-node.ts

# 2. 构建桌面应用
cd ../ellamaka-desktop && bun run build

# 3. 打包 macOS 安装包（开发版，未签名）
bun run package:mac
```

## 测试

```bash
# 单元测试（需要 electron-mock 预加载）
cd packages/ellamaka-desktop
bun test --preload ./electron-mock.ts --force-exit src

# 类型检查
bun run typecheck

# 全仓类型检查
bun turbo typecheck
```

`--preload ./electron-mock.ts` 模拟了 Electron API（`electron`、`electron-store` 等），使测试在 Node/Bun 环境下可运行，无需启动真实 Electron 窗口。

## 基线检查

```bash
# 验证 packages/desktop/ 未偏离 v1.15.13 基线
bash scripts/check-desktop-baseline.sh

# 验证 packages/app/ 未偏离 v1.15.13 基线
bash scripts/check-app-baseline.sh
```

## 验证契约

详见 `docs/DESKTOP.md` §11。可自动化验证的已通过 CI。需要手动运行时验证的：

| # | 验证内容 | 操作 |
|---|---------|------|
| 1 | Electron 启动后加载 Workbench `/workbench` | 启动应用，确认界面是 Workbench |
| 3 | TUI/Terminal 可创建、输入、输出、调整尺寸 | 创建 Session，切换 TUI 视图 |
| 4 | Renderer 刷新后 PTY ID 和 PID 不变 | 创建 TUI 后 `Cmd+R` 刷新 |
| 5 | 刷新不创建重复 PTY | 刷新后 sidecar 中 PTY 数量不变 |
| 6 | Panel 关闭后对应 PTY 进程消失 | 关闭 Panel |
| 7 | Space 关闭后全部 PTY 消失 | 关闭 Space Tab |
| 9 | 应用退出后 sidecar 和子进程全部终止 | 退出应用，`ps aux \| grep` 确认 |
| 11 | Renderer 异常退出后可重连 | 模拟崩溃后恢复 |

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

## 安全边界

- BrowserWindow 启用 context isolation，Renderer 不启用 Node integration
- Preload 只暴露明确允许的 IPC 方法
- Sidecar 只监听 loopback，每次启动生成临时认证凭据
- 认证凭据由 Main Process 持有，不写入 `localStorage`
- PTY 探测、重连和删除经过现有认证与 directory 路由边界
- 应用退出由 Main Process 统一终止 sidecar 和子进程组
