# WopalSpace Application Domain

> **Status**: Active
> **Updated**: 2026-10-26
> **Parent**: `./DESIGN.md`
> **Scope**: private `@wopal/wopalspace` 的目标态架构、能力范围、公开契约、核心流程与状态归属
> **Sibling DESIGNs**:
>
> - `./DESIGN-ellamaka-sdk.md` — 统一公开 SDK、HTTP/OpenAPI 与本机调用方式
> - `./DESIGN-onboarding.md` — 唯一 Web Onboarding 初始化流程与 `wopal setup` launcher
> - `./DESIGN-dsh-base.md` — DSH closure、Home、profile 与运行时激活
> - `./DESIGN-auth.md` — Phase 3 认证加固方向（Draft）
> - `../../../.wopal/docs/DESIGN-assembly.md` — Ontology 装配、Space 物化与能力选择规则

## Purpose

`@wopal/wopalspace` 是 Ellamaka monorepo 内部的 private WopalSpace 应用层 package。

它集中实现 Setup、Ontology、Space，以及少量已正式注册的 Wopal 产品设置写入，使 GUI、Workbench、Wopal CLI 和自动化调用看到同一套业务规则。它不对 npm 消费者发布；公开调用统一通过 `@wopal/ellamaka-sdk`。

本文只描述目标态，不描述迁移步骤。

## Scope

| 能力域 | 负责什么 |
| --- | --- |
| Setup | 首次初始化、初始化状态、初始化计划，以及 Home/Ontology/Space/credential 的共享初始化业务 |
| Ontology | Ontology 仓库安装、复用、检查、同步、贡献和能力池查询 |
| Space | Space 定位、注册、初始化/修复、装配物化、状态、同步和能力选择 |
| Product Settings | 受 schema 约束的 Wopal 产品级 canonical setting 写入；当前正式键为全局 `wopal.dsh.web.enabled` |

以下能力不属于 `@wopal/wopalspace`：

- Product 安装、更新与修复：继续由 Wopal CLI 拥有；
- Evolution、Skill Lifecycle、Plan Scheduling；Evolution 的查询、worktree、内容提交、采用清单调整和失败恢复全部由 Wopal CLI 本机实现，不调用 WopalSpace service；
- Wopal CLI 的参数解析、交互提示、输出格式、machine envelope 和退出码；
- Ellamaka Runtime 的 Session、Agent、PTY、Tool 和 effective capability discovery；
- Core Preparation 内部的 DSH、plugin dependency、preflight 机制；
- 通用多 key / 多作用域 Config Plane、DSH native 配置投影与 schema catalog；
- 任意文件系统、Shell 或进程执行 API。

## Architecture

依赖方向固定为：

```text
                         @wopal/ellamaka-sdk
                         one public client
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
                    ▼                           ▼
          Ellamaka Runtime             @wopal/wopalspace
       Session / Agent / PTY            Setup / Ontology / Space
       Tool / CorePreparation                    │
                    │                            │
                    └──────────────┬─────────────┘
                                   ▼
                         Ellamaka Server host
```

关键边界：

- `@wopal/wopalspace` 是 WopalSpace application 业务的唯一实现位置。
- `@wopal/ellamaka-sdk` 是唯一公开 SDK；它可以同时暴露 Runtime API 和 WopalSpace API，但二者内部 owner 仍然分开。
- `@wopal/wopalspace` 可以调用 `@wopal/ellamaka-core`；Core、Session、Agent、PTY、Tool 等底层 Runtime 模块不能反向依赖 WopalSpace。
- `packages/opencode` 作为最终 Server/Application composition host，以及其中的 Workbench integration，可以直接组合 Runtime 与 private WopalSpace service；这不等于底层 Runtime domain 反向依赖 WopalSpace。
- WopalSpace 与 Ellamaka Core 的内部协作使用代码级 service，不通过启动 Ellamaka CLI 子进程。

目标 package：

```text
packages/wopalspace/    private @wopal/wopalspace
```

对外 service contract 统一由 `@wopal/ellamaka-sdk` 发布。

## Public API Model

WopalSpace operation 进入 Ellamaka 的统一 HttpApi/OpenAPI，再由 `@wopal/ellamaka-sdk` 生成 client。

```text
private @wopal/wopalspace
       │ application operations
       ▼
Ellamaka Server API composition
       │
       ├─ real HTTP/SSE -> Browser / Desktop / remote client
       │
       └─ local transport -> Wopal CLI
                              Worker/RPC -> app.fetch(Request)
```

