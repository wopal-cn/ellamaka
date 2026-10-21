# DSH 融合基础设计

> **Status**: Active
> **Updated**: 2026-10-20
> **Parent**: `./DESIGN.md`
> **Sibling DESIGNs**:
>
> - `./DESIGN-wopalspace.md` — WopalSpace Setup 对 CorePreparation 的上层消费边界
>
> **Scope**: DSH v0.2 的运行资源、固定 Home 基本防护、切代前备份与 profile 生命周期。

Bridge 就是 `@wopal/ellamaka-cordis` 包。它负责加载本产品固定的 DSH、准备环境、挂载两个 profile、适配 Bun/Electron 执行差异，以及把 DSH 工具接到 Ellamaka。实际工具注册、PTC 程序执行和沙箱实现由 DSH 提供。

内部 dsh-adapter 也在这个包中；opencode 只注册插件和提供引擎回调，不保存另一份 DSH 适配代码。CLI 用 Bun，Desktop 用产品自带的 Electron utilityProcess，二者编译同一份 Bridge 源码。

## Runtime Ownership

基本安全边界保护唯一的 DSH Home，使较新的闭包取得所有权之后，较旧的闭包无法再打开它。

1. `$WOPAL_HOME/dsh/home` 是唯一的活动 Home。
2. Ellamaka 维护一个递增的 closureVersion，CLI 与 Desktop 构建共用。当锁定的 DSH 闭包或产品自有的 DSH 文件发生可能影响 Home 数据的变化时提升它。产品的 SemVer 与发布通道不用于判断 Home 兼容性。
3. 每个启用 DSH 的运行实例在使用 Home 期间持有共享 OS 锁。同一 closureVersion 可以在多个进程中并存。切换到较新版本必须取得同一把锁的排他形式，因此仍在运行的旧实例会阻止切换。
4. 较新版本写入 Home 之前，产品先完成备份，再记录新版本。备份或状态写入失败则禁止 DSH 激活。较旧版本面对标记了更新版本的 Home 时拒绝打开。
5. 一个小的持久 managed marker 记录 Ellamaka 已接管该 Home。既无 marker 也无版本状态的历史 Home，在操作员确认旧 DSH 进程已停止、持排他锁并完成备份之后，一次性接管。产品绝不自行接管无版本 Home。若 marker 存在但版本状态缺失，或任一元数据文件损坏，报告未知状态并拒绝写 Home。不得从 DSH 私有文件推断它的历史。
6. 若新版本可能已写入 Home 之后激活失败，保留备份并报告失败。不自动恢复 Home，也不启动旧闭包。
7. DSH 拥有自己的私有数据格式。Ellamaka 不建立兼容图、数据转换器、自动恢复流程或恢复命令。DSH 失败只降级 DSH，原生 Ellamaka 保持可用。
8. 真正启动 Runtime 的产品只准备自己的 DSH 资源。Setup 不扫描其他已安装产品，也不准备它们的 Home。

| 路径 | 用途 |
|---|---|
| `$WOPAL_HOME/dsh/home` | 唯一的活动 Home |
| `$WOPAL_HOME/dsh/closures/<version>` | 产品固定的 DSH 运行时 |
| `$WOPAL_HOME/dsh/backups/<timestamp>` | 版本切换前生成的副本 |
| `$WOPAL_HOME/dsh/state/current.json` | 活动 closureVersion |
| `$WOPAL_HOME/dsh/state/managed` | 最小持久所有权标记，不含历史，也不含 DSH 私有 schema |
| `$WOPAL_HOME/dsh/state/home.lock` | 共享使用与排他版本切换 |
| `$WOPAL_HOME/dsh/staging` | 临时物化区 |

该锁把版本切换与正在运行的 DSH 进程串行化。运行状态只记录活动闭包版本，不描述 DSH 的私有数据 schema。

## Dependency Closure

### Release Boundary

`packages/ellamaka-cordis/package.json` 只声明 `@deepseek-ai/dsh` 一个包作为 DSH 依赖的唯一版本入口。`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-app-boot`、`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-plugin-manager` 及全部子包版本均由 `@deepseek-ai/dsh` 自身的依赖树唯一锁定；`package.json` 与 `bunfig.toml` 不重复维护 `@deepseek-ai/dsh-*` 子包列表。

