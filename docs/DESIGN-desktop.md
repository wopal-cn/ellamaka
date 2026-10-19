# ellamaka-desktop 设计

> **Status**: Active
> **Updated**: 2026-10-15
> **Parent**: `./DESIGN.md`
> **Sibling DESIGNs**:
>
> - `./DESIGN-wopalspace.md` — WopalSpace Setup 与 CorePreparation integration boundary
> - `./DESIGN-onboarding.md` — Renderer 使用的统一 WopalSpace Setup/Onboarding
> - `./DESIGN-ellamaka-sdk.md` — Renderer 的 Public Platform SDK 与 App-private BFF 边界

本文档描述 `packages/ellamaka-desktop` 的目标架构。桌面应用承载 `ellamaka-app` Workbench。Electron 主进程管理窗口和本地 sidecar，sidecar 统一管理 Web 与 Desktop 的 PTY 生命周期。

## 设计目标

`ellamaka-desktop` 提供稳定的本地桌面运行环境，使 Workbench 的界面生命周期与后台进程生命周期相互独立。Web 与 Desktop 共用 sidecar 的 PTY 断连宽限机制。

- Renderer 刷新只重载界面，已有 TUI 和 Terminal 继续运行。
- Panel 和 Space 主动关闭时立即释放对应 PTY；页面或窗口关闭后由 sidecar 在宽限期结束时回收 PTY。
- 应用退出时，系统终止全部 sidecar 和子进程。
- `ellamaka-app` 同时服务浏览器和桌面端，两种环境共享产品能力与 PTY 生命周期，并分别接入浏览器和 Electron 系统能力。
- 一次 Desktop build 内的桌面包、Engine sidecar、SDK 和 app 使用同一 Ellamaka source commit；OpenCode 只作为选择性 fix/功能的参考来源，不参与 Desktop release identity。

## 包定位与版本基线

### 包定位

| 包       | 路径                         | 角色                       | 修改规则             |
| -------- | ---------------------------- | -------------------------- | -------------------- |
| 品牌产品 | `packages/ellamaka-desktop/` | 可编辑的 Ellamaka 桌面应用 | 正常开发、修改、定制 |

需要参考 OpenCode 桌面实现时，从 `labs/ref-repos/opencode/packages/desktop` 读取。上游安全修复或兼容修复经评估后手工移植到 `packages/ellamaka-desktop/`。

### 独立复制模式

`packages/ellamaka-desktop` 与 `ellamaka-app` 采用相同的品牌包模式，集中承载 Ellamaka 桌面定制。

| 维度     | 上游 `packages/desktop`                         | `packages/ellamaka-desktop`        |
| -------- | ----------------------------------------------- | ---------------------------------- |
| 包路径   | 参考 `labs/ref-repos/opencode/packages/desktop` | `packages/ellamaka-desktop`        |
| 包名     | `@opencode-ai/desktop`                          | `@wopal/ellamaka-desktop`          |
| 桌面框架 | Electron                                        | Electron，版本由本包依赖与测试决定 |
| 渲染应用 | 参考 `labs/ref-repos/opencode/packages/app`     | `@wopal/ellamaka-app`              |
| 本地服务 | OpenCode node sidecar                           | Ellamaka/WopalSpace node sidecar   |
| 默认界面 | OpenCode 主界面                                 | Ellamaka Workbench `/workbench`    |

### Source 协同与产品版本

`ellamaka-desktop`、`ellamaka-app`、`packages/opencode` 和 JS SDK 在一次 Desktop build 内使用同一 Ellamaka source commit，避免跨源码快照组合。这个 source 一致性不等于产品版本锁步：`ellamaka-desktop` 与外部 `ellamaka-cli` 各自使用独立 SemVer 和 release tag。

Electron 安全修复、生命周期修复和平台兼容修复可以只发布 Desktop patch。共享 Engine/API 变化可能需要协调发布 CLI 与 Desktop；component 版本仍独立。External CLI 与 Desktop 没有 runtime 配对门禁。Host 即使一次选择 CLI + Desktop，也分别验证和提交两个 component；Dormant peer 不参与 Desktop runtime。

## 系统架构

```text
Electron Main Process
├── Window Manager
└── Sidecar Manager
          │ IPC
Electron Preload
          │ allowlisted desktop API
ellamaka-app Renderer
          │ HTTP / WebSocket
Ellamaka node sidecar
├── PTY Session Registry
├── Disconnect Grace Reaper
└── PTY / TUI processes
```