同一个 operation 只有一份名称、输入、输出和错误语义。本机 transport 不经过 TCP，但不能形成第二套业务 API。

## Public Operations

WopalSpace 的长期公开协议由本节与后续各领域章节共同定义。`DESIGN-ellamaka-sdk.md` 定义 contract 如何进入 HttpApi/OpenAPI/generated client；本文件是 WopalSpace operation 路径、输入输出语义与业务行为的真相源。

### Refactor Compatibility Contract

本轮 WopalSpace 重构改变业务 owner、调用边界和 transport，不重新定义已经由现有 Wopal CLI、Onboarding、Workbench 与 OpenCode-compatible Runtime 验证过的领域行为。除本设计明确声明的目标变化外，现有可观察业务语义构成兼容基线。

必须保持的兼容维度包括：

- 输入的既有默认值、合法组合和稳定拒绝条件；
- 领域结果字段及其含义、partial-success 表达和稳定错误语义；
- Ontology 的 clone/fork、origin/upstream、branch/history、dirty-worktree、preview/apply、push/PR 与恢复行为；
- Space 的 registry identity、assembly snapshot、shared/local/private/include/exclude/path/plugin selection、sparse、relink/repair、sync 与回滚行为；
- 用户文件、Git history、无关 dirty change 和已有本地状态的保护边界；
- 幂等、重复调用、并发、取消、重试和失败恢复的可观察结果；
- Workbench/Onboarding 已验证的 Session、PTY、文件浏览、导航、重连和 Space 使用流程；
- OpenCode-compatible Runtime 与 `PluginInput.client` 的既有兼容边界，由 Runtime/SDK owner 保持，不因 WopalSpace 重构而改变。

允许改变的只有本设计明确列出的目标合同，例如：共享业务 owner 变为 private `@wopal/wopalspace`、HTTP/local 共用 canonical schema、`ontology.inspect` 与显式 `refresh` 分离、Terminal Setup 收敛为 Web Onboarding launcher、产品安装仍归 Wopal CLI。架构变化本身不能被解释为业务语义变化。

实施时，旧 Wopal CLI/Onboarding/Workbench 代码不是新的设计真相源，但它们与现有测试是兼容基线证据。对迁移的 operation，应先用 characterization 测试固定当前可观察行为，再让新 service 在相同 fixture 上得到等价领域结果和副作用；只有本设计明确改变的字段或流程允许形成有意差异。

### Contract Rules

- `:name` 是稳定 registry key；`displayName` 只用于展示。
- 列表结果统一为 `{ items, total }`。
- 公开错误统一包含稳定 `code`、`message` 与可选 `suggestion`，并由同一 `HttpApiEndpoint` 声明对应 HTTP status。
- inspect/list/search/status/scan/plan 等只读 operation 不得隐式执行 fetch、创建 Runtime instance、修复文件、改写 registry 或改变 Git refs。
- 写 operation 在第一处持久化前重新读取决定本次动作的关键 facts。preview 与 apply 使用同一判定逻辑；preview 不产生本地或远端写入。
- HTTP operation 解释 Server 所在机器的路径与 `$WOPAL_HOME`；trusted-local transport 使用 Worker 注入的本机上下文。调用参数不能替换宿主根目录或获得任意文件系统能力。
- path-bearing operation 在读写前执行规范化、registered-root/realpath confinement 与 Git target validation。
- secret 只进入需要它的执行调用，不出现在 plan、持久状态、事件、日志或错误详情。

### Product Settings

private `@wopal/wopalspace` 提供受控的 canonical settings writer，供 Server composition 写入已经由 Active DESIGN 注册的 Wopal 产品设置。它不是任意 JSONC 编辑器，也不是通用 Config Plane。

当前正式注册的唯一键是 `wopal.dsh.web.enabled`：

- 作用域固定为用户全局 `$WOPAL_HOME/config/settings.jsonc`；默认值 `true`。
- Space `settings.jsonc` 与 `settings.local.jsonc` 不参与这个键的覆盖，也不能成为它的写入目标。
- writer 在持久化前校验 key、scope 与 value，原子发布修改，并保留 JSONC 注释、未知字段和同文件内其他配置。
- Server 的 `config-v2` handler 组合 Runtime effective read 与这个 writer；Workbench 不直接读写配置文件。
- 写入结果返回 `restart-required`。运行中的 Server/sidecar 继续使用启动时解析出的 Web profile 意图，直到用户重启。

更广泛的 global/space 配置编辑、来源解释、reset-key、schema catalog 与 DSH native projection 属于统一 Config Plane 的后续范围，不由这个窄 writer 推断或提前实现。