构建脚本从唯一的 `@deepseek-ai/dsh` 入口与工作区 `bun.lock` 派生 `dsh-runtime.manifest.json` 和完整的 `dsh-runtime.lock.json`（由 `Arborist` 展开全部传递依赖闭包），并通过漂移检查保证签入的 manifest、lock 与 `package.json` 一致。升级 DSH 版本只需更新 `@deepseek-ai/dsh` 版本号、重新生成 `bun.lock` 并刷新运行时清单与锁文件。

Ellamaka 源码维护一个递增的 `closureVersion`，CLI 与 Desktop 构建共用。当锁定的 DSH 闭包或产品自有 DSH 文件发生可能影响 Home 数据的变化时提升它。Home 兼容性仅由 `closureVersion` 判定，与 CLI/Desktop 的产品 SemVer 及发布通道解耦。

### Materialization

在读写 Home 之前，先在 `$WOPAL_HOME/dsh/staging` 物化并校验产品固定的 DSH 依赖闭包，通过包完整性检查后再就位到 `$WOPAL_HOME/dsh/closures/<version>`。同版本已就位的完整闭包直接复用。下载、解包或必需包校验失败时，在触碰 Home 之前终止准备。

`ELLAMAKA_DSH=0` 在 DSH 专属环境设置、文件访问、网络访问、物化与 profile 挂载之前短路。

### Loading and Status

从产品的 install anchor 解析 DSH 运行时 API，使 Bridge 与 DSH 包使用同一份已安装闭包。

| 状态 | 含义 |
|---|---|
| disabled | 用户明确关闭了 DSH |
| preparing | 当前产品正在物化或准备它的 DSH 资源 |
| ready | 该入口所需的 DSH 能力已通过激活检查 |
| degraded | DSH 不可用；原生 Ellamaka 保持可用 |

通过 Runtime health 暴露稳定的失败原因、当前构建的 closureVersion 与已记录的 Home 版本（可得时）。不要让消费方直接检查 Home 状态。只有在所请求的 profile 通过激活检查之后，才发布 DSH 路由、工具与句柄。

准备阶段失败不阻断原生 Runtime 与模型会话，涵盖等待接管的历史 Home、闭包失败、Home 被占用与缓存损坏。DSH 工具面回退到原生工具，宿主通过 health 与入口自身的反馈呈现稳定原因，绝不让会话失去可用工具。同一进程内稍后才挂载 DSH 的入口（例如操作员确认接管后的 Desktop），在下一次请求时切到沙箱工具；只在启动时挂载一次的入口（例如 TUI 与 serve），保持原生工具直到重启。profile 已 ready 之后容器才失效的情况，沿用既有的 fail-closed 请求语义。

### Compiled Runtime

打包后的运行时必须通过 install anchor 从产品固定的闭包解析 DSH。要在真实 CLI 二进制与 Desktop sidecar 上验证该路径；仅源码层的包解析不足以证明。

## Profile Runtime

### Declarations and Layers

