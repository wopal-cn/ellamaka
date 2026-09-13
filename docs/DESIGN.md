# Ellamaka

> **状态**: Active
> **更新时间**: 2026-09-13
> **上级架构**: `../../../docs/products/wopal-space/DESIGN.md`
> **子设计**:
>
> - `./DESIGN-desktop.md` — 官方桌面应用架构
> - `./DESIGN-distribution.md` — 分发与版本身份唯一真相源
> - `./DESIGN-ellamaka-dsh.md` — ellamaka 与 dsh 融合架构
> - `./DESIGN-onboarding.md` — Desktop onboarding 目标实现
> - `./DESIGN-workbench.md` — Workbench 工作台设计
> **配套文档**:
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
| 运行时重载                | 单元化 ReloadController 与两级重载协议                                                            | [Unified Reload & Lifecycle](#unified-reload--lifecycle) |
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
| `CHANNEL_RELEASE` | `latest`   | 发布渠道标识                                             |
| `CHANNEL_DEV`     | `main`     | 本地开发渠道标识                                         |
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
| Environment override | `OPENCODE_CONFIG_CONTENT`                                |

权限合并同此优先链，按最后匹配项生效。非 WopalSpace 模式的配置文件入口迁移至 `$WOPAL_HOME/config/settings.jsonc`，不加载 opencode XDG 全局配置；agents、commands、plugins、skills 与外部技能继续遵循 OpenCode-compatible capability loading，并由 `$WOPAL_HOME` 提供 Ellamaka 全局覆盖层。

空间配置分为公开与私有两层：`config/settings.jsonc` 随 ontology 提交分发，承载公共默认值；`config/settings.local.jsonc` 为用户私有覆盖，不提交。两层通过 `mergeDeep` 合并，后者优先。

非 WopalSpace 模式下，能力扫描在 OpenCode 生态目录（`.opencode/`、`~/.opencode/`、`~/.config/opencode/`）之后叠加 `$WOPAL_HOME/` 全局能力，后者最后加载并覆盖同名能力。`$WOPAL_HOME/config/` 是纯配置目录，不参与能力扫描。

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

DSH 容器装配与融合细则见 [DESIGN-ellamaka-dsh.md](./DESIGN-ellamaka-dsh.md)。

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
