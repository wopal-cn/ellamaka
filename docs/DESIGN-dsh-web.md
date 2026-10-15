# Web profile 设计

> **Status**: Active
> **Updated**: 2026-10-14
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

已有用户 preset/配置的适配遵循对应 DSH release guide，保留原始数据；Ellamaka 不建设通用格式转换事务。插件和 ontology 的分发产物使用标准声明 bundle。

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

安装通过标准插件供应链将包快照放入 web profile 的 node_modules，并记录依赖与 bundle 声明。源码中的包为私有本地 bundle，不以存在 package.json 作为已发布 npm 包的证明。生成与兼容检查使用目标产品固定的 DSH 闭包。用户覆盖固定保存在核心 Active Home 的 profile 补丁中，包更新不覆盖该用户层；DSH 原生 preset revision 只表达 preset 自身版本，不参与 Ellamaka Home closureVersion 判断，也不作为配置编辑目标。

自定义 DSH tools 与 MCP 按各自标准 DSH 插件/bundle 挂载；此 preset bundle 不承担所有动态能力的总包职责。Ellamaka 通过工具容器消费外部能力，其内部 adapter 契约归工具容器设计。

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

3. **准备与激活**：serve、Desktop 与默认 TUI 共用 Core Runtime Preparation；ellamaka run 固定 DSH-disabled。Runtime 使用统一 closureVersion 检查固定核心 Home，较新版本写入前先备份；Home lock 防止版本切换与运行中的 DSH 并发。Core READY 后各入口才按需挂载 Web/tools；ELLAMAKA_DSH=0 时整个 DSH 分支跳过。细节归 [基础设计](./DESIGN-dsh-base.md#closure-and-startup-lifecycle)。

## Core Profile Hosting

核心 Web 与工具由同一产品 Runtime host 拥有；Web 冷重建遵循主设计的 Unified Reload，tools 默认在宿主进程内。两个 profile 使用各自 Cordis context，工具容器保持 session-free，不作为独立的用户空间。

多个 `serve`、Desktop、TUI 与纯 native `run` 同时存在是 Core 产品要求；`run` 不参与 DSH profile 挂载或 Home 使用。同一 closureVersion 下，各入口按自身正常职责直接挂载所需的官方 profile；Ellamaka 不选举 Home owner、不建立 single-owner hosting、不通过 proxy 共享 Web profile，也不为 `web` / `ellamaka-tools` 增加宿主级 writer lock。部分 DSH plugin/backend 可能尚未提供完整的跨进程一致性保证，因此多个 DSH-enabled 实例共享同一 Home 仍存在上游并发风险；该风险与直接运行多个官方 DSH 实例相同，是当前接受的已知限制。用户希望避免该风险时，可自行只保留一个 DSH-enabled 实例，并对其他实例设置 `ELLAMAKA_DSH=0`。

**核心容器由同一 Runtime host 拥有**。Web 与 tools 使用独立 Cordis context；Web 的冷重建可使用受管子进程，tools 保持 session-free backend。它们与用户独立启动的实验进程是不同生命周期边界，不通过共享 Web Home owner 解决上游并发问题。

## 与 Workbench 的界面融合

### 当前承载模型

dsh iframe 在 Workbench 的助理标签中承载完整 DSH 界面。DSH 开启且当前激活通用空间时显示 iframe；关闭 DSH 时显示原生通用会话。

- iframe 与原生工作区持久挂载，切换只改变可见性，不重载会话。
- iframe 覆盖内容区，DSH 自带侧栏。
- 独立 DSH 标签、实验 profile、空间皮肤与跨框架插件定制属于 Proposed 子设计，本轮不作为运行基础的交付目标。

### iframe 地址派生

iframe 的来源地址优先取认证入口，回落 `<server url>/dsh/` 派生，不写死相对路径。

原因是开发模式下前端与后端分别监听不同端口，相对 `/dsh/` 在开发页面会解析到前端来源。开发下经代理指向页面来源的 `/dsh/`，Desktop 与生产指向后端来源，两侧都命中挂载点。

## Related Documents

| 文档                                                                 | 引用目的                      |
| -------------------------------------------------------------------- | ----------------------------- |
| `./DESIGN-ellamaka-tools.md`                                         | 工具容器 profile 的装配与投影 |
| `./DESIGN-dsh-custumize.md` | Proposed 定制方向，非本轮实施合同 |
| `./DESIGN-workbench.md`                                              | Workbench 工作台设计          |
| `research/deepseek-harness-architecture-and-integration-research.md` | dsh 全景调研                  |