### Electron Main Process

Main Process 是桌面应用与本地服务的所有者，负责：

- 创建和管理 BrowserWindow。
- 启动、监控和停止 Ellamaka sidecar。
- 执行桌面菜单、文件选择、系统通知、更新和深链接能力。
- 在应用退出时停止 sidecar，使 sidecar finalizer 释放全部 PTY。

### Preload

Preload 暴露最小化、可验证的桌面 IPC 接口。Renderer 通过该接口访问窗口、文件系统、菜单、更新和 sidecar 初始化能力。PTY 生命周期继续使用现有 HTTP 和 WebSocket 契约，Renderer 保持浏览器安全边界。

### ellamaka-app Renderer

Renderer 负责 Workbench 的布局、交互和终端连接。桌面构建使用 `ellamaka-app` 的：

- 根导出与 Provider。
- Vite 插件和 CSS。
- public 静态资源。
- i18n 字典。
- `/workbench` 路由。

Renderer 通过 `PlatformProvider` 获得 `platform: "desktop"`，用于文件选择、菜单、更新和系统集成。PTY 生命周期不按平台分叉，也不通过 User-Agent 推断运行环境。

`ellamaka-app` 在浏览器和 Electron 中使用相同的 PTY 创建、探测、重连和显式删除逻辑。Electron Renderer 只增加桌面平台适配，不维护独立的 PTY 所有权副本。

**桌面快捷键规约**：

- 桌面环境（Electron）中，`Cmd + W` 快捷键受受控拦截保护：允许关闭未钉住的临时 Space Tab 或当前选中的 Panel；**凡处于钉住 (Pinned) 状态的 Tab（包括 General 日常对话 Tab 及已 Pin 的物理 Space Tab）严禁通过 `Cmd + W` 误操作关闭**。

**macOS 窗口标题栏与红绿灯避让规约**：

- 在 macOS Desktop 环境中，`BrowserWindow` 设置 `titleBarStyle: "hidden"` 及 `trafficLightPosition: { x: 12, y: 14 }`。
- `ellamaka-app` 的 Topbar组件必须保持 `flex-col` 结构，将 28px 高度的拖拽占位区 (`workbench-macos-window-chrome`) 放在最上方，Logo 与交互元素放置于下方的 toolbar 容器中，严禁在全局重构中将顶栏平铺混叠导致视觉撞车。

### Ellamaka sidecar

Desktop sidecar 是 **随 Desktop 打包、由 Desktop 管生命周期的 Ellamaka Server host**。它使用与 `ellamaka serve` 相同的 Server composition，而不是另一种 Runtime 或另一套 Onboarding。

Electron Main 只负责 sidecar 的进程生命周期、随机本地端口、本地认证、重启与退出。Ellamaka Runtime 负责 HTTP/SSE/WebSocket、Session、PTY 与 Core activation；WopalSpace integration layer 在同一 Server composition 上挂载 Setup/Onboarding HTTP projection。

Sidecar 使用单一 Server Runtime 生命周期。Server listener、基础 Runtime 与 WopalSpace API 就绪后，sidecar 先报告 Server health；Desktop Main 随即创建并显示窗口。sidecar 再检查自己的 embedded Core Runtime Descriptor，并通过 `CorePreparation` 在后台准备当前 Desktop build 需要的运行资源。DSH 等附加能力处于 `PREPARING/DEGRADED` 时只影响对应能力，不阻断已经可用的 native Runtime，也不延迟窗口出现。

Renderer 连接同一个 Server：Setup/Onboarding 与 Runtime/WopalSpace 平台能力通过 `@wopal/ellamaka-sdk/http`，Workbench 产品专用 projection/use case 通过 `ellamaka-app` 的 private BFF client。Desktop Main 不维护第二套 Setup 状态机，也不负责产品安装。

一个 sidecar 同时承载非 WopalSpace 与多个 WopalSpace directory instance。每个配置加载和插件创建按 directory 独立检测可选 `wopalSpaceRoot`。空间根与空间内任意子目录共享同一个值；非 WopalSpace instance 保持 OpenCode-compatible capability loading，并使用 WOPAL_HOME 全局配置与能力层。

