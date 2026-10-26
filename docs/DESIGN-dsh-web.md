# Web profile 设计

> **Status**: Active
> **Updated**: 2026-10-26
> **Parent**: `./DESIGN.md`
> **Sibling DESIGNs**:
>
> - `./DESIGN-dsh-base.md` — DSH 集成基础、依赖闭包与 Profile 生命周期
> - `./DESIGN-ellamaka-tools.md` — 工具容器 profile 的装配与投影
> - `./DESIGN-workbench.md` — Workbench 工作台设计

`web` profile 承载 DSH 的完整界面与会话。宿主基座、Home、包解析与配置队列由 [DSH 基础设计](./DESIGN-dsh-base.md) 拥有，本文定义 Web 的插件供应链、声明式 preset 和界面承载。

## Upgrade Ownership

Web 使用当前固定 DSH 版本的官方 Web profile 配置和 bundle 默认值，用户与空间扩展通过官方补丁和插件机制配置。官方拥有自身配置、会话数据和升级时的自动格式处理；Ellamaka 拥有宿主挂载、Home 备份与运行诊断。

升级后的验收是实际启动并检查 Web 运行。若官方能够直接处理已有配置，就沿用该结果；若出现破坏性变更，保留诊断，依据对应版本发布说明手动修正配置。产品不推测官方未来配置变更，也不增加一套自动转换规则。Web 的工具和默认行为跟随官方；Ellamaka tools 的最小装配与固定工具回归独立维护。

## Plugin Supply Chain

