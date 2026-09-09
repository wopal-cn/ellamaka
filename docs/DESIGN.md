# Ellamaka

> **状态**: Active
> **更新时间**: 2026-09-08
> **上级架构**: `../../../docs/products/wopal-space/DESIGN-wopalspace.md`

## 1. Role

ellamaka 是 OpenCode fork，WopalSpace 的执行引擎。它同时承载非 WopalSpace 与 WopalSpace 两种运行模式，负责配置加载、capability composition、ontology 运行时物化、plugin 执行与权限系统。

不负责：空间初始化、ontology 内容设计、空间运行态维护——这些归属 wopal-cli、Space Ontology 和 `.wopal-space/`。

### 1.1 设计文档关系

| 文档                    | 职责                                                                  | 关系                                       |
| ----------------------- | --------------------------------------------------------------------- | ------------------------------------------ |
| **BRANDING.md**         | 品牌化定制真相源：逐文件、逐行、逐模式记录所有上游注入变更            | 定制实现细节的唯一权威；本文件不重复其内容 |
| **DESIGN.md**（本文件） | 架构概览：适配点总表、配置契约、ontology 加载契约、状态归属           | 描述"是什么"和"有什么"，不描述"怎么改"     |
| **DISTRIBUTION.md**     | 发布/分发设计：产品 SemVer、OpenCode upstream、build identity、兼容选择、workflow、artifact contract、安装路径、R2 CDN | 版本身份与分发唯一真相源               |

定制实现细节（哪些文件改了、用什么模式注入、改动行数）一律见 **BRANDING.md**，本文件仅保留适配点索引和节号引用。

## 2. WopalSpace Adaptations

ellamaka 继承上游 OpenCode 全部 agent runtime、TUI/Web、session、tool、plugin 能力。WopalSpace 适配通过以下最小 fork delta 实现。详细注入模式、改动行数和具体代码见 **BRANDING.md**。

| 适配点                    | 概要                                                                                              | BRANDING.md 节号  |
| ------------------------- | ------------------------------------------------------------------------------------------------- | ----------------- |
| WopalSpace 自动检测       | CLI 从 cwd 检测单一空间；sidecar 按 instance directory 解析独立空间根                             | §5                |
| 全局路径分离              | `$WOPAL_HOME/config` + `$WOPAL_HOME/ellamaka/{data,cache,state}`                                  | §5                |
| 非 WopalSpace 模式        | 配置入口迁移至 WOPAL_HOME；capability loading 保持 OpenCode-compatible 并叠加 WOPAL_HOME 全局能力 | §6.2              |
| WopalSpace 模式           | 从 instance space root 加载 `.wopal/` 配置和能力；空间根与任意子目录共享同一 context              | §6.1              |
| Instance 运行模式         | 按 directory 检测空间根；server 不使用进程 env 表达当前空间                                       | §8                |
| Agent/Command/Plugin 加载 | 从 `.wopal/` 加载同名可覆盖内置                                                                   | §2, §5.1          |
| 权限合并                  | defaults → global → space settings → agent frontmatter                                            | §3（本文件）      |
| 引擎安装识别              | 识别 `$WOPAL_HOME/bin/` 安装路径                                                                  | §4.8              |
| Skill 加载                | base/user 并发解析，space overlay 按序覆盖                                                        | —                 |
| Branding & build          | BINARY_NAME、构建包装、CLI 品牌常量                                                               | §2–§4             |
| TUI 空间配置              | `settings.jsonc` 的 `tui` 字段和主题目录                                                          | §4.7              |
| Web UI 产品化             | Fork 上游 `packages/app` 为 `packages/ellamaka-app`，作为官方 Web 工作台形态                  | §9（本文件），§15 |
| Runtime API 与 SDK        | Effect HttpApi schema → OpenAPI → 生成 SDK；Wopal CLI adapter 将空间控制能力映射为 Runtime API    | §7.1（本文件）    |

上游文件改动遵循：新文件优先、提前返回 guard、回调注入、禁止格式化重排。完整策略和合并保护文件清单见 **BRANDING.md §12**。

## 2.1 品牌与构建包结构

ellamaka 的品牌身份与构建发布分属两个包，沿运行时/构建期边界划分：

| 包 | 职责 | 消费方 |
|---|---|---|
| `@wopal/ellamaka-brand`（`packages/ellamaka-brand/`） | 品牌真相源：branding 常量（BINARY_NAME、BINARY_TITLE、channel 常量、UI_UPSTREAM_URL）、logo/wordmark、TUI tips、WopalSpace 目录检测 | opencode 运行时（全部走包路径 import）；`ellamaka-release` 构建期（读 BINARY_NAME/CHANNEL_RELEASE） |
| `@wopal/ellamaka-release`（`packages/ellamaka-release/`） | 构建与发布唯一枢纽：构建编排（`src/cli/build.ts`）、构建期版本/渠道解析（`src/build-env.ts`）、发布身份模型（`src/identity.ts`）、构建目标矩阵、release context、manifest、gitee、cleanup、inventory、upstream lock | 构建脚本与 CI workflow；`opencode` 的 release-info 命令运行时读取 identity 模型 |

