# DSH 融合基础设计

> **Status**: Active
> **Updated**: 2026-10-09
> **Parent**: `./DESIGN.md`
> **Scope**: DSH v0.2 的文件领地、依赖闭包、profile 装配、配置重放与持久数据。

Ellamaka 的 DSH 宿主基座服务于 `web` 与 `ellamaka-tools` 两个独立容器。Bridge 随产品编译，官方运行时从版本固定的磁盘闭包加载。CLI 使用 Bun，Desktop 使用随产品提供的 Electron utilityProcess。

## Runtime Ownership

`$WOPAL_HOME/dsh` 是 DSH 的文件领地。宿主启动时设置 `DSH_HOME=$WOPAL_HOME/dsh/home`，向官方包提供一致的 home；Bridge 自己的路径从装配参数推导。

```text
$WOPAL_HOME/dsh/
├── closures/<fingerprint>/
│   ├── package.json
│   ├── package-lock.json
│   ├── runtime-manifest.json
│   └── node_modules/
├── home/
│   ├── profiles/
│   │   ├── node_modules/             # 官方依赖解析层
│   │   ├── web/
│   │   └── ellamaka-tools/
│   ├── sessions/  storages/  attachments/
│   ├── .credentials.yaml  .anonymous-user-id
│   ├── cordis.patch.yml              # home 用户补丁
│   └── .ellamaka-imports/            # 版本导入事务与保留的源配置
├── staging/
└── locks/
```

闭包中的官方包保持不可变。profile 声明、插件实体、用户补丁、凭证和会话数据由 home 拥有。profile 文件由运行中的引擎及其受控安装操作写入；诊断、测试和候选装配使用独立 home。

## Dependency Closure

### Release Boundary

Bridge 属于 Ellamaka 发布物。官方 DSH 依赖属于磁盘闭包。依赖方向为 Ellamaka → Bridge → 官方运行时；闭包不包含 Bridge 包、workspace 链接或 Bridge 的 TypeScript 源码。

`packages/ellamaka-cordis/package.json` 的精确 dependencies 是官方直接版本的唯一编辑源。生成器产出运行时 manifest 与完整依赖锁，CLI 与 Desktop sidecar 嵌入同一组产物。manifest 的 schema、Bridge ABI、精确依赖与内容指纹共同确定闭包身份。

依赖变更必须同时更新完整锁。发布流程校验产物漂移，运行时仅消费内嵌版本与锁。registry 负责传输，不决定版本。

### Materialization

所有产品入口共用 Runtime Manager：

| 入口                         | 容器        |
| ---------------------------- | ----------- |
| serve / web / Workbench 后端 | Web + tools |
| TUI                          | tools       |
| Desktop sidecar              | Web + tools |

`ELLAMAKA_DSH=0` 跳过闭包检查、文件创建、网络和挂载。启用时依次完成 Resolve、Inspect、Lock、Stage、Verify、Activate、Profile 与 Load。已有正确闭包走本地检查；缺失或损坏时取得跨进程锁，用 pacote 按完整锁下载和解压，在 staging 校验后原子激活。

完整锁保留平台可选依赖标记。可选包下载失败记录诊断，必需包失败使本次启动降级。物化不依赖用户安装的 npm、pnpm 或 Bun，也不在产品运行时求解依赖树。

初始化按 home 和指纹单飞。超时的调用方可以返回 degraded，实际物化持锁工作在结束后释放锁，避免其他进程同时重写 staging。默认启动物化时间预算为五分钟。

### Loading and Status

installAnchor 是闭包内 `@deepseek-ai/dsh/package.json` 的绝对位置。Bridge 从该锚点解析 Context、Loader、App Boot、cmdline、launch environment 与 WebServer 接口，所有运行时值属于同一闭包。

| 状态      | 对外含义                                     |
| --------- | -------------------------------------------- |
| disabled  | 用户通过唯一开关禁用                         |
| preparing | 校验、物化、版本导入或容器装配中             |
| ready     | 该入口要求的容器、服务和能力已通过验收并发布 |
| degraded  | 本次启动失败，原生 Ellamaka 继续可用         |

物化成功是内部阶段。挂载失败、必需工具缺失或默认 preset 不可绑定时，宿主清理部分资源并发布 degraded。新 Bridge 不静默加载版本不同的旧闭包。

### Compiled Runtime

CLI 构建开启 `autoloadPackageJson` 与 `autoloadTsconfig`，关闭 `autoloadDotenv` 与 `autoloadBunfig`。磁盘闭包的裸包解析需要运行时 package.json 加载；installAnchor 校验必须覆盖真实产品二进制。

闭包按指纹复用并保留。新产品使用新闭包，正在退出的旧进程持有自己的解析锚点。旧数据转换在旧引擎停止、profile 写入排他成立的启动中执行。

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

## Persistent Data

### Versioned Migration

本次升级采用操作者配合的配置迁移。升级前保存集成版 DSH home 快照及版本信息，保留旧闭包、preset 源目录和原文件。备份覆盖配置、会话、附件与存储，不在日志或验证记录中输出 secret 值。新版本不自动批量导入旧个人配置。

### Settings and Presets

设置以 profile entry 配置和用户补丁持久化，集成版入口为 `$WOPAL_HOME/dsh/home/profiles/web/cordis.patch.yml`。settings/configEditor 负责表单、字段校验、并发修订与 secret 路径更新。独立官方安装的 `~/.dsh` 只作参考，不混用两份 home。

活动 home 存在旧 `settings.yaml` 或 `settings.yml` 时，Web 挂载明确拒绝，并提示先备份、将旧文件保留在活动 home 之外，再经新表单配置；工具容器仍独立。由此避免上游异步逐 section 导入产生不可追踪的部分成功。模型、provider 与 token 由操作者在集成版配置页确认并输入。

旧 shell 配置对应平台 executor；旧 `agent-presets.default` 对应 `agent-preset-registry.selectedDefault`。持久配置写原始值；volatile 字段解析出的运行时信号仅用于验证和运行。

用户 preset 使用标准 bundle 的 `agent-preset` 声明。WopalSpace 三个角色保留 `preset.yml`、`agent.cordis.yml` 为生成源，由目标 rc.2 的官方 YAML 方言生成声明补丁后安装。旧目录和软链保留用于恢复，不继续依赖自动发现。三个命名角色分别显式挂载技能 provider，项目技能与 bundle 自带技能共同组成可见技能范围。

### Restoration

产品恢复需要匹配 Bridge、闭包与兼容的 home 配置。恢复使用导入前快照；目标已有后续编辑时报告冲突并保留两份内容。会话读取或恢复失败隔离到该会话，保留数据，工具副作用不自动重放。

## Reference Documents

| 资料                                                                 | 用途               |
| -------------------------------------------------------------------- | ------------------ |
| `research/deepseek-harness-architecture-and-integration-research.md` | 历史研究与机制考证 |