PluginInput 使用 `wopalSpaceRoot` 接收当前 instance 的空间根。Instruction 使用 Config 的当前模式保持既有兼容行为。Sidecar 的 `process.env` 不表达当前空间，也不装载 `$WOPAL_HOME/.env` 或空间 `.env`；`.env` 由每次 plugin invocation 的 effective env loader 消费。Shell、PTY、MCP 与 LSP 保持官方的运行时行为。

PTY Service 是 PTY 生命周期的权威所有者。最后一个 WebSocket subscriber 断开时，服务进入断连宽限期；同一 PTY 在宽限期内重新连接时继续运行，宽限期结束后仍未连接则自动终止。

### Desktop Server / Onboarding / Activation

```text
Electron Main
  -> start packaged Ellamaka Server
  -> wait Server health (listener + native Runtime + WopalSpace API)
  -> create and show the window
  -> Renderer connects through public SDK + app-private BFF client
  -> WopalSpace setup.plan decides /onboarding vs /workbench
sidecar (background)
  -> CorePreparation(current embedded build)
       -> Ready: activate required DSH capabilities
       -> Degraded: keep native Runtime + diagnosis
  -> Space materialized
       -> CorePreparation(instance(directory)) for plugin dependencies
```

DSH preparation progress and terminal state reach the Renderer through `/global/health` and the `core.preparation` events. The window and native sessions never wait for DSH.

An unversioned Home adoption is confirmed once by the Desktop entry after the window is available. The confirmation is a Desktop window-level dialog, never an Onboarding step; Setup does not drive CorePreparation. Confirming asks the sidecar to adopt Home under the exclusive lock and then mount DSH. Declining keeps DSH degraded and the application usable; the same confirmation appears on the next launch while Home remains unadopted.

Core readiness 不是是否展示 Onboarding 的唯一条件。Renderer 依据 Setup state 和 machine facts 进入配置阶段或运行阶段。Desktop Main 不读取 `onboarding.json` 推断 Core，也不实现 closure materializer、Home backup 或 plugin dependency installer。

Desktop build 自己的 embedded Core Runtime Descriptor 决定 DSH manifest/fingerprint 与所需 resources；Renderer/request 不能覆盖这些值。

### Product Inventory and Component Status

Desktop Main 只证明自身 embedded ReleaseIdentity、appId/channel、sidecar source 和 Core Runtime Descriptor 一致。External CLI、Wopal CLI 或另一个 Desktop channel 的版本不参与当前 sidecar 启动资格。

产品安装、补齐和更新继续由 Wopal CLI Product / 当前产品 updater 拥有。GUI Onboarding 不调用 private WopalSpace product service，也不安装 Wopal CLI 或 external Ellamaka CLI；需要时只展示当前事实与用户操作指引。

Desktop 自动更新只更新当前 Desktop/channel。

## 状态所有权

桌面应用将持久化界面状态、临时运行时状态和后台进程分层管理。

| 状态                                                   | 权威所有者                       | 生命周期                                         |
| ------------------------------------------------------ | -------------------------------- | ------------------------------------------------ |
| Panel 布局、宽度、绑定 Session、directory、PTY ID 提示 | `ellamaka-app` / `localStorage`  | 跨刷新、跨应用启动                               |
| PTY session、subscriber、断连回收计时                  | Ellamaka sidecar                 | 当前 sidecar 运行期                              |
| PTY/TUI 操作系统进程                                   | Ellamaka sidecar                 | 当前 sidecar 运行期                              |
| Directory WopalSpace context                           | Ellamaka sidecar `InstanceState` | 当前 directory instance；空间根和子目录共享 root |
| Sidecar 连接凭据                                       | Electron Main Process            | 当前应用进程                                     |

`localStorage` 继续负责 Workbench 布局，并将 PTY ID 作为重连提示保存。Sidecar 的 PTY Session Registry 是进程存活状态的真相源。Renderer 每次使用持久化 PTY ID 前都通过 `ptyManager.ensure()` 探测；2xx 表示存活并复用，明确 404 表示已回收并清除旧 ID，传输失败或非权威响应表示状态未知并保留旧 ID。只有 `dead` 结果才能触发 PTY 重建。

## PTY 断连宽限模型

每个 PTY Session 维护当前 WebSocket subscribers 和一个可取消的回收任务。默认断连宽限期为 10 秒。

