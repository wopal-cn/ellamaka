# Onboarding & Setup

> **Status**: Active
> **Updated**: 2026-10-14
> **Parent**: `./DESIGN.md`
> **Sibling DESIGNs**:
>
> - `./DESIGN-wopalspace.md` — Setup、Ontology、Space 业务边界
> - `./DESIGN-ellamaka-sdk.md` — 统一公开 SDK 与 Server API
> - `./DESIGN-desktop.md` — Desktop sidecar 与 Renderer 生命周期
> - `./DESIGN-dsh-base.md` — DSH Preparation / Activation 与 Home 安全协议
> - `./DESIGN-auth.md` — Phase 3 Host Auth 方向（Draft）

## Purpose

Onboarding 是 WopalSpace Setup 的**唯一用户形态**。不存在 Terminal Setup 向导，也不存在 CLI 侧第二套 Setup planner/state machine。

`wopal setup` 命令仍保留，但它只是 Onboarding 启动器：启动或复用 `ellamaka serve`，把用户指定的 host、port、password 等 Server 启动参数交给该进程，然后打开 `/onboarding`。真正的初始化交互全部在 Web UI 完成。

## Frontend Ownership

Onboarding 与 Workbench 都属于同一个前端 package：

```text
@wopal/ellamaka-app
  ├─ /onboarding   配置阶段
  └─ /workbench    运行阶段
```

它们不是两个独立前端产品。应用根据 Setup state 和当前机器事实决定进入哪个页面；完成 Onboarding 后通过同一 SPA router 进入 Workbench。

目标态不存在独立的 `@wopal/ellamaka-onboarding` backend package。当前 package 中仍有价值的 Setup state、single-flight、progress、cancel 等能力归 private `@wopal/wopalspace/setup`；HTTP/SSE contract 进入统一 Ellamaka Server API；GUI 只使用 generated `@wopal/ellamaka-sdk` client。

## Setup Ownership

private `@wopal/wopalspace/setup` 拥有：

- `$WOPAL_HOME/ellamaka/state/onboarding.json`；
- 当前 Setup facts；
- planner；
- action execution；
- operation single-flight；
- progress / cancel；
- completion 判断。

Setup 只描述 WopalSpace application 初始化。Ellamaka CorePreparation 是 Runtime 自己的运行前置，不由 Onboarding planner 驱动，也不写入 Setup completion。

## Product Boundary

Onboarding 不安装或更新产品。

以下能力继续留在 Wopal CLI Product：

- Wopal CLI install/update/repair；
- external Ellamaka CLI install/update/repair；
- Desktop stable/beta install/update/repair；
- 产品 inventory 与 release resolution。

能够进入 Onboarding，意味着当前承载它的 `ellamaka serve` 或 Desktop sidecar 已经存在。其他产品缺失时，Onboarding 可以展示事实和引导，但不能自行承担产品安装事务。

## `wopal setup` Launcher

`wopal setup` 只承担 Server/浏览器 launcher 职责：它不读取 `onboarding.json`，不做 Terminal prompts，不扫描已安装产品，也不提前准备其他产品的 Core Runtime。

目标调用链只有：

```text
wopal setup [host/port/password options]
  -> start or reuse ellamaka serve with those host settings
       -> this running Ellamaka build prepares its own Core Runtime
  -> open /onboarding
  -> user completes Setup in ellamaka-app
```

如果可用的 `ellamaka serve` 产品不存在，`wopal setup` 返回清楚的产品缺失诊断并指向 Wopal CLI Product 安装能力；它自己不把“启动 Onboarding”扩展成产品安装流程。

复用 Server 前核验管理身份、可连接的 endpoint、认证和用户显式指定的启动参数。参数不匹配时报告冲突，不静默忽略、不修改或终止已有 Server。无图形环境时输出可访问的 `/onboarding` URL；监听地址与浏览器地址分开，wildcard host 不能直接作为本机浏览器地址。

`wopal setup` 传递的 host/port/password 只配置它启动的 Server。浏览器通过现有 Server credential 连接，launcher 打开的 URL 不携带真实密码或其可逆编码；当前认证行为遵循现有 Server auth，Phase 3 的收敛方向见 `DESIGN-auth.md`。

## Initialization Flow

Web Onboarding 的 application flow：

