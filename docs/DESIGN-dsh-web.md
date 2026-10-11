# Web profile 设计

> **Status**: Active
> **Updated**: 2026-10-11
> **Parent**: `./DESIGN.md`

`web` profile 承载 DSH 的完整界面与会话。宿主基座、home、包解析、数据导入和配置队列由 [DSH 基础设计](./DESIGN-dsh-base.md) 拥有，本文定义 Web 的插件供应链、声明式 preset 和界面承载。

## Plugin Supply Chain

profile 的 package.json 是插件依赖与激活的唯一真相源：dependencies 保存精确包版本，dsh.profile.bundles 保存有序 bundle 层。用户补丁按 entry id 保存配置和启停。

官方闭包保持不可变；插件实体和依赖位于 profile 的 node_modules，官方 peer 从宿主共享解析层取得同一闭包版本。安装器使用现有 Bun 解析器、pacote 下载、完整性校验、临时区和跨进程锁。

```text
$DSH_HOME/profiles/
├── node_modules/                 # 官方依赖解析层
└── web/
    ├── package.json
    ├── node_modules/             # 插件实体与依赖
    ├── cordis.yml
    ├── cordis.patch.yml
    └── .plugin-manager/          # 官方管理操作状态和有界日志
```

### Installation Contract

Web 注入完整的 profileContext，settings、configEditor 和原生 pluginManager 由此获得 profile 的路径和配置事实。

profileContext.packageManager 提供 command、prefix args 与仅用于包操作的 env。原生 pluginManager 拥有界面协议、检查、进度、取消和应用结果；执行器为 Ellamaka 自带的 package worker。

worker 是产品内部入口。编译 CLI 调用自身，源码启动携带 CLI 源入口，Desktop 使用 install-command 解析的匹配引擎命令。cwd、profile、DSH root 和取消信号显式传递。

| 操作                | 宿主语义                                                   |
| ------------------- | ---------------------------------------------------------- |
| config get registry | 返回宿主 registry 配置或选择结果                           |
| view / JSON         | 查询 registry 元数据，返回包身份、版本、说明与 bundle 信息 |
| add                 | registry 包或本地目录快照，经 Bun 安装流水线               |
| remove              | 移除当前 profile 的实体与声明                              |
| install             | 按该 profile 的精确依赖重装                                |

worker 将已知 reporter、registry 和 fetch 参数映射为支持的语义；未知参数、未采用的来源与 build-script 执行请求在写入前拒绝。界面的检查与实际执行使用同一来源能力策略。

CLI 的 host-wide 操作与原生管理服务的 current-profile 操作使用明确作用域。current-profile 操作保持其他 profile 的声明与实体。命令形状仍由 Ellamaka dsh CLI 契约拥有，安装执行共用同一流水线。

### CLI Contract

用户命令由 Ellamaka 的 dsh 适配入口解析，安装结果与 Web 管理服务共用同一声明事实。

| 命令面                            | 契约                                                    |
| --------------------------------- | ------------------------------------------------------- |
| plugin add / remove / install     | 精确声明、受控安装和明确作用域                          |
| plugin enable / disable / list    | 用户补丁启停与已装清单                                  |
| dump-config / dump-default-config | 实际完整层或仅 bundle 层；显式 patch 缺失时报配置错误   |
| init                              | 共用初始化核心准备产品环境、验收 profile 后释放临时实例 |

plugin 的 profile 选项归子命令；根级选项出现在 plugin 之前时遵循现有冲突语义。程序启动由 serve/web/TUI/Desktop 产品入口拥有，用户插件安装不转发到外部包管理工具。

同一进程中的包名对应单一有效版本。安装协调器维护版本一致性，current-profile 操作控制依赖声明和激活；请求替换有效版本时协调受影响 profile，并返回 restart-required，避免两份不同版本同时执行。

### Bundles and Compatibility

bundle.patch 支持一个文件或有序文件数组，语法与配置求值采用官方 schema。声明提交前检查包身份、peer 范围、Bun 私有 API 依赖和隔离挂载结果。

只有通过兼容门禁的候选参与激活。已有不兼容插件保留实体和声明，提供包、版本与 runtime 诊断；精确版本豁免由官方风险接受契约承接。