| 状态      | 进入条件                                       | 行为                                         |
| --------- | ---------------------------------------------- | -------------------------------------------- |
| Connected | 至少一个 subscriber 已连接                     | PTY 正常运行，回收任务保持取消状态           |
| Grace     | PTY 创建后尚未连接，或最后一个 subscriber 断开 | PTY 继续运行并开始 10 秒倒计时               |
| Disposed  | 宽限期结束仍无 subscriber，或收到显式 DELETE   | 终止进程、关闭连接并从 Session Registry 删除 |

新连接进入时取消该 PTY 的回收任务。多个 subscribers 共享同一 PTY 时，只有最后一个连接断开才进入 Grace。

Workbench 对需要继续运行的隐藏 TUI 和收起的 Split Terminal 保持 subscriber 连接。普通视图切换只改变可见性，不让活跃 PTY 进入 Grace。

`directory` 与 Workbench `spacePath` 保持独立。所有 PTY 探测和显式删除请求使用 PTY 创建时的真实 directory。

## 生命周期行为

### 创建 PTY

1. Renderer 请求 sidecar 创建 PTY。
2. Sidecar 返回 `ptyID`。
3. Renderer 将 PTY 绑定到 Panel。
4. Renderer 建立 PTY WebSocket 连接。
5. Sidecar 将连接加入该 PTY 的 subscribers，并取消可能存在的回收任务。

PTY 连接建立后，Renderer 刷新不会改变其后台进程所有权。

### Renderer 刷新

1. Workbench flush 当前布局。
2. 页面生命周期分支保留 PTY ID，不执行 `pagehide` 删除逻辑，也不显示浏览器离开警告。
3. Renderer 和 PTY WebSocket 连接被销毁。
4. Sidecar 在最后一个 subscriber 断开后进入 10 秒 Grace。
5. 新 Renderer 从 `localStorage` 读取布局和 PTY ID 提示。
6. Renderer 使用 `ptyID + directory` 探测已有 PTY。
7. 探测成功后重新建立 WebSocket 连接，sidecar 取消回收任务。
8. 已失效的 PTY 从布局缓存中清除，并按需创建新 PTY。

若第 6 步发生 `Failed to fetch`、超时或其他传输错误，Renderer 保留 PTY ID 和 Panel 布局并继续重连；不得在 sidecar 启动窗口内把未知状态误判为 PTY 已失效。

刷新前后复用同一个 PTY ID 和操作系统进程。

### Panel 或 Space 关闭

1. Renderer 使用真实 directory 请求 sidecar 终止 PTY。
2. Sidecar 确认终止。
3. Renderer 清除 Panel 的 PTY 绑定。

Space 关闭按相同流程处理该空间全部 Panel PTY。

### 桌面窗口关闭

1. BrowserWindow 销毁 Renderer，PTY WebSocket 随之断开。
2. Sidecar 将失去最后 subscriber 的 PTY 置为 Grace。
3. 窗口未恢复连接时，sidecar 在 10 秒宽限期结束后终止对应 PTY。

窗口关闭与浏览器 Tab 关闭共用同一套断连回收语义。Sidecar 通过 WebSocket subscriber 状态完成回收判定，Electron 保持轻量桌面外壳职责。

### 应用退出

1. Main Process 停止本地 sidecar。
2. Sidecar finalizer 终止 Session Registry 中的全部 PTY。
3. Main Process 终止 sidecar 子进程组。
4. Electron 应用退出。

Sidecar 停止是应用级兜底，确保未完成单项清理的进程随应用一起终止。

### Renderer 异常退出

Renderer 崩溃不会立即终止 PTY。Sidecar 将断开的 PTY 置为 Grace，使 Renderer 在宽限期内恢复并重新连接。超过宽限期仍未恢复的 PTY 自动回收。

## Web 与 Desktop 生命周期

| 场景              | 浏览器 Workbench       | ellamaka-desktop        |
| ----------------- | ---------------------- | ----------------------- |
| Renderer/页面刷新 | 宽限期内重连并保留 PTY | 宽限期内重连并保留 PTY  |
| 浏览器 Tab 关闭   | 宽限期结束后回收 PTY   | 不适用                  |
| Panel/Space 关闭  | 立即终止对应 PTY       | 立即终止对应 PTY        |
| 桌面窗口关闭      | 不适用                 | 宽限期结束后回收 PTY    |
| 应用退出          | 不适用                 | 终止全部 PTY 和 sidecar |

