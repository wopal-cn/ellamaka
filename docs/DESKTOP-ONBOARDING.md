# Desktop Onboarding — 目标实现规范

> **状态**: Target Shape
> **更新时间**: 2026-08-04
> **上级文档**:
>
> - `../../../docs/products/wopal-space/DESIGN-onboarding.md` — 统一入口架构与职责边界
> - `./DESKTOP.md` — Desktop 启动、窗口与 sidecar 生命周期
>   **CLI machine 契约**: `../../../projects/wopal-cli/src/lib/setup-machine.ts`

本文档定义 Ellamaka Desktop onboarding 的目标实现。入口判定只依赖 `onboarding.json`（Desktop-owned UI 状态）；CLI machine operation 的输入、输出和业务语义以 wopal-cli 代码为准。

---

## 1. 实现架构

```text
SolidJS Onboarding Renderer
  └── Preload allowlist
        └── Electron Main
              ├── onboarding UI state / IPC / logging
              ├── CLI bootstrap and process lifecycle
              └── wopal setup --machine --json --api-version 1
```

| 层       | 实现责任                                                                                                                     | 主要位置                                       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Renderer | 呈现四阶段 onboarding、收集用户输入、触发 probe/execute、显示进度和结果、控制用户确认导航。                                  | `src/renderer/onboarding/`                     |
| Preload  | 向 Renderer 暴露最小化 onboarding API。                                                                                      | `src/preload/index.ts`、`src/preload/types.ts` |
| Main     | 读取 onboarding 状态决定入口，bootstrap CLI，编排步骤执行，保存 UI 状态并治理 CLI 子进程。                                   | `src/main/onboarding-*.ts`                     |
| CLI      | 执行安装、Ontology、Runtime、Space、Provider 和 Memory 的确定性变更。                                                        | `wopal setup --machine`                        |

Renderer 不直接访问文件系统或启动子进程。它不依赖 sidecar、Server 或 SDK。冷启动进入 onboarding 时不挂载 Workbench，健康门禁完成前 sidecar 保持未启动。onboarding 本身不依赖 sidecar 完成配置。

## 2. 启动门禁与状态

Desktop 在启动时解析 `WOPAL_HOME`。GUI 进程缺少 shell 环境时，Main 从登录 shell 补齐该变量；不可用时使用默认目录。

Main 随后读取 `$WOPAL_HOME/ellamaka/state/onboarding.json` 决定入口：

| 条件                          | Desktop 行为                                              |
| ----------------------------- | --------------------------------------------------------- |
| 状态文件缺失                  | 创建 onboarding 窗口（首次配置），不启动 sidecar          |
| 状态文件存在但 `completed` 未真 | 创建 onboarding 窗口（恢复），不启动 sidecar              |
| `completed === true`          | 启动 sidecar 并进入 Workbench                             |
| CLI bootstrap 失败            | 创建 onboarding 窗口，并展示 bootstrap 诊断               |

`onboarding.json` 是界面恢复载体。状态包含当前阶段、步骤展示状态、结构化结果、可展示错误和更新时间。它不保存机器健康结论。

`wopal setup` 不向 Desktop 添加 `--setup` 参数。CLI 仅在用户确认后清除 `onboarding.json`，然后通过正常应用入口启动 Desktop；Desktop 冷启动时自然重新进入 onboarding。Desktop 已运行时，启动只会唤醒现有进程，不会导航到 onboarding——需要重新配置的用户先退出 Desktop，再运行 `wopal setup`。

Main 是 UI 状态文件的唯一写入者。写入使用临时文件加 rename 的原子替换，并以用户私有权限保存。状态不保存 token、API key 或其他秘密。损坏文件会移入带时间戳的备份，再由最新步骤探测结果重建。

旧 `onboarding.json` 的步骤名继续兼容读取。旧步骤 `install-wopal-cli`、`install-ellamaka-cli` 和 `star-guide` 分别映射到当前的 `install-cli` 或 `done`。

## 3. 阶段与步骤

底层状态机保留八个步骤，供恢复、执行和诊断使用：

```text
system-check → install-cli → github-auth → ontology-setup
  → create-space → ai-provider → memory-config → done
```

Renderer 将它们呈现为四个阶段：

| 阶段       | UI 步骤                                        | 实现行为                                                                             |
| ---------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| 引擎准备   | `system-check`、`install-cli`                  | 检查并选择 `WOPAL_HOME`；连续安装 Wopal CLI 和 Ellamaka Engine。                     |
| 预备能力   | `ontology-setup`                               | 选择或复用 Ontology。GitHub 认证仅在 Fork 所需时以内嵌表单执行。成功后准备 Runtime。 |
| 空间与记忆 | `create-space`、`ai-provider`、`memory-config` | 创建或复用 Space，配置可选 Provider，并配置全局或 Space 级记忆。                     |
| 启动       | `done`                                         | 展示健康摘要、可选 Star 操作，并从健康门禁进入 Workbench。                           |

