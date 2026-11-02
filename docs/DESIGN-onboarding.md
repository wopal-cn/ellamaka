# Onboarding & Setup

> **Status**: Active
> **Updated**: 2026-11-02
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

## Application Startup Gate

Serve/Browser 与 Desktop 共用 `ellamaka-app` 的启动阶段判断。Server 可连接并完成认证后，应用通过 Setup inspect 读取当前 Host 的 Home 锁定状态和 Setup completion。读取期间只显示中性的启动界面，不挂载 Onboarding、Workbench 或其阶段专属 Provider，也不启动 Workbench 的 global config bootstrap。判断结果绑定当前 Server 身份，切换连接后重新读取并丢弃旧连接的迟到结果。

Home 未锁定或 Setup 未完成时直接进入 Onboarding；Setup 已完成时默认进入 Workbench。直接访问 `/workbench` 也遵循这一判断。用户显式进入 `/onboarding` 时允许重新执行当前 Host 的可见 Runtime Preparation，即使 Setup 已完成。Setup facts 不可读取时显示可重试的启动诊断，不推断为已完成或进入 Workbench。

Server 的 Setup 完成事实与 Runtime readiness 分开。Setup 未完成时，Onboarding 在 Space 步骤之后显式触发 host preparation；完成 Setup 后，当前 Host 的同一激活所有者按请求的 profile 激活 DSH，无需重启。Setup 完成的冷启动由 Host 检查、准备并激活。Workbench DSH entry 等后端入口也须检查当前 Host 的 Setup 生命周期，不能通过直接请求提前激活。

Preparation 只发布资源准备事实；Web 与 Tools 的 ready/degraded 由各自激活结果发布。幂等 preparation 保留已经激活的状态。浏览器与 Desktop 共享同一阶段判断，Desktop Main 只拥有窗口和 sidecar 生命周期。

## Setup Ownership

private `@wopal/wopalspace/setup` 拥有：

- `$WOPAL_HOME/.setup/ellamaka.json`；
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

`wopal setup` 只承担 Server/浏览器 launcher 职责：它不直接读取或解释 `$WOPAL_HOME/.setup/ellamaka.json`，不做 Terminal prompts，不扫描已安装产品，也不提前准备其他产品的 Core Runtime。

目标调用链只有：

```text
wopal setup [host/port/password options]
  -> start or reuse ellamaka serve with those host settings
  -> open /onboarding
  -> user completes Setup in ellamaka-app, including Core Runtime preparation after Space
```

如果可用的 `ellamaka serve` 产品不存在，`wopal setup` 返回清楚的产品缺失诊断并指向 Wopal CLI Product 安装能力；它自己不把“启动 Onboarding”扩展成产品安装流程。

复用 Server 前核验管理身份、可连接的 endpoint、认证和用户显式指定的启动参数。参数不匹配时报告冲突，不静默忽略、不修改或终止已有 Server。无图形环境时输出可访问的 `/onboarding` URL；监听地址与浏览器地址分开，wildcard host 不能直接作为本机浏览器地址。

`wopal setup` 传递的 host/port/password 只配置它启动的 Server。浏览器通过现有 Server credential 连接，launcher 打开的 URL 不携带真实密码或其可逆编码；当前认证行为遵循现有 Server auth，Phase 3 的收敛方向见 `DESIGN-auth.md`。

## Home Selection and Lifecycle

`WOPAL_HOME` 是 Home 的唯一持久化真相源。Onboarding 不维护另一份 Home registry、绑定文件或产品私有路径配置。

正常使用模式下，Ellamaka Host 启动时读取当前用户的 `WOPAL_HOME`。Desktop 从 Finder/Dock 冷启动而没有继承 shell rc 时，宿主读取用户 login shell 环境补齐该值。若 `WOPAL_HOME` 已存在，Host 从启动起锁定该 Home；Onboarding 第一页显示路径但不允许改选。若变量不存在，Host 进入 Home 尚未确认的 bootstrap 状态：第一步允许用户输入或选择路径，确认成功后把该值持久化到当前用户的 shell/user environment，同时立即作为本次 Host 的 effective Home。持久化失败时 Home 保持未确认，后续 Setup 不开始。

开发测试模式由 `WOPAL_DEV=1` 明确标识。`scripts/dev.sh` 的 `serve`、`desktop`、`tui` 入口都设置该标识。此模式下 shell 中已有的 `WOPAL_HOME` 或平台默认路径只作为第一步的初始候选，用户可以选择不同路径；确认只更新当前开发进程树的 effective `WOPAL_HOME`，不修改用户 shell profile 或 user environment。

`scripts/dev.sh` 的 Web 开发入口在 Home 确认前只执行健康检查并进入 Onboarding。Global Config bootstrap 从 Home 锁定后开始，由 Workbench 与 Runtime 按需读取该 Home 的配置。

Home 一旦确认，在当前 Ellamaka Host 生命周期内不可切换。Foundation、GitHub、Ontology、Space、Core Preparation、Workbench 以及 Host 启动的子进程都消费同一个锁定值；页面刷新、重复 inspect、shell 环境变化或后续请求都不能重新解析 Home。需要改变正常使用模式的 Home 时，用户先修改持久 `WOPAL_HOME`，再重启 Host。