边界纪律：

- 运行时（opencode）只依赖 `ellamaka-brand`；对 `ellamaka-release` 的唯一运行时依赖是 `identity` 模型（`ellamaka debug release-info`），该模型是构建期与运行期共享的纯数据契约，位于 release 包是因为它的 schema 与 manifest/构建流水线同源演进。
- `ellamaka-release` 不被任何运行时热路径引用；它依赖 `ellamaka-brand`（构建期读品牌常量），方向单一，无环。
- 品牌常量消费一律走包路径 `@wopal/ellamaka-brand/branding` 等导出，禁止相对路径跨包引用。

历史上本结构由三个包承载（`packages/ellamaka`/`@wopal/ellamaka-build`、`@wopal/ellamaka-script`、`@wopal/ellamaka-release`），2026-09-01 收编定案：`ellamaka-build` 更名 `ellamaka-brand`，`ellamaka-script` 的 `Script` 收编为 `ellamaka-release` 的 `build-env` 模块。

## 3. Configuration Contract

Ellamaka 运行时包含两种模式：

- **非 WopalSpace**：当前 instance 没有 `wopalSpaceRoot`。配置入口由 WOPAL_HOME 所有，capability loading 保持 OpenCode-compatible 的目录发现和覆盖机制，并在末层叠加 WOPAL_HOME 全局能力。
- **WopalSpace**：当前 instance 的 `wopalSpaceRoot` 是空间根。当前 directory 可以是空间根或其任意子目录，配置和能力始终从这个根加载。

WopalSpace 模式下配置加载优先级（低→高）：

| 层级                 | 来源                                                     |
| -------------------- | -------------------------------------------------------- |
| Built-in defaults    | ellamaka 内置                                            |
| Global config        | `$WOPAL_HOME/config/settings.jsonc`                      |
| Space settings       | `<space>/.wopal/config/settings.jsonc` → `ellamaka` 字段 |
| Agent frontmatter    | `<space>/.wopal/agents/*.md`                             |
| Environment override | `OPENCODE_CONFIG_CONTENT`                                |

权限合并同此优先链，按最后匹配项生效。非 WopalSpace 模式的配置文件入口迁移至 `$WOPAL_HOME/config/settings.jsonc`，不加载 opencode XDG 全局配置；agents、commands、plugins、skills 与外部技能继续遵循 OpenCode-compatible capability loading，并由 `$WOPAL_HOME` 提供 Ellamaka 全局覆盖层。

## 4. Ontology Loading Contract

| 加载面   | 来源                                             | 行为                                           |
| -------- | ------------------------------------------------ | ---------------------------------------------- |
| Commands | `.wopal/commands/`                               | 可覆盖内置命令                                 |
| Agents   | `.wopal/agents/`                                 | Markdown 定义 agent 身份与 frontmatter         |
| Plugins  | `.wopal/plugins/`                                | 向 runtime 暴露 plugin tools                   |
| Settings | `.wopal/config/settings.jsonc`                   | `ellamaka` 字段配置 engine，`tui` 字段配置 TUI |
| Skills   | `$WOPAL_HOME/skills/` → `<space>/.wopal/skills/` | 并发解析 + 按序合并，右侧优先                  |

## 5. Upstream Merge Boundary

> **状态**: 已放弃跟踪上游（2026-08-31 起）。ellamaka 不再从 `upstream/dev` 合并 OpenCode 变更，`dev` 分支不再作为上游跟踪线。以下历史机制仅作记录，不再执行。

| 规则     | 说明                                                                                  |
| -------- | ------------------------------------------------------------------------------------- |
| 分支     | `main` = 定制稳定线；`dev` = 不再跟踪 upstream/dev                                    |
| 合并方向 | 无（已放弃上游合并）                                                                  |
| 参考来源 | 后续如需参考 OpenCode 模块代码，从 `labs/ref-repos/opencode/` 读取对应模块            |

详细合并流程、合并保护文件清单、定制代码最小侵入原则、冲突热点和验证清单见 **BRANDING.md §12**。

## 6. Distribution

Ellamaka CLI 构建为多平台 standalone binary，Desktop 构建为原生安装包。两者分别使用标准 SemVer、namespaced tag、workflow 和 latest feed。Desktop 与 CLI 是同一产品的两种形态，运行时版本保证为 wopal-cli `>= MIN_WOPAL_CLI_VERSION` 与 CLI 主版本 `vX.Y` 与 Desktop 一致。`wopal ellamaka install` 默认安装完整产品，`--cli` 只安装外部 CLI。

构建入口：CI 中 `publish-ellamaka-cli.yml` 调用 `scripts/build.sh cli`（内部走 `packages/ellamaka-release/src/cli/build.ts`）并注入 env；本地开发使用 `packages/ellamaka-release/src/cli/build.ts` 包装脚本。

onboarding 将 ontology base capabilities 物化到 `WOPAL_HOME` 后，ellamaka 按现有 user/base + space overlay 链路加载。外部 CLI 的安装收据位于 `$WOPAL_HOME/ellamaka/state/`，`bin/` 只保存 executable。

