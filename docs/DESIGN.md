# Ellamaka

> **Status**: Active
> **Updated**: 2026-10-14
> **Parent Architecture**: `../../../docs/products/wopal-space/DESIGN.md`
> **Sub-DESIGNs**:
>
> - `./DESIGN-auth.md` — Draft，阶段 3 Host/DSH 认证统一方向，不属本轮实施范围
> - `./DESIGN-config-engine.md` — Draft，阶段 3 配置编辑设计，不属本轮实施范围
> - `./DESIGN-wopalspace.md` — private `@wopal/wopalspace` application capabilities、API、领域逻辑与 Core integration boundary
> - `./DESIGN-desktop.md` — 官方桌面应用架构
> - `./DESIGN-distribution.md` — 分发与版本身份唯一真相源
> - `./DESIGN-dsh-base.md` — dsh 融合基础：文件领地、依赖闭包、热加载
> - `./DESIGN-dsh-web.md` — Web profile：插件供应链与当前 iframe 承载
> - `./DESIGN-dsh-custumize.md` — Proposed，空间皮肤/独立 DSH 标签/实验 profile，后续细化，不属本轮实施
> - `./DESIGN-ellamaka-sdk.md` — 统一公开 SDK、OpenAPI 3.1、HTTP 与本机 Worker transport
> - `./DESIGN-ellamaka-tools.md` — 工具容器 profile：能力采用与沙箱
> - `./DESIGN-logging.md` — 日志架构：角色分域路由、文件生命周期、Trace 与脱敏策略
> - `./DESIGN-onboarding.md` — WopalSpace Setup/Onboarding 在 Ellamaka Server host 上的集成
> - `./DESIGN-plan-scheduler.md` — Proposed，阶段 4 可选调度设计，不属本轮实施范围
> - `./DESIGN-workbench.md` — Workbench 工作台设计

## Role

ellamaka 是 OpenCode fork，是 WopalSpace 的底层执行引擎、Server host 与官方 GUI host。它拥有 Core/DSH、Agent、Session、PTY、Tool 和 Runtime 配置语义；private `@wopal/wopalspace` 拥有 Setup、Ontology、Space application 业务；`@wopal/ellamaka-app` 拥有官方 Onboarding/Workbench 产品体验及其 App BFF。Product 安装/update、Evolution、Skill Lifecycle 与 Plan Scheduling 继续由 Wopal CLI 拥有。

领域依赖方向固定为 **WopalSpace → Ellamaka**：`ellamaka-core`、Session、Agent、PTY、Tool 等底层 Runtime domain 不反向 import WopalSpace。Server composition root 可以同时挂载 Public Platform API 与 Official App BFF；App BFF 可以组合 Runtime 和 private WopalSpace facts，但不改变底层 domain 的依赖方向。

对外只发布一个 platform service SDK：`@wopal/ellamaka-sdk`。它只承载可复用的 Runtime 与 WopalSpace public contract。官方 App 的 BFF contract 由 `@wopal/ellamaka-app` 私有拥有，不进入公开 SDK 或其 SemVer。

## Unified Capability Architecture

```text
                    Ellamaka Server host
                           │
          ┌────────────────┴────────────────┐
          │                                 │
          ▼                                 ▼
 Public Platform API                 Official App BFF
          │                                 │
   ┌──────┴──────┐                  @wopal/ellamaka-app
   ▼             ▼                    private client
Runtime     private @wopal/wopalspace
Session     Setup / Ontology / Space
Agent
PTY
Tool

Public Platform API -> @wopal/ellamaka-sdk -> third-party / Browser / Desktop
Wopal CLI Ontology/Space -> @wopal/ellamaka-sdk/local -> Worker -> app.fetch(Request)
Official App BFF -> ellamaka-app internal generated client only
```

- `@wopal/ellamaka-sdk` 只从 Public Platform HttpApi/OpenAPI 生成一个公开 client model。
- Browser/Desktop 对通用 Runtime/WopalSpace 能力使用公开 SDK；官方 Onboarding/Workbench 的跨领域投影和产品专用 use case 使用 `ellamaka-app` 私有 BFF client。
- Official App BFF 与 Public Platform API 可以挂在同一个 Server/端口，但两者拥有独立 contract publication boundary。
- private `@wopal/wopalspace` 不发布；Server composition 直接调用它，local SDK artifact 在构建时组装所需 private implementation。
- GUI Onboarding 与 Workbench 都位于 `@wopal/ellamaka-app`：前者是配置阶段，后者是运行阶段；Setup 业务归 private WopalSpace，Workbench 的产品投影/跨领域用例归 App BFF。
- Product 安装/update 不迁入 WopalSpace；Onboarding/Setup 不再安装 Wopal CLI、Ellamaka CLI 或 Desktop。
- Core Preparation 按实际运行的产品/build 准备运行资源；`wopal setup` 只负责启动/reuse `ellamaka serve` 并打开 Web Onboarding。
- Space plugin dependencies 在 `.wopal` 物化后立即准备，并由 Runtime instance activation 保留 fallback。
- `ellamaka-cordis` 继续拥有 DSH closure/Home/profile 与 container activation mechanics。

基础 Runtime 与 WopalSpace application 不调用 Wopal CLI subprocess。Wopal CLI 对基础 Ontology/Space 操作消费统一 SDK，同时直接实现 Product/Evolution/Skill/Plan 自有领域；Evolution 完整流程在 CLI 本机执行。

## WopalSpace Adaptations

ellamaka 继承上游 OpenCode 全部 agent runtime、TUI/Web、session、tool、plugin 能力。下表是 ellamaka 全部定制点的完整索引，每项指向其权威设计文档章节。

