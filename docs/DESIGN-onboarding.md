# Onboarding — 目标实现规范

> **Status**: Active
> **Updated**: 2026-09-18
> **Parent**: `./DESIGN.md`
> **Parent Architecture**:
>
> - `../../../docs/products/wopal-space/DESIGN-onboarding.md` — 统一入口架构与职责边界
> - `./DESIGN-desktop.md` — Desktop 启动、窗口与 sidecar 生命周期

本文档定义 Ellamaka onboarding 的目标实现。编排引擎与 HTTP/SSE 路由由独立包 `@wopal/ellamaka-onboarding` 承载，Web 与 Desktop 共用同一服务端与同一套 SolidJS 页面组件。入口判定只依赖 `onboarding.json`；CLI machine operation 的输入、输出和业务语义以 wopal-cli 代码为准，其契约见 `../../../projects/wopal-cli/src/lib/setup-machine.ts`。

**边界**：本文档描述 onboarding 编排服务、HTTP/SSE 契约、Web 页面组件与 Desktop 接入方式。`prepare-ontology`、`prepare-runtime`、`initialize-space` 等确定性 operation 的业务语义（含装配物化、类型装配单消费）由 wopal-cli 实现与定义，本文档不重复定义；各宿主仅按 machine capability 契约调用并展示结果。

---

## 实现架构

```text
SolidJS Onboarding 页面（@wopal/ellamaka-app /pages/onboarding）
  └── OnboardingClient（HTTP + SSE）
        └── /api/onboarding（mountOnboarding）
              └── OnboardingService（编排、状态持久化、事件流）
                    └── wopal setup --machine --json --api-version 1
```

| 层 | 实现责任 | 主要位置 |
| --- | --- | --- |
| Web 页面 | 呈现四阶段向导、收集用户输入、触发 probe/execute、显示进度与结果、控制确认导航。 | `packages/ellamaka-app/src/pages/onboarding/` |
| Onboarding 服务 | 步骤编排、单飞锁、超时与取消、状态持久化（`onboarding.json`）、SSE 事件流、HTTP 路由。 | `packages/ellamaka-onboarding/src/` |
| 宿主 | `serve` / Desktop sidecar 通过 `mountOnboarding` 挂载 `/api/onboarding`；Desktop 由内嵌页面按 `onboarding.json` 选择 onboarding 或 Workbench。 | `packages/opencode/src/cli/cmd/serve.ts`、`packages/ellamaka-desktop/src/main/` |
| CLI | 执行安装、Ontology、Runtime、Space、Provider 的确定性变更。 | `wopal setup --machine` |

服务端是唯一的状态写入者，前端没有任何文件访问。SSE（`GET /stream`）推送 progress/log/error/complete 事件；长耗时操作的实时可观测性由该流承载。

## HTTP/SSE 契约

挂载前缀 `/api/onboarding`，路由由 `@wopal/ellamaka-onboarding/router` 提供：

| Method | Path | 语义 |
| --- | --- | --- |
| GET | `/state` | 读取持久化状态视图（completed、currentStep、completedSteps） |
| POST | `/probe` | 只读探测，不推进步骤、不写状态 |
| POST | `/execute` | 串行执行一个步骤；并发时返回 503 `ONBOARDING_OPERATION_BUSY` |
| POST | `/cancel` | 中止当前执行型操作 |
| POST | `/complete` | 完成门禁（见下节） |
| GET | `/stream` | SSE 事件流，含 15s 心跳 |

认证由挂载自带（`auth: "self"`），与宿主服务共用凭据。

## 步骤与阶段

底层步骤常量（`ONBOARDING_STEPS`）保留七步，供恢复、执行和诊断使用：

```text
system-check → install-cli → ontology-setup → create-space → ai-provider → done
```

页面呈现为四个阶段：

| 阶段 | UI 步骤 | 实现行为 |
| --- | --- | --- |
| 引擎准备 | `system-check`、`install-cli` | 检查并选择 `WOPAL_HOME`；安装或复用 Wopal CLI 与 Ellamaka Engine。 |
| 预备能力 | `ontology-setup` | 选择或复用 Ontology；成功后自动执行 Runtime 准备。 |
| 空间与启动准备 | `create-space`、`ai-provider` | 创建或复用 Space，可选配置 Provider。 |
| 启动 | `done` | 展示健康摘要、可选 Star 操作，经完成门禁进入 Workbench。 |

Memory 配置不属于 onboarding 旅程。记忆配置的写入者与消费面归配置体系（`./DESIGN-config-engine.md`），由 Workbench 设置面板按需完成；`configure-memory` machine operation 保留给 terminal setup 使用，onboarding 编排不再调用。

`github-auth` 是伪步骤：可执行（保存 Token 时经 `executeStep`），但不出现在向导步骤映射中。

## Probe 只读原则