### Setup Endpoints

| Operation | Method/path | Contract |
| --- | --- | --- |
| `setup.inspect` | `GET /wopal-space/setup/inspect` | 返回 application Setup 状态与各目标实时 facts；零写入 |
| `setup.plan` | `POST /wopal-space/setup/plan` | 输入 `goals`；返回宿主内保存的 `planId` 与有序 actions；零写入业务资源 |
| `setup.execute` | `POST /wopal-space/setup/runs` | 输入 `planId/actionId` 与该 action 必需的临时 credential；返回 `SetupRun` |
| `setup.progress` | `GET /wopal-space/setup/runs/:runId` | 返回当前 run 快照 |
| `setup.progress.events` | `GET /wopal-space/setup/runs/:runId/events` | SSE；返回带单调 `sequence` 的进度事件 |
| `setup.cancel` | `POST /wopal-space/setup/runs/:runId/cancel` | 请求取消并等待当前安全提交/清理边界结束后返回 run 状态 |
| `setup.complete` | `POST /wopal-space/setup/complete` | 输入 `planId`；重验 application 目标并持久化 completed |

`SetupGoal` 至少覆盖 foundation、ontology、space、github、provider 与 preset。`SetupAction` 包含稳定 `actionId`、goal 与 `requiresInput`；`SetupRun` 包含 `runId/actionId/status` 与可选稳定错误。

### Ontology Endpoints

| Operation | Method/path | Contract |
| --- | --- | --- |
| `ontology.list` | `GET /wopal-space/ontologies` | 返回已注册 Ontology；只读本地 registry/facts |
| `ontology.install` | `POST /wopal-space/ontologies` | 输入 source/name 与 clone-or-fork 模式；返回注册身份及 created/reused 事实 |
| `ontology.inspect` | `GET /wopal-space/ontologies/:name/status` | 返回本地仓库、remote topology、工作区与同步 facts，以及本次 refresh 的 PR 查询结果与查询诊断；不联网 |
| `ontology.refresh` | `POST /wopal-space/ontologies/:name/refresh` | 受控 fetch remote refs，并按贡献分支查询 GitHub PR；分别返回 Git 与 PR 刷新结果，不改本地分支/工作区 |
| `ontology.sync` | `POST /wopal-space/ontologies/:name/sync` | `confirm:false` preview，`confirm:true` apply；返回本地与远端各阶段结果 |
| `ontology.capability.list` | `GET /wopal-space/ontologies/:name/capabilities` | 返回 Ontology 完整能力池；不做 Runtime 权限过滤 |

### Space Endpoints

| Operation | Method/path | Contract |
| --- | --- | --- |
| `space.resolve` | `POST /wopal-space/spaces/resolve` | 按稳定 name 或可信 directory 上下文解析已注册 Space |
| `space.list` | `GET /wopal-space/spaces` | 返回已注册 Space |
| `space.init` | `POST /wopal-space/spaces` | 输入 name/root/ontology/type/displayName；返回注册身份、`materialized` 与 `preparation` 两个独立事实 |
| `space.projects.list` | `GET /wopal-space/spaces/:name/projects` | 返回 registered root 下项目与 worktree facts |
| `space.files.list` | `GET /wopal-space/spaces/:name/files` | 输入可选相对 `path`；返回 registered root 内受控目录项，不启动 Runtime |
| `space.files.read` | `GET /wopal-space/spaces/:name/files/content` | 输入相对 `path`；返回 registered root 内受控文件内容，不启动 Runtime |
| `space.search` | `GET /wopal-space/spaces/:name/search` | 在 registered root 内按受控条件查找 repo/dir/file |
| `space.scan` | `POST /wopal-space/spaces/:name/scan` | 扫描 repo/worktree/AGENTS 等只读事实，不启动 Runtime |
| `space.status` | `GET /wopal-space/spaces/:name/status` | 返回 Git、assembly snapshot、selection、sparse 与 preparation facts |
| `space.sync` | `POST /wopal-space/spaces/:name/sync` | `confirm:false` preview，`confirm:true` apply；返回 shared/private/sparse 与部分结果 |
| `space.capability.add` | `POST /wopal-space/spaces/:name/capabilities` | 输入 references/local/section/confirm；添加 shared 或 local selection |
| `space.capability.remove` | `DELETE /wopal-space/spaces/:name/capabilities` | 与 add 同一 selection contract；移除指定 selection |

`space.capability.*` 的 `section` 保持开放集合，默认 `ellamaka`；只有 plugin selection 接受 section。结果保留 selection、warnings、capabilities 与 state commit 等领域事实。