`github-auth` 是底层状态步骤，不单独渲染页面。`install-cli` 负责 Wopal CLI 健康，读取 CLI latest，并按运行时版本检查（wopal-cli 下界 + CLI 主版本与 Desktop 一致）完成校验与安装；不使用精确 `engineVersion` pin，也不搜索历史 CLI。Desktop 应用本身在进入 onboarding 前已由用户或 `wopal setup` 安装。Runtime 准备由 `ontology-setup` 成功后的 machine operation 执行。

顶部阶段追踪器只允许访问已解锁阶段。用户可以返回已访问步骤；返回后重新 probe，并以真实机器状态重算后续阶段。任何成功结果都停留在当前页面，直到用户显式点击"下一步"。

## 4. Onboarding 交互模型

`OnboardingRoot` 持有当前阶段、执行状态、步骤结果、错误、解锁阶段和日志。各步骤组件通过 `onStatusChange` 与 `onError` 上报状态；根组件管理固定导航栏和跨步骤状态。

左侧步骤说明由 `content/zh-CN/guides/*.md` 在构建时打包，步骤元数据与业务交互仍由 TypeScript 管理。说明区使用共享 Markdown Renderer 与 DOMPurify 渲染，支持列表、引用、代码、本地 `asset:` 图片和 HTTPS 外链图片；外链图片使用懒加载并禁止发送 Referrer。桌面布局按 `40:60` 分配说明区与操作卡片，窄屏通过折叠面板复用同一份说明内容。

每个步骤先使用 `onboardingProbe` 获取只读事实。probe 用于回填目录、既有认证、已安装 Ontology、Space 列表、Provider 和 Memory 摘要。新环境默认采用 Clone。用户明确选择贡献能力时进入 Fork。已有 Ontology 始终复用实际模式。probe 不推进步骤，也不写状态。

执行由 `onboardingExecuteStep` 发起。步骤完成后使用统一的 `ResultPanel` 呈现成功、执行中或失败状态。Memory、Provider、Ontology 和 Space 的所有写入都通过 CLI machine operation 完成。Renderer 只保存未提交草稿。Space 目标来自 CLI inspect；没有有效路径时空间配置入口保持禁用。`install-cli` 在需要时安装或修复组件。若 Wopal CLI 已健康而 Engine 失败，重试只执行 Engine 子步骤。

`done` 页面只在用户点击"启动工作台"时执行完成门禁。它先调用 `onboardingComplete`，再调用 `onboardingTransitionToWorkbench`；Main 复用仍健康的 sidecar，只有不存在或已失效时才启动/重启。Star 是用户主动触发的独立动作，不阻断启动。

## 5. Main IPC 与执行

| IPC 能力                             | Main 行为                                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `onboarding-probe`                   | 返回本地与 CLI 的只读摘要，不改写步骤状态。                                                                      |
| `onboarding-execute-step`            | 串行化执行一个步骤，记录状态，转发进度，并返回结构化结果。                                                       |
| `onboarding-set-current-step`        | 持久化用户导航后的当前步骤。                                                                                     |
| `onboarding-complete`                | 执行 `inspect`，仅在 `verdict === "healthy"` 时保存 UI 完成状态（`completed: true`）。                            |
| `onboarding-transition-to-workbench` | 在当前 Electron 进程中启动 Workbench 并复用 onboarding 窗口。                                                    |
| `onboarding-set-wopal-home`          | 更新当前 Main 进程使用的 `WOPAL_HOME`。                                                                          |

每次 `onboarding-execute-step` 创建一个 `AbortController`。Main 同一时间只接受一个执行型操作；第二个请求立即返回 `ONBOARDING_OPERATION_BUSY`。执行期间，Main 将状态置为 `in-progress`，结束后写入 `done`、`skipped` 或 `failed`。

### 5.1 CLI bootstrap 与 machine operation

`system-check` 由 Main 执行本地 bootstrap 检查。`install-cli` 先运行站点 installer 的 install-only 模式安装或复用 Wopal CLI，再调用 machine operation 读取 CLI latest 并安装外部 Ellamaka CLI。machine operation 在修改 binary 前完成 latest manifest 的 ReleaseIdentity 与 artifact SHA-256 校验；latest 不兼容时明确失败并建议刷新或重试。Wopal CLI 的版本来自直接执行已安装 binary 的 `wopal --version`。

