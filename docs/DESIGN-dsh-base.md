# DSH 融合基础设计

> **Status**: Active
> **Updated**: 2026-10-14
> **Parent**: `./DESIGN.md`
> **Sibling DESIGNs**:
>
> - `./DESIGN-wopalspace.md` — WopalSpace Setup 对 CorePreparation 的上层消费边界
>
> **Scope**: DSH v0.2 的运行资源、固定 Home 基本防护、切代前备份与 profile 生命周期。

Bridge 就是 `@wopal/ellamaka-cordis` 包。它负责加载本产品固定的 DSH、准备环境、挂载两个 profile、适配 Bun/Electron 执行差异，以及把 DSH 工具接到 Ellamaka。实际工具注册、PTC 程序执行和沙箱实现由 DSH 提供。

内部 dsh-adapter 也在这个包中；opencode 只注册插件和提供引擎回调，不保存另一份 DSH 适配代码。CLI 用 Bun，Desktop 用产品自带的 Electron utilityProcess，二者编译同一份 Bridge 源码。

## Runtime Ownership

The basic safety boundary protects the single DSH Home from being opened by an older closure after a newer one has taken ownership.

1. $WOPAL_HOME/dsh/home is the only active Home.
2. Ellamaka maintains one increasing closureVersion shared by CLI and Desktop builds. It changes when the pinned DSH closure or product-owned DSH files change in a way that can affect Home data. Product SemVer and release channel do not identify Home compatibility.
3. Every DSH-enabled runtime holds a shared OS lock while using Home. The same closure version may run in multiple processes. Switching to a newer version requires the exclusive form of that same lock; an active older runtime therefore prevents the switch.
4. Before a newer version can write Home, the product completes a backup and then records the new version. A backup or state write failure prevents DSH activation. An older version refuses to open a Home marked with a newer version.
5. A small persistent managed marker records that Ellamaka has taken ownership of this Home. An existing Home without both marker and version state is adopted once, after old DSH processes have stopped, the exclusive lock is held, and a backup succeeds. If the marker exists but the version state is missing, or either metadata file is corrupt, report unknown state and refuse Home writes. Do not infer its history from DSH-private files.
6. If activation fails after the new version may have changed Home, retain the backup and report the failure. Do not restore Home automatically or start an older closure.
7. DSH owns its private data format. Ellamaka does not build a compatibility graph, data converter, automated restore flow, or recovery command. A DSH failure degrades DSH while native Ellamaka remains available.
8. The product that starts a Runtime prepares its own DSH resources. Setup does not scan other installed products or prepare their Home.

| Path | Purpose |
|---|---|
| $WOPAL_HOME/dsh/home | The single active Home |
| $WOPAL_HOME/dsh/closures/<version> | Product-pinned DSH runtime |
| $WOPAL_HOME/dsh/backups/<timestamp> | Copy made before a version change |
| $WOPAL_HOME/dsh/state/current.json | Active closureVersion |
| $WOPAL_HOME/dsh/state/managed | Minimal persistent ownership marker; no history or private DSH schema |
| $WOPAL_HOME/dsh/state/home.lock | Shared use and exclusive version change |
| $WOPAL_HOME/dsh/staging | Temporary materialization area |

The lock serializes version changes against running DSH processes. Runtime state records only the active closure version; it does not describe DSH's private data schema.

## Dependency Closure

### Release Boundary

packages/ellamaka-cordis/package.json and the checked-in package-manager lock pin the DSH dependency versions. Ellamaka source owns one increasing closureVersion, embedded by both CLI and Desktop. Bump it when the locked DSH closure or product-owned DSH files change in a way that could affect Home data. Do not infer Home compatibility from CLI/Desktop SemVer or channel, and do not add a full-content fingerprint or a compatibility matrix.

The generated manifest and lock must stay consistent with those inputs. Keep the existing build and drift checks; they do not need to predict upstream DSH data migrations or maintain a history of published closure versions.

### Materialization

Materialize and validate the product-pinned DSH dependencies before reading or writing Home. Use the checked-in lock and its existing package integrity checks. A failed download, extraction, or required package check fails preparation before Home is touched. Keep the existing staging and closure reuse behavior; do not add a second package manager or a separate Home safety protocol here.

