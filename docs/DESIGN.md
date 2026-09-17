# Ellamaka

> **Status**: Active
> **Updated**: 2026-09-17
> **Parent Architecture**: `../../../docs/products/wopal-space/DESIGN.md`
> **Sub-DESIGNs**:
>
> - `./DESIGN-config-engine.md` — 引擎配置消费面：三层读取、面板数据链经 CLI 唯一写入实现
> - `./DESIGN-desktop.md` — 官方桌面应用架构
> - `./DESIGN-distribution.md` — 分发与版本身份唯一真相源
> - `./DESIGN-dsh-base.md` — dsh 融合基础：文件领地、依赖闭包、热加载
> - `./DESIGN-dsh-web.md` — Web profile：插件供应链与界面承载
> - `./DESIGN-ellamaka-tools.md` — 工具容器 profile：能力采用与沙箱
> - `./DESIGN-onboarding.md` — Desktop onboarding 目标实现
> - `./DESIGN-plan-scheduler.md` — 空间级计划工作区、调度交互与运行接管
> - `./DESIGN-workbench.md` — Workbench 工作台设计
> **Companion Documents**:
>
> - `./API-CONTRACT.md` — Runtime API 与 SDK 契约

## Role

ellamaka 是 OpenCode fork，WopalSpace 的执行引擎。它同时承载非 WopalSpace 与 WopalSpace 两种运行模式，负责配置加载、capability composition、ontology 运行时物化、plugin 执行与权限系统。

不负责：空间初始化、ontology 内容设计、空间运行态维护——这些归属 wopal-cli、Space Ontology 和 `.wopal-space/`。

## WopalSpace Adaptations

ellamaka 继承上游 OpenCode 全部 agent runtime、TUI/Web、session、tool、plugin 能力。下表是 ellamaka 全部定制点的完整索引，每项指向其权威设计文档章节。