其余系统变更通过 `wopal setup --machine --json --api-version 1` 执行。Main 验证 `setup.operation` JSON envelope，并把 CLI 的 `created`、`reused`、`skipped` 结果映射为 Desktop 结果。

Ontology 页面默认使用 Clone。Fork 模式复用 GitHub CLI、`GITHUB_TOKEN`、`GH_TOKEN` 或本地配置中的现有凭据；缺少凭据时先提交内嵌 `github-auth`，随后调用 `prepare-ontology`。Main 在 Ontology 成功或复用后调用 `prepare-runtime`。Space、Provider 和 Memory 分别使用对应的 machine operation。

### 5.2 超时、终止与进度

Main 是 timeout 的唯一 Owner。Wopal installer 具有下载超时和五分钟安装上限；Engine machine operation 使用十分钟硬上限，并以 45 秒无 stdout/stderr 活动作为下载停滞门禁，持续产生下载进度时会刷新活动计时；Ontology 准备使用五分钟硬上限。Renderer 不设置独立的竞速超时。

超时或内部 abort 会停止整个子进程树：Unix 先向进程组发送 `SIGTERM`，再升级至 `SIGKILL`；Windows 使用 `taskkill /t /f`。子进程完成或终止后不再转发 stdout/stderr 进度。

Main 将步骤进度广播给 Renderer，并记录到 `$WOPAL_HOME/logs/onboarding.log`。日志超过 1 MB 时滚动为 `onboarding.log.1`，写入前会脱敏常见 token 与 API key 模式。Renderer 日志抽屉保存最近 200 条显示记录，并保留用户的展开状态。

执行型 operation 使用显式 runtime impact：`externalCli` 与 `desktopSidecar` 分开报告，`stopRunning` 是调用方授权输入，不是 operation 自动推导的成功结果。替换外部 Bun CLI 不得停止 Desktop sidecar；只有确需重启内嵌 sidecar 的 operation 才能在 UI 明确说明活跃 Session/PTY 会终止并确认后执行。

### 5.3 依赖安装

Onboarding 不预装插件与 dsh 依赖（2026-09-01 决策，原提前物化方案已废弃）。依赖安装由 ellamaka 运行时兜底统一负责：

| 依赖 | 运行时兜底 |
| ---- | ---------- |
| 用户级插件依赖 | ellamaka 首次使用即装 |
| 空间级插件依赖 | ellamaka per-directory 加载时安装 |
| dsh 依赖闭包 | ellamaka 装配 dsh 前自物化（Runtime Manager，见 `DESIGN-dsh-poc.md` §3.4） |

onboarding 可能被跳过（用户已完成后重装、纯终端 setup、外部安装），运行时兜底保证依赖始终可用，onboarding 编排对依赖安装无前置要求。

## 6. 关键文件

| 文件                                                 | 职责                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `src/shared/onboarding-constants.ts`                 | 底层步骤名称与顺序。                                                                   |
| `src/renderer/onboarding/step-controller.ts`         | 阶段映射、可选步骤和前进/后退控制器。                                                  |
| `src/renderer/onboarding/onboarding-root.tsx`        | UI 状态、导航、阶段追踪器和步骤装配。                                                  |
| `src/renderer/onboarding/step-guide.ts`              | 步骤说明别名、Markdown 图片协议与安全预处理。                                          |
| `src/renderer/onboarding/content/step-guides.ts`     | 构建时 Markdown 和本地图片资源注册。                                                   |
| `src/renderer/onboarding/components/StepGuide.tsx`   | 共享 Markdown 步骤说明渲染。                                                           |
| `src/renderer/onboarding/components/ResultPanel.tsx` | 结果状态的共享呈现结构。                                                               |
| `src/main/onboarding-gate.ts`                        | 启动模式判定与 shell 环境补齐。                                                        |
| `src/main/onboarding-state.ts`                       | 状态 schema、恢复、原子写入和步骤迁移。                                                |
| `src/main/onboarding-ipc.ts`                         | IPC handler、步骤编排、probe 与完成门禁。                                              |
| `src/main/bootstrap-installer.ts`                    | Wopal CLI bootstrap、版本探测与安装生命周期。                                          |
| `src/main/setup-machine-client.ts`                   | CLI machine operation 执行与响应验证。                                                 |
| `src/main/child-process-lifecycle.ts`                | 跨平台子进程树终止。                                                                   |
| `src/main/sidecar-supervisor.ts`                     | Desktop 内嵌 sidecar 的唯一生命周期 Owner；onboarding 阶段不启动。                     |
| `src/renderer/index.tsx`                             | 冷启动挂载选择：onboarding 或 Workbench。                                              |