ELLAMAKA_DSH=0 short-circuits before DSH-specific environment setup, filesystem access, network access, materialization, or profile mounting.

### Loading and Status

Resolve DSH runtime APIs from the product's install anchor so the Bridge and DSH package use the same installed closure.

| Status | Meaning |
|---|---|
| disabled | The user explicitly disabled DSH |
| preparing | The current product is materializing or preparing its DSH resources |
| ready | This entry's required DSH capabilities passed activation checks |
| degraded | DSH is unavailable; native Ellamaka remains usable |

Expose a stable failure reason, the current build closureVersion and the recorded Home version through Runtime health when available. Do not make consumers inspect Home state directly. Publish DSH routes, tools, and handles only after the requested profile passes activation checks.

### Compiled Runtime

The packaged runtime must resolve DSH from the product-pinned closure through its install anchor. Validate that path in the actual CLI binary and Desktop sidecar; source-only package resolution is insufficient.

## Profile Runtime

### Declarations and Layers

profile 的 `package.json` 声明 dependencies 与有序 `dsh.profile.bundles`，是安装与激活的真相源。`cordis.yml` 是宿主生成的空 Include 根；`cordis.patch.yml` 是用户补丁。

完整配置按下列顺序求值：bundle 层 → profile 用户层 → home 注入与 home 用户层 → 命令行覆盖 → 宿主能力约束与显式环境硬禁用。一般用户配置保留覆盖能力；运行时不可执行的后端、无会话容器边界和禁用的 telemetry 由宿主约束保护。

ProfileRuntime 拥有 profile facts、完整补丁生成、包解析、root Include、mutation queue、验收与释放。启动、配置转储和重放共用同一生成过程，后续重放重新读取实际声明文件。

Ellamaka 自己创建的 profile 初始文件、固定 root Include 和必要格式整理只在首次准备或确认这些宿主文件缺失/未完成时写入；正常同版本 mount 只验证这些宿主文件，不重复改写。需要补写时遵守当前 Home lock 和 profile mutation queue。

### Boot Contract

DSH v0.2 使用 `createRuntimeResolution` 提供不可变的包映射，`auditStartupEntries` 提供启动审计，`prepareProfilePatches/reconcileProfilePatches` 提供版本兼容与激活诊断。

装配时注入 profileContext：name、dir、patchPath、installAnchor、cwd、home、startedBundles、overlays、telemetryDisabledEnv。Web 还注入 packageManager。overlays 包含必要的宿主约束，使原生设置与插件管理操作使用同一策略。

App Boot 审计后，宿主检查采用的必需服务和工具。Web 检查默认 preset 可解析和可绑定；tools 检查对应平台的采用集合。插件等待服务的警告不能直接等同于完整挂载成功。

## Host Compatibility

### Package Routing

带完整 resolution 的官方 PluginPackages 使用 Node 内部模块拦截器。Bun 使用官方支持的 metadata-only 模式，模块路由由 Bridge 拥有；Desktop 采用同一宿主解析契约。

首次启动自动接入 Bridge 的元数据资源解析，使用已选闭包与当前 profile 的 ESM 导出条件读取 package.json、locale 与受限图标，不执行插件代码。PluginPackages.metaOf 覆盖运行时/预设清单；PluginManager.listBundles 的公开子类适配覆盖官方可选 bundle 与已安装 bundle 清单。该子类由公开 EntryTree.import 路由接入，保留官方配置、Remote 方法标记、安装流程和兼容性诊断，不修改上游包、私有 Node 解析器或用户配置文件。

全新 home 的冷启动验收同时覆盖两类清单：官方资源的本地化字段正确、元数据错误为零、已启用全局插件和默认预设无失败或等待状态。缺少可选资源继续遵循官方契约；损坏元数据、图标越界及包版本不兼容保留真实诊断。API/token 等个人配置由用户自己维护，不以人工修补元数据作为首次启动前置。