Home 尚未确认时只允许读取 bootstrap facts 和执行 Home 选择；不得创建 Home、Runtime 私有目录、Setup state、Ontology、Space 或 DSH 资源。Home 确认后才进入普通 Setup planner/action 流程。

Setup 恢复状态与 Runtime 私有状态分离。`$WOPAL_HOME/.setup/ellamaka.json` 只承载 Onboarding 恢复位置和 completion；`$WOPAL_HOME/ellamaka/**` 只属于 Ellamaka Runtime。Ontology 安装与随后 Home seed 完成之前，Setup 可以写 `.setup/ellamaka.json` 和 Ontology 自己的目录，但不得创建正式 `ellamaka/` Runtime 树。Ontology/Home seed 提交完成后，后续 Space instance preparation 与 Core Preparation 才可以按各自职责创建 Runtime 私有目录。

## Initialization Flow

Web Onboarding 的 application flow：

```text
inspect current facts
  -> confirm/lock WOPAL_HOME when required
  -> ensure WOPAL_HOME foundation
  -> ensure GitHub identity (fork 模式必需)
  -> ensure/reuse Ontology
  -> seed Home base config
       -> config/settings.jsonc 的 ellamaka 块
  -> create Home capability roots (stub)
  -> create/reconcile Space
       -> .wopal materialized
       -> prepare that Space instance plugin dependencies
  -> prepare Core Runtime (host: closure / Home / profiles)
  -> optional credential/provider bootstrap
  -> re-inspect completion
  -> complete
```

顺序表达依赖，不要求所有 action 串行执行。

### GitHub 身份与 Ontology 来源

Ontology 有两种来源，选哪种由 GitHub 身份决定：

- **fork（默认）**：origin 指向用户自己的 GitHub fork，upstream 指向 `wopal-cn`。用户的改动既能在本地运行，也能提回上游。
- **clone**：直接克隆 upstream，个人使用，不与自己的 GitHub 账号建立关系。

GitHub 身份探查排在 Ontology 之前，因为 fork 必须先有身份才能建。探查已经得到可用身份时，Onboarding 直接进入 Ontology 安装界面，不要求用户再次执行 GitHub 配置动作。

Setup 可以从以下来源探查 GitHub 身份事实：

1. 本机 `gh` 已登录，`gh api user` 能返回 login；探查这份持久登录态时忽略当前进程的 `GITHUB_TOKEN` / `GH_TOKEN`，避免环境变量遮蔽真实的 `gh` 登录状态；
2. 承载 Ellamaka Server/sidecar 的 shell 环境已经提供 `GITHUB_TOKEN` 或 `GH_TOKEN`，并且该 token 经 GitHub `/user` 验证后能返回 login；这类继承凭证只读使用，不复制进 `$WOPAL_HOME`；
3. `$WOPAL_HOME/.env` 已有 token，经 GitHub 验证通过后可作为兼容凭证来源。

探查按本机 `gh` 持久登录、shell 环境 token、Home token 的顺序进行；某个 token 存在但验证失败时继续检查下一来源，不能让失效的高优先级 token 遮蔽后续仍有效的身份。

Onboarding 的 Fork 用户路径以本机 `gh` 登录为准。`gh api user` 尚不可用时，界面引导用户安装/使用 GitHub CLI，运行 `gh auth login`，随后由用户触发重新探查；继承的 shell/Home token 可以作为服务端兼容凭证事实，但不会代替 GUI 的本机 gh 登录要求。用户若明确放弃 fork，则选择 clone 并继续，不要求 GitHub 登录。

`$WOPAL_HOME/.env` 里存在一行 token 不算完成；该 token 若已失效，身份仍视为不可用。

Ontology 模式的默认值和可选范围由身份决定：

| 本机 gh 登录 | 默认  | 可选        |
| ------------ | ----- | ----------- |
| 可用         | fork  | fork、clone |
| 不可用       | clone | 只有 clone  |

未认证时界面不提供 fork 选项，避免把用户引到一个必然失败的路径。

fork 过程中缺少权限、组织策略限制、同名仓库冲突或建 fork 失败时，失败归 Ontology 步骤所有。失败后 Onboarding 重新探查 GitHub 身份：身份仍可用时留在 Ontology 安装界面供用户重试 fork 或主动选择 clone；身份已经不可用时才回到 GitHub 登录引导。系统不静默降级成 clone，也不留下半个 fork。

`completed` 的 application 最低含义是：Home foundation 合法、Home 配置含可用的 `ellamaka` 块、存在可读取 Ontology、存在可验证 assembly snapshot/worktree 的 Space，以及用户本次明确要求的初始化输入已经处理。

产品 Runtime readiness 不写入 `completed`，产品安装状态也不是永久 completion gate。

### Home 基础配置与能力根目录

`foundation` 只准备 `$WOPAL_HOME` 根目录：确保它存在、可写。它不创建能力目录，不预建 `ellamaka/**`，不写任何初始配置。Setup 自己的恢复状态写在 `.setup/ellamaka.json`；Runtime 私有树只能在 Ontology/Home seed 完成后的 preparation 阶段按需创建。

