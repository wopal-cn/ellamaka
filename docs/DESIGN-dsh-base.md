# DSH 融合基础设计

> **Status**: Active
> **Updated**: 2026-10-11
> **Parent**: `./DESIGN.md`
> **Scope**: DSH v0.2 的文件领地、固定 Active Home、closure 变更备份、统一 Core prepare/activation、profile 生命周期与持久数据。

Bridge 就是 `@wopal/ellamaka-cordis` 包。它负责加载本产品固定的 DSH、准备环境、挂载两个 profile、适配 Bun/Electron 执行差异，以及把 DSH 工具接到 Ellamaka。实际工具注册、PTC 程序执行和沙箱实现由 DSH 提供。

内部 dsh-adapter 也在这个包中；opencode 只注册插件和提供引擎回调，不保存另一份 DSH 适配代码。CLI 用 Bun，Desktop 用产品自带的 Electron utilityProcess，二者编译同一份 Bridge 源码。

## Runtime Ownership

以下约束是本设计的最高优先级 invariant：

1. **`$WOPAL_HOME/dsh/home` 是唯一 Active DSH Home，路径永久稳定。** skill、profile、插件、配置工具和外围基础设施可以长期依赖这个路径。
2. **`closureFingerprint` 是 Core 判断 DSH runtime 是否发生变化的唯一 Home-safety 信号。** Core 不推断 DSH 的 session、storage、plugin state、配置或凭证格式是否兼容。
3. **Bridge ABI 只校验 Ellamaka Bridge 能否加载目标 closure。** 它属于 closure/loader 的内部机械契约，不表示 Home 格式，不参与 Home 迁移判断。Ellamaka 不定义 `homeFormat`。
4. **closure 变化时，目标 closure 第一次写 Active Home 之前必须完成 Home 备份。** 备份失败即 fail closed；不得先启动新 DSH 再补备份。
5. **Home 内部迁移归 DSH 自身。** 备份成功后，新 DSH 直接使用固定 Home；若 DSH 支持原生自动迁移，由 DSH 自己执行。Ellamaka 不实现通用 Home migration、逆向 migration、兼容矩阵或“自动验证即兼容”的推断。
6. **Core Runtime Preparation 与 Runtime Activation 分离，WopalSpace Onboarding 独立。** Core 只准备运行必需事实；Onboarding 不参与 runtime readiness。

```text
$WOPAL_HOME/dsh/
├── home/                               # 唯一 Active DSH Home（固定地址）
│   ├── profiles/{web,ellamaka-tools}/
│   ├── sessions/  storages/  attachments/
│   └── .credentials.yaml  cordis.patch.yml
├── closures/<fingerprint>/             # 产品固定的不可变 DSH runtime
├── backups/<backup-id>/
│   ├── home/                           # closure 切换前的完整恢复副本
│   └── backup.json                     # old/new closure、产品版本、时间等最小元数据
├── state/current.json                  # 最近被允许写 Active Home 的 closure fingerprint
├── staging/                            # closure 下载/解包等临时产物
└── locks/                              # closure 与 Home mutation 门禁
```

Active Home 保存用户真实的 profile 声明、插件实体、补丁、凭证、DSH session 与 storage。`backups/` 只用于灾难恢复，不作为 `DSH_HOME`，也不参与日常运行。当前阶段不自动清理 closure-change backup；后续 retention 需要独立设计和明确授权。

`state/current.json` 的 `closureFingerprint` 只表示“最近被授权写这个 Home 的 closure”，不是兼容性证明。closure 变化时，Core 在持有 Home mutation gate 且确认没有活动写入者后完成备份；备份 durable 后才把目标 fingerprint 记录为当前 writer 并允许目标 DSH 打开 Home。若目标 DSH 随后启动失败，Home 可能已经被其原生逻辑修改，因此 Core 不伪装成功、也不自动猜测如何回退；备份保持可用并在诊断中报告。

## Dependency Closure

### Release Boundary

Bridge 属于 Ellamaka 发布物。官方 DSH 依赖属于磁盘闭包。依赖方向为 Ellamaka → Bridge → 官方运行时；闭包不包含 Bridge 包、workspace 链接或 Bridge 的 TypeScript 源码。

`packages/ellamaka-cordis/package.json` 的精确 dependencies 是官方直接版本的唯一编辑源。生成器产出运行时 manifest 与完整依赖锁，CLI 与 Desktop sidecar 嵌入同一组产物。manifest 的 schema、Bridge ABI、精确依赖与内容指纹共同确定闭包身份。

