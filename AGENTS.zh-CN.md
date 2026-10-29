---
name: Ellamaka AGENT RULES
description: Ellamaka 长期有效的架构边界、实施、日志与验证规则
---

# Agent Development Rules

## Canonical References

- [DESIGN](docs/DESIGN.md) 是目标态与详细架构契约的权威来源。
- 按任务阅读子设计：DSH 基础 [DESIGN-dsh-base](docs/DESIGN-dsh-base.md)、DSH Web [DESIGN-dsh-web](docs/DESIGN-dsh-web.md)、工具容器 [DESIGN-ellamaka-tools](docs/DESIGN-ellamaka-tools.md)、统一 SDK [DESIGN-ellamaka-sdk](docs/DESIGN-ellamaka-sdk.md)、Workbench [DESIGN-workbench](docs/DESIGN-workbench.md)、Desktop [DESIGN-desktop](docs/DESIGN-desktop.md)、Onboarding [DESIGN-onboarding](docs/DESIGN-onboarding.md)、分发 [DESIGN-distribution](docs/DESIGN-distribution.md)、日志 [DESIGN-logging](docs/DESIGN-logging.md)、配置 [DESIGN-config-engine](docs/DESIGN-config-engine.md)。
- 包级规范（改动对应包时必读）：[opencode](packages/opencode/AGENTS.md)、[ellamaka-cordis](packages/ellamaka-cordis/AGENTS.md)、[ellamaka-app](packages/ellamaka-app/AGENTS.md)、[ellamaka-desktop](packages/ellamaka-desktop/AGENTS.md)。
- 本文件保留实施与验证时必须照做的稳定规则；详细数据模型、流程和接口以对应 DESIGN 为准，但本文件的规则不因 DESIGN 有描述而省略。
- 根 `AGENTS.md` 与 `AGENTS.zh-CN.md` 是双语镜像，任何规则变更必须在同一次提交内同步更新两份。

## Architecture and Directories

Ellamaka 由 Runtime、Server 组合宿主、private WopalSpace 应用服务和官方 App BFF 组成。Server 可在同一宿主挂载 Public Platform API 与 App-private BFF；底层 Runtime 不依赖 WopalSpace 或 App BFF。Browser/Desktop 的平台能力通过公开 SDK，官方 App 投影通过 app-private generated client；Wopal CLI 拥有 Product 管理。目标边界见 DESIGN；当前 filesystem map 只列已存在路径。

| 路径                                                                                                                         | 模块职责                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| packages/ellamaka-core/                                                                                                      | 共享产品原语，包括路径、进程、文件与日志能力                                                                                       |
| packages/opencode/src/cli/                                                                                                   | Ellamaka CLI 入口、命令路由和 TUI 启动                                                                                             |
| packages/opencode/src/config/、packages/opencode/src/plugin/                                                                 | 配置求值与插件装配                                                                                                                 |
| packages/opencode/src/server/                                                                                                | Server 组合、Root/Instance API、HTTP 与事件连接；WopalSpace handler 集成位于 routes/instance/httpapi/                              |
| packages/opencode/src/session/、packages/opencode/src/agent/、packages/opencode/src/permission/、packages/opencode/src/tool/ | Runtime 会话、Agent、权限评估与工具执行                                                                                            |
| packages/opencode/src/workbench/                                                                                             | Server 侧 Workbench 组合，连接 Runtime 与 Space 数据                                                                               |
| packages/ellamaka-cordis/                                                                                                    | DSH 闭包加载、Cordis 生命周期与 profile Bridge                                                                                     |
| packages/sdk/js/                                                                                                             | 公开 Runtime/WopalSpace contract 与生成 client                                                                                     |
| packages/ellamaka-app/                                                                                                       | Browser/Desktop 共用的 Onboarding/Workbench 界面，以及 Official App BFF contract/client 的 owner                                   |
| packages/ellamaka-desktop/                                                                                                   | Electron 原生壳层与 Server sidecar 生命周期                                                                                        |
| packages/ellamaka-release/                                                                                                   | CLI/Desktop 产品构建、identity 与发布                                                                                              |
| scripts/                                                                                                                     | 只放面向用户的便利脚本：构建、开发、发布。每个脚本必须在 `scripts/README.md` 登记。CI 门禁、测试工具等代码归属于拥有它的 package。 |

快速判断边界时保留以下事实：

- Space 配置和 Runtime instance 按请求 directory 隔离；进程级环境变量不代表多目录 Server 的当前 Space。
- 能力发现不等于 Agent 执行授权；配置读取或被动 Workbench 查询也不等于启动目录 Runtime。
- 当前实际启动 Runtime 的 Ellamaka build 负责准备自己的运行资源，不扫描或预热机器上的其他产品；ellamaka run 保持 native-only，DSH 关闭。