每个步骤先经 `POST /probe` 获取只读事实，用于回填目录、既有认证、已安装 Ontology、Space 列表与 Provider 摘要。probe 不推进步骤、不写状态、不触发 `executeStep`。

检测到既有资源时，页面展示可复用事实，由用户显式点击"下一步"确认后才发起执行。步骤的完成事实来自 operation 结果（`created` / `reused` / `skipped`），不来自 probe。

## 交互模型

`OnboardingRoot` 持有当前步骤、执行状态、步骤结果、错误、解锁阶段和日志。各步骤组件通过 `onStatusChange` 与 `onError` 上报状态；步骤组件通过注册机制向根组件暴露 `submit` / `retry` 动作，根组件导航栏直接调用注册闭包，不使用 DOM 查询或全局事件驱动子组件。

左侧步骤说明由 `content/zh-CN/guides/*.md` 在构建时打包。说明区使用共享 Markdown 渲染并做净化处理，支持本地 `asset:` 图片与 HTTPS 外链图片（懒加载、禁止 Referrer）。

顶部阶段追踪器只允许访问已解锁阶段。用户可以返回已访问步骤；返回后重新 probe，并以真实机器状态重算后续阶段。任何成功结果都停留在当前页面，直到用户显式点击"下一步"。

## Ontology 模式选择

新环境默认采用 Clone：零凭据门槛，不需要 GitHub 认证即可获取官方本体。用户明确选择贡献能力时进入 Fork；Fork 模式复用 GitHub CLI、`GITHUB_TOKEN`、`GH_TOKEN` 或本地配置中的现有凭据，缺少凭据时先提交内嵌 `github-auth`。已有 Ontology 始终复用实际模式，向导不自动改写同步方式。

可用空间类型来自本地本体的装配定义（`assembly/archetypes/`），条目形态为 `{ type, description? }`；本体未物化时展示"未检测到可用类型"。`common` 不是空间类型。

## 完成门禁与状态统一

`POST /complete` 是完成门禁：服务端执行一次 `inspect`，当且仅当 `verdict === "healthy"` 时持久化 `completed: true`；不健康时拒绝完成并返回缺失项摘要，前端展示后停留在 `done` 页。

步骤事实与旅程完成标记分层：每个步骤的执行事实来自 machine operation 结果（`created` / `reused` / `skipped`），机器真实状态不来自 `onboarding.json`；旅程完成标记（`completed: true`）统一落 `onboarding.json`。CLI setup 旅程（terminal / GUI 编排）成功完成时同样写入该文件——完成状态是所有入口共享的唯一事实，任何入口完成初始化后，其他入口不再重复引导。

`onboarding.json` 是界面恢复载体，包含当前阶段、步骤展示状态、结构化结果、可展示错误和更新时间。损坏文件移入带时间戳的备份后由最新探测重建。旧步骤名 `install-wopal-cli`、`install-ellamaka-cli`、`star-guide`、`memory-config` 兼容映射到现步骤或忽略。

## Desktop 接入

Desktop 内嵌同一套 `@wopal/ellamaka-app` 页面。Main 启动时解析 `WOPAL_HOME`（GUI 进程缺 shell 环境时从登录 shell 补齐），sidecar 随应用启动；主窗口按 `onboarding.json` 决定渲染 onboarding 还是 Workbench。

| 条件 | Desktop 行为 |
| --- | --- |
| 状态文件缺失或 `completed` 未真 | 渲染 onboarding 页面 |
| `completed === true` | 渲染 Workbench |
| sidecar 启动失败 | 展示本地诊断页，不静默白屏 |

`wopal setup` 不向 Desktop 传 `--setup` 参数。CLI 在用户确认后清除 `onboarding.json`，Desktop 冷启动自然重新进入 onboarding。

sidecar 是 onboarding HTTP 面的宿主：onboarding 服务、Workbench 与 PTY 治理同进程。sidecar 启动失败时 onboarding 无法提供网络探测，诊断页承载兜底信息；依赖安装不进 onboarding（运行时兜底负责），保证 onboarding 编排对依赖无前置要求。

## 超时与取消

服务端是 timeout 的唯一 Owner：Engine 安装十分钟硬上限（45 秒无输出视为停滞，持续输出则刷新）、Ontology 准备五分钟、其余操作两分钟。每次执行绑定一个 `AbortController`，`POST /cancel` 触发中止；取消与超时的结果码分别为 `ONBOARDING_OPERATION_CANCELLED`、`ONBOARDING_OPERATION_TIMEOUT`。同一时间只接受一个执行型操作，第二个请求立即返回 `ONBOARDING_OPERATION_BUSY`。

## Reference Documents

| Document | Purpose |
|----------|---------|
| `../../../projects/wopal-cli/src/lib/setup-machine.ts` | machine capability 契约的实现真相源 |
| `./DESIGN-config-engine.md` | 记忆等配置的写入者与消费面归属 |