详细 artifact contract 见 `docs/DISTRIBUTION.md`。

## 7. State Ownership

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

### 7.1 Runtime API 与 SDK 契约

Ellamaka 的 HTTP API 是 Workbench 和外部集成使用运行时能力的唯一网络表面。领域 schema 同时驱动 Effect HttpApi 路由、运行时校验、OpenAPI 和生成 SDK。Root API 承载全局控制能力，Instance API 承载工作目录相关运行时能力。

Workbench Session Projection 是左侧会话列表的服务端只读模型，只返回 `time_archived IS NULL` 且 `parent_id IS NULL` 的 Session。归档会话和子会话不属于可直接装载的根会话资源。

Wopal CLI adapter 作为 Runtime 的领域服务使用 `wopal ... --api-version` capability。它维护非权威空间快照，并将稳定的 CLI 结果映射为 Ellamaka 领域资源和错误。adapter 位于 sidecar 内，直接 spawn wopal 进程；wopal 调用是无状态进程边界，不引入专门的常驻 worker。消费侧 schema 从 wopal 共享契约包导入，与 wopal 的 TypeBox 契约同源。浏览器只使用 Ellamaka API。

`CliContract` 将 CLI 安装状态与能力调用分开处理。`/global/health` 公开最低版本、已检测版本与兼容状态。CLI 不可用时，Ellamaka 保持 Session Runtime，Workbench 将 Space Control 降级为可恢复状态。用户确认修复后，Runtime 使用已安装 CLI 的更新命令或第一方 installer 修复二进制，并重新探测状态；sidecar 与已有 Workbench 现场继续运行。

完整的路径语义、schema、错误、版本、SDK 生成和端点门禁见 [API-CONTRACT.md](./API-CONTRACT.md)。

### 7.2 Sidecar Instance Context

一个 sidecar 同时服务多个 directory instance。配置加载和插件创建从当前 directory 直接检测可选的 `wopalSpaceRoot`。空间根与空间内任意子目录得到同一个 root；非 WopalSpace instance 不继承其他空间状态。

PluginInput 通过可选 `wopalSpaceRoot` 字段接收当前 instance 的空间根。字段缺失表示非 WopalSpace。插件使用该字段定位空间级资源，普通 Engine 运行时保持上游环境与子进程行为。

`WOPAL_HOME` 是 sidecar 的进程级安装根。它拥有全局配置、全局能力和运行时存储。`WOPAL_SPACE` 与 `WOPAL_SPACE_ROOT` 只服务单目录 CLI 兼容边界，不承担 server request routing 或 plugin context 所有权。


## 8. Unified Reload & Lifecycle

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

## 9. Web UI 与 ellamaka-app

### 9.1 定位

WopalSpace 需要 Web UI 作为 TUI 之外的第二种用户界面。`ellamaka-app`（`packages/ellamaka-app/`）是该形态的官方实现，fork 自上游 `packages/app`，以正式技术栈承载三栏 IDE 工作台、多空间并行与 TUI+Chat 融合的产品形态。

### 9.2 架构决策

`ellamaka-app` 通过 fork 上游 `packages/app` 获得，而非在既有原型上迭代。这一选择让定制代码与上游解耦：它复用现有基础设施（core/sdk/ui/i18n/terminal/theme），Web UI 形态随 ellamaka 独立演进，不受上游 `packages/app` 更新节奏约束。

### 9.3 详细规约

关于 `ellamaka-app` 工作台（Workbench）的具体界面、视图模型（TUI/Chat/Split 面板模型）、详细目录架构、能力迁移规约以及与 `wopal-cli` 的协同，请参阅独立的详细设计规范文档：

- 中文版：[WORKBENCH.md](file:///Volumes/U500G/coding/wopal-workspace/projects/ellamaka/docs/WORKBENCH.md)

> 上游 `packages/app` 已放弃跟踪（见 §5），`ellamaka-app` 独立演进。后续如需参考上游 UI 代码，从 `labs/ref-repos/opencode/packages/app` 读取。

---

## 10. Related Documents

| 文档                              | 引用目的                                                       |
| --------------------------------- | -------------------------------------------------------------- |
| `./BRANDING.md`                   | 品牌化定制唯一真相源—                                          |
| `./API-CONTRACT.md`               | Runtime API、OpenAPI、生成 SDK 与 Wopal CLI adapter 契约       |
| `./WORKBENCH.md`                  | ellamaka 自定义工作台 app 设计                                 |
| `./DESIGN-ellamaka-dsh.md`            | ellamaka 与 dsh 融合架构（DSH 容器装配、插件供应链、Bun 宿主 HMR） |
| `./DISTRIBUTION.md`               | 产品 SemVer、OpenCode upstream、构建身份、兼容选择、release、artifact、安装契约 |
| `../../wopal-cli/docs/DESIGN.md`  | wopal-cli 如何消费 ellamaka release                            |
| `packages/opencode/AGENTS.md`     | engine package 内部规则                                        |
| `packages/ellamaka-app/AGENTS.md` | ellamaka 官方 web UI 包级开发规则                              |