## Setup

WopalSpace Setup 只有一个用户 presentation：`@wopal/ellamaka-app` 的 `/onboarding`。

共享初始化状态保存在：

```text
$WOPAL_HOME/ellamaka/state/onboarding.json
```

它只保存 Setup 流程恢复位置和 `completed` 等 application 状态，不缓存：

- Ellamaka 产品当前 Core readiness；
- 产品真实安装版本；
- Ontology 当前 Git 状态；
- Space 当前装配状态；
- provider/GitHub credential 明文。

`wopal setup` 不是第二套 Setup client。它只启动或复用 `ellamaka serve`、传递 host/port/password 等 Server 参数并打开 `/onboarding`。

### Flow

```text
inspect current machine
  -> ensure WOPAL_HOME foundation
  -> ensure/reuse Ontology
  -> create/reconcile Space
       -> .wopal materialized
       -> prepare this Space instance plugin dependencies
  -> optional credential/provider bootstrap
  -> re-inspect completion
  -> complete
```

Setup 不安装或更新 Wopal CLI、Ellamaka CLI、Desktop stable/beta。能够进入 Onboarding，意味着承载该页面的 Server 产品已经存在；其他产品安装/升级继续由 Wopal CLI Product 命令显式完成。

`completed=true` 只表示首次 application 初始化完成，不表示当前或未来的 Runtime/Space instance 永久 Ready。

Home foundation 包括受控目录、用户 capability roots、初始配置与所需工具资源；已有用户内容保留。窄范围 credential bootstrap 复用 Runtime credential writer 和受控 GitHub credential adapter，不引入完整 Config Plane。credential 不进入 plan、state、events 或错误详情。

Setup service 在当前宿主中只执行一个 action，重复请求复用或返回 busy；底层共享 Git/文件写入沿用各资源现有锁。plan 只读，execute 在写入前重验实际 facts；complete 与执行使用同一写入边界，持久完成记录成功后才返回完成。进程退出后的 in-progress 只作为恢复提示，重新 inspect 后继续，不能据此认定 action 成功。

### Operation Semantics

- `setup.inspect` 每次从 Home、Ontology registry/Git、Space registry/assembly 与受控 credential presence 读取实时 facts，再与 `onboarding.json` 的流程恢复信息组合。损坏 state 作为明确事实返回，不在 inspect 中改名、覆盖或修复。
- `setup.plan` 把用户 goals 与 inspect facts 比较，只生成仍需执行的 actions，并在当前 Server 内保存生成计划时使用的关键 fact fingerprint。计划中不得复制 credential。
- `setup.execute` 先重新 inspect 并比较 plan fingerprint；关键事实变化时返回 `SETUP_PLAN_STALE`。同宿主已有另一 action 时返回或复用对应 run，否则建立单一 run，调用 foundation/Ontology/Space/credential/preset 的真实 owner。每个持久步骤完成后发布事件。
- `setup.progress` 只读 run snapshot；SSE 从 caller 指定或 Server 可恢复的 sequence 继续发送，重连不能把缺失事件解释为成功。
- `setup.cancel` 设置 operation cancellation signal。已进入原子 Git/文件提交边界的步骤完成提交或回滚后才结束；随后返回 `cancelled`、`failed` 或已经完成的真实状态。
- `setup.complete` 重新 inspect 当前 application facts，并验证 plan 中用户明确要求的 goals。满足后写入 `completed=true`；写入失败返回 `SETUP_STATE_WRITE_FAILED`，目标不足返回 `SETUP_INCOMPLETE`。DSH degraded 与产品 inventory 不属于 completion 条件。

稳定 Setup 错误至少包括 `SETUP_PLAN_NOT_FOUND`、`SETUP_PLAN_STALE`、`SETUP_OPERATION_BUSY`、`SETUP_INCOMPLETE`、`SETUP_STATE_WRITE_FAILED`。

## Core Preparation

Core Preparation 属于 `@wopal/ellamaka-core`。它解决的是：**当前真正运行的 Ellamaka 产品/build，或某个具体 Space instance，在使用对应能力前是否具备所需运行资源。**

它不是“整机产品全集”的准备器，也不是 Setup planner 的一个步骤。

### Product-Bound Preparation

每个实际运行入口只准备自己：

```text
ellamaka serve/web
  -> read current build embedded runtime identity
  -> prepare current build requirements
  -> activate required DSH/runtime capabilities

Desktop sidecar
  -> read embedded sidecar runtime identity
  -> prepare embedded build requirements
  -> activate required DSH/runtime capabilities

TUI
  -> prepare current build requirements
  -> activate only capabilities this entry needs

ellamaka run
  -> native Core only
  -> DSH branch permanently disabled
```