## Development Commands

| Scenario                   | Command                                                                                 | When                                    |
| -------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------- |
| Lint                       | bun run lint                                                                            | 修改代码后                              |
| Full typecheck             | bun run typecheck                                                                       | TypeScript 改动后                       |
| Test isolation gate        | bun run check:test-isolation                                                            | 修改任何测试/fixture/preload/测试配置后 |
| opencode unit tests        | bun run test:unit（在 packages/opencode/）                                              | Runtime 单元测试                        |
| opencode integration tests | bun run test:integration（在 packages/opencode/）                                       | Server/跨模块集成变化                   |
| App unit tests             | bun run test:unit --force-exit（在 packages/ellamaka-app/）                             | 前端逻辑变化                            |
| App boundary check         | bun run check:workbench-boundaries（在 packages/ellamaka-app/）                         | Workbench 目录变化                      |
| Desktop tests              | bun test --preload ./electron-mock.ts --force-exit src（在 packages/ellamaka-desktop/） | Desktop 主进程/渲染器变化               |
| Development entry          | ./scripts/dev.sh help                                                                   | GUI、TUI、Server 联调                   |

测试必须从所属包执行；完整命令和制品验证方式看各包规范与脚本 help。

## Implementation Rules

- Server handler 只负责传输适配和领域调用；跨域组合放在 Server composition，不能让 Runtime 向上依赖 WopalSpace。跨包实施同时遵循改动 package 最近的 AGENT 规则。
- 遵循 directory instance 边界传递配置和插件上下文。变更配置或权限规则后核对实际合并结果，不用能力发现列表代替授权结果。
- Browser/Desktop 的平台 HTTP contract 由公开 SDK 提供；Official App BFF contract 由 app-private generated client 提供。任一 contract 变化时都必须成组生成对应类型与运行时参数映射，不手改 generated 文件。
- 跨包动态加载、资源解析或打包行为必须验证真实产品制品，源码态检查不能替代宿主验证。
- 明确异步任务与子进程的 owner；取消和退出必须等待 owner 所拥有资源完成清理。
- 临时验证使用隔离 Home、profile、仓库和凭证；不得改写用户真实运行环境。隔离 Home 由 `WOPAL_HOME` 选择（如 `WOPAL_HOME=/path/to/tmp/home`），不是 `HOME`——只设 `HOME` 不会重定向产品路径；启动任何真实进程前，先从其早期输出核对所打印路径全部落在隔离 Home 内。
- 定制边界（针对 upstream 文件）：新能力优先放新文件，upstream 文件只保留最少的 import 与调用注入点；定制分支用早返回 guard，避免与主线重叠；需要 upstream 内部能力时优先 callback/闭包注入，不暴露 upstream Service 类型；复用逻辑抽共享 helper，不复制大段 upstream 流程；不得对 upstream 文件做无关格式化、import 重排、依赖或对象键重排；`.gitattributes` 不添加 merge 策略驱动，冲突显式逐文件解决。
- DSH 与 Bridge：`$WOPAL_HOME` 根目录禁止 `pnpm install` / `bun install`（pnpm 会爬到 workspace 根，摧毁 Bun 管理的依赖拓扑）；引擎运行期间，进程外的任何写操作都不得触碰 `$WOPAL_HOME/dsh/home/profiles/`（连"内容相同"的幂等写也会与引擎竞态）；`wopal.dsh.web.enabled` 是仅全局生效的 Web profile 开关，`ELLAMAKA_DSH_TOOLS` 是进程级 Tools profile 开关，Space 的 `wopal.pluginConfig.dsh-adapter.sandbox.enabled` 只决定是否采用该 backend，不启停 profile；Bridge 只随 Ellamaka 产品发布，不单独发包、也不作为 `$WOPAL_HOME/dsh` 的依赖；tool container 不创建 dsh session，只传每次调用所需的最小上下文；插件"安装一次、按 profile 激活"，同一进程不并行两个版本。
- WopalSpace 集成边界：Setup、Ontology 与基础 Space 业务只在 private WopalSpace 服务内实现一次，并通过 Public Platform SDK 暴露；Product 管理、Evolution、Skill 生命周期与调度继续由 Wopal CLI 拥有。Ellamaka 不依赖 Wopal CLI 的命令处理、共享 schema 包或最低 CLI 版本。Session provisioning 只接受已注册 Space 与安全的相对目录，目录失败不删除 Session。
- 接口与 SDK：新端点先定领域 owner 与 Root/Instance 归属，走 `HttpApiGroup`。可复用 Runtime/WopalSpace operation 进入 Public Platform contract/公开 SDK；只服务官方 App 的 projection/use case 进入 App BFF 私有 contract，不得进入公开 `/doc` 或 SDK exports。每份 contract 的重生成都必须“全有全无”，同时核对类型和运行时参数映射；生成物一律不手改。
- 权限规则：agent frontmatter 不声明 `"*": allow` 一类通配，只写显式收窄；合并求值是 LAST-wins，显式规则必须排在通配之后。改完用 `GET /agent` 复核合并后的实际规则顺序。能力发现列表不等于授权结果。
- 发布纪律：release build 入口是 CLI 二进制的唯一打包点；不引入 Wopal CLI 版本下限或发布顺序依赖。CLI 与 Desktop 独立更新；公开 `@wopal/ellamaka-sdk` / `@wopal/ellamaka-plugin` npm 包拥有独立 SemVer 与独立 workflow，CLI/Desktop 产品发布不得 bump 或发布这些 npm 包；Desktop UI 改动必须在原生 Windows 上验证（macOS 构建不算数）；release workflow 只用 Node 24-native 官方 action，新增/升级 action 前检查其 `runs.using` 为 `node24`；已提交发布不可变，整版撤回流程见 DESIGN-distribution。
- 日志：由 ellamaka-core 的结构化 logger 统一路由和脱敏，插件只用内置 `ctx.logger`（不 `console.log`、不自建 logger）。必须记：生命周期变化、错误与异常（含降级路径）、关键决策。不得记：循环内逐条、成功路径例行、可从上下文推出的信息。循环要聚合成一条摘要；上下文放结构化字段而非拼进消息；`catch` 不得吞异常。默认 INFO，DEBUG 用于诊断，TRACE 按类别显式开启。任何日志都不得记录凭证、prompt/消息正文、工具参数、命令、路径或无界子进程输出。分级、路由与文件细则见 DESIGN-logging。
- 排障：放大日志用 `--log-level` / `--trace <类别>`，不要往代码里加临时日志；显式 `--log-level` 覆盖 `--trace` 提升。日志定位（角色分域目录、dev scope、DSH 文件）见 DESIGN-logging。
- 启动与进度：只报告真实执行的阶段，有真实总量才给计数/百分比，长阶段发心跳；进度走 stderr 或专用 UI，机器 stdout 保持纯净。`wopal.dsh.web.enabled=false` 且 `ELLAMAKA_DSH_TOOLS=0` 时报告跳过 DSH preparation，并保持零 DSH 文件/网络/mount 副作用。Tools profile 加载失败可以保留 Native Tools；一旦 Tools 已 ready 且当前 Space 采用 `dsh-adapter`，沙箱或工具执行失败必须原样失败，严禁改用 Native Tools 重试。