两种环境共享 `PtyManager` 的创建、探测、重连和显式删除能力，也共享 sidecar 的断连宽限机制。Electron 只提供桌面外壳和 sidecar 生命周期。

## Sidecar 集成

桌面构建通过 `packages/opencode/script/build-node.ts` 生成 node runtime。Electron 构建将该 runtime 作为 Main Process 可加载的 sidecar 模块。

Sidecar 启动环境遵循 Ellamaka 路径和配置体系：

- 使用 `~/.wopal/` 下的配置、数据、缓存和状态目录。
- 加载 Ellamaka 品牌配置与 WopalSpace 能力。
- 挂载 Workbench App BFF 所需的 Session Tree / creation locations / Session provision / DSH embed private API。
- 保持 `x-opencode-directory`/directory query 的实例路由契约。
- 在 PTY 创建后启动首次连接宽限任务。
- 在 PTY 最后一个 subscriber 断开时启动 10 秒回收任务，在重新连接时取消任务。
- 在收到显式 PTY DELETE 或 Instance finalizer 执行时立即终止进程。
- 禁用 sidecar 自身的嵌入式 Web UI，由 Electron Renderer 提供界面。

Main Process 只检查 sidecar 的 Server health，确认 listener/认证可连接。Renderer 通过公开 SDK 读取 Setup plan 与 Runtime/Core 状态，并通过 app-private BFF client 取得 Workbench 产品投影，据此显示 GUI Onboarding 或 Workbench。