当前产品需要的 DSH manifest、`closureVersion` 与 preparation resources 由该 build 自己携带和验证。没有要求把这些信息做成可供另一个产品离线读取的跨产品 Descriptor contract。

`wopal setup` 不调用 CorePreparation。它启动的 `ellamaka serve` 会按照上面的正常产品启动路径准备自己。

### Instance Preparation

Space plugin dependency 只在 `.wopal` 已经物化之后才有明确输入：

```text
space.init
  -> materialize/reconcile Space and .wopal
  -> CorePreparation.prepare(instance(spaceRoot))
       -> path-plugin dependencies
       -> instance preflight
```

本机 SDK Worker 可独立执行 instance preparation，使用与 Server 相同的 contributor，不启动 DSH 或完整 Runtime。依赖安装按规范化后的真实目录跨进程互斥，获得锁后重读声明与指纹；只有成功安装且输入仍匹配时才发布准备结果。

Runtime 第一次加载该 Space 时仍执行 `inspect(instance)`；如果依赖后来发生变化，再通过同一 service fallback prepare。

如果 Space 已成功物化但 instance preparation 失败，不能回滚或删除 Space。结果是“Space 已存在，但 instance 尚未 Ready”，修复后可以重新准备。返回结果明确区分 Space 物化成功与 instance preparation 的失败/取消，重试只补齐缺失准备，不重新创建 Space。

### Preparation and Activation

准备 DSH 文件与真正启动 DSH 容器是两件事：

```text
CorePreparation
  -> closure / Home / profile ready

product entry
  -> mountDshWeb / mountDshTools as required
```

CorePreparation 不拥有产品进程生命周期；产品入口根据自己的需要执行 Runtime Activation。

Server 使用单一 Runtime 生命周期。某项附加能力处于 `PREPARING` 或 `DEGRADED` 时只影响该能力，不把整个 Runtime readiness 绑定到单项附加能力。

### DSH Home Safety Boundary

DSH Home 的保护归 Runtime 所有，不归 Setup。每个产品构建携带共享的 closureVersion。运行中的 DSH 进程持有 Home 共享锁；切换到更新的 closure 版本必须取得排他锁并完成 Home 备份。已记录的更新版本会阻止较旧产品打开 Home。持久 managed marker 用来区分历史 Home 的首次接管与版本状态丢失；元数据未知/损坏或备份失败都会阻止 DSH 写入。历史 Home 首次接管要求旧的、不参与协议的 DSH 进程已经停止；该确认由交互入口完成一次。Setup 不准备其他产品、不检查 Home 内部、不恢复备份，也不翻译 DSH 数据。

### Readiness States

Core Preparation 使用统一事实状态：

| 状态 | 含义 |
| --- | --- |
| `READY` | 当前目标满足运行条件 |
| `NEEDS_PREPARATION` | 当前事实要求准备 |
| `PREPARING` | 同一目标已有准备任务，调用方加入同一任务 |
| `BUSY` | 当前暂时不允许安全准备 |
| `DEGRADED` | 准备/检查有问题，但已有基础能力不必整体停机 |

状态是实时事实，不写入 Onboarding completed 状态。

### Entry Rules

| 入口 | Core Preparation / Activation |
| --- | --- |
| `ellamaka serve` / `web` | 启动时检查当前 build；需要时准备；Ready 后激活该入口所需 DSH 能力 |
| Desktop | sidecar 检查 embedded build；需要时准备；Ready 后激活 Desktop 所需 DSH 能力 |
| 默认 TUI | 检查当前 build；进入具体 Space 时另外检查 instance |
| `wopal setup` | 只启动/reuse `ellamaka serve` 并打开 `/onboarding`；自身不执行 CorePreparation |
| `space.init` | `.wopal` 物化成功后立即准备该 Space plugin dependencies |
| Space Runtime activation | `inspect(instance)`；不 Ready 时 fallback prepare，只影响该 Space |
| `ellamaka run` | 固定 DSH-disabled；不做任何 DSH Preparation，不创建/复用/探测 DSH 容器，不读写 DSH Home/profile，不暴露 DSH tools |
| `run --attach` | 不创建本机 listener/目录 instance，不执行 CorePreparation 或 DSH 准备/挂载；远端 Runtime 自己负责 |

独立的 `ellamaka dsh init` 不属于目标态。DSH preparation 由真正需要 DSH 的产品入口按需完成。

## Ontology