本体安装完成后，才写入 Home 的基础配置，位置在本体之后、Space 之前。

`config/settings.jsonc` 的 `ellamaka` 块来自本体的 `config/settings.jsonc`。这个块是产品正常启动的前提：缺失时 Runtime 无法正常工作，所以它是本阶段的必要产物，不是可选项。

合并语义：Home 尚无该块时整块写入；已有该块时只补缺失 key，`permission` 整块保留、不深合并，用户已有的其他顶层 key 保持不变。已有用户内容一律保留，重复进入只补缺、不覆盖。

Home 能力装配是独立的一份设计，采用 `base.yml` 装配单，覆盖 Home 目录下多个 Space 共享的能力。这份设计尚未定稿，也不在本阶段实现。本阶段只保留该步骤的 stub：创建 `agents`、`skills`、`rules`、`commands` 四个空目录，供用户自行放置能力，不做任何能力物化。

## Core Preparation Timing

Core Preparation 只有一份实现，属于 `@wopal/ellamaka-core`。它按 target 分为两类：

| target     | 内容                                                   | 频率            | 依赖                                        | 调用点                                 |
| ---------- | ------------------------------------------------------ | --------------- | ------------------------------------------- | -------------------------------------- |
| `instance` | 该 Space 的插件依赖                                    | 每个 Space 一次 | 该 Space 的 `.wopal`                        | `space.init` 内部，`.wopal` 物化完成后 |
| `host`     | `dsh.closure`（依赖闭包）/ `dsh.home` / `dsh.profiles` | 每个 build 一次 | `WOPAL_HOME` 目录；后续版本可能需要本体资源 |

`prepare` 是幂等的：目标已 READY 时直接返回，不重复下载或改写。因此 host preparation 只在第一个 Space 创建后真正执行一次，后续创建 Space 复用同一份结果。

### host preparation 放在 Space 之后

host preparation 排在 Space 之后，理由有两条。

当前实现依赖 `WOPAL_HOME` 目录；后续准备过程可能需要本体资源。把调用点放在 Ontology 与 Space 都已就绪之后，可以为这类需求提供完整输入。

排得越靠后，出错时需要回滚的状态越少。初始化走到这一步时，foundation、Ontology 与 Space 都已完成并各自提交；host preparation 失败只影响运行时这一项，不会让前序成果作废。

因此 Onboarding 把它作为 Space 之后的一个独立步骤执行，并在此展示 `CorePreparationEvent` 的 `step` / `phase` / 已耗时；存在真实度量时才报告 current/total。

### 调用时机由入口是否具备 Setup presentation 决定

具备 Setup presentation 指该入口能把用户引导到 Web Onboarding。这条边界决定重活能否推迟到用户可见处执行。

| 入口                             | Setup 未完成                                                 | Setup 已完成                                      |
| -------------------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| `wopal setup` / `ellamaka serve` | 不挂载 DSH；host preparation 在 Onboarding 的 Space 之后执行 | 启动时检查，需要时准备，然后挂载                  |
| Desktop                          | 同 `serve`：sidecar 提供 HTTP 与 Onboarding，不预挂 DSH      | sidecar 检查 embedded build，需要时准备，然后挂载 |
| TUI                              | 无 Setup presentation，启动时兜底准备 Tools profile          | 同左                                              |
| `ellamaka run`                   | 固定 DSH-disabled，不做 Preparation                          | 同左                                              |
| `run --attach`                   | 不创建本机 listener/instance，不执行 Preparation             | 同左                                              |

### 兜底规则

任何正式使用 DSH 能力的位置，都必须在用前检查该能力是否 READY；未 READY 则调用同一个 `prepare`。兜底不是第二套逻辑，只是同一函数的晚调用：

| 兜底点                  | 检查对象                                                                    |
| ----------------------- | --------------------------------------------------------------------------- |
| 挂载 DSH Web / Tools 前 | 对应 profile 是否 prepared；否则不发布该能力并暴露 `PREPARING` / `DEGRADED` |
| TUI 启动                | Tools profile；TUI 不消费 Web profile                                       |
| Space Runtime 首次加载  | `inspect(instance)`，未 READY 则 fallback prepare                           |

### 与 Setup 状态的边界

Setup planner 不生成 Core Preparation 的 action，`$WOPAL_HOME/.setup/ellamaka.json` 也不记录 Core readiness。Runtime readiness 是每次从当前 Runtime 实时读取的事实。Onboarding 只负责在对应步骤内触发并呈现它。

重新进入 Onboarding 时，即使 application Setup state 已经 `completed=true`，也不能据此跳过本次 Host 的 Runtime Preparation。只要当前 Onboarding 生命周期尚未确认 Runtime READY，就必须经过同一可见 preparation 步骤；它是幂等调用，已 READY 时立即复用结果。这样 Setup completion 永远不能被误当成当前进程的 Core/DSH readiness。

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

`$WOPAL_HOME/.setup/ellamaka.json` 只记录 application Setup 流程；产品 Core readiness 每次从当前 Runtime/CorePreparation 实时读取。

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