`web/package.json` 是插件依赖与激活的唯一真相源：`dsh.profile.bundles` 保存有序 bundle 包名列表（默认包含 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`，只写包名不锁版本），`dependencies` 仅保存用户或空间额外安装的外部扩展包（registry 版本，或本地目录的 `file:` 路径）。用户补丁 `cordis.patch.yml` 按 entry id 保存配置和启停。

官方内置 bundle 始终从宿主当前固定的外部 DSH 闭包（`installAnchor`）解析，不写入 `web/package.json` 的 `dependencies`，也不安装进 `web/node_modules`。`web/pnpm-workspace.yaml` 固定设置 `autoInstallPeers: false`：外部插件将 `@deepseek-ai/*` 声明为 `peerDependencies`，安装时只在 `web/node_modules` 落地插件实体及其自身的第三方 `dependencies`，绝不在 profile 内保存任何版本的 `@deepseek-ai/*` 基础包。运行期所有 `@deepseek-ai/*` 导入由宿主解析路由统一指向当前唯一的 DSH 闭包（`profiles/node_modules` 兜底层仅为裸包名的父级回退提供同源链接）。安装由官方 `pluginManager` 与其 pnpm 唯一负责：本地目录一律以 `file:` 声明——它把包快照复制进 profile 并安装其第三方依赖。

pnpm 是宿主前置条件，与官方 DSH 一致：产品既不随包分发 pnpm，也不代为安装；缺失时在安装入口直接报告，不留到官方安装器以裸退出码失败。

```text
$DSH_HOME/profiles/
├── node_modules/                 # 官方依赖解析兜底层（指向当前闭包）
└── web/
    ├── package.json              # bundles 列表与外部插件 dependencies
    ├── pnpm-workspace.yaml       # autoInstallPeers: false
    ├── node_modules/             # 外部插件实体及其第三方依赖（不含 @deepseek-ai/*）
    ├── cordis.yml                # 运行期合成根锚点（每次挂载前重置为 []）
    ├── cordis.patch.yml          # 用户补丁层
    └── .plugin-manager/          # 官方管理操作状态和有界日志
```

### Installation Contract

Web 注入完整的 profileContext，settings、configEditor 和原生 pluginManager 由此获得 profile 的路径和配置事实。

原生 pluginManager 拥有界面协议、检查、进度、取消、应用结果与安装执行（pnpm）。Ellamaka 不注入 profileContext.packageManager，因此只有一套安装器、一份声明语义和一份 lockfile；`ellamaka dsh plugin` 只做转发，DSH_HOME 指向本产品的 home。

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

`bundle.patch` 支持一个文件或有序文件数组，语法与配置求值采用官方 schema。声明提交前检查包身份、peer 范围、Bun 私有 API 依赖和隔离挂载结果。

启动与重放时，`loadProfile` 与 `prepareProfilePatches` 按 `includePrerelease: true` 校验每个 bundle 与插件行的 `peerDependencies`（同时读取 `web/compatibility.json` 中的精确版本风险豁免）：

- **核心内置 bundle 门禁**：`@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app` 是 `web` 容器成立的必需内置 bundle，缺失或跳过时挂载直接失败。
- **外部扩展与第三方插件兼容**：声明兼容版本范围（如 `^0.2.0-rc.2`）的外部插件在 DSH 升级后自动在新闭包下继续运行；因锁死旧版本且未配置豁免而进入 `skippedBundles`（或补丁行进入 `skippedIncompatible`）的第三方插件保留磁盘实体和声明，宿主输出包名、版本要求与当前 runtime 版本的告警诊断并跳过该插件，保持 `web` 容器与其余兼容插件正常启动。

新 bundle、配置修改和启停可以重放。同名包重装或版本替换返回 `restart-required`；配置重放不清除原生模块缓存。文件监听与原生管理操作共用宿主 ProfileRuntime 的 mutation queue 和失败恢复。

### Failure and Cancellation

解析、下载与预检失败保留正式声明。取消结束 worker 的受控进程范围，安装结果区分 failed、cancelled、applied 和 restart-required。应用失败恢复上一份成功运行状态，磁盘输入的拒绝诊断与运行状态分别表达。

主容器的生命周期由宿主拥有。插件管理报告需要重启的结果，产品入口承接用户发起的重新启动。

## Declarative Presets

Web 的 preset 目录由 agent-preset 声明与 agent-preset-registry 服务组成。声明是普通 bundle 插件行，包含 id、展示元数据和 plugins；官方 Web bundle 提供 standard、ptc、minimal、cordis 的定义。

用户 preset 与 shipped preset 的覆盖通过声明 id 表达。用户默认值保存在 agent-preset-registry.selectedDefault。读取、选择、启停与配置持久化使用 profile 用户补丁和官方管理接口。

声明更新产生新的 revision，已有 Agent 保留使用中的 revision，新绑定使用当前定义。无法导入、等待不可用服务或泄漏全局服务的定义按原生 broken-definition 语义提供诊断。默认定义通过可绑定验收后，宿主发布 Web 挂载成功。

已有用户 preset/配置的适配遵循对应 DSH release guide，保留原始数据；Ellamaka 不建设通用格式转换事务。插件和 ontology 的分发产物使用标准声明 bundle。

### Runtime Capability Policy

Web 的能力组合与执行后端一致。Bun 与 Node Desktop 都装配标准 `ptcRuntime`，标准、PTC、Cordis 以及依赖 `workflow-ptc` 的用户配置单不再因 Bun 宿主而裁掉 PTC 行。Bun 复用当前闭包中的官方 `@deepseek-ai/dsh-ptc-runtime-node` provider；Bridge 只适配两个宿主差异：用 Amaro 的 strip-only 结果补齐缺失的 `node:module.stripTypeScriptTypes`，以及把 Bun 不稳定的额外 fd 控制 pipe 映射为标准 stdin/stdout Duplex。stderr 仍承载 bootstrap/进程诊断，DSH 的 JsonChannel framing、binding、期限、取消、沙箱、输出限制和清理逻辑保持上游实现。

源码 Bun 执行 Bridge 的极小 child entry 后进入官方 `process.js`；编译后的 CLI 复用同一个 Ellamaka 可执行文件，通过 DSH 官方 `DSH_PTC_RUNTIME_NODE=1` 私有角色在正常 CLI 初始化之前进入 child bootstrap。Node Desktop 继续直接使用原生 Node provider，不经过 Bun 兼容层。两种 Bun 形态都必须验证真实程序执行、连续多次进程启动、取消与平台沙箱拒绝；在 macOS 上 `workspace-write` 的验收要求 provider 报告 full enforcement，`read-only` 必须拒绝临时目录写入。Bun 的 heap 参数不声明为 Node/V8 等价的硬内存上限；资源边界以已验证的沙箱、deadline、取消和输出上限为准。

宿主能力补丁在每次完整配置生成中应用，原生管理操作也消费该补丁。用户自建声明引用不可用服务时保留具体诊断。Ellamaka 主 Session 的外部能力装配属于独立的 Session 设计。

## Web Surface

Web 插件向 VirtualWebServer 注册 HTTP、动态模块和 upgrade 通道，主监听器在 /dsh 前缀分发。令牌、cookie、Host/Origin fence、iframe 入口和资源 URL 的适配见父设计。

原生 pluginManager 的客户端和服务端位于同一 profile，数据、进度和结果经官方连接通道传输。Workbench 消费同源的认证入口与挂载状态，运行时挂载失败显示不可用状态。

## Wopal Preset Bundle

Wopal 的角色 preset 由 ontology 的 `dsh/agents-presets/` 提供，包名为 `@wopal/dsh-presets`。它是声明式 bundle，包含 wopal、fae、rook 三个 preset 与随包技能；不承载 Ellamaka 内部 adapter、工具安装器或另一套工具可见性插件。

```text
dsh/agents-presets/
├── package.json              # @wopal/dsh-presets；dsh.bundle.patch 数组与兼容 peerDependencies 范围
├── generate-presets.mjs      # 使用目标 DSH 闭包的 YAML 方言生成/检查
├── wopal/
│   ├── preset.yml            # 展示元数据源
│   ├── agent.cordis.yml      # preset 插件声明源
│   ├── preset.patch.yml      # 运行时加载的声明补丁
│   └── skills/               # 随包技能
├── fae/                      # 同样的三份声明文件
└── rook/                     # 同样的三份声明文件
```

`dsh.bundle.patch` 有序加载三个角色的 `preset.patch.yml`。每个补丁插入官方 `agent-preset` 声明，包含稳定 id、展示元数据与 plugins；注册、绑定和 revision 由 DSH 原生 preset 服务管理。工具、技能与 persona 使用对应 preset 中的官方插件行配置。`@wopal/dsh-presets` 及本体仓库的 DSH 插件（`dsh/plugins/*`）在 `package.json` 的 `peerDependencies` 中统一声明兼容的 SemVer 范围（如 `^0.2.0-rc.2`），不绑定单一精确 RC 版本号，使宿主升级 DSH 兼容版本时无需重新安装本体插件。

安装通过标准插件供应链将包快照放入 `web` profile 的 `node_modules`，并记录依赖与 bundle 声明。源码中的包为私有本地 bundle，生成与兼容检查使用目标产品固定的 DSH 闭包。用户覆盖固定保存在核心 Active Home 的 profile 补丁中，包更新不覆盖该用户层；DSH 原生 preset revision 只表达 preset 自身版本，不参与 Ellamaka Home `closureVersion` 判断，也不作为配置编辑目标。

自定义 DSH tools 与 MCP 按各自标准 DSH 插件/bundle 挂载；此 preset bundle 不承担所有动态能力的总包职责。Ellamaka 通过工具容器消费外部能力，其内部 adapter 契约归 [工具容器设计](./DESIGN-ellamaka-tools.md)。

## Team Collaboration

直接采用 DSH 官方组队能力，不新建机制。

- **招人**：主 agent 运行时经子代理工具招人；大规模并行用工作流工具。
- **队员装备**：队员自动加入队长的配置单，继承队长的工具、技能与空间规则，天然知道这个空间的守则。角色差异由任务书（名称、描述、提示词）与目录规则表达。
- **协作纪律**：消息往来、任务分派、完成上报是引擎内建能力；协作规范写入主 agent 人格。
- **按角色配置装备**：官方招人接口不含配置单字段，按角色挂载不同配置单由自定义招人提供者在需要独立工具集时扩展。

## Preset and Profile Distribution

配置单与 profile 在 WopalSpace 体系下按职责边界分层维护与装配：

1. **能力包与 Profile 职责分离**：本体仓库（`dsh/`）仅维护跨版本的声明式预设包（`dsh/agents-presets`）与扩展插件包（`dsh/plugins/*`），不维护 `web` 或 `ellamaka-tools` 的 profile 基线目录。
2. **Profile 初始化**：CorePreparation（`dsh.profiles` 步骤）在固定核心 Home `$WOPAL_HOME/dsh/home/profiles/<profile>/` 使用官方文件格式准备 profile：Web 使用官方模板，tools 使用产品最小插件声明。每次准备与启动前将合成根锚点 `cordis.yml` 重置为 `[]\n`。已有用户声明文件保持不变。
3. **预设与插件安装**：WopalSpace Onboarding 或插件管理命令在用户启用相关增强时，通过官方 `pluginManager` 流水线将本体仓库提供的 `@wopal/dsh-presets` 及扩展插件以 `file:` 本地包快照方式安装到 `web` profile，保持本地目录物理独立。
4. **准备与激活**：`serve`、Desktop 与默认 TUI 共用 CorePreparation；`ellamaka run` 固定跳过 DSH。Runtime 使用统一 `closureVersion` 检查固定核心 Home，较新版本写入前先备份；Home lock 防止版本切换与运行中的 DSH 并发。Web 与 Tools 只按各自启用事实请求 profile；两者都关闭时整个 DSH 分支跳过。细节归 [DSH 基础设计](./DESIGN-dsh-base.md#closure-and-startup-lifecycle)。

## Core Profile Hosting

核心 Web 与工具由同一产品 Runtime host 拥有；Web 冷重建遵循主设计的 Unified Reload，tools 默认在宿主进程内。两个 profile 使用各自 Cordis context，工具容器保持 session-free，不作为独立的用户空间。

多个 `serve`、Desktop、TUI 与纯 native `run` 同时存在是 Core 产品要求；`run` 不参与 DSH profile 挂载或 Home 使用。同一 closureVersion 下，各入口按自身正常职责直接挂载所需的官方 profile；Ellamaka 不选举 Home owner、不建立 single-owner hosting、不通过 proxy 共享 Web profile，也不为 `web` / `ellamaka-tools` 增加宿主级 writer lock。部分 DSH plugin/backend 可能尚未提供完整的跨进程一致性保证，因此多个 DSH-enabled 实例共享同一 Home 仍存在上游并发风险；该风险与直接运行多个官方 DSH 实例相同，是当前接受的已知限制。用户希望避免该风险时，可自行只保留一个实际启用 DSH profile 的实例；Web 与 Tools 分别使用各自的启用事实关闭。

**核心容器由同一 Runtime host 拥有**。Web 与 tools 使用独立 Cordis context；Web 的冷重建可使用受管子进程，tools 保持 session-free backend。它们与用户独立启动的实验进程是不同生命周期边界，不通过共享 Web Home owner 解决上游并发问题。

## Workbench Integration

### Enablement

DSH Web 是独立于 Ellamaka Native Assistant 的用户界面核心。是否为当前 Server/sidecar 启动 Web profile 由 Wopal 全局设置 `wopal.dsh.web.enabled` 决定：

```jsonc
{
  "wopal": {
    "dsh": {
      "web": { "enabled": true },
    },
  },
}
```

该键只从 `$WOPAL_HOME/config/settings.jsonc` 读取，默认值为 `true`。Space 的 `settings.jsonc` / `settings.local.jsonc` 不覆盖这个值，因为同一个 Server/sidecar 只承载一个 Web profile。Workbench Settings 通过统一 `config-v2` 设置接口修改这个全局事实；首个版本返回 `restart-required`，运行中的 Web profile 不因磁盘值变化被即时挂载或卸载。重启后，Runtime health 的 `dsh.web` 反映新的生效状态。

这个开关只管理 Web profile。`ellamaka-tools` profile 由 Ellamaka 进程自己的环境开关管理，Space 是否采用 DSH 沙箱工具由 `wopal.pluginConfig.dsh-adapter` 决定；三者互不代替。

### Hosting Model

DSH iframe 在 [Workbench](./DESIGN-workbench.md) 中拥有独立的固定 DSH Tab，不再替换 General/Assistant 内容。Runtime 的 `dsh.web` 是这个 Tab 的运行时事实：`disabled` 时不显示 DSH Tab；`preparing` 时 Tab 已存在并显示启动状态；`ready` 后加载完整 DSH iframe；`degraded` 时保留 DSH Tab 并显示不可用/诊断状态。

- DSH Tab 与原生工作区相互独立。用户切换 Tab 只改变可见性，不把一个表面自动替换成另一个。
- Web profile 启用时，Workbench 从首次得到 `preparing`/`ready`/`degraded` 意图起稳定保留 DSH Tab；sidecar 重启的中间未知状态不把它闪退成 Assistant。
- iframe 只在当前 sidecar generation 的 `dsh.web=ready` 后请求受控入口并设置有效 `src`。新 generation 未 ready 前不请求新的入口，也不通过 `/dsh/` fallback 抢跑。
- iframe 首次成功加载后保持 keep-alive；Tab 切换不重载 DSH 会话。sidecar generation 变化后，等新 generation `ready` 再更新入口。
- iframe 覆盖内容区，DSH 自带侧栏。
- 实验 profile、空间皮肤与跨框架插件定制归 [Proposed 定制方向](./DESIGN-dsh-custumize.md)。

### Iframe Origin Derivation

iframe 的来源地址优先取认证入口，回落 `<server url>/dsh/` 派生，不写死相对路径。

原因是开发模式下前端与后端分别监听不同端口，相对 `/dsh/` 在开发页面会解析到前端来源。开发下经代理指向页面来源的 `/dsh/`，Desktop 与生产指向后端来源，两侧都命中挂载点。

## Reference Documents

| 文档                                                                 | 引用目的     |
| -------------------------------------------------------------------- | ------------ |
| `research/deepseek-harness-architecture-and-integration-research.md` | DSH 全景调研 |