profile 的 `package.json` 声明有序 `dsh.profile.bundles` 与外部插件 `dependencies`，是安装与激活的真相源。官方内置 bundle（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`）从外部安装闭包（`installAnchor`）加载，不在 `profile/package.json` 的 `dependencies` 中锁定版本，也不安装到 `profile/node_modules`。`profile/pnpm-workspace.yaml` 固定 `autoInstallPeers: false`，外部插件声明的 `@deepseek-ai/*` 对等依赖不写入 `profile/node_modules`，运行期统一路由到当前活动的 DSH 闭包。

`cordis.patch.yml` 是用户补丁层；`cordis.yml` 是运行期合成根锚点（非用户配置文件）。完整配置按下列顺序求值：bundle 层 → profile 用户层 → home 注入与 home 用户层 → 命令行覆盖 → 宿主能力约束与显式环境硬禁用。一般用户配置保留覆盖能力；运行时不可执行的后端、无会话容器边界和禁用的 telemetry 由宿主约束保护。

ProfileRuntime 拥有 profile facts、完整补丁生成、包解析、root Include、mutation queue、验收与释放。启动、配置转储和重放共用同一生成过程，后续重放重新读取实际声明文件。

宿主通过官方 `initProfile` 初始化缺失的 `package.json`、`cordis.patch.yml` 与 `pnpm-workspace.yaml`，已有声明文件保持用户内容不变（若 `$DSH_HOME/cordis.patch.yml` 被意外清空为空白文本，准备阶段将其恢复为官方空数组模板 `[]`）。因为运行期 Cordis `Include.write()` 会将展开后的合成树写回 `cordis.yml`，宿主在准备阶段和每次 `mountProfile` 启动前都无条件将 `profile/cordis.yml` 重置为 `[]\n`，避免上一次运行写回的合成树在下次启动时重复叠加。

### Boot Contract

DSH v0.2 使用 `createRuntimeResolution` 提供不可变的包映射，`auditStartupEntries` 提供启动审计，`prepareProfilePatches/reconcileProfilePatches` 提供版本兼容与激活诊断。

装配时注入 profileContext：name、dir、patchPath、installAnchor、cwd、home、startedBundles、overlays、telemetryDisabledEnv。overlays 包含必要的宿主约束，使原生设置与插件管理操作使用同一策略。

`loadProfile` 与 `prepareProfilePatches` 按 `includePrerelease: true` 校验每个 bundle 与插件行的 `peerDependencies`（同时支持 `profile/compatibility.json` 的精确版本豁免）。宿主内置核心 bundle（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`）缺失或跳过时挂载直接失败；用户或第三方扩展 bundle 因版本不兼容进入 `skippedBundles`（或补丁行进入 `skippedIncompatible`）时，宿主记录告警诊断并跳过该扩展，保持核心容器与其余兼容插件正常启动。

App Boot 审计后，宿主检查采用的必需服务和工具：`web` 检查核心 Web 服务与默认 preset（`standard`）可解析、可绑定；`ellamaka-tools` 检查本平台全部采用工具均已实际注册到 `tools` 服务（详见 `./DESIGN-ellamaka-tools.md`）。插件等待服务的警告不能等同于完整挂载成功。

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

Bun 中 `node:util` 的 ESM 命名空间在首次被静态 import 时就已绑定，之后再声明新导出不会出现在该命名空间里，因此上一条的运行时补丁无法覆盖已经 import 过它的模块图。官方 subprocess provider 以命名导入方式消费 `getSystemErrorMessage`，Bun 下会直接 import 失败，进而使 `bash-sandbox`、`tool-bash`、`tool-fs-search`、`ptc-runtime` 等入口保持 pending。Bridge 在 Bun 下用加载插件把这一行导入改写成"保留 `getSystemErrorName` 与 `inspect`，本地以同义函数补 `getSystemErrorMessage`"；改写锚点必须精确且唯一，上游形状变化时显式失败，不静默降级为无 subprocess 后端。Node 与 Desktop 使用原生实现，不启用该改写。

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

Bun 的 PTC 兼容同样限制在确定的宿主差异上。主进程通过 Bun loader 对官方 `@deepseek-ai/dsh-ptc-runtime-node` provider 的单一 `stripTypeScriptTypes` import 做精确替换，实际 strip-only 转换由随 Bridge 发布的 Amaro 执行。上游默认把 JsonChannel 放在 `child_process` 的额外 fd 7 双向 pipe 上，而 Bun 连续创建额外 pipe 会出现可复现的 `ENOENT` / `EPIPE`；因此 Bun 路径只把该私有控制通道改走标准 stdin/stdout，stderr 保留为 bootstrap/进程诊断，官方 JsonChannel framing、binding、沙箱、取消、超时、输出预算与进程回收仍原样复用。源码态由 Bun 执行极小 child entry，编译态由同一产品二进制在 DSH 官方 `DSH_PTC_RUNTIME_NODE=1` 标记下进入私有 child 角色。provider 的 strip、stdio/control、child bootstrap 任一适配锚点变化时，兼容层必须显式失败，禁止静默降级到无 PTC。

## Closure and Startup Lifecycle

### Product Binding

每个 Ellamaka 产品构建携带自己的 closureVersion 与固定的 DSH lock。只有真正启动的产品参与 Home 访问。休眠的 CLI、stable Desktop 或 beta Desktop 安装不影响正在运行产品的准备。

由同一组闭包输入构建的 CLI 与 Desktop 使用同一版本。产品的发布版本或通道不决定使用不同的 Home 版本。

### Core State and Preparation Integration

Core Preparation 提供 DSH 闭包、Home 与 profile 步骤。产品入口准备自己需要的 DSH 资源，然后激活所请求的 profile。`ELLAMAKA_DSH=0` 跳过全部 DSH 准备。

Home 检查与版本变化使用唯一的 Home 锁。进程只要可能访问 Home，就持有共享锁。版本变化必须取得排他锁，因此旧 DSH 进程仍在使用 Home 时无法进行。

### Home Version Check and Backup

在准备 profile 或激活 DSH 之前，在 Home 锁下比较产品版本与 `state/current.json`。有效的已记录版本始终优先于缺失的 marker：较旧运行时仍然拒绝它，较新运行时仍然需要正常的备份/切代。缺失 marker 不会重置 Home 版本：

| Home 状态 | 处理方式 |
|---|---|
| Home、marker 与 state 全都不存在 | 首次准备在激活 DSH 之前记录版本与 managed marker |
| Home 存在，但既无 marker 也无版本状态 | 在操作员一次性确认旧 DSH 进程已停止、并持有排他锁之后，备份 Home，再记录当前版本与 marker |
| marker 存在但版本状态缺失，或元数据不可读/无效 | 报告未知状态，保留文件并拒绝写 Home |
| 版本状态有效但 marker 缺失 | 保留已记录的版本；在激活前于排他锁下补齐 marker，不把 Home 当作无版本处理 |
| 记录版本等于产品版本 | 在共享锁下使用该 Home |
| 记录版本新于产品版本 | 拒绝访问；不降级，也不修改 Home |
| 产品版本更新 | 取得排他锁，备份当前 Home，更新记录版本，再准备产品自有文件并激活 DSH |

备份或元数据发布失败时，候选运行时得不到任何 Home 写权限。版本与 marker 使用原子文件写入发布；不完整的元数据会被报告，不会被自动清除或猜测。已有 managed Home 在版本更新失败时保留原有版本。备份是供人工恢复的副本，不是运行时目录；在可知时保留源 closureVersion 与 managed 元数据，无版本的历史来源则明确标为 unknown。无版本 Home 的首次接管属于离线升级边界：旧构建不持有这把新锁，因此仅取得锁并不能证明那些旧进程已经停止。Ellamaka 不校验也不翻译 DSH 私有数据格式。

无版本 Home 的接管是唯一需要操作员确认的 Home 变更。交互入口 TUI 与 Desktop 在本地应用旁呈现一次确认，并明确要求先停止旧的 Ellamaka/DSH 进程。非交互入口从不提示：它们通过 health 与准备结果报告 `DSH_HOME_LEGACY_ADOPTION_REQUIRED`，并指引操作员改用交互入口。确认后依次执行排他锁、以未知源版本备份、原子发布版本与 marker；任一步失败都不改动 Home。版本闸门保护所有参与本协议的构建。不感知该锁的构建仍在协议之外，因此不得对已接管的 Home 运行。

### Activation Failure and Manual Recovery

DSH 激活失败只降级 DSH。若新版本可能已经写入 Home，保留其记录版本并保留备份；不自动恢复数据，也不对它启动旧代码。

用户需要恢复备份时，必须先停止所有使用该 Home 的 Ellamaka/DSH 进程。恢复是人工离线文件操作，要把选定的 Home 副本连同与之匹配的已记录版本/managed 元数据一起还原；未知的历史版本不得猜测。本版本不提供恢复命令、自动恢复流程或恢复状态机。

### Preparation Progress Semantics

DSH 步骤发送 `@wopal/ellamaka-core` 的统一 `CorePreparationEvent`，不定义第二套 event type。`step` 分别为 `dsh.closure`、`dsh.home`、`dsh.profiles`；内部 `phase` 可以表达 materialize、integrity、home-version-check、backup、profile-seed、resolution/preflight 等细分。

只有底层存在真实度量时才报告 current/total/unit。准备事件标明 Home version check、backup 和 profile 步骤，不暴露 Home 内容或 secret。各实际产品入口消费同一底层事件来源。

### Unified Entry Matrix

| 入口 | Preparation | Runtime Activation |
| --- | --- | --- |
| `ellamaka serve` / `web` | 读取当前 CLI build descriptor；Ready 则 fast path，否则 prepare | Ready 后挂载该入口需要的 DSH Web/Tools；失败时 native Runtime 保持可用 |
| Desktop | 读取当前 embedded sidecar descriptor；Ready 则 fast path，否则 prepare | Ready 后挂载 Desktop 所需 DSH 能力 |
| 默认 TUI | 读取当前 build descriptor；需要时 prepare | Ready 后挂载该入口需要的 DSH tools；失败时原生 TUI 保持可用 |
| `wopal setup` | 自身不执行 DSH Preparation；它启动/reuse 的 `ellamaka serve` 按 `serve` 行处理当前 build | 打开 Web Onboarding |
| `ellamaka run` | 永久跳过 DSH 分支 | 纯 Ellamaka Core；不探测、复用或挂载 DSH |
| `run --attach` | 不创建本机 listener/目录 instance，不执行 CorePreparation 或 DSH 准备/挂载 | 使用远端 Runtime |

Stable Desktop、Beta Desktop、external CLI 可以来自不同 release；真正运行谁，就由谁自己携带的 closureVersion 进入 Home version check。未运行的产品不参与准备。

`ellamaka run` 是固定的 DSH-disabled 入口，不执行 Home version check 或 DSH activation。即使机器上已有 DSH Home 或另一个进程已挂载 DSH，run 也不能复用、探测或挂载这些能力。

独立的 `ellamaka dsh init` 不属于目标态。closure/Home/profile preparation 统一由真正需要 DSH 的产品启动入口按需完成。

### Release Guidance

闭包版本变化在用户启动目标 Ellamaka 产品时处理。准备会在较新版本写入之前检查并备份 Home。若激活失败，备份保持为人工恢复材料；不尝试自动降级或恢复。

官方 adapter/preset/profile 自身必须在发布前修好并随产品发布，不能把产品代码修补责任推给用户 Agent。

### Commands and Ownership

| 组件 | 职责 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Core Preparation | `@wopal/ellamaka-core` 编排 contributors；API、single-flight、readiness、progress 归主 DESIGN 的 Core Readiness contract |
| closure manager | 固定 lock 的物化与 install-anchor 校验 |
| Home version guard | 唯一的共享/排他锁、closure 版本检查、较新版本写入前备份 |
| ProfileRuntime | 产品自有 profile/plugin 的装配、审计、replay/release |
| Runtime Activator | 在持有共享 Home 锁的前提下激活已准备好的 profile |
| internal dsh-adapter | DSH 工具 ready 后接入 Ellamaka；沙箱不可用时回退原生工具并可观测 |
| Runtime startup caller | 未 READY 时调用 `CorePreparation.prepare(host)` 兜底；不复制 DSH mechanics |

## Persistent Data

当前 DSH native 配置仍落在 `$WOPAL_HOME/dsh/home/profiles/<profile>/cordis.patch.yml`；Settings/ConfigEditor/HMR/Loader 拥有字段校验、revision 与 native apply lifecycle。Phase 3 Config Draft 计划把用户可管理的 DSH authored facts 提升到统一 `settings.jsonc`/`settings.local.jsonc`，再通过 DSH provider 投影回 native lifecycle；该方向不属于当前 Runtime Foundation 实施。closure-change backup 只保存恢复副本和最小元数据，不成为配置读写来源。

用户 preset 采用目标 DSH 的标准 bundle 声明与官方 YAML 方言；来源的生成文件和实际配置都保留。用户插件使用 profile 的固定依赖声明；官方解析层按当前 closure 重建，第三方兼容性按实际包声明和 Loader 诊断检查。不兼容实体不能通过沿用 revision/source 链接继续执行。closure-change backup 不冻结用户自行修改的外部插件源码或外部服务；内部 adapter 的匹配由产品制品保证。

Ellamaka 的 `settings.jsonc` 和三层 `wopal.pluginConfig` 仍是内部 adapter 行为配置来源，不写入 DSH profile 代替它。职责与字段归 [工具容器设计](./DESIGN-ellamaka-tools.md#internal-adapter) 与主设计的 [既有配置读面](./DESIGN.md#config-read-surface)。

Active Home 与 closure-change backup 按原敏感级别保存；失败信息只记录 backup 标识、相对路径和错误 code。用户编辑、复制配置或外部工具副作用不自动重放。

## Reference Documents

| 资料 | 用途 |
| -------------------------------------------------------------------- | ------------ |
| `research/deepseek-harness-architecture-and-integration-research.md` | DSH 机制研究 |