Bridge 根据不可变运行时映射维护 `profiles/node_modules` 的官方解析层。插件实体与依赖位于当前 profile 的 node_modules，官方 peer 指向同一闭包。外来实体冲突产生诊断，宿主不覆盖用户的真实目录。

公开 EntryTree import 边界把裸包名解析为绝对模块 URL：官方包从闭包解析，外部包从当前 profile 解析。相对路径以所属声明文件为锚点，嵌套 group 使用相同规则。解析遵守 package exports 的 import/runtime 条件，缺失项明确失败。

Loader 的 internal 值保持真实。宿主不使用 Node 私有加载器模拟对象；第三方插件必须通过 Bun 兼容预检。

### Standard APIs

Bun 缺少官方 provider 消费的标准诊断 API 时，由 Bridge 在加载前初始化小型兼容入口。`getSystemErrorMessage` 缺失时，以 `getSystemErrorName` 提供错误码诊断并同步 builtin ESM exports。原生实现存在时直接使用原生实现。

兼容入口只处理已确定的 API 差异。进程和沙箱错误分类依赖结构化 code/errno，避免依赖某个运行时的错误文案。

## Configuration Lifecycle

### Serialized Mutations

每个 profile 的 HMR 服务提供 `watchConfig(filename, refresh)` 与 `runExclusive(operation)`。registerConfig 为同一注册和队列的兼容别名。宿主配置监听、configEditor、settings 与 pluginManager 的修改使用同一队列。

监听等待 ready，规范化路径并拒绝重复注册。已有操作完成后释放资源，关闭后的队列拒绝新操作；嵌套事务明确拒绝。

监听范围包括 profile manifest、profile 补丁与 home 补丁。内容签名决定是否重放，各 profile 根据实际输入变化触发。lastObservedInputs 与 lastAppliedGeneration 分别保存观察和成功状态，相同坏输入不会形成重复激活风暴。

### Activation and Recovery

配置激活保存上一份成功补丁，执行完整求值、兼容预检、reconcile、Loader settlement 与服务验收。失败时恢复原补丁并校验原状态，再返回失败；恢复失败使该挂载失效。

原生 reconcile 的失败诊断与宿主回滚是两个责任。配置队列对原生管理操作抛出的错误也执行恢复，确保 CLI 和 UI 使用一致的失败语义。

新增 bundle、启停与配置修改可以重放。包版本或代码替换产生 restart-required，运行中的模块保留当前实例，后续新进程使用新实体。闭包版本变更由产品启动边界承接；冷重载的单元协议见父设计。

Electron 使用产品内置 Node。宿主以官方 LocalSubprocessRuntime 的子类提供同一个公共 subprocess 服务，仅在控制通道、当前 Electron 可执行文件与官方 PTC bootstrap 三者同时匹配时恢复 `ELECTRON_RUN_AS_NODE=1`。控制协议、沙箱包装、进程所有权、取消及回收仍由 DSH 管理；用户不需要安装独立 Node。程序求值前清空环境变量。

Bun 在引擎和界面 preload 之前安装 Node diagnostic 兼容层，解决 `getSystemErrorMessage` 的命名导出初始化时序；Node 原生实现保持。该处理仅涉及公开 builtin 函数，不伪造 Loader internal 或私有 Node 接口。

Bun 的 PTC 兼容同样限制在确定的宿主差异上。主进程通过 Bun loader 对固定 rc.2 provider 的单一 `stripTypeScriptTypes` import 做精确替换，实际 strip-only 转换由随 Bridge 发布的 Amaro 执行。rc.2 默认把 JsonChannel 放在 `child_process` 的额外 fd 7 双向 pipe 上，而 Bun 连续创建额外 pipe 会出现可复现的 `ENOENT` / `EPIPE`；因此 Bun 路径只把该私有控制通道改走标准 stdin/stdout，stderr 保留为 bootstrap/进程诊断，官方 JsonChannel framing、binding、沙箱、取消、超时、输出预算与进程回收仍原样复用。源码态由 Bun 执行极小 child entry，编译态由同一产品二进制在 DSH 官方 `DSH_PTC_RUNTIME_NODE=1` 标记下进入私有 child 角色。固定 provider 的 strip、stdio/control、child bootstrap 任一适配锚点变化时，兼容层必须显式失败，禁止静默降级到无 PTC。