```text
inspect current facts
  -> ensure WOPAL_HOME foundation
  -> ensure/reuse Ontology
  -> create/reconcile Space
       -> .wopal materialized
       -> prepare that Space instance plugin dependencies
  -> optional credential/provider bootstrap
  -> re-inspect completion
  -> complete
```

顺序表达依赖，不要求所有 action 串行执行。

`completed` 的 application 最低含义是：Home foundation 合法、存在可读取 Ontology、存在可验证 assembly snapshot/worktree 的 Space，以及用户本次明确要求的初始化输入已经处理。

产品 Runtime readiness 不写入 `completed`，产品安装状态也不是永久 completion gate。

## Product Runtime Preparation

哪个 Ellamaka 产品真正启动 Runtime，就由哪个产品准备自己的 Core Runtime；不存在机器级产品全集和跨产品 prewarm。

| 入口 | 行为 |
| --- | --- |
| `ellamaka serve` / `web` | 当前 CLI build 启动时检查/准备自己的 Runtime 资源，然后激活该入口需要的 DSH 能力 |
| Desktop | packaged sidecar 对自己的 embedded build 做同样检查/准备 |
| 默认 TUI | 当前 build 自己准备；具体 Space instance 单独检查 |
| `wopal setup` | 只负责拉起/reuse `ellamaka serve` 并打开 Onboarding；CorePreparation 由该 serve 进程自己执行 |
| `ellamaka run` | 固定 DSH-disabled；不执行任何 DSH Preparation/Activation |
| `run --attach` | 不创建本机 listener/目录 instance，不执行 CorePreparation 或 DSH 准备/挂载；使用远端 Runtime |

Server 只有一个 Runtime 生命周期。基础能力正常提供；某个附加能力处于 PREPARING/DEGRADED 时只影响该能力。

DSH Home 的 closureVersion check、切换前备份和旧版本拒绝规则由 Runtime 拥有；Onboarding 不复制这些规则，也不检查或准备其他产品。

## Space Instance Preparation

Space plugin dependency 只在 `.wopal` 已经物化之后才有明确输入。

```text
space.init
  -> materialize .wopal
  -> CorePreparation.prepare(instance(spaceRoot))
       -> path-plugin dependencies
       -> instance preflight
```

如果 preparation 失败，Space 保持已物化状态，不回滚删除。Runtime 第一次真正加载 Space 时再次 `inspect(instance)`，必要时 fallback prepare。

## API

Onboarding 只通过运行中的 Ellamaka Server API 工作：

```text
ellamaka-app /onboarding
  -> @wopal/ellamaka-sdk/http
  -> Ellamaka Server
  -> private @wopal/wopalspace/setup
```

`@wopal/ellamaka-sdk/local` 仍可服务 Wopal CLI 的 Ontology/Space trusted-local operations，但**不提供另一种 Setup presentation**。

## State and Progress

`onboarding.json` 只记录 application Setup 流程；产品 Core readiness 每次从当前 Runtime/CorePreparation 实时读取。

Setup progress 只表达 Onboarding application actions。Runtime 自己的 DSH/Core Preparation progress 可以作为独立健康事实展示，但 Setup 不复制 Core 的 run state，也不把 Core step 变成 Setup action。

GUI 页面负责展示进度、收集输入和导航，不负责定义哪些底层 Core step 应该执行。

## Authentication

Onboarding API 不维护独立认证实现。它与 Workbench、Runtime、WopalSpace API 共用 Ellamaka Server 认证。

当前阶段保持现有 Server auth 机制；Phase 3 统一 Host Auth 方向见 `DESIGN-auth.md`。

## Invariants

1. Onboarding 是唯一 Setup 用户形态；不存在 Terminal Setup 向导。
2. `wopal setup` 只是 `ellamaka serve + /onboarding` 的便利入口，不实现 Setup 业务。
3. Onboarding 与 Workbench 是同一个 `@wopal/ellamaka-app` 的不同阶段页面。
4. Onboarding backend 业务归 `@wopal/wopalspace/setup` 与统一 Server API，不形成独立 backend domain。
5. Setup 不负责产品安装/update，也不枚举或预热其他产品。
6. 哪个 Runtime 产品启动，就由哪个产品准备自己的 Core Runtime。
7. Setup completion 与 Core readiness 分离。
8. Space plugin dependencies 在 `.wopal` 物化后准备，不提前猜测。
9. DSH Home 版本检查与备份不属于 Setup，所有入口都必须遵守 Runtime 保护。