新 bundle、配置修改和启停可以重放。同名包重装或版本替换返回 restart-required；配置重放不清除原生模块缓存。文件监听与原生管理操作共用宿主 ProfileRuntime 的 mutation queue 和失败恢复。

### Failure and Cancellation

解析、下载与预检失败保留正式声明。取消结束 worker 的受控进程范围，安装结果区分 failed、cancelled、applied 和 restart-required。应用失败恢复上一份成功运行状态，磁盘输入的拒绝诊断与运行状态分别表达。

主容器的生命周期由宿主拥有。插件管理报告需要重启的结果，产品入口承接用户发起的重新启动。

## Declarative Presets

Web 的 preset 目录由 agent-preset 声明与 agent-preset-registry 服务组成。声明是普通 bundle 插件行，包含 id、展示元数据和 plugins；官方 Web bundle 提供 standard、ptc、minimal、cordis 的定义。

用户 preset 与 shipped preset 的覆盖通过声明 id 表达。用户默认值保存在 agent-preset-registry.selectedDefault。读取、选择、启停与配置持久化使用 profile 用户补丁和官方管理接口。

声明更新产生新的 revision，已有 Agent 保留使用中的 revision，新绑定使用当前定义。无法导入、等待不可用服务或泄漏全局服务的定义按原生 broken-definition 语义提供诊断。默认定义通过可绑定验收后，宿主发布 Web 挂载成功。

目录式用户 preset 的导入、settings 版本转换与源数据保留归属基础设计的导入事务。插件和 ontology 的分发产物使用标准声明 bundle。

### Runtime Capability Policy

Web 的能力组合与执行后端一致。Bun 与 Node Desktop 都装配标准 `ptcRuntime`，标准、PTC、Cordis 以及依赖 `workflow-ptc` 的用户配置单不再因 Bun 宿主而裁掉 PTC 行。Bun 仍复用 rc.2 的官方 `@deepseek-ai/dsh-ptc-runtime-node` provider；Bridge 只适配两个宿主差异：用 Amaro 的 strip-only 结果补齐缺失的 `node:module.stripTypeScriptTypes`，以及把 Bun 不稳定的额外 fd 控制 pipe 映射为标准 stdin/stdout Duplex。stderr 仍承载 bootstrap/进程诊断，DSH 的 JsonChannel framing、binding、期限、取消、沙箱、输出限制和清理逻辑保持上游实现。

源码 Bun 执行 Bridge 的极小 child entry 后进入官方 `process.js`；编译后的 CLI 复用同一个 Ellamaka 可执行文件，通过 DSH 官方 `DSH_PTC_RUNTIME_NODE=1` 私有角色在正常 CLI 初始化之前进入 child bootstrap。Node Desktop 继续直接使用原生 Node provider，不经过 Bun 兼容层。两种 Bun 形态都必须验证真实程序执行、连续多次进程启动、取消与平台沙箱拒绝；在 macOS 上 `workspace-write` 的验收要求 provider 报告 full enforcement，`read-only` 必须拒绝临时目录写入。Bun 的 heap 参数不声明为 Node/V8 等价的硬内存上限；资源边界以已验证的沙箱、deadline、取消和输出上限为准。

宿主能力补丁在每次完整配置生成中应用，原生管理操作也消费该补丁。用户自建声明引用不可用服务时保留具体诊断。Ellamaka 主 Session 的外部能力装配属于独立的 Session 设计。

## Web Surface

Web 插件向 VirtualWebServer 注册 HTTP、动态模块和 upgrade 通道，主监听器在 /dsh 前缀分发。令牌、cookie、Host/Origin fence、iframe 入口和资源 URL 的适配见父设计。

原生 pluginManager 的客户端和服务端位于同一 profile，数据、进度和结果经官方连接通道传输。Workbench 消费同源的认证入口与挂载状态，运行时挂载失败显示不可用状态。

## Wopal Preset Bundle

Wopal 的角色 preset 由 ontology 的 `dsh/agents-presets/` 提供，包名为 `@wopal/dsh-presets`。它是声明式 bundle，包含 wopal、fae、rook 三个 preset 与随包技能；不承载 Ellamaka 内部 adapter、工具安装器或另一套工具可见性插件。