## Testing

- 逻辑行为遵循 TDD：先写能复现输入/输出行为的失败测试，再实现并重构。
- 测试真实 owner 和跨模块边界；mock 只放在明确的传输或外部系统边界。
- 修改平台宿主、运行时闭包或发布制品时，在对应真实平台/制品路径验证；说明静态检查未覆盖的边界。
- 自动化覆盖可重复的逻辑和协议行为；手动验证只用于无法由测试观察的 GUI 或原生宿主行为。
- 改动涉及的文件必须通过 `bunx oxlint --deny-warnings <文件>`（不得新增 warning）与 `bunx prettier --check`；改 TypeScript 必须 typecheck 通过；测试从所属包目录运行，不从仓库根。

### 测试隔离铁律

以下规则全仓适用；`bun run check:test-isolation` 检查其中可静态识别的违规，其余由行为测试与实施评审验证。
原理、三种隔离模型、规则到门禁的完整对照见
[docs/testing-isolation.md](docs/testing-isolation.md)。

- 替换依赖要用**依赖注入**，不要用进程级替换。普通测试文件禁止调用 `mock.module`：Bun 的模块替换是进程级的，
  `mock.restore()` 不撤销它，且对已经 import 的绑定也生效，会泄漏给之后加载的每个测试文件。
  正确做法是给产品加一个接缝（service、factory、`Layer.mock`），由测试注入替身。
- `*.test.*` 文件禁止直接写入或删除 `process.env`。统一使用所属 package 的
  `test/fixture/process-env.ts::scopedEnv`；当前 `opencode`、`ellamaka-core`、`ellamaka-cordis` 都有该 helper。
  其他 package 若需要修改环境变量，先新增同样的 package-local 非测试 fixture，禁止在测试里手写恢复逻辑；
  这些进程级 scope 不得在并发测试中重叠。若依赖在 import 时读取 `process.env`，必须改用依赖注入或独立进程。