| 适配点                    | 概要                                                                                              | 详见                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------- |
| WopalSpace 自动检测       | CLI 从 cwd 检测单一空间；sidecar 按 instance directory 解析独立空间根                             | [Space Detection Contract](#space-detection-contract) |
| 全局路径分离              | `$WOPAL_HOME/config` + `$WOPAL_HOME/ellamaka/{data,cache,state}`                                  | [State Ownership](#state-ownership)     |
| 非 WopalSpace 模式        | 配置入口由 WOPAL_HOME 所有；capability loading 保持 OpenCode-compatible 并叠加 WOPAL_HOME 全局能力 | [Configuration Contract](#configuration-contract) |
| WopalSpace 模式           | 从 instance space root 加载 `.wopal/` 配置和能力；空间根与任意子目录共享同一 context              | [Configuration Contract](#configuration-contract) |
| Instance 运行模式         | 按 directory 检测空间根；server 不使用进程 env 表达当前空间                                       | [Sidecar Instance Context](#sidecar-instance-context) |
| Agent/Command/Plugin 加载 | 从 `.wopal/` 加载同名可覆盖内置                                                                   | [Ontology Loading Contract](#ontology-loading-contract) |
| 权限合并                  | defaults → global → space settings → agent frontmatter                                            | [Configuration Contract](#configuration-contract) |
| 插件去重                  | 全局与空间 ontology 同 runtime id 插件按后加载者保留                                              | [插件去重](#插件去重)                   |
| Skill 加载                | base/user 并发解析，space overlay 按序覆盖                                                        | [Ontology Loading Contract](#ontology-loading-contract) |
| TUI 配置与 `/help`        | `settings.jsonc` 的 `tui` 字段；WopalSpace 模式 `/help` 由空间命令接管                            | [TUI 配置加载](#tui-配置加载)           |
| 品牌身份                  | 品牌常量、CLI 身份、Logo、文件系统命名决策                                                        | [品牌身份](#品牌身份)                   |
| 构建与发布                | 品牌注入、平台矩阵、构建接口                                                                      | [Release Backbone](./DESIGN-distribution.md#release-backbone) |
| Web UI 产品化             | `packages/ellamaka-app` 作为官方 Web 工作台形态                                                    | [Web UI 与 ellamaka-app](#web-ui-与-ellamaka-app)、[DESIGN-workbench.md](./DESIGN-workbench.md) |
| Runtime API 与 SDK        | Effect HttpApi schema → OpenAPI → 生成 SDK；Wopal CLI adapter 将空间控制能力映射为 Runtime API    | [Runtime API 与 SDK 契约](#runtime-api-与-sdk-契约) |
| DSH 双引擎融合            | 进程内运行 dsh 引擎，双容器共用单端口；工具能力经投影进入 ellamaka 工具管道                        | [DSH 双引擎融合](#dsh-双引擎融合)       |
| 运行时重载                | 单元化 ReloadController 与两级重载协议                                                            | [Unified Reload & Lifecycle](#unified-reload--lifecycle) |
| 引擎配置消费              | 三层配置读取、`wopal-space/config` API（读写均转发 CLI）与设置面板数据链                          | [DESIGN-config-engine.md](./DESIGN-config-engine.md) |
| 引擎安装识别              | 识别 `$WOPAL_HOME/bin/` 安装路径                                                                  | [Install Contract](./DESIGN-distribution.md#install-contract) |

定制逻辑以独立模块承载：新文件优先，上游文件只保留最小 import 与调用注入点。

## 品牌与构建包结构

ellamaka 的品牌身份与构建发布分属两个包，沿运行时/构建期边界划分：

| 包 | 职责 | 消费方 |
|---|---|---|
| `@wopal/ellamaka-brand`（`packages/ellamaka-brand/`） | 品牌真相源：branding 常量（BINARY_NAME、BINARY_TITLE、channel 常量、UI_UPSTREAM_URL）、logo/wordmark、TUI tips、WopalSpace 目录检测 | opencode 运行时（全部走包路径 import）；`ellamaka-release` 构建期（读 BINARY_NAME/CHANNEL_RELEASE） |
| `@wopal/ellamaka-release`（`packages/ellamaka-release/`） | 构建与发布唯一枢纽：构建编排（`src/cli/build.ts`）、构建期版本/渠道解析（`src/build-env.ts`）、发布身份模型（`src/identity.ts`）、构建目标矩阵、release context、manifest、gitee、cleanup、inventory、upstream lock | 构建脚本与 CI workflow；`opencode` 的 release-info 命令运行时读取 identity 模型 |

边界纪律：

- 运行时（opencode）只依赖 `ellamaka-brand`；对 `ellamaka-release` 的唯一运行时依赖是 `identity` 模型（`ellamaka debug release-info`），该模型是构建期与运行期共享的纯数据契约，位于 release 包是因为它的 schema 与 manifest/构建流水线同源演进。
- `ellamaka-release` 不被任何运行时热路径引用；它依赖 `ellamaka-brand`（构建期读品牌常量），方向单一，无环。
- 品牌常量消费一律走包路径 `@wopal/ellamaka-brand/branding` 等导出，禁止相对路径跨包引用。

## 品牌身份

ellamaka 的全部用户可见身份由 `@wopal/ellamaka-brand` 集中定义，不在源码中硬编码品牌值。

### 品牌常量

| 常量              | 值         | 用途                                                     |
| ----------------- | ---------- | -------------------------------------------------------- |
| `BINARY_NAME`     | `ellamaka` | CLI 命令名、help 文本、错误前缀                          |
| `BINARY_TITLE`    | `Ellamaka` | 用户界面标题、sidebar 版本署名                           |
| `VERSION_PREFIX`  | `ellamaka` | 版本字符串前缀                                           |
| `CHANNEL_RELEASE` | `stable`   | 发布 build channel 标识（`latest` 仅为 R2 feed 别名）     |
| `CHANNEL_DEV`     | `main`     | 本地开发 build channel 标识                               |
| `UI_UPSTREAM_URL` | `null`     | 未内嵌 Web UI 时的在线代理目标域名；`null` 禁用反向代理  |

### CLI 身份

- **命令名**：`.scriptName(BINARY_NAME)` 一步覆盖全部 yargs 自动生成的输出——usage 行、帮助文本前缀、错误信息前缀。
- **命令描述与提示**：命令 `describe`、`prompts`、错误提示中的 `"opencode"` 均替换为 `BINARY_NAME`，通过 import 注入。包管理器命令中的上游 npm 包名与非用户可见日志保持原样。
- **Logo**：CLI 启动 ASCII art 与 TUI 首页动画使用 ELLAMAKA 块字符画（4 行 × 19 列，左半 "ELLA" + 右半 "MAKA"），字模数据位于 `logo.ts`，非 TTY 环境降级为单行 wordmark。
- **错误上报**：GitHub issue URL 指向 `wopal-cn/ellamaka`，issue 模板参数名为 `ellamaka-version`。

CLI 版本号与发布身份语义见 [Version Identity](./DESIGN-distribution.md#version-identity)。

### TUI 品牌资产

- **Tips**：原创 tips 列表定义在 `packages/ellamaka-brand/tips.ts`，导出 `ELLAMAKA_TIPS`，由 tips-view 引用。策展保留通用功能提示，移除上游特有服务提示；命令引用走 `BINARY_NAME`，配置引用走 `settings.jsonc`。
- **Sidebar 署名**：sidebar footer 与缺省署名中的 `OpenCode` 替换为 `BINARY_TITLE`。

TUI 主题与 logo 插件（`tui-ellamaka.tsx`、`ellamaka-theme.json`）由 `.wopal/` ontology 提供，见 ontology 设计文档。

### 文件系统命名决策

| 路径/名称                               | 说明                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `ellamaka.db` / `ellamaka-{channel}.db` | 数据库文件名，位于 `$WOPAL_HOME/ellamaka/data/`                           |
| `# ellamaka`                            | shell PATH 标记，写入 `.zshrc` / `.bashrc`，卸载时据此识别                |
| `ellamaka.local`                        | mDNS 默认域名，经 `BINARY_NAME` 注入                                      |

以下路径保留 `opencode` 命名：`.opencode/`（OpenCode-compatible capability 扫描目录）、`opencode-clipboard.png`（运行时缓存）、`ProviderID.opencode`（内部 provider 标识）、`opencode.json` / `opencode.jsonc`（非 WopalSpace 模式的兼容读取入口）。

## Configuration Contract

Ellamaka 运行时包含两种模式：

- **非 WopalSpace**：当前 instance 没有 `wopalSpaceRoot`。配置入口由 WOPAL_HOME 所有，capability loading 保持 OpenCode-compatible 的目录发现和覆盖机制，并在末层叠加 WOPAL_HOME 全局能力。
- **WopalSpace**：当前 instance 的 `wopalSpaceRoot` 是空间根。当前 directory 可以是空间根或其任意子目录，配置和能力始终从这个根加载。

WopalSpace 模式下配置加载优先级（低→高）：

| 层级                 | 来源                                                     |
| -------------------- | -------------------------------------------------------- |
| Built-in defaults    | ellamaka 内置                                            |
| Global config        | `$WOPAL_HOME/config/settings.jsonc`                      |
| Space settings       | `<space>/.wopal/config/settings.jsonc` → `ellamaka` 字段 |
| Space local settings | `<space>/.wopal/config/settings.local.jsonc`（私有覆盖）  |
| Agent frontmatter    | `<space>/.wopal/agents/*.md`                             |
| Environment override | `ELLAMAKA_CONFIG_CONTENT`                                |

普通会话权限合并同此优先链，按最后匹配项生效；调度会话还受 Scheduled Plan Execution 中不可放宽的 profile 上限约束。非 WopalSpace 模式的配置文件入口迁移至 `$WOPAL_HOME/config/settings.jsonc`，不加载 opencode XDG 全局配置；agents、commands、plugins、skills 与外部技能继续遵循 OpenCode-compatible capability loading，并由 `$WOPAL_HOME` 提供 Ellamaka 全局覆盖层。配置链环境变量统一使用 `ELLAMAKA_` 前缀，命名空间与兼容规则见 `../../../docs/products/wopal-space/DESIGN-config-settings.md`。

空间配置分为公开与私有两层：`config/settings.jsonc` 随 ontology 提交分发，承载公共默认值；`config/settings.local.jsonc` 为用户私有覆盖，不提交。两层通过 `mergeDeep` 合并，后者优先。

非 WopalSpace 模式下，能力扫描在 OpenCode 生态目录（`.opencode/`、`~/.opencode/`、`~/.config/opencode/`）之后叠加 `$WOPAL_HOME/` 全局能力，后者最后加载并覆盖同名能力。`$WOPAL_HOME/config/` 是纯配置目录，不参与能力扫描。

### External Capability Directories

两个上游惯例目录的跨模式行为不同：

| 目录 | 非 WopalSpace | WopalSpace | 依据 |
| ---- | ------------- | ---------- | ---- |
| `.claude/`（含 `~/.claude/`） | 加载 | **不加载** | WopalSpace 模式为强制禁用触发条件之一 |
| `.agents/`（含 `~/.agents/`） | 加载 | **加载** | 行业标准目录，所有模式常驻 |

`.agents` 在 WopalSpace 模式下的优先级与 `$WOPAL_HOME` 全局能力一致：空间 `<space>/.wopal/skills/` 的同名技能覆盖它。

ellamaka 为 `$WOPAL_HOME/` 与 `<space>/.wopal/` 下的本地插件自动安装其 `package.json` 声明的依赖，其他能力目录保持上游行为。机制细节见 [配置机制参考](./references/ellamaka-config-mechanism.md)。

## Space Detection Contract

ellamaka 按当前执行目录识别运行模式。检测逻辑由 `packages/ellamaka-brand/detect.ts` 提供，是纯目录检测，无副作用。

检测算法：

1. 从 cwd 向上逐级查找 `.wopal/.git`
2. `.wopal/.git` 是文件（非目录）→ ontology worktree 标记，返回该目录作为空间根
3. `.wopal/.git` 不存在或是目录 → 跳过，继续向上
4. 到达用户 home → 停止，返回 undefined（非 WopalSpace 模式）

空间根契约：

| 运行边界             | 检测来源                              | 所有权                  |
| -------------------- | ------------------------------------- | ----------------------- |
| CLI 单目录           | `detectWopalSpace(process.cwd())`     | 当前 CLI 进程           |
| Server / sidecar     | `detectWopalSpace(instance.directory)` | 当前 directory instance |
| Plugin               | `PluginInput.wopalSpaceRoot`          | 当前 plugin instance    |

- 从空间根或其任意子目录进入都得到同一个 `wopalSpaceRoot`。
- CLI 入口将检测结果映射为 `WOPAL_SPACE` / `WOPAL_SPACE_ROOT`，供同一 CLI 进程使用。这是单进程兼容边界，不表达 sidecar 的当前空间。
- Sidecar 不从父进程继承空间状态，也不在 instance 配置加载中修改进程级环境变量；entry 中间件先清除继承的空间变量再执行检测。
- `--disable-wopalspace` 关闭 CLI 检测入口，作为显式逃生舱。

## Ontology Loading Contract

| 加载面   | 来源                                             | 行为                                           |
| -------- | ------------------------------------------------ | ---------------------------------------------- |
| Commands | `.wopal/commands/`                               | 可覆盖内置命令                                 |
| Agents   | `.wopal/agents/`                                 | Markdown 定义 agent 身份与 frontmatter         |
| Plugins  | `.wopal/plugins/`                                | 向 runtime 暴露 plugin tools                   |
| Settings | `.wopal/config/settings.jsonc`                   | `ellamaka` 字段配置 engine，`tui` 字段配置 TUI |
| Skills   | `$WOPAL_HOME/skills/` → `<space>/.wopal/skills/` | 并发解析 + 按序合并，右侧优先                  |

### TUI 配置加载

TUI 配置仅从 ellamaka 自身路径加载，不加载 `~/.config/opencode/tui.*`。全局 TUI 配置取自 `$WOPAL_HOME/config/settings.jsonc` 的 `tui` 字段；WopalSpace 模式下由 `<space>/.wopal/config/settings.jsonc` 的同名字段合并覆盖。主题扫描目录仅保留 `$WOPAL_HOME/config/`，跳过全部 `.opencode/` 目录。

WopalSpace 模式下 `/help` 由空间级 `commands/help.md` 接管，而非 TUI 内置 `DialogHelp`。ellamaka 的 TUI palette 命令（keymap 层）与服务端命令（`Command.Service`）是两套独立系统，`help.show` 的 `slashName` 在 WopalSpace 模式下置空，使 `/help` 落入服务端命令解析；其余 palette 命令不受影响。

### 插件去重

WopalSpace 模式下，`$WOPAL_HOME/`（全局 ontology）与 `<space>/.wopal/`（空间 ontology）可以包含同一插件，其文件路径不同但 runtime `id` 相同。按 file URL 去重无法识别这类重复，会导致插件被加载两次。

`deduplicateLoadedPluginsByRuntimeId()` 在插件模块加载完成后、执行 `server()` 之前按 runtime `id` 去重，同一 id 保留后加载（高优先级）的插件。去重发生在模块加载与执行之间的边界上，对 config 层零侵入。

## Upstream Merge Boundary

ellamaka 与 OpenCode upstream 各自独立演进，不进行上游合并。`main` 是 ellamaka 的定制稳定线。需要参考 OpenCode 模块代码时，从 `labs/ref-repos/opencode/` 读取对应模块。

| 规则     | 说明                                             |
| -------- | ------------------------------------------------ |
| 分支     | `main` = 定制稳定线                              |
| 合并方向 | 无                                               |
| 参考来源 | OpenCode 模块代码参考 `labs/ref-repos/opencode/` |

正式采用的 OpenCode Engine version 与 commit 记录在 `release/upstreams.lock.json` 的 `sources.opencode`，作为 provenance 与兼容基线。CLI/Desktop build 与 release workflow 从 lock 读取该基线。

## Distribution

Ellamaka CLI 构建为多平台 standalone binary，Desktop 构建为原生安装包。两者分别使用标准 SemVer、namespaced tag、workflow 和 latest feed。Desktop 与 CLI 是同一产品的两种形态，运行时版本保证为 wopal-cli `>= MIN_WOPAL_CLI_VERSION` 与 CLI 主版本 `vX.Y` 与 Desktop 一致。`wopal ellamaka install` 默认安装完整产品，`--cli` 只安装外部 CLI。

构建入口：CI 中 `publish-ellamaka-cli.yml` 调用 `scripts/build.sh cli`（内部走 `packages/ellamaka-release/src/cli/build.ts`）并注入 env；本地开发使用 `packages/ellamaka-release/src/cli/build.ts` 包装脚本。

onboarding 将 ontology base capabilities 物化到 `WOPAL_HOME` 后，ellamaka 按现有 user/base + space overlay 链路加载。外部 CLI 的安装收据位于 `$WOPAL_HOME/ellamaka/state/`，`bin/` 只保存 executable。

详细 artifact contract 见 `docs/DESIGN-distribution.md`。

## State Ownership

| 状态                             | 位置                                                  | Owner                                                                                 |
| -------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Global config                    | `$WOPAL_HOME/config/`                                 | ellamaka                                                                              |
| Runtime data                     | `$WOPAL_HOME/ellamaka/data/`                          | ellamaka                                                                              |
| Cache                            | `$WOPAL_HOME/ellamaka/cache/`                         | ellamaka                                                                              |
| Process state                    | `$WOPAL_HOME/ellamaka/state/`                         | ellamaka                                                                              |
| Instance WopalSpace root         | 当前 directory 的检测结果                             | `undefined` 表示非 WopalSpace；绝对路径表示 WopalSpace                                |
| CLI WopalSpace compatibility env | CLI 单进程运行期的 `WOPAL_SPACE` / `WOPAL_SPACE_ROOT` | CLI 入口；不作为 sidecar 当前空间状态                                                 |
| Wopal CLI 健康                   | `$WOPAL_HOME/bin/wopal` 的短时探测结果                | `CliContract`，CLI 二进制保持版本事实来源                                             |
| 空间 ontology                    | `<space>/.wopal/`                                     | Space Ontology，ellamaka 加载                                                         |
| 空间运行态                       | `<space>/.wopal-space/`                               | space runtime；wopal-plugin 按 instance root 写日志，Ellamaka engine 不拥有其目录结构 |

根路径 `WOPAL_HOME` 可通过环境变量覆盖，默认 `~/.wopal`。临时目录使用 `/tmp/ellamaka/`。

### 环境变量来源

Core `Global` 只负责 `WOPAL_HOME` 路径布局，不将 `.env` 文件写入 `process.env`；`process.env` 只表达真实进程启动环境与 shell 临时覆盖。`.env` 由 wopal-plugin 的 per-invocation loader 消费，优先级为：真实 process/shell env > 当前空间 `<wopalSpaceRoot>/.wopal/.env` > 全局 `$WOPAL_HOME/.env`。

### 系统管理配置

企业 MDM 场景下，系统管理配置域为 `ai.wopal.managed`，路径为 `/Library/Application Support/wopal`（macOS）、`%ProgramData%/wopal`（Windows）或 `/etc/wopal`（Linux）。

### Runtime API 与 SDK 契约

Ellamaka 的 HTTP API 是 Workbench 和外部集成使用运行时能力的唯一网络表面。领域 schema 同时驱动 Effect HttpApi 路由、运行时校验、OpenAPI 和生成 SDK。Root API 承载全局控制能力，Instance API 承载工作目录相关运行时能力。

Workbench Session Projection 是左侧会话列表的服务端只读模型，只返回 `time_archived IS NULL` 且 `parent_id IS NULL` 的 Session。归档会话和子会话不属于可直接装载的根会话资源。

Workbench 的被动读取不拥有会话运行环境：会话运行状态快照来自已初始化 instance 的规范状态，通知摘要直接读取 Session 数据库，空间文件树与预览使用注册 Space 范围内的 Root 文件读取。以上读取均不触发 directory bootstrap。只有 Panel 中的会话需要目录能力；恢复的非当前 Space 首次访问时才挂载，访问后保持后台会话与终端连接。

Wopal CLI adapter 作为 Runtime 的领域服务使用 `wopal ... --api-version` capability。它维护非权威空间快照，并将稳定的 CLI 结果映射为 Ellamaka 领域资源和错误。adapter 位于 sidecar 内，直接 spawn wopal 进程；wopal 调用是无状态进程边界，不引入专门的常驻 worker。消费侧 schema 从 wopal 共享契约包导入，与 wopal 的 TypeBox 契约同源。浏览器只使用 Ellamaka API。

`CliContract` 将 CLI 安装状态与能力调用分开处理。`/global/health` 公开最低版本、已检测版本与兼容状态。CLI 不可用时，Ellamaka 保持 Session Runtime，Workbench 将 Space Control 降级为可恢复状态。用户确认修复后，Runtime 使用已安装 CLI 的更新命令或第一方 installer 修复二进制，并重新探测状态；sidecar 与已有 Workbench 现场继续运行。

完整的路径语义、schema、错误、版本、SDK 生成和端点门禁见 [API-CONTRACT.md](./API-CONTRACT.md)。

### Sidecar Instance Context

一个 sidecar 同时服务多个 directory instance。配置加载和插件创建从当前 directory 直接检测可选的 `wopalSpaceRoot`。空间根与空间内任意子目录得到同一个 root；非 WopalSpace instance 不继承其他空间状态。

PluginInput 通过可选 `wopalSpaceRoot` 字段接收当前 instance 的空间根。字段缺失表示非 WopalSpace。插件使用该字段定位空间级资源，普通 Engine 运行时保持上游环境与子进程行为。

`WOPAL_HOME` 是 sidecar 的进程级安装根。它拥有全局配置、全局能力和运行时存储。`WOPAL_SPACE` 与 `WOPAL_SPACE_ROOT` 只服务单目录 CLI 兼容边界，不承担 server request routing 或 plugin context 所有权。

## Unified Reload & Lifecycle

后端把运行时单元的可重载能力统一为一个模型：一个 `ReloadController` 管理若干 `ReloadUnit`，每个单元独立用同一套生命周期协议重载。单元是进程内的可重载边界：

| 单元 | 状态源 | 重载含义 |
| --- | --- | --- |
| `global` | 全局 config 与 provider | dispose 全部 instance 并重新 bootstrap，发出 `global.disposed` |
| `instance:<directory>` | 单目录 instance | `InstanceStore.reload`（dispose + bootstrap） |
| `dsh:web` | web profile manifest / closure | 重建 DSH web 容器 |
| `dsh:tools` | ellamaka-tools profile manifest / closure | 重建 DSH 工具容器 |

**两级重载**：

- **Hot replay** —— config-only 与 patch 变更，原地回放配置，不产生新代际。DSH 由 profile watcher 承载；opencode 配置 watch 同属此类。
- **Cold reload** —— 版本与代码变更。统一协议 `drain → dispose → build → verify → publish(generation) → notify`，产生新 generation。

**隔离边界**：进程内重挂载复用同 URL 的已求值模块（原生 `import()` 与内部 loader 均按 URL 缓存），插件版本升级不生效；冷重载依赖新进程边界来重置模块图，与内部 loader 无关。`dsh:web` 的 build 在独立可重启子进程中完成，宿主以 loopback HTTP 承接并稳定转发 `/dsh` 前缀。Desktop 复用 `utilityProcess`（现有 sidecar 已是同款）；bun standalone serve 以全新 bun 子进程承载 web 容器、宿主经 node:http 代理转发 `/dsh`。`dsh:tools` 是无会话的 per-call 执行，默认 in-process，必要时升级为同款隔离。`--expose-internals` 服务于官方 node-hmr，在 Electron 中当前不可用，是本设计的非依赖项；普通 Node 22 与 bun 子进程均可分载 web 容器并返回认证首页、宿主代理转发 200（已 spike）。

**触发定域**：按状态源变化定单元，不做固定组合——web profile 变 → `dsh:web`；tools profile 变 → `dsh:tools`；共享 dsh-base/closure 变 → web+tools；全局 provider/config 变 → `global` 与各 `instance:*`，不牵动 dsh。单元用 `invalidatedBy` 声明依赖边；当前 global 不依赖任何 dsh 单元，未来做集中配置管理只需增补一条边。

**发布与事件**：每个单元原子发布 entry/route 与 generation，事件携带 `unit` 与 `generation`。保留 `global.disposed` 的兼容语义；DSH 单元重载只重建 Workbench 的 DSH iframe，不触发整个 sidecar 的 generation。

**一致性**：materialize/install 与 cold reload 在 shared home 锁上串行；先停旧代、确认终止，再启新代；重载超时或失败只降级该单元，不升级为整进程重启。

DSH 容器装配与融合细则见 [DESIGN-dsh-base.md](./DESIGN-dsh-base.md)。

## DSH 双引擎融合

ellamaka 在自己的进程内运行 dsh 引擎。融合的目的是获得沙箱执行、插件生态与动态装载能力，同时保持 ellamaka 的会话所有权与对外契约不变。

### 双容器模型

进程内运行两个相互独立容器，共用 ellamaka 的唯一监听端口：

| 容器 | Profile | 职责 | 会话 |
|------|---------|------|------|
| **Web 容器** | `web` | 承载 dsh 完整 Web 界面（会话、账本、检查点、Agent 配置体系） | 有 |
| **工具容器** | `ellamaka-tools` | 提供纯工具执行后端，供 ellamaka 工具管道调用 | 无 |

```text
ellamaka 进程（唯一监听端口）
├── ellamaka 引擎 + Effect HttpApi    → /api/*、/workbench 等原生资源
│     └── ToolRegistry：内置工具 + dsh-adapter 投影的容器工具
├── /dsh/* → 受控 Node 路由挂载点 → VirtualWebServer（Web 容器）
│     ├── /api/*          → dsh 官方 connection 插件
│     ├── /api/events.*   → dsh 官方 WebSocket 下行通道
│     ├── /plugins/*      → dsh 官方 modules 插件
│     ├── /plugins/events → dsh 官方 HMR 插件
│     └── /*              → dsh 官方 frontend-static
├── 工具容器（ellamaka-tools profile，无 webserver）
│     └── globalThis.__ellamakaDshContainer → dsh-adapter 调用工具
└── DSH Runtime Manager → 依赖闭包物化与容器挂载
      └── DSH Bridge（编译进 ellamaka 发布物，动态加载官方运行时）
```

**两个容器必须分离**：Web 界面需要 dsh 的完整 agent-loop 语义（会话账本、检查点、完整插件集）；工具采用只需要工具本体与最小调用上下文。同一个容器无法同时满足两种装配——检查点插件会强制刷新调用方的活动会话。

**入口分工**：

- CLI serve / web：挂载 Web 容器与工具容器
- Desktop sidecar：挂载 Web 容器与工具容器
- TUI：只挂工具容器（无 iframe 需求）
- Workbench：由承载页面的 serve/web 后端或 Desktop sidecar 提供两个容器

### 采用范围

融合只采用 dsh 的工具能力，不采用它的会话语义。

dsh 的会话与账本语义、调度、子代理等引擎能力依赖 dsh 自身的会话模型，与 ellamaka 的会话所有权冲突。契约桥能翻译接口形状，翻译不了引擎语义。这类能力的获取路径是按 ellamaka 的数据模型复刻所需机制，不复用其包。

工具插件不在这个范围内。它们是叶子工具，只消费会话的浅层形状，不依赖 agent-loop 语义。

工具容器与 adapter 投影路径不创建、不持有任何会话，只提供执行能力。

### 组件清单

| 组件 | 位置 | 职责 |
|------|------|------|
| `VirtualWebServer` | `@wopal/ellamaka-cordis` | 实现 dsh 官方 WebServer 接口，提供路由与 upgrade 分发，不创建监听 socket |
| 受控路由挂载点 | `Listener.mountNodeRoute` | 按前缀分发 HTTP 与 upgrade 到已注册 handler，保留 Effect listener 生命周期 |
| Ellamaka DSH Bridge | `@wopal/ellamaka-cordis` | 随 CLI 与 Desktop sidecar 编译发布，提供容器、虚拟 WebServer、运行时动态加载与 dsh boot 装配 |
| DSH Runtime Manager | `@wopal/ellamaka-cordis/runtime` | 所有入口共用的启动入口，负责禁用判断、闭包物化、完整性校验、动态加载与容器挂载 |
| DSH Plugin Manager | `@wopal/ellamaka-cordis/plugins` | 插件供应链：安装区管理、依赖解析、热挂载与 profile 声明同步 |
| wopal 插件包 | `@wopal/dsh-wopal-pack` | 配置单与自定义能力随包发布 |
| DSH 运行时清单 | ellamaka 构建产物 | 构建时从 `packages/ellamaka-cordis/package.json` 派生并锁定 dsh 官方依赖 |
| dsh 引擎装配 | `@wopal/ellamaka-cordis/dsh-web` | 通过 installAnchor 从物化闭包加载官方运行时，重放 boot 序列，构造两个容器 |
| dsh-adapter | `.wopal/plugins/dsh-adapter` | 把工具容器中的工具投影进 ellamaka ToolRegistry |

依赖方向单一：ellamaka 依赖 Bridge，Bridge 依赖 dsh 运行时。dsh 不依赖 Bridge，Bridge 不发布为独立包。

### 单端口分发

dsh 的 Web 路由与 ellamaka 原生路由共用 ellamaka 的监听端口：

1. ellamaka Server 提供受控 Node 路由挂载点，保存前缀与 HTTP/upgrade handler。
2. `VirtualWebServer` 持有 dsh 官方插件注册的路由与 upgrade socket，暴露分发能力。
3. `mountDshWeb` 返回的 webServer 经 `Listener.mountNodeRoute({ prefix: "/dsh", ... })` 挂到主 listener。
4. 主服务器剥离 `/dsh` 前缀后，`VirtualWebServer` 看到的是官方 `/api`、`/plugins` 原始路径。

调用方获得 register 与 dispose 能力，不获得原始 `node:http.Server`。upgrade socket 由 `VirtualWebServer` 持有，在 host dispose 与主 listener 停止时销毁，补足 Node `closeAllConnections()` 不覆盖 WebSocket 的行为。

`/dsh` 保持前缀挂载而不升根。这让 dsh 成为前缀自治的独立表面：它内部硬编码的 `/api` 与引擎自己的 API 命名空间不冲突，桌面壳的代理判据与认证的信任域边界都以这个前缀为准。

### 浏览器前缀适配

dsh 前端在隔离 iframe 内加载。`VirtualWebServer` 在 index 注入链末尾注入适配脚本，把 dsh 浏览器的传输映射到 `/dsh/*`：

- `fetch`（字符串、`Request`、`URL` 对象）、`WebSocket`、`EventSource`
- `document.createElement("script")` 动态加载的插件 bundle
- 覆盖相对路径与同源绝对 URL；外部 URL 与已带 `/dsh` 的 URL 保持不变

静态资源使用文档相对路径（`./assets/*`），官方靠注入 `<base href="/">` 锚定根。index 变换把根绝对与相对 URL 一并绝对化到 `/dsh` 前缀，免疫 base 标签逃逸，并移除 iframe 不需要的 PWA manifest 链接。

### 浏览器认证

dsh 的 Web 面使用官方 `browser-auth`。进程持有启动令牌，浏览器首次访问 index 必须携带令牌换取一张绑定授权的签名 cookie（HttpOnly、Path=/、SameSite=Strict、默认 30 天）。`/api` 通道叠加主机与来源信任校验（403）和 cookie 认证（401）两层栅栏，静态资源公开。

集成使用官方代码，不自造会话机制：

- **认证入口**：`mountDshWeb` 从官方 connection 服务现算认证路径（`/dsh/?token=...`），令牌不持久化。
- **出站跳转改写**：官方令牌交换的 303 响应把 location 写死为 `/`。`VirtualWebServer` 对跳转响应的 Location 头做前缀改写，使 iframe 登录不跳出挂载点。
- **下发通道**：serve 端把入口地址发布到模块级单槽，经 `GET /workbench/dsh-url` 由已认证的 workbench API 现答。令牌只经 ellamaka 的已认证面下发。
- **前端消费**：`DshSurface` 经 SDK 取地址，来源与活跃 server 一致才采用，否则回落 `<server>/dsh/` 派生。同源判定把回环别名归一化（localhost、127.0.0.1、[::1] 同主机同端口视为同源）。
- **开发拓扑**：cookie 是 SameSite=Strict，Vite 开发端口到后端端口的跨站 iframe 带不上 cookie。开发配置把 `/dsh` 代理到后端，使 iframe 与 cookie 同源。代理同时把 Origin 头对齐目标来源，因为官方信任栅栏要求 Origin 与 Host 一致。

### 认证的双信任域

ellamaka 的基础认证与 dsh 的 browser-auth 各守各的门。基础认证守外层，即令牌的分发面；cookie 守内层，即 dsh 自己的 `/api` 通道与 index。

iframe 内运行的是 dsh 自己的前端代码，它的请求不携带 ellamaka 前端的认证凭证，因此内层必须有一张 dsh 自己认可的凭证。用户感知上是统一的：一次外层登录，令牌与 cookie 在后台流转。

这个边界由四项机制固化：

- **信任跟随跨域决策**：dsh 的主机信任列表从宿主跨域信任决策派生（服务器跨域配置与命令行参数合并后的来源列表），经 profile 补丁层注入。非回环主机必须命中该列表。默认空列表的行为不变，只信任回环地址。认证机制本身仍归官方实现。
- **iframe 失效自愈**：前端探测 iframe 内的 401 响应，命中即重取入口地址并重载，令牌地址重载即重新换取 cookie。
- **挂载认证显式声明**：路由挂载点强制声明认证策略（自带完整认证或明确公开），不允许默认无认证。
- **升级与请求共享认证路径**：WebSocket 握手与 `/api` 请求经同一道认证，由官方实现守卫，宿主不设独立认证。

### 桥接 API 规范

从异步侧调用回 Effect 世界的桥接遵守以下形态：

1. **持有 work fiber 必须用 `Effect.forkIn(scope)(work)`**：在 `Effect.scoped` 内取 scope，`forkIn(scope)` 直接返回持有的 fiber。中断经 `runtime.runFork(Fiber.interrupt(fiber))`。禁止用 `runPromise` 驱动长任务。
2. **顶层 `Effect.runFork` / `runPromise` / `runCallback` 在运行时未导出**，一律经 `ManagedRuntime` 实例方法调用。
3. **`Effect.scope` 必须在 `Effect.scoped` 内获取**，否则以空缺陷终止。
4. **异步本地存储上下文**：effect 体内发起的桥接调用沿传播链天然继承实例上下文；纯异步侧发起的轮次需要捕获与恢复。
5. **取消语义**：中断后清理函数按子先父后顺序确定性执行，`forkIn(scope)` 的并发子任务级联清理。容器入口只启动，不拥有中断权。

### 生成 SDK 的双文件一致性

生成客户端由两个文件共同决定一个字段的线上行为：类型层与运行时的参数映射层。

**类型存在不等于运行时会发送**。接口新增字段后如果只重新生成类型，或生成中断留下半新状态，运行时的映射层缺少对应键会让客户端在编码时静默丢弃该字段，没有报错也没有日志。

验收方式是对新增字段在两个文件中都能检索到，或全量重新生成后比对差异。

### 权限规则的合并顺序

权限评估是最后匹配者生效，规则表顺序等于 frontmatter 声明顺序经合并后的位置。

同一个 agent 的配置可以来自多份副本（`$WOPAL_HOME` 与空间 `.wopal`），按加载顺序深度合并。后加载副本的键保留其声明位置，一条显式的收窄规则可能被先声明但合并后靠后的通配规则压过，静默放行。

需要收窄通配的显式规则必须保证在合并后的规则表中位于通配之后。最稳妥的写法是 frontmatter 不声明通配，只写显式例外，引擎默认值已经提供通配兜底。

验收方式是查询活实例的 agent 定义，确认显式规则位于相关通配之后。

### 与其他设计的关系

- 文件领地、依赖闭包、物化与热加载机制见 [DESIGN-dsh-base.md](./DESIGN-dsh-base.md)。
- 工具容器的装配、工具投影与沙箱策略见 [DESIGN-ellamaka-tools.md](./DESIGN-ellamaka-tools.md)。
- Web profile 的插件供应链、插件包与界面承载见 [DESIGN-dsh-web.md](./DESIGN-dsh-web.md)。

## Web UI 与 ellamaka-app

### 定位

WopalSpace 需要 Web UI 作为 TUI 之外的第二种用户界面。`ellamaka-app`（`packages/ellamaka-app/`）是该形态的官方实现，从上游 `packages/app` 独立复制而来，承载三栏 IDE 工作台、多空间并行与 TUI+Chat 融合的产品形态。

### 架构决策

`ellamaka-app` 通过复制上游 `packages/app` 获得，而非在既有原型上迭代。这一选择让定制代码与上游解耦：它复用现有基础设施（core/sdk/ui/i18n/terminal/theme），Web UI 形态随 ellamaka 独立演进。

### 详细规约

Workbench 的具体界面、视图模型、目录架构、能力迁移规约以及与 `wopal-cli` 的协同见 [DESIGN-workbench.md](./DESIGN-workbench.md)。需要参考上游 UI 代码时，从 `labs/ref-repos/opencode/packages/app` 读取。

---

## Related Documents

| 文档                              | 引用目的                                                 |
| --------------------------------- | -------------------------------------------------------- |
| `../../wopal-cli/docs/DESIGN.md`  | wopal-cli 如何消费 ellamaka release                      |
| `packages/opencode/AGENTS.md`     | engine package 内部规则                                  |
| `packages/ellamaka-app/AGENTS.md` | ellamaka 官方 web UI 包级开发规则                        |

## Scheduled Plan Execution

界面结构、空间级工作区切换、审批与排期交互由 [DESIGN-plan-scheduler.md](./DESIGN-plan-scheduler.md) 定义；HTTP 路径、数据与错误契约由 [API-CONTRACT.md](./API-CONTRACT.md#plan-scheduler-api-proposal) 定义。Workbench 壳负责承载，调度领域状态由 CLI 提供。

Ellamaka 实现 Wopal CLI 定义的 Runner Port：版本协商、幂等执行身份、非交互 Session、结构化事件/结果、查询、取消与完整工具进程树收尾。CLI 拥有可审阅的 DAG JSON、时间、运行态 JSON claim，ontology Provider 拥有审批和实际实施准备；runtime 承接已批准 revision 与验证过的环境。

调度 profile 在普通配置合并后施加不可放宽的权限上限。它允许正常编辑、网络、构建和测试，保护 Git 管理元数据、权威 Plan 与审批/调度写权限，阻止 Agent 自行提交、合并或推进人工生命周期。工具代理/隔离覆盖间接 shell 与子进程路径，提示词不能替代强制执行。

Workbench 经 Runtime Integration API 使用同一 CLI 能力，提供审批后停止、DAG 确认、cron/时区、阻塞诊断、运行历史和人工接管；Desktop/Web 共享行为。跨项目协议遵循 [Plan Orchestration](../../../docs/products/wopal-space/DESIGN-plan-orchestration.md)，交互遵循 [Scheduler UI](../../../docs/products/wopal-space/DESIGN-plan-scheduler-ui.md)。