Ontology 内容真相源是 Git repository。WopalSpace 负责安装、登记和维护协作关系。

### Operation Semantics

- `ontology.list` 读取 registry 并为每个条目返回稳定身份和可安全取得的本地摘要；单个仓库不可读时作为该条目的诊断事实，不触发 fetch 或自动修复。
- `ontology.inspect` 解析 registry 指向的真实仓库，检查 branch/worktree cleanliness、origin/upstream topology、已知 refs 与同步关系。它只基于本地对象数据库和 refs。
- `ontology.capability.list` 从已注册 Ontology 的 assembly/capability source 解析完整候选能力及来源信息；它描述“可供 Space 选择什么”，不计算某个 Runtime 当前实际加载或授权了什么。
- `ontology.install` 先验证 name/source/mode 与现有 registry/repository 是否兼容。兼容的同一仓库返回 reused；不存在时在受控临时/目标位置完成 clone 或 fork topology 建立、验证 assembly 后再提交 registry。身份冲突、remote/history 冲突在注册写入前终止。
- `ontology.refresh` 更新 remote tracking refs、FETCH_HEAD 与对象数据，并查询贡献分支对应的 PR；Git fetch 与 PR 查询分别报告成功或不可用。PR 查询失败不阻断本地同步状态展示。
- `ontology.sync` 先生成本地/远端动作计划。preview 返回该计划且零写入；apply 重新生成并确认仍等价后执行。local main 更新成功而 push 失败时，返回 local success + remote failure，后续重试不得重复破坏已完成的本地阶段。

### Install

```text
resolve source and clone/fork mode
  -> reuse valid existing repo or clone/fork
  -> verify remote topology and assembly content
  -> register ontology
```

已有仓库的 remote/history 与请求冲突时必须停止并报告，不能覆盖用户 Git history。

### Refresh and Inspect

inspect 只读本地 Git facts 与本次 refresh 提供的 PR 结果，不执行网络查询。refresh 显式刷新 refs 并查询 GitHub；刷新结果仅供本次调用使用，Git 保存分支/worktree，GitHub 保存 PR 身份与状态，不另建持久化贡献记录或后台轮询。

Fork 模式下，从本地 `contribute/*` 分支、origin 上同前缀分支及其 worktree 合并取得贡献清单；同一分支只展示一次。查询限定当前 upstream 仓库、origin fork 的完整身份、head branch 与目标 `main`，不把其他 fork 的同名分支当作本次贡献。多个候选无法唯一确认时展示歧义。

每项展示分支名、worktree 路径（存在时）、PR 编号/链接及 open / merged / closed 状态。未找到对应 PR 与查询失败分别展示；merged 标记“已合并，待收尾”，closed-unmerged 标记“已关闭，待决定”，两者都不是删除授权。远端分支已删除但本地分支/worktree 仍存在的贡献继续可见。命名约定只约束新建资源，现有长名称仍可发现，不自动改名或删除。

CLI `ontology status` 先请求 refresh，再 inspect。Git 或 PR 刷新失败保留可取得的事实并明确标注，不能用缓存宣称当前已合并或可安全清理。

### Sync

Fork 模式：`upstream/main -> origin/main -> local main -> origin/main`。

Clone 模式：`origin/main -> local main`。

preview 不修改 refs；apply 使用相同判断执行。冲突不能留下半完成状态；本地同步成功但 push 失败时要明确报告本地与远端结果不同。

### Contribute

上游贡献是 `ontology-evolution` 技能指导的原生 Git/GitHub 工作流。创建、评审修复、冲突处理和清理由 Agent 使用 `git` 与 `gh` 完成；WopalSpace service/SDK 的贡献相关职责是只读状态查询。

#### Branch and Worktree

一个主题对应一个 PR、一个 `contribute/<slug>` 分支和一个 `<space-root>/.worktrees/ontology-contribute-<slug>/` worktree。slug 使用简短英文主题，2–4 个词、最多 24 个字符，仅小写字母、数字及单连字符；不用完整提交标题、时间戳或随机串。名称占用时先查明归属，同一贡献复用，不反复加后缀新建。

worktree 从当前 `upstream/main` 建立，保持完整检出，与空间稀疏装配工作树分离。PR 创建后一直保留到评审、修复、合并回流及授权清理结束；失败或冲突保留现场。宿主本体目录保持当前分支和工作内容不变。

#### Scope and PR Content

Space 是内容维护入口。经用户授权汇入 local main 后，Agent 只选取本主题提交或经过核对的改动片段进入贡献分支，保留新增、修改、删除与重命名的完整语义。文件相同不代表主题相同；不能用整文件覆盖保证不夹带同期修改，也不能覆盖贡献分支已有的上游适配和冲突解决。