| 适配点                               | 概要                                                                                                                                                                                                          | 详见                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| WopalSpace 自动检测                  | CLI 从 cwd 检测单一空间；sidecar 按 instance directory 解析独立空间根                                                                                                                                         | [Space Detection Contract](#space-detection-contract)                                             |
| 全局路径分离                         | `$WOPAL_HOME/config` + `$WOPAL_HOME/ellamaka/{data,cache,state}`                                                                                                                                              | [State Ownership](#state-ownership)                                                               |
| 日志路由                             | 角色分域：serve / sidecar 恒落 `$WOPAL_HOME/logs`，tui 在空间内落 `.wopal-space/logs`（与 CLI 空间路由同语义）                                                                                                | [Logging Architecture](./DESIGN-logging.md)                                                       |
| 非 WopalSpace 模式                   | 配置入口由 WOPAL_HOME 所有；capability loading 保持 OpenCode-compatible 并叠加 WOPAL_HOME 全局能力                                                                                                            | [Configuration Contract](#configuration-contract)                                                 |
| WopalSpace 模式                      | 从 instance space root 加载 `.wopal/` 配置和能力；空间根与任意子目录共享同一 context                                                                                                                          | [Configuration Contract](#configuration-contract)                                                 |
| Instance 运行模式                    | 按 directory 检测空间根；server 不使用进程 env 表达当前空间                                                                                                                                                   | [Sidecar Instance Context](#sidecar-instance-context)                                             |
| Agent/Command/Plugin 加载            | 从 `.wopal/` 加载同名可覆盖内置                                                                                                                                                                               | [Ontology Loading Contract](#ontology-loading-contract)                                           |
| 权限合并                             | defaults → global → space settings → agent frontmatter                                                                                                                                                        | [Configuration Contract](#configuration-contract)                                                 |
| 插件去重                             | 全局与空间 ontology 同 runtime id 插件按后加载者保留                                                                                                                                                          | [插件去重](#插件去重)                                                                             |
| Skill 加载                           | base/user 并发解析，space overlay 按序覆盖                                                                                                                                                                    | [Ontology Loading Contract](#ontology-loading-contract)                                           |
| TUI 配置与 `/help`                   | `settings.jsonc` 的 `tui` 字段；WopalSpace 模式 `/help` 由空间命令接管                                                                                                                                        | [TUI 配置加载](#tui-配置加载)                                                                     |
| 品牌身份                             | 品牌常量、CLI 身份、Logo、文件系统命名决策                                                                                                                                                                    | [品牌身份](#品牌身份)                                                                             |
| 构建与发布                           | 品牌注入、平台矩阵、构建接口                                                                                                                                                                                  | [Release Backbone](./DESIGN-distribution.md#release-backbone)                                     |
| Web UI 产品化                        | `packages/ellamaka-app` 作为官方 Web 工作台形态                                                                                                                                                               | [Web UI 与 ellamaka-app](#web-ui-与-ellamaka-app)、[DESIGN-workbench.md](./DESIGN-workbench.md)   |
| Runtime API 与 SDK                   | `@wopal/ellamaka-sdk` 是唯一公开 SDK；同一 OpenAPI/client 同时暴露 Runtime 与 WopalSpace API，HTTP 与 trusted-local Worker 只是不同 transport | [Runtime API 与 SDK 契约](#runtime-api-与-sdk-契约) |
| DSH 双引擎融合                       | 进程内运行 dsh 引擎，双容器共用单端口；工具能力经投影进入 ellamaka 工具管道                                                                                                                                   | [DSH 双引擎融合](#dsh-双引擎融合)                                                                 |
| Core Preparation                     | `@wopal/ellamaka-core` 按当前实际产品/build 或 Space instance 计算 readiness；哪个产品启动就准备哪个产品，不做跨产品 prewarm | [Core Readiness and Preparation](#core-readiness-and-preparation) |
| DSH Home、closure 备份与启动生命周期 | `$WOPAL_HOME/dsh/home` 永久固定；closure/Home/profile 由 Core Preparation 的 DSH steps 编排；`ELLAMAKA_DSH=0` 只跳过 DSH branch                                                                               | [Closure and Startup Lifecycle](./DESIGN-dsh-base.md#closure-and-startup-lifecycle)               |
| 运行时重载                           | 单元化 ReloadController 与两级重载协议                                                                                                                                                                        | [Unified Reload & Lifecycle](#unified-reload--lifecycle)                                          |
| 引擎配置消费                         | 三层配置读取、插件配置合并与整表交付；`config-v2` 读面由引擎直答，写入经共享配置服务                                                                                                                          | [Config Read Surface](#config-read-surface)、[DESIGN-config-engine.md](./DESIGN-config-engine.md) |
| 能力发现层                           | 发现层与运行时过滤层分离；GET `/skill`、`/rule`、`/tool` 返回完整列表，不碰权限过滤                                                                                                                           | [Capability Discovery Layer](#capability-discovery-layer)                                         |
| Session 能力边界                     | 保留静态 config/agent 权限与持久 session permission；可选 plugin runtime rules 只在单次 permission ask 前临时叠加，不改 run loop/Permission Service 持久状态                                                  | [Session Capability Contract](#session-capability-contract)                                       |
| Runtime Context Contribution         | 插件通过 messages.transform 在 retained history 尾部追加本次请求的临时上下文；动态 Skill catalog 等运行态信息不改 system/tool 前缀                                                                            | [Runtime Context Contribution](#runtime-context-contribution)                                     |
| 引擎安装识别                         | 识别 `$WOPAL_HOME/bin/` 安装路径                                                                                                                                                                              | [Install Contract](./DESIGN-distribution.md#install-contract)                                     |

定制逻辑以独立模块承载：新文件优先，上游文件只保留最小 import 与调用注入点。

## 品牌与构建包结构

ellamaka 的品牌身份与构建发布分属两个包，沿运行时/构建期边界划分：

| 包                                                        | 职责                                                                                                                                                                                                                   | 消费方                                                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `@wopal/ellamaka-brand`（`packages/ellamaka-brand/`）     | 品牌真相源：branding 常量（BINARY_NAME、BINARY_TITLE、channel 常量、UI_UPSTREAM_URL）、logo/wordmark、TUI tips、WopalSpace 目录检测                                                                                    | opencode 运行时（全部走包路径 import）；`ellamaka-release` 构建期（读 BINARY_NAME/CHANNEL_RELEASE） |
| `@wopal/ellamaka-release`（`packages/ellamaka-release/`） | 构建与发布唯一枢纽：构建编排（`src/cli/build.ts`）、构建期版本/渠道解析（`src/build-env.ts`）、发布身份模型（`src/identity.ts`）、构建目标矩阵、release context、manifest、gitee、cleanup、inventory、release identity | 构建脚本与 CI workflow；`opencode` 的 release-info 命令运行时读取 identity 模型                     |

边界纪律：

- 运行时（opencode）只依赖 `ellamaka-brand`；对 `ellamaka-release` 的唯一运行时依赖是 `identity` 模型（`ellamaka debug release-info`），该模型是构建期与运行期共享的纯数据契约，位于 release 包是因为它的 schema 与 manifest/构建流水线同源演进。
- `ellamaka-release` 不被任何运行时热路径引用；它依赖 `ellamaka-brand`（构建期读品牌常量），方向单一，无环。
- 品牌常量消费一律走包路径 `@wopal/ellamaka-brand/branding` 等导出，禁止相对路径跨包引用。

## 品牌身份

ellamaka 的全部用户可见身份由 `@wopal/ellamaka-brand` 集中定义，不在源码中硬编码品牌值。

### 品牌常量

| 常量              | 值         | 用途                                                    |
| ----------------- | ---------- | ------------------------------------------------------- |
| `BINARY_NAME`     | `ellamaka` | CLI 命令名、help 文本、错误前缀                         |
| `BINARY_TITLE`    | `Ellamaka` | 用户界面标题、sidebar 版本署名                          |
| `VERSION_PREFIX`  | `ellamaka` | 版本字符串前缀                                          |
| `CHANNEL_RELEASE` | `stable`   | 发布 build channel 标识（`latest` 仅为 R2 feed 别名）   |
| `CHANNEL_DEV`     | `main`     | 本地开发 build channel 标识                             |
| `UI_UPSTREAM_URL` | `null`     | 未内嵌 Web UI 时的在线代理目标域名；`null` 禁用反向代理 |

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

| 路径/名称                               | 说明                                                       |
| --------------------------------------- | ---------------------------------------------------------- |
| `ellamaka.db` / `ellamaka-{channel}.db` | 数据库文件名，位于 `$WOPAL_HOME/ellamaka/data/`            |
| `# ellamaka`                            | shell PATH 标记，写入 `.zshrc` / `.bashrc`，卸载时据此识别 |
| `ellamaka.local`                        | mDNS 默认域名，经 `BINARY_NAME` 注入                       |

以下路径保留 `opencode` 命名：`.opencode/`（OpenCode-compatible capability 扫描目录）、`opencode-clipboard.png`（运行时缓存）、`ProviderID.opencode`（内部 provider 标识）、`opencode.json` / `opencode.jsonc`（非 WopalSpace 模式的兼容读取入口）。

## Configuration Contract

Ellamaka 运行时包含两种模式：

- **非 WopalSpace**：当前 instance 没有 `wopalSpaceRoot`。配置入口由 WOPAL_HOME 所有，capability loading 保持 OpenCode-compatible 的目录发现和覆盖机制，并在末层叠加 WOPAL_HOME 全局能力。
- **WopalSpace**：当前 instance 的 `wopalSpaceRoot` 是空间根。当前 directory 可以是空间根或其任意子目录，配置和能力始终从这个根加载。

WopalSpace 模式下配置加载优先级（低→高）：

| 层级                 | 来源                                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| Built-in defaults    | ellamaka 内置                                                                 |
| Global config        | `$WOPAL_HOME/config/settings.jsonc`                                           |
| Space settings       | `<space>/.wopal/config/settings.jsonc` → `ellamaka` 段与 `wopal.pluginConfig` |
| Space local settings | `<space>/.wopal/config/settings.local.jsonc`（私有覆盖）                      |
| Agent frontmatter    | `<space>/.wopal/agents/*.md`                                                  |
| Environment override | `ELLAMAKA_CONFIG_CONTENT`                                                     |

普通会话权限按同一优先链合并，最后匹配者生效；调度会话还受 Scheduled Plan Execution 的 profile 上限约束。非 WopalSpace 模式只从 `$WOPAL_HOME/config/settings.jsonc` 读取全局产品配置，不读取 opencode XDG 全局配置；agents、commands、plugins、skills 与外部技能继续遵循 OpenCode-compatible 能力加载，并由 `$WOPAL_HOME` 提供最后一层全局覆盖。配置链环境变量统一使用 `ELLAMAKA_` 前缀，完整规则见 `../../../docs/products/wopal-space/DESIGN-config-settings.md`。

空间配置分为公开与私有两层：`config/settings.jsonc` 随 ontology 提交分发，承载公共默认值；`config/settings.local.jsonc` 为用户私有覆盖，不提交。两层通过 `mergeDeep` 合并，后者优先。

非 WopalSpace 模式下，能力扫描在 OpenCode 生态目录（`.opencode/`、`~/.opencode/`、`~/.config/opencode/`）之后叠加 `$WOPAL_HOME/` 全局能力，后者最后加载并覆盖同名能力。`$WOPAL_HOME/config/` 是纯配置目录，不参与能力扫描。

### Config Read Surface

Workbench 经引擎 HTTP 读面获取生效配置，供权限选择器等界面消费。读面由引擎从自己的加载状态直答，不经 CLI；既有 `/config` 端点维持运行时视图，不扩展。

```typescript
// 读——引擎直接从自己的加载状态回答，不走 CLI
HttpApiEndpoint.get("configGet", "/config-v2", {
  query: WorkspaceRoutingQuery,
  success: described(ConfigV2ReadResponse, "Effective configuration read surface"),
})
```

响应形状：

```jsonc
{
  "effective": {
    "ellamaka": {
      /* 实例合并后的引擎配置，与 /config 同源同值 */
    },
    "wopal": {
      "pluginConfig": {
        /* 三层合并后的插件行为配置表 */
      },
    },
  },
}
```

- 端点挂实例作用域中间件（Instance Context + Workspace Routing + Authorization），两种运行模式通用；非 WopalSpace 实例返回空段，响应形状不变。
- `effective.ellamaka` 与 `/config` 同源同值（`$VAR` 已在加载时代换）；`effective.wopal.pluginConfig` 为三层文件镜像，`$VAR` 不代换，引用解析发生在消费方插件内部。
- 权限选择器：显示条件为 dock 变体 + DSH `ready`（状态自 `/global/health`）+ 内置 dsh-adapter 生效 + `effective.wopal.pluginConfig["dsh-adapter"].sandbox.enabled === true`；默认模式取 `sandbox.mode`。
- 配置写入（`PATCH` / `reset-key` 调用共享服务）与设置面板的完整契约由 [DESIGN-config-engine.md](./DESIGN-config-engine.md) 承载。

### External Capability Directories

两个上游惯例目录的跨模式行为不同：

| 目录                          | 非 WopalSpace | WopalSpace | 依据                                  |
| ----------------------------- | ------------- | ---------- | ------------------------------------- |
| `.claude/`（含 `~/.claude/`） | 加载          | **不加载** | WopalSpace 模式为强制禁用触发条件之一 |
| `.agents/`（含 `~/.agents/`） | 加载          | **加载**   | 行业标准目录，所有模式常驻            |

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

| 运行边界         | 检测来源                               | 所有权                  |
| ---------------- | -------------------------------------- | ----------------------- |
| CLI 单目录       | `detectWopalSpace(process.cwd())`      | 当前 CLI 进程           |
| Server / sidecar | `detectWopalSpace(instance.directory)` | 当前 directory instance |
| Plugin           | `PluginInput.wopalSpaceRoot`           | 当前 plugin instance    |

- 从空间根或其任意子目录进入都得到同一个 `wopalSpaceRoot`。
- CLI 入口将检测结果映射为 `WOPAL_SPACE` / `WOPAL_SPACE_ROOT`，供同一 CLI 进程使用。这是单进程兼容边界，不表达 sidecar 的当前空间。
- Sidecar 不从父进程继承空间状态，也不在 instance 配置加载中修改进程级环境变量；entry 中间件先清除继承的空间变量再执行检测。
- `--disable-wopalspace` 关闭 CLI 检测入口，作为显式逃生舱。

## Ontology Loading Contract

| 加载面   | 来源                                             | 行为                                                   |
| -------- | ------------------------------------------------ | ------------------------------------------------------ |
| Commands | `.wopal/commands/`                               | 可覆盖内置命令                                         |
| Agents   | `.wopal/agents/`                                 | Markdown 定义 agent 身份与 frontmatter                 |
| Plugins  | `.wopal/plugins/`                                | 向 runtime 暴露 plugin tools                           |
| Settings | `.wopal/config/settings.jsonc`                   | `ellamaka` 字段配置 engine，`tui` 字段配置 TUI         |
| Skills   | `$WOPAL_HOME/skills/` → `<space>/.wopal/skills/` | 并发解析 + 按序合并，右侧优先                          |
| Rules    | `$WOPAL_HOME/rules/` → `<space>/.wopal/rules/`   | 目录扫描 `**/*.{md,mdc}`，空间层按相对路径覆盖全局同名 |

### TUI 配置加载

TUI 配置仅从 ellamaka 自身路径加载，不加载 `~/.config/opencode/tui.*`。全局 TUI 配置取自 `$WOPAL_HOME/config/settings.jsonc` 的 `tui` 字段；WopalSpace 模式下由 `<space>/.wopal/config/settings.jsonc` 的同名字段合并覆盖。主题扫描目录仅保留 `$WOPAL_HOME/config/`，跳过全部 `.opencode/` 目录。

WopalSpace 模式下 `/help` 由空间级 `commands/help.md` 接管，而非 TUI 内置 `DialogHelp`。ellamaka 的 TUI palette 命令（keymap 层）与服务端命令（`Command.Service`）是两套独立系统，`help.show` 的 `slashName` 在 WopalSpace 模式下置空，使 `/help` 落入服务端命令解析；其余 palette 命令不受影响。

### 插件去重

WopalSpace 模式下，`$WOPAL_HOME/`（全局 ontology）与 `<space>/.wopal/`（空间 ontology）可以包含同一插件，其文件路径不同但 runtime `id` 相同。按 file URL 去重无法识别这类重复，会导致插件被加载两次。

`deduplicateLoadedPluginsByRuntimeId()` 在插件模块加载完成后、执行 `server()` 之前按 runtime `id` 去重，同一 id 保留后加载（高优先级）的插件。去重发生在模块加载与执行之间的边界上，对 config 层零侵入。

## Capability Discovery Layer

引擎内部严格区分两个能力层次，两者读不同的方法，互不干扰：

| 层次         | 职责                      | 过滤权限                       | 代表方法                                                                                                                               |
| ------------ | ------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 发现层       | "引擎加载了什么"          | 否，返回完整列表               | `Skill.all()`、`ToolRegistry.capabilityEntries()`、`MCP.capabilityEntries()`、`Rule.all()`                                             |
| 运行时过滤层 | "这个 agent 这次能用什么" | 是，按 agent 权限与 model 过滤 | `Skill.available(agent, sessionPermission)`、`ToolRegistry.tools({ agent, sessionPermission, ...model })`、会话执行时 `permission.ask` |

系统提示词生成、工具清单构建、执行授权全部走运行时过滤层。

发现层通过 HTTP API 与 SDK 向外部消费者暴露完整能力列表，供 wopal-cli 的 `wopal space capability list` 命令查询空间武器库。发现层端点只返回武器元数据（名称、描述、来源、路径），不传递工具的执行方法：

| 端点         | 发现层方法                                                     | 返回内容                                                                                                                                                                           |
| ------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/skill` | `Skill.all()`                                                  | 全部已加载技能（name、description、location）                                                                                                                                      |
| GET `/rule`  | `Rule.all()`                                                   | 全部已发现规则（相对路径、description、keywords、agentScope）                                                                                                                      |
| GET `/tool`  | `ToolRegistry.capabilityEntries()` + `MCP.capabilityEntries()` | 全部注册工具（id、description、来源类型：builtin / custom / mcp），不含 execute；registry 侧保留 builtin / custom 来源标注，MCP 侧保留原始 service key 并输出与运行时一致的复合 id |

发现层端点不按 agent 权限过滤，不触碰运行时过滤层的任何方法。规则发现是引擎新增能力：扫描全局 `$WOPAL_HOME/rules/` 与空间 `<spaceRoot>/.wopal/rules/` 两层目录的 `**/*.{md,mdc}` 文件，空间层按相对路径覆盖全局同名，直接子目录名作为 agent 作用域。规则的运行时注入（按 agent 与用户提示匹配）仍由 wopal-plugin 负责，与发现层分离。

## Session Capability Contract

ellamaka 不引入第二套 Wopal 专属 capability/permission 系统。现有 config 与 agent frontmatter 继续形成静态权限基线；Session 记录已有的 `permission` 仍是通用、持久的 session-scoped overlay，按既有最后匹配者生效语义与 agent permission 合成。没有 session overlay 时行为与现状完全一致。

在持久规则之外，Plugin SDK 提供一个可选的 **runtime permission rules** seam：`experimental.permission.rules`。它只在一次 `ctx.ask()` 求值前运行，输入 `{ sessionID, agent, permission, patterns }`，插件可向 `output.rules` 追加临时规则。引擎按 `agent.permission → session.permission → plugin runtime rules` 的顺序合并后，继续交给现有 Permission evaluator；因此 plugin runtime rule 遵守既有 LAST-wins 语义。

runtime rules 的边界必须保持窄而清楚：

- 它们只属于当前 permission ask，不写入 `session.permission`，不写入 project-wide approved pool，也不改变 Permission Service 的持久状态；
- Hook 是 additive optional contract；没有插件实现时输出为空，行为与现状完全一致；
- Hook 由 `SessionTools` 在构造 `ctx.ask()` ruleset 时消费，不要求 run loop 重新读取 Session，不修改 `Permission.Service`，也不要求具体 Tool（包括 `skill`）认识插件；
- Plugin 是受信任的运行时扩展，因而可以追加 allow/ask/deny；具体插件应按自身领域收窄使用范围。Wopal 当前只用它解决动态 Skill grant，不在本阶段用它实现 Tool/Rule 动态权限。

原有 Session permission 一致性仍成立：Tool 的 schema visibility / execution gate，以及 Skill 的原生 available/catalog / execution gate，继续消费 `agent.permission + session.permission`。Plugin runtime rules 不自动改变这些静态/持久清单；需要向模型表达运行时新增能力时，由插件通过 Runtime Context Contribution 追加对应的临时 catalog。这样引擎保持通用权限内核，插件负责自己的动态能力事实。

## Runtime Context Contribution

插件通过 `experimental.chat.messages.transform` 在每个正常模型请求的消息转换前调整本次请求消息。插件可在数组末尾追加普通文本或 `synthetic` TextPart；本次请求数组中的修改由引擎转换为模型消息。会话数据库仍由 Session 消息写入流程管理。

临时上下文由插件根据当前会话事实重新生成，并追加到本次请求末尾。插件负责保留先前消息内容和顺序，使动态内容只影响追加点之后的请求前缀。模型步数上限的 MAX_STEPS assistant guard 由引擎在转换后的消息末尾追加。

需要在 Chat 中展示和追溯的注入内容，通过 Session 消息写入流程保存为 `synthetic` TextPart，并由已有注入信息组件呈现。`synthetic` 标记描述内容来源；是否持久保存由消息写入流程决定，是否进入后续模型上下文由历史构造流程决定。持久合成消息参与后续历史，临时 transform 追加内容仅用于本次请求。

动态上下文的业务含义、文本格式和状态重建由插件负责。对于动态 Skill，推荐只在 request tail 发布被额外激活 Skill 的 `name + description`，让模型继续调用原生 `skill(name)` 取得 SKILL.md、base directory 与资源文件；不要把 Skill body/path 复制进插件注入。运行时 Skill 的实际 load allow 由 `experimental.permission.rules` 与插件自己的 Session Skill Overlay 同源生成，避免“看得到但加载不了”或“能加载但模型不知道”的双真相源。

## Upstream Reference Boundary

ellamaka 独立演进，`main` 是定制稳定线。OpenCode 仅作为只读参考与选择性代码来源；需要的安全修复、bug fix 或功能从 `labs/ref-repos/opencode/` 逐项评估后 cherry-pick 或手工移植。

| 规则     | 说明                                             |
| -------- | ------------------------------------------------ |
| 分支     | `main` = 定制稳定线                              |
| 合并方向 | 无                                               |
| 参考来源 | OpenCode 模块代码参考 `labs/ref-repos/opencode/` |

选择性吸收的 OpenCode 变更由 Git commit/cherry-pick 记录来源。Ellamaka release identity 只描述 Ellamaka 自身版本、channel、source commit 与构建；Ellamaka SDK 的公开兼容性由自身 SemVer contract 定义。

## Distribution

Ellamaka CLI 构建为多平台 standalone binary，Desktop 构建为原生安装包。两者使用独立 SemVer、tag、workflow 和 latest feed，并可独立安装/更新。Product 安装、补齐和跨产品 inventory 由 Wopal CLI 负责。DSH Home 由实际启动的产品按 closureVersion 检查，更新前先备份；旧版本不会打开已标记为更新的 Home。

构建入口：CI 中 `publish-ellamaka-cli.yml` 调用 `scripts/build.sh cli`（内部走 `packages/ellamaka-release/src/cli/build.ts`）并注入 env；本地开发使用 `packages/ellamaka-release/src/cli/build.ts` 包装脚本。

Onboarding 是 private `@wopal/wopalspace/setup` 的唯一用户形态，通过 `@wopal/ellamaka-sdk/http` 由统一 Server 承载。`wopal setup` 只是启动/reuse `ellamaka serve` 并打开 `/onboarding` 的便利入口；不存在 Terminal Setup 向导，也不安装/更新产品。

详细 artifact contract 见 `docs/DESIGN-distribution.md`。

## Plugin SDK Distribution

ellamaka 在 OpenCode fork 的 plugin/runtime 契约层之上做了一批增量扩展。Runtime 与 WopalSpace public contract 统一通过 `@wopal/ellamaka-sdk` 分发；private `@wopal/wopalspace` 不发布。SDK 版本不镜像 CLI/Desktop Product SemVer。`@wopal/ellamaka-plugin` 是既有插件 author contract，可复用同一 npm 发布基础设施，但其兼容关系由 plugin contract 自己定义。发布机制与版本策略见 `docs/DESIGN-distribution.md` 的 npm 包发布章节。

fork 的 plugin 契约层在 OpenCode-derived contract 上新增六处可选扩展：

- `SystemPromptSectionKind` / `SystemPromptSection` / `SystemPromptMetadata` —— 结构化系统提示词元数据，引擎在 `session/prompt.ts` 构造，经 `chat.params.systemMetadata` 传入插件
- `PluginInput.wopalSpaceRoot` —— 空间根来源，wopal 空间集成的基础
- `Hooks.chat.params` 的 `systemMetadata` 输入 —— 结构化提示词随模型请求透传
- `Hooks["tool.provider"]` —— 每次模型请求动态提供工具集，支撑运行时挂载/卸载
- `ToolContext.extra` —— 宿主向工具调用透传附加上下文（如沙箱模式）
- `Hooks["experimental.permission.rules"]` —— permission ask 前的临时 rules overlay；输入 session/agent/permission/patterns，输出可追加的 `PermissionRule[]`，合并后仍由原 Permission evaluator 求值

六处扩展均为可选字段或新增 hook，是上游类型的超集：上游/旧插件在新引擎上没有对应函数时由 dispatcher 直接跳过，行为保持不变。依赖 `experimental.permission.rules` 的新插件需要与提供该契约的 Ellamaka 版本配套分发；新插件运行在旧引擎上不会获得 runtime permission overlay，因此不属于受支持组合。扩展的完整契约与消费者矩阵见 `../../../.wopal/docs/DESIGN-wopal-plugin.md`（wopalSpaceRoot、systemMetadata、动态 Skill permission overlay）与 [工具容器设计](./DESIGN-ellamaka-tools.md)（内部 adapter、tool.provider 与沙箱语义）。

SDK/root调用模型的MAJOR变化不自动改变PluginInput.client。现有插件的注入client保留当前调用合同，由引擎薄适配到唯一canonical client；类型、认证刷新、Session/权限/事件调用一起验证，具体边界见 [Plugin Client Compatibility](./DESIGN-ellamaka-sdk.md#plugin-client-compatibility)。

插件消费这些扩展时直接声明 `@wopal/ellamaka-plugin` 依赖，运行时引擎以 `InstallationVersion` 剥离 rc/beta 后的纯主版本为兜底 pin，保证插件拿到的契约层类型与引擎一致。

## State Ownership

| 状态                             | 位置                                                  | Owner                                                                                 |
| -------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| WopalSpace local root            | `$WOPAL_HOME`                                         | 产品级路径契约：显式环境变量优先，否则使用平台默认路径                                |
| Global config                    | `$WOPAL_HOME/config/`                                 | 当前配置文件与既有加载链；统一 Config Plane / writer ownership 留到 Phase 3 Draft     |
| Runtime data                     | `$WOPAL_HOME/ellamaka/data/`                          | ellamaka                                                                              |
| Cache                            | `$WOPAL_HOME/ellamaka/cache/`                         | ellamaka                                                                              |
| Process state                    | `$WOPAL_HOME/ellamaka/state/`                         | ellamaka                                                                              |
| Instance WopalSpace root         | 当前 directory 的检测结果                             | `undefined` 表示非 WopalSpace；绝对路径表示 WopalSpace                                |
| CLI WopalSpace compatibility env | CLI 单进程运行期的 `WOPAL_SPACE` / `WOPAL_SPACE_ROOT` | CLI 入口；不作为 sidecar 当前空间状态                                                 |
| 空间 ontology                    | `<space>/.wopal/`                                     | Space Ontology，ellamaka 加载                                                         |
| 空间运行态                       | `<space>/.wopal-space/`                               | space runtime；wopal-plugin 按 instance root 写日志，Ellamaka engine 不拥有其目录结构 |

`WOPAL_HOME` 遵循 WopalSpace 产品级路径契约：显式环境变量优先；macOS/Linux 默认 `~/.wopal`，Windows 默认 `%USERPROFILE%\.wopal`。Ellamaka 只消费该路径契约，不拥有另一套解析规则。临时目录使用系统临时目录下的 `ellamaka/`。

### 环境变量来源

Core `Global` 只负责 `WOPAL_HOME` 路径布局，不将 `.env` 文件写入 `process.env`；`process.env` 只表达真实进程启动环境与 shell 临时覆盖。`.env` 由 wopal-plugin 的 per-invocation loader 消费，优先级为：真实 process/shell env > 当前空间 `<wopalSpaceRoot>/.wopal/.env` > 全局 `$WOPAL_HOME/.env`。

### 系统管理配置

企业 MDM 场景下，系统管理配置域为 `ai.wopal.managed`，路径为 `/Library/Application Support/wopal`（macOS）、`%ProgramData%/wopal`（Windows）或 `/etc/wopal`（Linux）。

### Runtime API 与 SDK 契约

Ellamaka Server 同时承载 Public Platform API 与 Official App BFF。Public Platform API 只组合可复用的 Runtime 与 WopalSpace contract，并生成 `@wopal/ellamaka-sdk` 的公开 OpenAPI/client/types；Official App BFF 只服务 `@wopal/ellamaka-app`，拥有独立的私有 schema/client，不进入公开 SDK。

Workbench 的 Session Tree、creation locations、跨 Space 的 Session provision 等是官方 App projection/use case，由 App BFF 组合 Runtime facts 与 WopalSpace facts。可独立复用的 Space registry/projects/search/files 能力归 private `@wopal/wopalspace` 并进入 Public Platform API；可独立复用的 Session/status/metadata 能力归 Runtime public contract。

Browser/Desktop 对平台能力通过 `@wopal/ellamaka-sdk/http` 连接 Server，对官方 App BFF 使用 `ellamaka-app` 内部 client；Wopal CLI 对 Ontology/Space 等 trusted-local operations 通过 `@wopal/ellamaka-sdk/local` Worker transport 进入同一 WopalSpace handlers。Setup 通过 Server-hosted Web Onboarding 使用公开 WopalSpace Setup API。local 发布物 self-contained，不要求消费者安装 unpublished private package。

详细 SDK 契约见 [Ellamaka SDK](./DESIGN-ellamaka-sdk.md)，application 边界见 [WopalSpace Application Domain](./DESIGN-wopalspace.md)。

## Core Readiness and Preparation

Core Preparation 是 `@wopal/ellamaka-core` 的代码级 readiness service。它不表达“整机 Ellamaka 是否 Ready”，而是回答**某个具体产品/build 或某个 Space instance 是否具备它自己需要的运行资源**。

统一状态为 `READY | NEEDS_PREPARATION | PREPARING | BUSY | DEGRADED`。`inspect` 只读 facts；`prepare` 对同一 target single-flight。

`host` 指当前运行产品的 build-bound target，不是整机全局状态。产品 identity 由宿主注入；调用方只选择目标，不指定内部 steps。产品入口注入 Cordis contributors，instance contributor 使用可独立运行的配置声明读取与依赖准备原语。

结果同时保留各 capability/step 的状态与稳定 reason，产品入口只激活已 Ready 的能力。进度使用 `CorePreparationEvent`，包含 run/target/step identity 和实际 phase；计量值只在底层可度量时出现。取消在安全检查点生效，已开始的持久提交完成或明确失败后才释放锁；订阅者断连不取消共享任务。

READY 是观察结果，不是 Home 使用许可；DSH Activation 必须重新检查当前 closureVersion，并持有 Home lock。

产品入口从自己的 Core Runtime Descriptor 取得 build identity、closureVersion 与所需 resources：

```text
ellamaka serve/web -> prepare current CLI build -> activate required DSH
Desktop sidecar    -> prepare embedded build    -> activate required DSH
TUI                -> prepare current build     -> activate entry-required capability
ellamaka run       -> native Core only; DSH branch permanently disabled
```

`wopal setup` 不调用 CorePreparation，也不读取其他产品 descriptor；它启动的 `ellamaka serve` 按正常产品启动路径准备当前 build。

Wopal-managed serve 的 Runtime health 回显启动时注入的 `managedInstanceId`，用于 CLI 核验进程所有权。身份由宿主启动配置绑定，普通 HTTP request 不能替换；health 的 DSH/Core detail 与该管理身份互不替代。

Space instance 只有在 `.wopal` 物化后才准备 path-plugin dependencies。`space.init` 主动准备；Runtime 第一次激活该 Space 时 `inspect(instance)` 并保留 fallback。Instance failure 只影响该 Space。

DSH Preparation 与 Runtime Activation 分离：CorePreparation 负责 closure/Home/profile ready；真正产品入口再 `mountDshWeb/mountDshTools`。Server 不分成 Bootstrap/Full 两套 Runtime，某项附加能力 PREPARING/DEGRADED 只影响该能力。

独立 `ellamaka dsh init` 不属于目标态；DSH preparation 统一由真正需要 DSH 的产品入口按需完成。

### Sidecar Instance Context

一个 sidecar 同时服务多个 directory instance。配置加载和插件创建从当前 directory 直接检测可选的 `wopalSpaceRoot`。空间根与空间内任意子目录得到同一个 root；非 WopalSpace instance 不继承其他空间状态。

PluginInput 通过可选 `wopalSpaceRoot` 字段接收当前 instance 的空间根。字段缺失表示非 WopalSpace。插件使用该字段定位空间级资源，普通 Engine 运行时保持上游环境与子进程行为。

`WOPAL_HOME` 是 sidecar 的进程级安装根。它拥有全局配置、全局能力和运行时存储。`WOPAL_SPACE` 与 `WOPAL_SPACE_ROOT` 只服务单目录 CLI 兼容边界，不承担 server request routing 或 plugin context 所有权。

## Unified Reload & Lifecycle

后端把运行时单元的可重载能力统一为一个模型：一个 `ReloadController` 管理若干 `ReloadUnit`，每个单元独立用同一套生命周期协议重载。单元是由 Runtime host 管理的可重载边界：

| 单元                   | 状态源                                    | 重载含义                                                       |
| ---------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| `global`               | 全局 config 与 provider                   | dispose 全部 instance 并重新 bootstrap，发出 `global.disposed` |
| `instance:<directory>` | 单目录 instance                           | `InstanceStore.reload`（dispose + bootstrap）                  |
| `dsh:web`              | web profile manifest / closure            | 重建 DSH web 容器                                              |
| `dsh:tools`            | ellamaka-tools profile manifest / closure | 重建 DSH 工具容器                                              |

**两级重载**：

- **Hot replay**：只重放配置/patch，不更换进程模块图。
- **Cold reload**：代码或包版本变化时，按 `drain → dispose → build → verify → publish → notify` 重建对应单元。这里的单元 revision 只用于重载事件，不是 DSH `closureVersion`。

**隔离边界**：进程内重挂载复用同 URL 的已求值模块（原生 `import()` 与内部 loader 均按 URL 缓存），插件版本升级不生效；冷重载依赖新进程边界来重置模块图，与内部 loader 无关。`dsh:web` 的 build 在独立可重启子进程中完成，宿主以 loopback HTTP 承接并稳定转发 `/dsh` 前缀。Desktop 复用 `utilityProcess`（现有 sidecar 已是同款）；bun standalone serve 以全新 bun 子进程承载 web 容器，宿主经 loopback 代理转发 `/dsh`：HTTP 走 `node:http` 请求代理；WebSocket upgrade 在宿主以 `ws` noServer 终结（Bun 对 `ws` 握手走原生通道），再以 Bun 原生 WebSocket 客户端拨子进程桥接帧——禁止在宿主 upgrade socket 上直接 `socket.write`（Bun 吞掉全部字节，oven-sh/bun#9882/#35325），也不得改用 `ws` 包客户端拨号（其握手依赖 `node:http` 的 upgrade 事件，Bun 不投递）。桥接必须保持两条不变量：拨号携带浏览器原始 Host/Cookie/Origin（子进程 DSH 见证 Host 派生 cookie 名并校验 cookie，改写为子进程 loopback authority 必然 401）；逐帧保持文本/二进制类型（RPC 在同一 socket 混发 JSON 文本与二进制，文本降级为二进制会被解码拒绝并断开）。子进程拒绝 upgrade 时不得先回浏览器 101——握手完成必须晚于上游接受，否则认证或后端失败会表现为永久重连。`dsh:tools` 是无会话的 per-call 执行，默认 in-process，必要时升级为同款隔离。`--expose-internals` 服务于官方 node-hmr，在 Electron 中当前不可用，是本设计的非依赖项；普通 Node 22 与 bun 子进程均可分载 web 容器并返回认证首页、宿主代理转发 200（已 spike）。

**触发定域**：按状态源变化定单元，不做固定组合——web profile 变 → `dsh:web`；tools profile 变 → `dsh:tools`；共享 dsh-base 配置变 → web+tools；产品闭包变更由产品重启与 Home 协议接管；全局 provider/config 变 → `global` 与各 `instance:*`，不牵动 dsh。单元用 `invalidatedBy` 声明依赖边；当前 global 不依赖任何 dsh 单元，未来做集中配置管理只需增补一条边。

**发布与事件**：每个单元原子发布 entry/route 与自身 revision，事件携带 `unit` 与 `revision`。`global.disposed` 语义保持不变；DSH 单元重载只重建 Workbench 的 DSH iframe，不触发整个 sidecar 重启。

**一致性**：DSH closure 下载由 materialize.lock 保护；Home 版本切换由 DESIGN-dsh-base.md 的单一 Home lock 与切换前备份保护。Cold reload 不另建 Home 状态机。重载失败只降级对应单元。

DSH 容器装配与融合细则见 [DESIGN-dsh-base.md](./DESIGN-dsh-base.md)。

## DSH 双引擎融合

ellamaka 的 Runtime host 承载 dsh 引擎，容器可在宿主或受管子进程中运行，生命周期由该 host 拥有。融合的目的是获得沙箱执行、插件生态与动态装载能力，同时保持 ellamaka 的会话所有权与对外契约不变。

DSH v0.2 由 Bridge 接入。$WOPAL_HOME/dsh/home 是唯一 Active Home。CLI/Desktop 使用同一 closureVersion；同版本可并发持有 shared Home lock。切换到较新版本前必须取得 exclusive Home lock 并完成 backup；旧版本面对更新 Home 时 fail closed。DSH closure、Home backup 与 profile preparation 由当前产品的 CorePreparation 执行，ELLAMAKA_DSH=0 跳过 DSH steps。基本 Home 版本保护见 [基础设计](./DESIGN-dsh-base.md)。

### 双容器模型

Runtime host 管理两个相互独立容器，共用 ellamaka 的唯一公开监听端口；Web 冷重建的子进程边界见 Unified Reload：

| 容器         | Profile          | 职责                                                         | 会话 |
| ------------ | ---------------- | ------------------------------------------------------------ | ---- |
| **Web 容器** | `web`            | 承载 dsh 完整 Web 界面（会话、账本、检查点、Agent 配置体系） | 有   |
| **工具容器** | `ellamaka-tools` | 提供纯工具执行后端，供 ellamaka 工具管道调用                 | 无   |

```text
ellamaka Runtime host（唯一公开监听端口）
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

**统一 Core 生命周期**：Ellamaka Core 的 preparation API 固定为 `CorePreparation.inspect(target)` 与 `CorePreparation.prepare(request, options)`；target 分为 `host` 和 `instance(directory)`。Host canonical steps 为 `dsh.closure → dsh.home → dsh.profiles`、`plugins.global-deps`、`host.preflight`；WopalSpace instance 另外执行 `plugins.instance-deps → instance.preflight`。Runtime Activation 独立于 Preparation，按 capability 的 READY facts 激活；DSH 挂载还必须在 Home lock 保护下重新核验 closureVersion。

| 入口 | Preparation | Activation |
| --- | --- | --- |
| CLI `serve` / `web` | 检查/准备当前 CLI build 需要的 Runtime resources | Ready 后挂载该入口需要的 DSH Web/Tools；失败只降级 DSH 能力 |
| Desktop sidecar | 检查/准备当前 embedded sidecar build | Ready 后挂载 Desktop 所需 DSH 能力 |
| 默认 TUI | 检查/准备当前 build；Space plugin 另按 instance 检查 | Ready capability 挂载；失败时原生 TUI 可继续 |
| directory instance | `.wopal` 物化后主动准备，首次使用时 fallback | instance Ready 后加载 path plugins |
| `ellamaka run` | DSH 永久跳过 | 纯 native Core，不探测/复用/挂载任何 DSH |
| `run --attach` | 不创建本机 listener/目录 instance，不执行 CorePreparation 或 DSH 准备/挂载 | 使用远端 Runtime |

`ELLAMAKA_DSH=0` 时不创建 DSH 目录、不下载 closure、不备份或改写 Home、不挂载 DSH 容器，但 global/instance plugin dependency steps 仍按 target 执行。Preparation 状态、代码级 service/progress contract 见 [Core Readiness and Preparation](#core-readiness-and-preparation)；closure-change backup 与固定 Home 细节见 [Closure and Startup Lifecycle](./DESIGN-dsh-base.md#closure-and-startup-lifecycle)。

### 采用范围

Ellamaka Agent 的工具采用路径复用 DSH 工具执行能力，持久 Session 与消息语义归 Ellamaka。独立的 Web profile 承载完整 DSH 引擎，其会话、账本和 agent-loop 归 DSH；两种会话域通过独立容器隔离。

工具容器中的调用外观只提供执行所需的浅层上下文。依赖 DSH 会话、账本、调度或子代理语义的 provider 属于 Web 执行面；Ellamaka 自身的相应能力按其数据模型提供。API 定义或类型依赖存在于闭包，不代表这些 provider 在工具容器激活。

工具插件不在这个范围内。它们是叶子工具，只消费会话的浅层形状，不依赖 agent-loop 语义。

工具容器与 adapter 投影路径不创建、不持有任何会话，只提供执行能力。

### 组件清单

| 组件                | 位置                                                   | 职责                                                                                                            |
| ------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `VirtualWebServer`  | `@wopal/ellamaka-cordis`                               | 实现 dsh 官方 WebServer 接口，提供路由与 upgrade 分发，不创建监听 socket                                        |
| 受控路由挂载点      | `Listener.mountNodeRoute`                              | 按前缀分发 HTTP 与 upgrade 到已注册 handler，保留 Effect listener 生命周期                                      |
| Ellamaka DSH Bridge | `@wopal/ellamaka-cordis`                               | 随产品编译发布，提供 DSH 调用协议适配、容器、虚拟 WebServer 与固定运行时装配                                    |
| DSH Runtime Manager | `@wopal/ellamaka-cordis/runtime`                       | 所有入口共用的启动入口，负责禁用判断、闭包物化、完整性校验、动态加载与容器挂载                                  |
| DSH 插件供应链      | `@wopal/ellamaka-cordis/plugins`                       | 内置安装器、包解析、profile 声明与配置重放；原生 pluginManager 经 profileContext.packageManager 调用宿主 worker |
| Wopal preset bundle | `@wopal/dsh-presets`（ontology `dsh/agents-presets/`） | 声明 wopal/fae/rook preset 并携带随包技能；通过标准 DSH bundle 装配                                             |
| DSH 运行时清单      | ellamaka 构建产物                                      | 构建时从 `packages/ellamaka-cordis/package.json` 派生并锁定 dsh 官方依赖                                        |
| dsh 引擎装配        | `@wopal/ellamaka-cordis/dsh-web`                       | 通过 installAnchor 和 profile facts 装配两个容器，验收服务、工具与默认 preset 后发布句柄                        |
| dsh-adapter         | `@wopal/ellamaka-cordis/dsh-adapter`                   | 把工具容器中的工具投影进 ellamaka ToolRegistry                                                                  |

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
- **出站跳转改写**：官方令牌交换的 303 响应使用相对 Location `./`，浏览器按当前 `/dsh/` 请求解析，保持挂载前缀；VirtualWebServer 也将根相对跳转改写到该前缀。
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

WopalSpace 需要统一 Web UI 作为 TUI 之外的第二种用户界面。`ellamaka-app`（`packages/ellamaka-app/`）同时承载配置阶段 `/onboarding` 与运行阶段 `/workbench`；两者属于同一个前端应用。

### 架构决策

`ellamaka-app` 通过复制上游 `packages/app` 获得，而非在既有原型上迭代。这一选择让定制代码与上游解耦：它复用现有基础设施（core/sdk/ui/i18n/terminal/theme），Web UI 形态随 ellamaka 独立演进。

### 详细规约

Workbench 的界面、视图模型、目录架构、能力适配规则以及与 `wopal-cli` 的协同见 [DESIGN-workbench.md](./DESIGN-workbench.md)。需要参考上游 UI 代码时，从 `labs/ref-repos/opencode/packages/app` 读取。

---

## Related Documents

| 文档                                         | 引用目的                            |
| -------------------------------------------- | ----------------------------------- |
| `../../../projects/wopal-cli/docs/DESIGN.md` | wopal-cli 如何消费 ellamaka release |
| `packages/opencode/AGENTS.md`                | engine package 内部规则             |
| `packages/ellamaka-app/AGENTS.md`            | ellamaka 官方 web UI 包级开发规则   |

## Scheduled Plan Execution

界面结构、空间级工作区切换、审批与排期交互由 [DESIGN-plan-scheduler.md](./DESIGN-plan-scheduler.md) 定义；HTTP 路径、数据与错误契约由 [Scheduler API 草案](./DESIGN-plan-scheduler.md#api-proposal) 定义。Workbench 壳负责承载，调度领域状态由 CLI 提供。

Ellamaka 实现 Wopal CLI 定义的 Runner Port：版本协商、幂等执行身份、非交互 Session、结构化事件/结果、查询、取消与完整工具进程树收尾。CLI 拥有可审阅的 DAG JSON、时间、运行态 JSON claim，ontology Provider 拥有审批和实际实施准备；runtime 承接已批准 revision 与验证过的环境。

调度 profile 在普通配置合并后施加不可放宽的权限上限。它允许正常编辑、网络、构建和测试，保护 Git 管理元数据、权威 Plan 与审批/调度写权限，阻止 Agent 自行提交、合并或推进人工生命周期。工具代理/隔离覆盖间接 shell 与子进程路径，提示词不能替代强制执行。

Workbench 经 Runtime Integration API 使用同一 CLI 能力，提供审批后停止、DAG 确认、cron/时区、阻塞诊断、运行历史和人工接管；Desktop/Web 共享行为。跨项目协议遵循 [Plan Orchestration](../../../docs/products/wopal-space/DESIGN-plan-orchestration.md)，交互遵循 [Scheduler UI](../../../docs/products/wopal-space/DESIGN-plan-scheduler-ui.md)。