依赖变更必须同时更新完整锁。发布流程校验产物漂移，运行时仅消费内嵌版本与锁。registry 负责传输，不决定版本。

### Materialization

初始化核心共用 closure manager 与 ProfileRuntime。网络下载和闭包物化在 Home 写入门禁之前完成；物化锁与环境初始化锁不嵌套持有。有效闭包直接复用，缺失或损坏时使用完整锁下载、校验并原子安装。registry 只决定传输来源。

完整锁保留平台可选依赖标记；必需包失败返回明确诊断。物化复用产品内置的安装实现，不要求机器另装 npm、pnpm、Node 或 Bun。闭包物化按 WOPAL_HOME 与指纹共享正在进行的任务，实际下载持锁到结束，默认预算为五分钟。

所有入口的准备、closure 变更备份与启动规则见 [Closure and Startup Lifecycle](#closure-and-startup-lifecycle)。`ELLAMAKA_DSH=0` 保持零 DSH 文件、网络与挂载行为。配置要求 DSH 工具或沙箱时，关闭或初始化失败必须报告能力不可用，不能改用无沙箱后端完成同一请求。

### Loading and Status

installAnchor 是闭包内 `@deepseek-ai/dsh/package.json` 的绝对位置。Bridge 从该锚点解析 Context、Loader、App Boot、cmdline、launch environment 与 WebServer 接口，所有运行时值属于同一闭包。

| 状态      | 对外含义                                     |
| --------- | -------------------------------------------- |
| disabled  | 用户通过唯一开关禁用                         |
| preparing | 依赖准备、Home 安全检查、profile 准备或容器装配中     |
| ready     | 该入口要求的容器、服务和能力已通过验收并发布 |
| degraded  | 本次启动失败，原生 Ellamaka 继续可用         |

物化成功是内部阶段。入口所需容器全部验收并完成环境初始化记录后，宿主才发布 DSH URL、路由、工具容器和 ready。挂载失败、必需工具缺失或默认 preset 不可绑定时，宿主释放全部候选资源，保留失败目标用于诊断，并发布 degraded。导入来源始终保持原样，初始化核心只加载本产品选定的闭包。

### Compiled Runtime

CLI 构建开启 `autoloadPackageJson` 与 `autoloadTsconfig`，关闭 `autoloadDotenv` 与 `autoloadBunfig`。磁盘闭包的裸包解析需要运行时 package.json 加载；installAnchor 校验必须覆盖真实产品二进制。

闭包按指纹复用并保留。各进程始终持有本产品的解析锚点；任何由新 closure 触发的 Home 写入都必须发生在 closure-change backup 完成之后。

## Profile Runtime

### Declarations and Layers

profile 的 `package.json` 声明 dependencies 与有序 `dsh.profile.bundles`，是安装与激活的真相源。`cordis.yml` 是宿主生成的空 Include 根；`cordis.patch.yml` 是用户补丁。

完整配置按下列顺序求值：bundle 层 → profile 用户层 → home 注入与 home 用户层 → 命令行覆盖 → 宿主能力约束与显式环境硬禁用。一般用户配置保留覆盖能力；运行时不可执行的后端、无会话容器边界和禁用的 telemetry 由宿主约束保护。

ProfileRuntime 拥有 profile facts、完整补丁生成、包解析、root Include、mutation queue、验收与释放。启动、配置转储和重放共用同一生成过程，后续重放重新读取实际声明文件。

### Boot Contract

DSH v0.2 使用 `createRuntimeResolution` 提供不可变的包映射，`auditStartupEntries` 提供启动审计，`prepareProfilePatches/reconcileProfilePatches` 提供版本兼容与激活诊断。

装配时注入 profileContext：name、dir、patchPath、installAnchor、cwd、home、startedBundles、overlays、telemetryDisabledEnv。Web 还注入 packageManager。overlays 包含必要的宿主约束，使原生设置与插件管理操作使用同一策略。

App Boot 审计后，宿主检查采用的必需服务和工具。Web 检查默认 preset 可解析和可绑定；tools 检查对应平台的采用集合。插件等待服务的警告不能直接等同于完整挂载成功。

## Host Compatibility

### Package Routing

带完整 resolution 的官方 PluginPackages 使用 Node 内部模块拦截器。Bun 使用官方支持的 metadata-only 模式，模块路由由 Bridge 拥有；Desktop 采用同一宿主解析契约。

首次启动自动接入 Bridge 的元数据资源解析，使用已选闭包与当前 profile 的 ESM 导出条件读取 package.json、locale 与受限图标，不执行插件代码。PluginPackages.metaOf 覆盖运行时/预设清单；PluginManager.listBundles 的公开子类适配覆盖官方可选 bundle 与已安装 bundle 清单。该子类由公开 EntryTree.import 路由接入，保留官方配置、Remote 方法标记、安装流程和兼容性诊断，不修改上游包、私有 Node 解析器或用户配置文件。

全新 home 的冷启动验收同时覆盖两类清单：官方资源的本地化字段正确、元数据错误为零、已启用全局插件和默认预设无失败或等待状态。缺少可选资源继续遵循官方契约；损坏元数据、图标越界及包版本不兼容保留真实诊断。API/token 等个人配置迁移由操作者处理，不以人工修补元数据作为首启前置。

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

Ellamaka CLI 与 Desktop sidecar 各自捆绑精确 DSH dependencies、Bridge 与内部 adapter。生成 manifest 的 `fingerprint` 唯一标识这套 closure；它也是 Core 判断“是否需要在新 runtime 第一次写 Home 前做安全备份”的唯一版本事实。

manifest 中可以保留 Bridge ABI，用于拒绝 Bridge 无法加载的 closure；ABI 不表示 Home 格式。Core 不把 Ellamaka SemVer、Bridge ABI 或任何自定义 `homeFormat` 用来推断 DSH 持久数据兼容性。

CLI/Desktop 的产品版本一致性是另一条独立安全线：二者同时安装时当前阶段要求 `major.minor` 相同。单组件更新允许短暂留下磁盘版本不一致，但任何本地入口在 DSH activation 前都必须通过轻量 product-alignment preflight；不一致时先修复产品组合，不能让两个 minor 代际依次写同一个 Home。该 gate 不参与 closure change 判断，也不触发 Home migration。具体规则归 `DESIGN-distribution.md`。

### Core Runtime and Onboarding State

Core Runtime Preparation 与 WopalSpace Onboarding 是两套独立状态：

```text
CoreRuntimeState:
UNPREPARED -> PREPARING -> READY -> RUNNING
                   |
                   +-> FAILED / BUSY / INCOMPATIBLE

OnboardingState:
NOT_STARTED -> IN_PROGRESS -> COMPLETED
                    |
                    +-> NEEDS_INPUT
                    +-> FAILED
```

Core Runtime Preparation 必须自动、幂等、无用户输入。`NEEDS_INPUT` 不属于 Core。Onboarding 未完成不能阻止 `ellamaka`、`ellamaka run`、serve/web 或 Desktop 进入 READY/RUNNING。

### Core Runtime Preparation and Activation

所有本地运行入口共享 `ensureCoreRuntimeReady()`。它只处理 Ellamaka 本身运行所需且可以确定性完成的事实：基础目录/配置、当前产品 closure，以及 DSH 启用时的 closure materialization、固定 Home 安全准备和产品自有的标准 profiles/plugins。它不得下载 ontology、创建 Space、要求 GitHub 凭据，也不得把外部 provider/model 当作 readiness 门禁。

DSH 路径分为：

- **prepareDsh**：物化并校验目标 closure；若 Home 不存在则创建固定 `dsh/home`；若 `state/current.json` 记录的 closure 与目标 fingerprint 不同且已有 Home，则先在 Home mutation gate 下创建完整 backup。backup 成功后才允许目标 closure 成为新的 Home writer，并可更新 Ellamaka 自己确定性拥有的 profile/plugin 资产。
- **activateDsh**：使用目标 closure 打开固定 Home，并按入口挂载 web/tools。DSH 在这里执行它自身支持的任何原生数据/config migration。Ellamaka 只验证“运行能力是否可启动/挂载”的机械事实，不把启动成功宣称为未知用户状态的完整兼容证明。

closure 未变化时不因 Ellamaka patch、Onboarding 状态或其他猜测重复备份。closure 变化只触发一次安全边界；backup 完成后，即使目标 DSH 启动失败，`current.json` 仍表示目标 closure 已经被允许接触该 Home，避免下一次重试把已经被新 runtime 修改过的 Home错误地当作旧 closure 原始状态再次覆盖语义。

`ELLAMAKA_DSH=0` 是硬分支：不创建 `$WOPAL_HOME/dsh`、不物化 closure、不备份 Home、不准备 DSH profile/plugin、不挂载 DSH 容器。Core 仍可正常 READY/RUNNING；显式请求 DSH 专属能力时返回 unavailable，不静默换用语义不同的后端。

### Core Preparation Progress Contract

Core prepare/activate 使用统一结构化事件；progress 是启动契约，不受日志级别影响：

```text
CoreProgressEvent {
  scope: "prepare" | "activate"
  phase: "inspect" | "closure" | "home-backup" | "profiles" | "preflight"
       | "mount-web" | "mount-tools" | "ready" | "dsh-disabled"
  state: "started" | "progress" | "heartbeat" | "completed" | "skipped" | "failed"
  message: string
  current?: number
  total?: number
  unit?: string
  elapsedMs: number
  code?: string
}
```

约束：

- 真实可计量工作才提供 `current/total`；未知工作量不得伪造百分比。
- 长阶段没有量化进度时至少约每 5 秒 heartbeat；前端可自行更高频刷新 spinner/elapsed。
- backup 事件可以显示 backup id、old/new fingerprint 的安全缩写和目标相对路径，不显示 secret、token、凭据或用户消息内容。
- DSH 内部如果自行执行 migration，Core 不伪造“migration percent”；只能展示 DSH/宿主实际能够观测到的启动状态。
- `ELLAMAKA_DSH=0` 发 `dsh-disabled/skipped` 后继续 Core，不创建 DSH 文件。
- 非 TTY 下 started/completed/skipped/failed 与必要 heartbeat 使用可采集 stderr 行；`ellamaka run` 的业务 stdout 保持纯净。

### Unified Entry Matrix

| 入口 | Core 未 Ready | Core Ready 后 | Onboarding |
| --- | --- | --- | --- |
| `ellamaka serve` / `web` | 先启动 Bootstrap Control Plane，再 `ensureCoreRuntimeReady()`；失败保留 health/diagnostics | 同 listener activation；DSH 启用时挂 Web + tools | 独立，可显示但不阻塞 runtime |
| Desktop | sidecar Bootstrap 后自动准备 Core | 原地 activation，Renderer 可进入 Workbench | 独立，可跳过 |
| `ellamaka run` | 自动准备 Core；progress 写 stderr | activation 所需 runtime，执行后释放 | 不进入 |
| `ellamaka` | 自动准备 Core | 默认 TUI；DSH 启用时挂 tools | 不进入 |
| attach / `run --attach` | 不触碰本地 Core/DSH | 使用远端 runtime | 本地不参与 |
| `ellamaka setup` | Core 可独立准备 | 不要求长驻 runtime | 显式进入可选 Onboarding |
| `ellamaka dsh init` | 显式执行 DSH prepare/诊断 | 不保留运行容器 | 不等同于 Onboarding |

### Serve / Web Startup

serve/web 先建立最小 Bootstrap Control Plane，再自动准备 Core；它不等待 WopalSpace Onboarding。closure 变化时 `home-backup` 是 Core preparation 的安全阶段，备份失败则保持 Bootstrap diagnostics 可用并停止目标 DSH 写入。备份成功后，目标 DSH 可以在 activation 时自行处理它支持的原生迁移。

### Desktop Startup

Desktop 先启动 bootstrap sidecar，再 Core prepare/activation。Renderer 消费同一 progress 语义。首次启动可以显示 WopalSpace Onboarding，但用户暂不完成 ontology/Fork/Space/provider 也不影响原生 Ellamaka 能力。

Desktop 与外部 Ellamaka CLI 的产品兼容策略见 `DESIGN-distribution.md`。当前阶段二者同时安装时要求 `major.minor` 相同，用于避免两个明显不同的产品代际反复接触同一 DSH Home；这个规则是产品发布/更新兼容门禁，不参与 Home 格式推断。

### Run and TUI Startup

本地 `ellamaka run` 与默认 `ellamaka` TUI 都自动准备 Core，不进入 Onboarding。没有 ontology、Space、GitHub 或外部 provider 仍可运行。`run --attach` 完全使用远端宿主，不触碰本地 closure/Home。默认 TUI 产品入口就是 `ellamaka`，不存在要求用户调用的 `ellamaka tui`。

### WopalSpace Onboarding

Onboarding 只配置可选 WopalSpace 增强能力：ontology、可选 Fork/GitHub、可选 Space、可选 provider/model 与相关增强。`NEEDS_INPUT` 只允许出现在用户主动进入的交互分支，不得传播成 Core 的 `SETUP_REQUIRED`。`onboarding.json` 只保存旅程恢复/完成状态，不代表 runtime readiness。

### Closure Change Backup

Core 不判断 closure change 是否“breaking”；它只比较实际 fingerprint：

```text
current.json.closureFingerprint == target fingerprint
  -> 不做 closure-change backup

不同，且已有 dsh/home
  -> 等待/取得 Home mutation gate
  -> 完整备份 dsh/home 到 backups/<backup-id>/home
  -> 写 backup.json（old/new fingerprint、Ellamaka version、createdAt）
  -> backup durable
  -> 记录 target fingerprint 为新的 Home writer
  -> 允许目标 closure 打开固定 dsh/home
```

安全边界：

- backup 必须在目标 closure 第一次写 Home 之前完成；失败则目标 DSH 不得启动。
- backup 时不能存在活动 Home writer；不自动杀死所有权不明进程，冲突返回稳定 BUSY/HOME_BUSY 类错误。
- backup 保留原 Home 的受管理文件、权限与安全 symlink 语义；越界或回指来源的危险链接按既有安全规则拒绝。
- backup 不是 runtime environment，不被 mount，不参与正常读写；当前阶段不自动清理。
- 备份成功后 DSH 对 Home 做了什么属于 DSH 自身语义。若启动失败，Core 报 degraded 和 backup 位置，不自动执行未知的反向迁移。
- 产品降级同样只是一次 closure change：先备份当前 Home，再让旧 closure 尝试打开。若旧 DSH 无法处理较新的 Home，恢复哪个 backup、如何调整配置属于对应版本的迁移/恢复指导，不由通用 Core 猜测。

### Release Migration Guidance

DSH closure change 不等于一定存在人工迁移。若 DSH 自身已经能自动兼容，Release Notes 只需说明 runtime 发生变化及 Home 会先备份。

当研发阶段确认存在需要用户现场处理的配置/插件兼容事项时，**迁移知识不随 artifact 内置**。对应 Ellamaka Release Notes 提供稳定的 `wopal-site` migration guide URL；指南记录该次具体升级中已经验证过的处理步骤。用户需要帮助时让 Ellamaka Agent 读取该 URL 并按指南检查/修改现场配置。Core 不自动下载、自动执行或把该文档建模成 migration registry。

产品代码、内置 adapter、preset 或官方插件本身需要的兼容修复必须在 release 前完成并随产品发布，不能推给用户 Agent 现场改产品源码。

### Commands and Ownership

| 命令或组件 | 职责 |
| --- | --- |
| `ensureCoreRuntimeReady()` | 所有本地运行入口共用；自动准备运行必需事实与 closure-change backup |
| `ellamaka setup` / Onboarding | 可选 WopalSpace 增强旅程；允许 `NEEDS_INPUT`，不决定 Core readiness |
| `ellamaka dsh init` | 显式执行当前产品 DSH prepare/诊断；不提供通用迁移或 rollback 协议 |
| closure manager | 下载、完整性校验、install anchor 与 fingerprint |
| Home backup guard | closure 变化前的 writer gate、完整备份与最小状态记录 |
| ProfileRuntime | 产品自有 profile/plugin 装配、审计、重放与释放 |
| Runtime Activator | 让目标 DSH 使用已经安全准备的固定 Home，并按入口挂载能力 |
| 内部 dsh-adapter | DSH tools ready 时接入 Ellamaka；禁用/失败不静默降级 |

## Persistent Data

DSH 的配置固定落在 `$WOPAL_HOME/dsh/home/profiles/<profile>/cordis.patch.yml`；settings/configEditor 拥有字段校验、并发修订和 secret 更新。日志和诊断直接报告固定 Active Home 文件位置。closure-change backup 只保存恢复副本和最小元数据，不成为配置读写来源。

用户 preset 采用目标 DSH 的标准 bundle 声明与官方 YAML 方言；来源的生成文件和实际配置都保留。用户插件使用 profile 的固定依赖声明；官方解析层按当前 closure 重建，第三方兼容性按实际包声明和 Loader 诊断检查。不兼容实体不能通过沿用 revision/source 链接继续执行。closure-change backup 不冻结用户自行修改的外部插件源码或外部服务；内部 adapter 的匹配由产品制品保证。

Ellamaka 的 `settings.jsonc` 和三层 `wopal.pluginConfig` 仍是内部 adapter 行为配置来源，不写入 DSH profile 代替它。职责与字段归 [工具容器设计](./DESIGN-ellamaka-tools.md#internal-adapter) 与主设计的 [既有配置读面](./DESIGN.md#config-read-surface)。

Active Home 与 closure-change backup 按原敏感级别保存；失败信息只记录 backup 标识、相对路径和错误 code。用户编辑、复制配置或外部工具副作用不自动重放。

## Reference Documents

| 资料                                                                 | 用途               |
| -------------------------------------------------------------------- | ------------------ |
| `research/deepseek-harness-architecture-and-integration-research.md` | 历史研究与机制考证 |