```text
dsh/agents-presets/
├── package.json              # @wopal/dsh-presets；dsh.bundle.patch 数组
├── generate-presets.mjs      # 使用目标 DSH 闭包的 YAML 方言生成/检查
├── wopal/
│   ├── preset.yml            # 展示元数据源
│   ├── agent.cordis.yml      # preset 插件声明源
│   ├── preset.patch.yml      # 运行时加载的声明补丁
│   └── skills/               # 随包技能
├── fae/                      # 同样的三份声明文件
└── rook/                     # 同样的三份声明文件
```

`dsh.bundle.patch` 有序加载三个角色的 preset.patch.yml。每个补丁插入官方 agent-preset 声明，包含稳定 id、展示元数据与 plugins；注册、绑定和 revision 由 DSH 原生 preset 服务管理。工具、技能与 persona 使用对应 preset 中的官方插件行配置。

安装通过标准插件供应链将包快照放入 web profile 的 node_modules，并记录依赖与 bundle 声明。源码中的包为私有本地 bundle，不以存在 package.json 作为已发布 npm 包的证明。生成与兼容检查使用目标产品固定的 DSH 闭包。用户覆盖固定保存在核心 Active Home 的 profile 补丁中，包更新不覆盖该用户层；DSH 原生 preset revision 只表达 preset 历史，不属于 Ellamaka Home 迁移模型，也不作为配置编辑目标。

自定义 DSH tools 与 MCP 按各自标准 DSH 插件/bundle 挂载；此 preset bundle 不承担所有动态能力的总包职责。Ellamaka 通过工具容器消费外部能力，其内部 adapter 契约归工具容器设计。

## 空间皮肤插件

一个插件实现「界面按空间定制」，含服务端与客户端两半。

- **空间识别**：服务端从当前会话的工作目录反查所属空间。dsh 会话按空间目录建立，空间目录带 `.wopal-space/` 标记，纯文件系统判断，不依赖跨引擎调用。
- **数据通道**：服务端在 `/dsh/*` 下暴露该空间的皮肤配置（主题变量覆盖、界面件开关、品牌资源）；客户端同源请求，在同源适配下天然可用。
- **界面件**：客户端按配置应用主题变量与声明式插槽——品牌位、输入框上下常驻信息条、会话头部动作位、自定义工具的对话卡片。
- **风格一致性**：主题变量对齐 workbench 设计语言，皮肤件与 workbench 共享同一套品牌资源。

界面定制只走声明式插槽与主题变量，不整区替换，以保证未来架构演进时定制件可无损迁移。

## 组队语义

直接采用 dsh 官方组队能力，不新建机制。

- **招人**：主 agent 运行时经子代理工具招人；大规模并行用工作流工具。
- **队员装备**：队员自动加入队长的配置单，继承队长的工具、技能与空间规则，天然知道这个空间的守则。角色差异由任务书（名称、描述、提示词）与目录规则表达。
- **协作纪律**：消息往来、任务分派、完成上报是引擎内建能力；协作规范写入主 agent 人格。
- **按角色配置装备**：官方招人接口不含配置单字段，需要自定义招人提供者按角色挂载不同配置单。这是条件触发项：第一阶段的任务书与目录规则已覆盖角色分化的主要诉求，只有当「队员必须带不同工具」成为真实需求时才立项。

## Preset and Profile Distribution

配置单与 profile 在 WopalSpace 体系下按分层分发与运行时装配：

1. **分发源头**：配置单作为基础能力随本体仓库分发；profile 由本体统一维护 `web` 与 `ellamaka-tools` 的基准文件对（声明 bundles 与插件依赖的 package.json、写入配置规则与沙箱策略的补丁文件）。本体仓库不跟踪运行态生成的锚点文件与本地 node_modules。

2. **物化生成**：Core Runtime Preparation 将运行必需的标准 profile 基线物化到固定核心 Home `$WOPAL_HOME/dsh/home`。WopalSpace Onboarding 只在用户选择相关增强时，通过同一受控写入服务追加 ontology 提供的 preset bundle。profile 的声明文件物理复制到 `$DSH_HOME/profiles/<profile>/`，更新时采用声明合并策略（bundle 去重联合，保护本地自定义修改）。保持本地目录物理独立，规避跨目录软链带来的锁失效、模块寻址逃逸与热加载穿透问题。