Sidecar 生命周期由 `SidecarSupervisor`（[SidecarSupervisor 状态机](#sidecarsupervisor-状态机)）管理，提供自动重启、退避策略和状态广播。Main Process 不再直接调用 `spawnLocalServer`，而是通过 Supervisor 的 `start()`/`stop()`/`restart()` 接口控制 sidecar。

## 安全边界

- BrowserWindow 启用 context isolation，Renderer 不启用 Node integration。
- Preload 只暴露明确允许的 IPC 方法。
- Sidecar 只监听 loopback，并使用每次启动生成的认证凭据。
- 认证凭据由 Main Process 持有，不写入 `localStorage`。
- PTY 探测、重连和删除继续经过现有认证与 directory 路由边界。
- 应用退出由 Main Process 统一终止 sidecar 和子进程组。

## 品牌与桌面身份

桌面应用使用 Ellamaka 独立身份：

- 产品名称、可执行文件名和安装包名称使用 Ellamaka。
- App ID、协议、用户数据目录和日志目录与 OpenCode 隔离。
- 图标、菜单、窗口标题、通知和更新界面使用 Ellamaka 品牌资源。
- Deep Link 使用 Ellamaka 自有协议并由 Main Process 路由到 Workbench。
- 更新源、签名和发布渠道由 Ellamaka 分发体系管理。

品牌值集中定义并由构建层消费，Renderer 和 Main Process 不分散硬编码用户可见品牌。

## 验证契约

桌面实现满足以下行为：

1. Electron 启动后连接 packaged Ellamaka Server；Setup 已完成时进入 `/workbench`，未完成时进入统一 GUI Onboarding。DSH/Core 附加能力的 preparing/degraded 状态按能力显示，不把整个 Server 分成 Bootstrap/Full 两阶段。
2. 本地 sidecar 使用 Ellamaka/WopalSpace 配置启动。
3. TUI 和 Terminal 可以创建、输入、输出和调整尺寸。
4. Renderer 刷新后 PTY ID 和操作系统 PID 保持不变。
5. 刷新不会创建重复 PTY。
6. Panel 关闭后对应 PTY 进程消失。
7. Space 关闭后该空间全部 PTY 进程消失。
8. 浏览器 Tab 或桌面窗口关闭后，失去全部 subscribers 的 PTY 在宽限期结束时消失。
9. 应用退出后 sidecar 和全部子进程消失。
10. 多目录 Panel 的 PTY 删除始终路由到各自真实 directory。
11. Renderer 异常退出并恢复后能够重新连接仍然存在的 PTY。
12. 浏览器版 Workbench 与桌面版共享断连宽限和显式删除语义。
13. 多个 subscribers 连接同一 PTY 时，单个连接断开不会启动回收。
14. 显式 DELETE 不等待宽限期，立即终止 PTY。
15. PTY 创建后始终在宽限期内建立第一个 subscriber；连接未建立时自动回收。
16. TUI 视图隐藏或 Split Terminal 收起超过宽限期后，PTY 仍保持运行。

## 上游关系

参考实现从 `labs/ref-repos/opencode/packages/desktop` 读取，按人工 review 选择性 cherry-pick 或移植：

- Electron 安全更新保持优先级，并通过完整桌面回归验证。
- bug fix 按依赖、接口和行为逐项移植。
- 需要的功能先按 Ellamaka Desktop/Engine contract 评估，再吸收必要部分，不进行整体上游合并。

包级 `AGENTS.md` 维护开发命令、测试方式、生命周期规则和上游参考规则。品牌差异与分发身份见 `DESIGN.md` 品牌身份与 `DESIGN-distribution.md`，本文件维护桌面架构和运行时行为。

## SidecarSupervisor 状态机

`SidecarSupervisor`（`packages/ellamaka-desktop/src/main/sidecar-supervisor.ts`）是 Main Process 中 sidecar 运行时的真相源。它替代了 `server.ts` 中 `spawnLocalServer` 的一次性 Promise，提供完整的 sidecar 生命周期管理。

### 状态定义

| 状态         | 含义                                                      |
| ------------ | --------------------------------------------------------- |
| `starting`   | 正在启动 sidecar 进程，等待 Server health 通过         |
| `ready`      | Server 可连接；不表示所有附加能力 READY 或 Setup 已完成 |
| `lost`       | Sidecar 进程退出或启动失败，等待自动重试                  |
| `restarting` | 正在执行自动重启（spawn 新进程）                          |
| `failed`     | 连续 3 次重启失败，停止自动重试                           |
| `stopped`    | 应用退出或用户主动停止，不触发自动重启                    |

### 状态转换

```
starting → ready     (spawn 成功 + Server health 通过)
starting → lost      (spawn 失败)
ready → lost         (sidecar 进程退出)
lost → restarting    (退避延迟后自动重试)
restarting → ready   (重启成功)
restarting → lost    (重启失败，继续重试)
restarting → failed  (连续 3 次失败)
failed → starting    (用户手动重试)
* → stopped          (应用退出 / 用户停止)
```

### 串行化

所有 `start()`、`restart()`、`stop()` 操作通过内部 Promise 链串行化。同一时刻最多一个 spawn 操作。并发调用自动合并到同一操作队列。

### Terminal Reason

用户主动停止、安装更新、应用退出时设置 terminal reason（`user`/`update`/`quit`）。terminal reason 设置后，sidecar 退出不触发自动重启。

### 接口

```ts
class SidecarSupervisor {
  getState(): SidecarRuntimeState
  subscribe(listener: (state: SidecarRuntimeState) => void): () => void
  start(): Promise<void>
  restart(reason: SidecarTerminalReason | "auto"): Promise<void>
  stop(reason: SidecarTerminalReason): Promise<void>
  waitForReady(): Promise<SidecarRuntimeState>
}
```

## IPC allowlist 与 Preload

### 新增 IPC 通道

| 通道                | 方向                     | 用途                                |
| ------------------- | ------------------------ | ----------------------------------- |
| `get-sidecar-state` | Renderer → Main (invoke) | 获取当前 SidecarRuntimeState        |
| `restart-sidecar`   | Renderer → Main (invoke) | 用户手动重启 sidecar                |
| `sidecar-state`     | Main → Renderer (send)   | Supervisor 状态变化时广播到所有窗口 |

### Preload API

```ts
// ElectronAPI 新增方法
getSidecarState: () => Promise<SidecarRuntimeState>
onSidecarState: (cb: (state: SidecarRuntimeState) => void) => () => void
restartSidecar: () => Promise<void>
```

`onSidecarState` 返回 unsubscribe 函数，与现有 `onMenuCommand`、`onDeepLink` 等保持一致的取消订阅模式。

### awaitInitialization 兼容

`awaitInitialization` 只等待 SidecarSupervisor 进入 `ready`（Server 可连接），不表示 Setup 或 DSH 等附加能力已经 READY。Renderer 挂载后通过 `onSidecarState` 持续订阅 sidecar 生命周期，并通过 Onboarding/health API 获取 Core 与初始化状态。

### 凭据保护

`SidecarRuntimeState.connection` 包含 `password`。Preload 不写 `localStorage`，凭据只在 Main/Preload/Renderer 内存中传递。

## 重启策略与退避

### 退避参数

| 参数             | 值           |
| ---------------- | ------------ |
| 退避序列         | 1s → 2s → 5s |
| 最大连续失败次数 | 3            |
| 稳定窗口         | 60s          |

### 退避行为

- Sidecar 退出后立即进入 `lost` 状态，attempt 计数 +1
- 按 `backoffMs[attempt-1]` 延迟后进入 `restarting`，spawn 新进程
- 重启成功 → `ready`，attempt 清零
- 重启失败 → `lost`，继续下一次退避
- 连续 3 次失败 → `failed`，停止自动重试
- Sidecar 稳定运行 60s 后 attempt 清零（稳定窗口重置）

### 用户手动重试

`failed` 状态下用户可通过 `restartSidecar()` 手动重试。手动重试重置 attempt 计数器，清除 terminal reason。

## sidecar generation 与 PTY 恢复

### generation 概念

每次 sidecar 成功 spawn（Server health 通过）时，`SidecarSupervisor` 的 generation 计数器 +1。generation 通过 `SidecarRuntimeState` 传递给 Renderer，并注入到 `ServerConnection.Sidecar.generation` 字段。

### sidecar 连接身份变化

Desktop 的选择键保持稳定别名 `sidecar`，不能用于判断 sidecar 是否重启。`ServerConnection.key(server.current)` 对实际 sidecar 连接使用 `{url}#gen{N}` 格式。Renderer 在 `lost` / `restarting` 期间保留最后一次 ready 连接及其 generation；只有新的 ready generation 到达后，Workbench 才观察到连接身份变化并触发连锁反应：

1. `workbench-sidecar-cleanup.tsx` 的 `createEffect` 监听到实际连接身份变化（跳过首次）
2. 调用 `WorkbenchActions.clearAllPtyForServerChange()`
3. 清空所有 Panel 的 `tuiPtyId`/`termPtyId`/`splitPtyId`
4. TUI 视图切回 Chat
5. Split Terminal 关闭
6. `ptyManager` 内存引用清理
7. 显示一次性诊断提示："Sidecar restarted — PTY sessions have been reset"

### 三种场景对比

| 场景             | generation 变化 | PTY 行为                                    |
| ---------------- | --------------- | ------------------------------------------- |
| Sidecar 崩溃重启 | 是              | 立即清理所有 PTY 状态，TUI→Chat，Split 关闭 |
| SSE 断线重连     | 否              | 保留 PTY，10s Grace 内重连复用              |
| Renderer 刷新    | 否              | 保留 PTY，10s Grace 内重连复用              |

### 不自动恢复

PTY 清理后不自动创建 Session 或 PTY 伪装恢复。用户点击 TUI/Terminal 后按正常 Action 创建新 PTY。Session 绑定和草稿保留。

## Onboarding 启动行为

Desktop 没有独立 Onboarding lifecycle，也没有独立 Onboarding backend。`ellamaka-app` 同时包含 `/onboarding` 与 `/workbench`。

```text
Desktop cold start
  -> start packaged Ellamaka Server
  -> sidecar prepare current embedded build as startup fallback
  -> Renderer reads WopalSpace Setup state through @wopal/ellamaka-sdk/http
       Setup incomplete -> /onboarding
       Setup complete   -> /workbench
```

`$WOPAL_HOME/ellamaka/state/onboarding.json` 由 private `@wopal/wopalspace/setup` 管理。Desktop Main 不拥有或清除该状态。某个 Space 的 plugin dependency 变化只影响该 instance。

### Startup Product Identity

Desktop 在 sidecar 前校验自身 `resources/release-identity.json` 的 product/version/channel 与 app/内嵌 sidecar 一致。基础 HTTP、Core 与 Onboarding 不因 external CLI 或 Wopal CLI 缺失而停止。

启动 DSH 前，packaged sidecar 的 Core Preparation 从自身 embedded build identity 读取 closureVersion；Renderer/Desktop Main 不传也不能覆盖它。其他 CLI/Desktop 安装只有在自己真正启动时才参与 Home version check。多个 release 可以留在同一台机器上，旧版本不会在较新版本已接管 Home 后继续打开它。

自动更新继续校验当前 Desktop channel 的 target identity/平台/SemVer。更新后的 DSH Home 版本检查与备份由 Runtime 独立执行。