创建和修复都采用普通 push；同一个 PR 持续复用分支/worktree，可按评审补充或删除文件。推送被拒或存在不明外部提交时保留现场并核对，不强推。推送或建 PR 中断后，先核对远端 head 与已有 PR，再继续同一个现场。

PR 正文由 Agent 根据最终 diff 与实际验证编写，说明背景与原因、主要变化、影响的能力及文件清单、增删行数、范围选择依据和验证结果。统计从最终贡献分支相对 base 的差异取得，不用空泛固定模板或推测数字。

#### Return and Cleanup

PR 合并后，由用户决定执行 `ontology.sync` 接入上游实际落地历史并推送 fork main，再由 `space.sync` 对齐来源 Space；merge、squash 与 rebase 均走此路径。sync 只负责同步 refs，不管理贡献分支或 worktree 的删除。

Agent 在用户明确授权清理后核对：PR 身份与 merged 状态、落地提交已进入 local main、fork main 与 local main 对齐、来源 Space 已同步、worktree 没有未提交/未跟踪/被忽略的工作，以及本地和仍存在的远端 head 均等于该 PR 最终 head。只有证据齐备才能精确清理这一组资源。合并之后追加的提交、未合并关闭、查询失败、归属不明或其他 worktree 占用均保留并报告。

清理使用原生 Git，顺序为移除已核实干净的 worktree、删除仍存在的 fork 分支、删除本地分支。squash/rebase 导致普通安全分支删除不通过时，须凭上述证据与用户明确删除授权处理；不因内容看似相同就强删，不按前缀批量删除。操作部分失败如实报告残留。

#### Verification Boundaries

- 状态查询覆盖本地独有、远端独有、已有 worktree、远端已删除的分支，区分无 PR、查询失败和身份歧义。
- 多轮评审复用同一 PR/分支/worktree，允许补文件，发布前核对完整 diff 与正文。
- merge / squash / rebase 回流保留本地内容；sync 本身不删除贡献资源。
- 失败、冲突、外部提交、未提交内容或查询不明时保留现场；清理仅触达已授权且核实归属的资源。

## Space

Space 身份由 registry、Space root、Ontology `space/<name>` branch、`.wopal/` worktree 和 `.wopal-space/space-meta.json` 装配快照共同确定。

### Operation Semantics

- `space.resolve` 优先使用稳定 registry name；可信 directory 只用于反查已注册且 realpath 覆盖该目录的 Space。解析失败只返回诊断，不创建 registry 条目或 Runtime instance。
- `space.list` 以 registry 为入口返回稳定身份与可安全读取的装配摘要。registry 与磁盘事实不一致时报告 mismatch，不在 list 中执行 repair。
- `space.projects.list` 枚举 registered root 内受认可的 project/worktree facts；`space.files.list/read`、`space.search` 与 `space.scan` 使用同一 registered-root/realpath confinement。文件读取只接受受控相对路径，不执行 package/bootstrap、Git fetch 或 Runtime activation。
- `space.status` 汇总 registry、meta snapshot、Git branch/worktree、sparse/selection 与 instance preparation 的实时 facts；状态检查不改变这些事实。
- `space.init` 根据 registry、root、Ontology branch 与 snapshot 将请求分类为 create/reuse/relink/repair。它在改变任何用户状态前验证固定 Space type、目标 root、Ontology 身份和可恢复 snapshot；随后在现有装配事务边界内物化/修复 `.wopal`，成功后提交 registry/snapshot，再调用 instance preparation。materialization 与 preparation 分开返回，后者失败不撤销前者。
- `space.sync` 从当前 Space snapshot 与 Ontology main 计算允许触达的 shared 内容、private 排除和 sparse 变化。preview 零写入；apply 重算并校验 dirty touch-set，再按既有 refs/sparse/meta 事务执行。与 touch-set 冲突的脏改动或 private 上行在第一处写入前拒绝。
- `space.capability.add/remove` 先在当前 assembly snapshot 上计算 selection mutation 和重物化影响。`confirm:false` 返回 preview；apply 仅修改相应 manifest/meta/assembly 范围并保留无关用户内容。local selection 的持久化与 shared selection 的提交边界分别遵循各自 owner，失败返回可诊断的部分结果。

### Init

```text
resolve Space + Ontology
  -> classify create/reuse/relink/repair
  -> verify assembly type and snapshot
  -> materialize branch + .wopal worktree
  -> assemble content
  -> update registry/snapshot
  -> prepare instance plugin dependencies
```