3. **准备与激活**：serve、Desktop、run 与默认 TUI 共用 Core Runtime Preparation，但 preparation 与 runtime activation 分离。profile 物化、包实体和元数据检查都写固定核心 Home；closure fingerprint 变化时必须先完成固定 Home backup，之后目标 DSH 自己处理它支持的原生迁移。Core READY 后各入口才按需挂载 Web/tools；`ELLAMAKA_DSH=0` 时整个 DSH prepare/activate 分支跳过。固定 Home 与 closure-change backup 归 [基础设计](./DESIGN-dsh-base.md#closure-and-startup-lifecycle)。

## 多 profile 解耦

核心的两个容器（Web 与工具）保持同进程。实验性的第三方 profile 以独立进程运行，带独立的 DSH_HOME，不进入主 Web 容器，不与主引擎共享 profile 目录。

### 空间模型

Workbench 顶栏的空间类型扩展为三类：

| 空间类型         | 标识               | 内容                              | 进程归属            |
| ---------------- | ------------------ | --------------------------------- | ------------------- |
| **助理**         | `assistant`        | ellamaka 原生通用会话空间         | ellamaka serve 进程 |
| **DSH**          | `dsh`              | dsh web profile，完整界面         | ellamaka serve 进程 |
| **实验 profile** | `dsh-profile:<id>` | 指定闭包与指定 profile 的隔离实例 | 独立进程            |

- 助理与 DSH 各自独立开关、独立持久化激活状态，互不遮蔽。
- 实验 profile 是注册式实体：一个实验 profile 对应一个独立进程与一个空间标签，携带独立入口地址与健康状态。
- 工具容器保持同进程，不作为独立空间呈现。它服务于工具投影，不是用户可见空间。

### 配置模型

dsh 相关配置采用两层模型：

| 层         | 位置                           | 作用                                          |
| ---------- | ------------------------------ | --------------------------------------------- |
| 默认值     | 空间配置的 `ellamaka.dsh.*` 域 | 定义各空间的启停默认值与实验 profile 注册清单 |
| 运行时覆盖 | 设置面板与持久化存储           | 用户界面内修改，立即生效并持久化              |

合并逻辑：面板有值用面板值，未设置回落配置文件默认值。

`ELLAMAKA_DSH=0` 仍然保留为硬禁用路径，环境变量显式设置时优先于配置。这保证配置损坏时仍有自愈手段。

### 进程拓扑

**核心容器保持同进程**。Web profile 与工具 profile 继续与 ellamaka serve 同进程，得到单端口、单进程、零延迟工具调用。

**实验 profile 独立进程**。每个启用的实验 profile 由独立进程承载；它属于显式隔离实验域，不是正式核心 Active Home 的另一个版本，也不得被主 runtime 当作 Home 回滚目标。收益有三：

1. **闭包版本隔离**：实验进程可以绑定任意历史闭包，主进程继续跑当前闭包，避免单进程内双版本官方包冲突。
2. **故障防扩散**：实验插件崩溃、死锁或内存失控不影响主进程与正式 DSH 空间。
3. **home 隔离**：实验进程使用自己显式注册的隔离 DSH_HOME，不与核心 `$WOPAL_HOME/dsh/home` 共享 profile 目录。该例外只属于实验进程，不改变正式 Ellamaka runtime 的固定 Home invariant。

**启动范式**：独立启动加 Workbench 注册（用户自起、自己连）。`ellamaka dsh up --profile <name> --closure <fingerprint> [--port 0]` 独立跑出认证入口；Workbench 通过服务器管理界面注册，复用现有的添加、健康探针与持久化机制。注册后成为空间标签。主进程对实验进程零感知、零生命周期看管职责，隔离最干净。

### 闭包版本物化扩展

Runtime Manager 当前只物化宿主锁定的版本集。实验 profile 需要物化指定历史版本：

- 物化指定版本到 `closures/<fingerprint>`，复用现有的锁、暂存、校验、激活管线，版本来源从内嵌清单改为显式参数。
- 结果遵循闭包只增不减的约束，成功后永久保留，同指纹无限复用。

### 前端机制

- **标签模型**：助理、DSH、实验 profile 在顶栏并排；可见性从布尔派生改为按空间标识派生；激活空间决定呈现哪个表面。
- **保活 iframe 池**：每个 dsh 类空间持有一个保活 iframe，切换标签只切显示不重载，会话状态保留。
- **健康指示**：复用现有的按服务器健康探针机制，实验进程状态映射到空间标签指示。
- **信号绑定**：从单一的引擎挂载状态扩展为「引擎挂载态加实验空间清单」两类信号。

## 与 Workbench 的界面融合

### 多 profile 解耦前

dsh iframe 以遮蔽方式占用 Workbench 的「助理」标签，可见性由「dsh 启用且激活标签是通用空间」派生。

- **keep-alive**：iframe 与原生工作区双层持久挂载，只切显示；切换标签不重载 iframe，dsh 会话状态保留。
- **覆盖范围**：iframe 覆盖助理标签的内容区全部，dsh 界面自带侧栏。
- **回落**：禁用 dsh 时助理标签显示原生通用会话空间，与引入 dsh 之前一致。

这个遮蔽模型由多 profile 解耦演进替代——同一个标签在不同开关下代表两个不同的产品系统，心智模型分裂，也无法承载第二个 dsh 环境。

### iframe 地址派生

iframe 的来源地址优先取认证入口，回落 `<server url>/dsh/` 派生，不写死相对路径。

原因是开发模式下前端与后端分别监听不同端口，相对 `/dsh/` 在开发页面会解析到前端来源。开发下经代理指向页面来源的 `/dsh/`，Desktop 与生产指向后端来源，两侧都命中挂载点。

### 前端插件互通

dsh 前端插件体系与 Workbench 是两套框架，组件经 Web Component 跨框架互通。

**启动前提**（两条同时满足才排期）：

1. 插件生态在真实使用中：自建插件已日常在用，外部发现的插件中有被实际留存的案例。
2. Workbench 侧完成插槽化：已建立三到五个挂载点与属性契约。

**一个插件包的三个激活面**：profile 的 `package.json` 是唯一真相源，启用与禁用一个动作管三处。

| 面             | 目标                            | 激活契约                                 |
| -------------- | ------------------------------- | ---------------------------------------- |
| 服务端补丁     | dsh 服务端容器                  | profile bundle 层激活                    |
| 客户端         | dsh 界面                        | 官方客户端模块加载                       |
| workbench 界面 | Workbench 的 Web Component 插槽 | 满足本节启动前提后按插槽与加载器契约激活 |

新版面在插件声明中增加 workbench 界面段（入口文件与插槽清单）。插件作者用 React 写组件并包 Web Component 壳，或直接写轻量组件；Web Component 自包含运行时，Shadow DOM 提供样式隔离。

**数据通道**：dsh 容器的 HTTP 面挂在主服务器的 `/dsh/*`，Workbench 页面与之同源（生产同服务器，开发经代理转发）。dsh 第三方插件「服务端注册路由加客户端同源请求」的标准数据模式在 Workbench 中原样成立，改造量集中在界面壳。

容器未运行时，数据请求失败的降级语义由 Workbench 加载器承担：组件显示不可用态，不污染宿主。

**执行顺序**：同源连通 → 加载器最小链路 → 数据面实证 → 真实插件实证 → 失败语义。每步独立可逆。

**平台侧改造**：Bridge 提供 Web Component 文件的静态路由；Workbench 侧增加开发代理、插槽面（初始三到五个挂载点与属性契约）、组件加载器（读 profile 声明、过滤、动态导入、Shadow DOM 挂载、错误隔离、卸载）；供应链的启用面取值扩展加入 workbench。

**信任面**：Web Component 与 Workbench 同页面上下文，可信度等同于 dsh 插件同进程执行。用户显式安装加安装时的风险提示，不新增权限体系。此面不触碰官方闭包，不进入 dsh 界面运行时。

## Related Documents

| 文档                                                                 | 引用目的                      |
| -------------------------------------------------------------------- | ----------------------------- |
| `./DESIGN-ellamaka-tools.md`                                         | 工具容器 profile 的装配与投影 |
| `./DESIGN-workbench.md`                                              | Workbench 工作台设计          |
| `research/deepseek-harness-architecture-and-integration-research.md` | dsh 全景调研                  |