## Closure and Startup Lifecycle

### Product Binding

Each Ellamaka product build carries its closureVersion and pinned DSH lock. Only the product actually starting participates in Home access. Dormant CLI, stable Desktop, or beta Desktop installations do not affect the running product's preparation.

CLI and Desktop built from the same closure inputs use the same version. A product's release version or channel does not choose a different Home version.

### Core State and Preparation Integration

Core Preparation provides the DSH closure, Home, and profile steps. The product entry prepares the DSH resources it needs and then activates the requested profile. ELLAMAKA_DSH=0 skips all DSH preparation.

Home checks and version changes use the single Home lock. A running process holds a shared lock for as long as it may access Home. A version change requires the exclusive lock, so it cannot proceed while an older DSH process is still using Home.

### Home Version Check and Backup

Before profile setup or DSH activation, compare the product's version with state/current.json under the Home lock. A valid recorded version always takes precedence over a missing marker: an older runtime still refuses it, and a newer runtime still needs the normal backup/transition. The missing marker does not reset the Home version:

| Home state | Handling |
|---|---|
| Home, marker and state are all absent | First preparation records the version and managed marker before DSH activation |
| Existing Home has neither marker nor version state | With old DSH processes stopped and the exclusive lock held, back up Home, then record the current version and marker |
| Marker exists but version state is missing, or metadata is unreadable/invalid | Report unknown state, preserve the files and refuse Home writes |
| Valid version state exists but marker is absent | Preserve the recorded version; complete the missing marker under the exclusive lock before activation, without treating Home as unversioned |
| Recorded version equals the product version | Use the Home under a shared lock |
| Recorded version is newer than the product version | Refuse access; do not downgrade or modify Home |
| Product version is newer | Obtain the exclusive lock, back up the current Home, update the recorded version, then prepare product-owned files and activate DSH |

A failed backup or metadata publication grants the candidate runtime no Home write access. Version and marker publication use atomic file writes; incomplete metadata is reported, not automatically erased or guessed. Existing managed Home keeps its previous version when a version update fails. The backup is a copy for manual recovery, not a runtime directory. It retains the source closureVersion and managed metadata when known; an unversioned legacy source is explicitly marked unknown. First adoption of unversioned Home is an offline upgrade boundary: older builds do not hold this new lock, so obtaining it alone does not prove those older processes have stopped. Ellamaka does not verify or translate DSH-private data formats.

### Activation Failure and Manual Recovery

DSH activation failure degrades DSH only. If the new version may already have written Home, keep its version recorded and retain the backup; do not automatically restore data or launch older code against it.

If a user needs to restore a backup, all Ellamaka/DSH processes using that Home must first stop. Restore is a manual offline file operation that restores the selected Home copy together with its matching recorded version/managed metadata; an unknown legacy version must not be guessed. this release does not add a restore command, automated recovery workflow, or recovery state machine.

### Preparation Progress Semantics

DSH steps 发送 `@wopal/ellamaka-core` 的统一 `CorePreparationEvent`，不定义第二套 event type。`step` 分别为 `dsh.closure`、`dsh.home`、`dsh.profiles`；内部 `phase` 可以表达 materialize、integrity、home-version-check、backup、profile-seed、resolution/preflight 等细分。

只有底层存在真实度量时才报告 current/total/unit。准备事件标明 Home version check、backup 和 profile 步骤，不暴露 Home 内容或 secret。各实际产品入口消费同一底层事件来源。

### Unified Entry Matrix