- 必须等待被测操作自身返回的 Promise 或已发布的就绪信号，禁止固定等待。被测代码若启动异步工作却返回 `void`，
  应暴露完成 Promise/callback 接缝，而不是用 `setTimeout`、`Bun.sleep`、`Effect.sleep` 当“刷新/等一会儿”。
  一次性就绪优先用 `Promise.withResolvers()`/`Deferred`，轮询只能观察已发布状态；timeout 只作失败兜底，不作同步。
- 共享文件系统状态必须有 owner。写共享路径的测试自己拥有它，只释放自己写的那部分，
  绝不删除别的测试还在用的状态。
- 绝不为让测试通过而削弱断言。删掉 expect、缩短观察窗口、用 retry 掩盖真实 bug，
  是评审失败，不是修复。
- unit 层不放真实 I/O。子进程、文件监听、真实 git、网络请求、真实时钟都属于 integration 层。
- 任何改动测试、fixture、preload 或测试配置的工作，都必须先在仓库根运行 `bun run check:test-isolation`，
  通过后再跑所属 package 测试。baseline 是技术债账本，不是可复制/改名继承的豁免：碰到已有 baseline 债务时必须
  顺手迁移为合规写法，环境变量名或 API 改名也不能继承旧额度。只有在“零新增违规”后才运行
  `bun run check:test-isolation -- --fix`，它只能删除 stale 债务，严禁记录新债务。
- 错误路径必须由测试明确触发，并断言具体错误与原状态；不要假定权限位、用户身份、外部服务或已有缓存会制造预期故障。
- 环境门禁与实际操作必须同址。测试若先探测环境（可否写入、挂载状态、沙箱允许根）再据此选择分支，
  真实操作必须落在同一个目录或资源上，避免软链、挂载、叠加层让判断与操作不一致。
  沙箱拒绝探针规范化后必须位于所有允许写入根之外；选用符合前提的目标，不能削弱拒绝断言。
  没有错误不代表成功，必须验证输出或最终状态。
- 偶发失败修复必须验证原失败场景、冷进程与组合运行。验证组任一次失败都算失败，不能以重跑成功代替根因证据。
- 调整测试分层或入口必须核对实际执行文件，保持原有 CI 覆盖；每个用例的容器、子进程和临时目录在异常路径也必须完成清理。
- 跨运行时或宿主的子进程测试要覆盖流继承、管道背压及取消回收；小输出命令成功不足以证明进程边界正确。

### 手动验证入口

GUI、Onboarding 与 Desktop 壳层行为的验证入口。Agent 可用 CDP 检查 Desktop，只把仍需人工观察的行为交给用户。

| 入口                | 命令                                                      | 隔离                                                  |
| ------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| Desktop（常规）     | `./scripts/dev.sh desktop`                                | 使用真实环境；首次需 `--rebuild` 构建 sidecar         |
| Desktop（CDP）      | `./scripts/dev.sh desktop --rebuild --cdp-debug [端口]`   | 使用真实环境；5173 与所选 CDP 端口需空闲（默认 9222） |
| Workbench / backend | `./scripts/dev.sh serve`                                  | 端口 4096；`--cdp-debug` 打开 9222 CDP                |
| TUI                 | `./scripts/dev.sh tui`                                    | 默认进程内 backend                                    |
| 停止                | `./scripts/dev.sh stop <backend\|frontend\|desktop\|all>` | —                                                     |

- Desktop CDP：`agent-browser --session <name> connect <端口>` 连接 Electron 窗口做 UI 验证。9222 被占用时可指定端口，例如 `./scripts/dev.sh desktop --cdp-debug 9333` 后 `connect 9333`；只需所选端口空闲。
- 日志（dev 运行）：`.wopal-space/logs/dev/<scope>/ellamaka-dev-{tui,serve,sidecar}.log`。`<scope>` 是拥有 `scripts/dev.sh` 的仓库/工作树根（解析符号链接）的 md5 前 10 个十六进制字符；可从 `.wopal-space/logs/dev/registry` 解析，或按 dev.sh 同样方式计算 `printf '%s' "<root>" | md5 -q | cut -c1-10`。工作树运行记入其 base space 的 ledger。
- Plan 的 User Validation 必须引用本表并给出用户可直接复制运行的命令；"启动应用"这类泛化措辞不可接受。

## User-Supplied Rules

- JS SDK 重新生成：`./packages/sdk/js/script/build.ts`。
- 默认分支为 `main`，以它为审查基线。
- diff 使用 `main` 或 `origin/main`；上游参考代码从工作区 `labs/ref-repos/opencode/` 读取。
- 清楚授权的请求直接执行；只在关键信息缺失、真实安全风险或不可逆操作边界确认。