已有 Space 的装配快照不能靠猜测重建；重复 init 不能偷偷改变 Space type；修复不能直接删除用户内容；已有 Space 以自己的 branch/snapshot 为基准，不因重复 init 自动吸收 Ontology main 新变化。

### Query and Files

`space.list/projects.list/files.list/files.read/search/scan/status` 提供 WopalSpace 可复用事实，并进入 Public Platform API。官方 App BFF 需要这些 facts 时在 Server composition 内直接调用 private WopalSpace service。

受控 Space 文件浏览以 registered Space root 为边界，规范化和 realpath 后都不能逃出 root。它是 WopalSpace public contract 的共享基础能力，不形成任意 filesystem API。

### Sync and Capability Selection

Space sync 的 preview/apply 使用同一判断；private 内容不能因普通 sync 上传；失败不能留下无法解释的 refs/sparse/assembly 状态。

Capability selection 继续使用 Ontology assembly 定义的 shared/local、include/exclude/private 语义。WopalSpace 负责 selection mutation，Runtime 负责 effective capability discovery。

## Workbench Integration

Workbench UI 和 WopalSpace application 不是两个独立产品。`@wopal/ellamaka-app` 在运行阶段使用 Workbench，在配置阶段使用 Onboarding。

Workbench 所需的可复用 Space facts 由 `@wopal/wopalspace` 提供并进入 Public Platform contract。Session Tree、creation locations、Session Provision 等同时组合 Runtime session facts 与 Space facts 的产品投影/use case 归 `@wopal/ellamaka-app` 的 Official App BFF；Server composition 负责挂载这层私有 contract。

Official App BFF 可以直接调用 private WopalSpace query service 与 Runtime service。`ellamaka-core`、Session、Agent、PTY、Tool 等底层 Runtime 模块保持对 WopalSpace 无反向依赖。

## Security

当前阶段不建设 WopalSpace 细粒度 operation/resource IAM。WopalSpace API 使用 Ellamaka Server 统一认证边界；持有有效 Server credential 的调用方视为该 host 的受信管理者。

所有 path-bearing operation 仍必须执行自身业务边界检查，例如 Space root confinement、Git target validation 和 secret redaction。Phase 3 的统一 Host Auth 方向见 `DESIGN-auth.md`。

## State Ownership

| 状态/事实 | Owner |
| --- | --- |
| Setup 流程状态 | `@wopal/wopalspace` setup |
| 产品安装/update 事实与事务 | Wopal CLI Product |
| Core readiness / preparation run | `@wopal/ellamaka-core` |
| DSH closure/Home/profile mechanics | `@wopal/ellamaka-cordis` |
| Ontology Git 内容/history | Ontology repository |
| Ontology registry/lifecycle | `@wopal/wopalspace` ontology |
| 基础 Space registry/assembly lifecycle | `@wopal/wopalspace` space |
| Evolution 的提案、提交、采用清单调整及恢复 | Wopal CLI 本机 Evolution service |
| Runtime Session/Agent/PTY/Tool | Ellamaka Runtime |
| GUI Onboarding / Workbench view state | `@wopal/ellamaka-app` |

## Invariants

1. Setup、Ontology、Space 的共享业务只在 `@wopal/wopalspace` 实现一份。
2. Product 安装/update 继续由 Wopal CLI 拥有，不迁入 WopalSpace。
3. `@wopal/ellamaka-sdk` 是唯一公开 service SDK，承载 Runtime 与 WopalSpace public contract。
4. GUI Onboarding 与 Workbench 都属于 `@wopal/ellamaka-app`。
5. WopalSpace 不通过 spawn Ellamaka CLI 执行 Core Preparation。
6. Core Preparation 内部 readiness、锁、DSH/plugin/preflight 步骤归 `@wopal/ellamaka-core`。
7. 产品启动只准备当前产品/build 真正需要的运行资源；`wopal setup` 只负责拉起 Server Onboarding，不执行跨产品 preparation。
8. Space plugin dependency 只在 `.wopal` 物化后准备；失败不回滚已经成功物化的 Space。
9. `ellamaka run` 永久保持 DSH-disabled，除非 Runtime/DSH 设计被显式修改。
10. `ellamaka dsh init` 不属于目标态。
11. Workbench integration 可以直接组合 private WopalSpace service；底层 Runtime domain 不能反向依赖 WopalSpace。
12. 当前阶段不引入细粒度远程授权体系；业务 path/resource safety 仍必须由各 operation 保证。