| 入口 | Preparation | Runtime Activation |
| --- | --- | --- |
| `ellamaka serve` / `web` | 读取当前 CLI build descriptor；Ready 则 fast path，否则 prepare | Ready 后挂载该入口需要的 DSH Web/Tools；失败时 native Runtime 保持可用 |
| Desktop | 读取当前 embedded sidecar descriptor；Ready 则 fast path，否则 prepare | Ready 后挂载 Desktop 所需 DSH 能力 |
| 默认 TUI | 读取当前 build descriptor；需要时 prepare | Ready 后挂载该入口需要的 DSH tools；失败时原生 TUI 保持可用 |
| `wopal setup` | 自身不执行 DSH Preparation；它启动/reuse 的 `ellamaka serve` 按 `serve` 行处理当前 build | 打开 Web Onboarding |
| `ellamaka run` | DSH branch 永久跳过 | 纯 Ellamaka Core；不探测、复用或挂载 DSH |
| `run --attach` | 不创建本机 listener/目录 instance，不执行 CorePreparation 或 DSH 准备/挂载 | 使用远端 Runtime |

Stable Desktop、Beta Desktop、external CLI 可以来自不同 release；真正运行谁，就由谁自己携带的 closureVersion 进入 Home version check。未运行的产品不参与准备。

ellamaka run 是固定的 DSH-disabled 入口，不执行 Home version check 或 DSH activation。即使机器上已有 DSH Home 或另一个进程已挂载 DSH，run 也不能复用、探测或挂载这些能力。

独立的 `ellamaka dsh init` 不属于目标态。closure/Home/profile preparation 统一由真正需要 DSH 的产品启动入口按需完成。

### Release Guidance

Closure version changes are handled when the user starts the target Ellamaka product. Preparation checks and backs up Home before a newer version writes. If activation fails, the backup remains manual recovery material; no automatic downgrade or restore is attempted.

官方 adapter/preset/profile 自身必须在发布前修好并随产品发布，不能把产品代码修补责任推给用户 Agent。

### Commands and Ownership

| 组件                   | 职责                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Core Preparation       | `@wopal/ellamaka-core` 编排 contributors；API、single-flight、readiness、progress 归主 DESIGN 的 Core Readiness contract |
| closure manager | pinned lock materialization and install-anchor validation |
| Home version guard | one shared/exclusive lock, closure version check, backup before a newer version writes |
| ProfileRuntime         | product-owned profile/plugin 装配、审计、replay/release                                                          |
| Runtime Activator | activates a prepared profile while holding the shared Home lock |
| internal dsh-adapter   | DSH tools ready 后接入 Ellamaka；失败不静默降级                                                                  |
| Runtime startup caller | 未 READY 时调用 `CorePreparation.prepare(host)` 兜底；不复制 DSH mechanics                                       |

## Persistent Data

当前 DSH native 配置仍落在 `$WOPAL_HOME/dsh/home/profiles/<profile>/cordis.patch.yml`；Settings/ConfigEditor/HMR/Loader 拥有字段校验、revision 与 native apply lifecycle。Phase 3 Config Draft 计划把用户可管理的 DSH authored facts 提升到统一 `settings.jsonc`/`settings.local.jsonc`，再通过 DSH provider 投影回 native lifecycle；该方向不属于当前 Runtime Foundation 实施。closure-change backup 只保存恢复副本和最小元数据，不成为配置读写来源。

用户 preset 采用目标 DSH 的标准 bundle 声明与官方 YAML 方言；来源的生成文件和实际配置都保留。用户插件使用 profile 的固定依赖声明；官方解析层按当前 closure 重建，第三方兼容性按实际包声明和 Loader 诊断检查。不兼容实体不能通过沿用 revision/source 链接继续执行。closure-change backup 不冻结用户自行修改的外部插件源码或外部服务；内部 adapter 的匹配由产品制品保证。

Ellamaka 的 `settings.jsonc` 和三层 `wopal.pluginConfig` 仍是内部 adapter 行为配置来源，不写入 DSH profile 代替它。职责与字段归 [工具容器设计](./DESIGN-ellamaka-tools.md#internal-adapter) 与主设计的 [既有配置读面](./DESIGN.md#config-read-surface)。

Active Home 与 closure-change backup 按原敏感级别保存；失败信息只记录 backup 标识、相对路径和错误 code。用户编辑、复制配置或外部工具副作用不自动重放。

## Reference Documents

| 资料                                                                 | 用途         |
| -------------------------------------------------------------------- | ------------ |
| `research/deepseek-harness-architecture-and-integration-research.md` | DSH 机制研究 |
