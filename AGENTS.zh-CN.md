---
name: Ellamaka AGENT RULES
description: WopalSpace engine fork of OpenCode for running space-aware agents, commands, plugins, configuration, and TUI behavior
---

# Agent Development Rules

## Canonical References

- DESIGN: `docs/DESIGN.md`
- DSH FUSION: `docs/DESIGN-dsh-base.md`（融合基础：文件领地、依赖闭包、热加载）
- DSH WEB PROFILE: `docs/DESIGN-dsh-web.md`（插件供应链、插件市场、Workbench 融合）
- TOOL CONTAINER: `docs/DESIGN-ellamaka-tools.md`（能力采用、工具投影、沙箱）
- API CONTRACT: `docs/API-CONTRACT.md`
- WORKBENCH: `docs/DESIGN-workbench.md`
- ONBOARDING: `docs/DESIGN-onboarding.md`
- DESKTOP: `docs/DESIGN-desktop.md`
- DISTRIBUTION: `docs/DESIGN-distribution.md`
- Config Reference: `docs/references/ellamaka-config-mechanism.md`
- opencode package rules: `packages/opencode/AGENTS.md`
- ellamaka-cordis package rules: `packages/ellamaka-cordis/AGENTS.md`
- ellamaka-app package rules: `packages/ellamaka-app/AGENTS.md`
- desktop package rules: `packages/ellamaka-desktop/AGENTS.md`

## Architecture and Directories

执行链：OpenCode upstream → ellamaka fork → `--wopal-space` → `.wopal/` ontology → `.wopal-space/` runtime。

| 目录 | 职责 |
|---|---|
| `packages/opencode/` | OpenCode inherited engine 主包；内部规则见 `packages/opencode/AGENTS.md` |
| `packages/ellamaka-core/` | shared core、flags、global paths、installation/runtime 基础能力 |
| `packages/ui/` | inherited UI 组件库；只在 engine/TUI 需要时改动 |
| `packages/plugin/` | workspace support package |
| `packages/sdk/` | SDK workspace；JS SDK regeneration 使用既有脚本 |
| `packages/ellamaka-brand/` | 品牌常量、品牌字模、构建包装、WopalSpace 自动检测、安装路径判断及包级测试 |
| `packages/ellamaka-app/` | Workbench Web UI 前端；内部规则见 `packages/ellamaka-app/AGENTS.md` |
| `packages/ellamaka-desktop/` | Electron 桌面应用，承载 ellamaka-app Workbench 和本地 Ellamaka sidecar；内部规则见 `packages/ellamaka-desktop/AGENTS.md` |
| `docs/` | project DESIGN、API 契约、references、research 和 plans |

### Wopal 集成

Wopal 能力经 `packages/opencode/src/` 下的两个模块组进入引擎：`wopal/`（CLI adapter、contract、schema、SpaceRegistry）与 `workbench/`（会话 provision、会话投影、目录健康）；其 HTTP 面由 `workbench` 与 `wopal-space` 两个 HttpApi 组承载。

- 会话 provision 只接受已登记 Space 和安全的相对目录（路径穿越与未知 Space 一律拒绝）；目录失效不删除 Session。
- 端点行为与错误语义归 [API-CONTRACT](./docs/API-CONTRACT.md) 所有；集成测试位于 `packages/opencode/test/server/`（`wopal-cli-adapter`、`wopal-space-overview`、`workbench-session-api`）。

## Development Commands

| 场景 | 命令 |
|---|---|
| Lint | `bun run lint` |
| 全仓类型检查 | `bun run typecheck` |
| opencode 包测试 | `bun test --timeout 30000 --force-exit`（from `packages/opencode`） |
| opencode 构建 | `bun run build`（from `packages/opencode`） |
| ellamaka-brand 包测试 | `bun test`（from `packages/ellamaka-brand`） |
| 构建 ellamaka 品牌 CLI | `bun packages/ellamaka-release/src/cli/build.ts --web-ui ellamaka-app` |
| 构建 CLI 二进制 | `./scripts/build.sh cli` |
| 构建桌面应用 | `./scripts/build.sh desktop` |
| 发布 CLI（一步制） | `./scripts/release-cli.sh [--patch\|--minor\|--major\|--rc] [--dry-run]` |
| 发布 Desktop（一步制） | `./scripts/release-desktop.sh [--patch\|--minor\|--major\|--beta] [--dry-run]` |
| 撤回已发布版本 | `./scripts/withdraw-release.sh <cli\|desktop> [--channel stable\|beta] [version]` |
| 开发服务（TUI/Workbench/桌面） | `./scripts/dev.sh` |
| 桌面包测试 | `bun test --preload ./electron-mock.ts --force-exit src`（from `packages/ellamaka-desktop`） |

测试不能从 repo root 运行。`./scripts/dev.sh help` 和 `./scripts/build.sh help` 查看完整参数说明。

## Implementation Rules

### WopalSpace 定制约束

- WopalSpace 定制优先放在新文件；上游文件只保留最小 import 和调用注入点。
- 定制分支使用提前返回 guard，避免与 upstream 主流程改动重叠。
- 新模块需要访问 upstream 内部能力时优先用回调/闭包注入，不直接暴露 upstream Service 类型边界。
- 复用 upstream 逻辑时提取共享 helper，不复制大段 upstream 流程。
- 禁止对 upstream 文件做无关格式化重排、import 重排、dependency 重排或 object key 重排。
- `.gitattributes` 不包含 `merge=ours` 规则；冲突一律显式逐文件解决，禁止添加 merge 策略驱动。

### HTTP API 与 SDK 契约

- 新端点遵循 `docs/API-CONTRACT.md`。先确认领域 Owner、Root/Instance 层级、既有 group 和资源语义，再定义 Effect Schema、请求、成功结果、领域错误与兼容性。
- 端点归入 `HttpApiGroup`。全局 WopalSpace 控制能力归 Root API，Session、文件、项目、PTY 和工作目录能力归 Instance API。handler 只转换 HTTP 与领域服务。
- 路径表达领域资源与自然从属关系。查询条件属于 query 参数。文件系统、Shell、CLI 执行和目录 provision 由所属领域服务拥有，不形成浏览器可直接调用的通用原语。
- SDK 由 Effect HttpApi → OpenAPI → `packages/sdk/js/script/build.ts` 自动生成。应用代码使用生成客户端；`packages/sdk/js/src/v2/gen/**` 由生成管线拥有。
- 新增或修改端点必须测试 schema、成功结果、领域错误和 middleware 边界，重新生成 SDK，并同步更新相关 DESIGN 文档。
- **SDK 重新生成是全有或全无**：任何 payload schema 变更后，必须从 `packages/sdk/js` 运行 `bun script/build.ts`（禁止手改 gen 文件）。一个字段只有当 `types.gen.ts` 和 `sdk.gen.ts` 同时包含才算落地——仅类型层存在不是证据；陈旧的 `buildClientParams` 映射会在编码期静默丢弃字段且无报错（见 [ellamaka 设计](./docs/DESIGN.md) 的 SDK generation 一节）。用 `rg "<fieldName>" src/v2/gen/` 验证命中两个文件，或 diff 重新生成的输出。
- **权限规则：显式仅靠位置胜过通配**：求值按合并规则集 LAST-wins，且一个 agent 的 frontmatter 可能来自多份副本（`~/.wopal` home + space `.wopal`）按加载顺序深度合并。frontmatter 不得声明 `"*": allow` 式通配（引擎默认已提供通配兜底），只允许显式收窄。修改权限 frontmatter 后，通过 `GET /agent` 在活实例上验证显式规则位于合并列表中任何通配之后（见 [ellamaka 设计](./docs/DESIGN.md) 的 permission merge 一节）。

### Workbench 前端开发

Workbench 前端开发规则（状态所有权、身份作用域、依赖方向、PTY 生命周期、effect 竞态防护、持久化、测试等强制边界）见 `packages/ellamaka-app/AGENTS.md`。本文件不重复这些规则，修改 Workbench 前端代码时必须遵守该规范。

### CLI 发布契约

- 发布构建入口（`packages/ellamaka-release/src/cli/build.ts`）是已发布 CLI 二进制（`scripts/build.sh cli`、CI `publish-ellamaka-cli.yml`）的唯一打包点。其 `define` 块必须保留 `"process.env.MIN_WOPAL_CLI_VERSION"` 条目——值由 `scripts/build.sh` 导出（经 `resolve_min_wopal_cli_version`），未设置时经 `readMinWopalCliVersion` 回退读取 `.ci/versions.json`。运行时（`packages/opencode/src/wopal/cli-contract.ts`）在模块加载期 fail-closed，且编译产物跳过源码树文件回退：丢失或拼错该 define 的构建在构建机上仍能通过自身烟测（checkout 存在使回退路径可解析），但在所有最终用户机器上启动即崩。移动或拆分构建入口时，必须同步迁移该 define。

### Desktop 发布契约

- `main` 只用于 `build.sh desktop --channel main` 本地构建验证。发布 workflow 只接受 `beta` 和 `stable`。
- Windows Desktop UI 变更必须经原生 Windows CI 和运行时验证。macOS 构建不足以替代该验证。
- 发布 workflow 只使用原生支持 Node 24 的官方 JavaScript action。新增或升级 action 前必须检查其 `action.yml`，确认 `runs.using` 为 `node24`。`FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` 只作兼容保护，不能替代升级。发布 workflow 测试锁定已批准的 action 基线。
- 产品版本使用 namespaced tag（`ellamaka-cli-vX.Y.Z`、`ellamaka-desktop-vX.Y.Z`），遵循 [Tags 与 Channels](./docs/DESIGN-distribution.md#tags-与-channels)。已提交 release 不可变：同一 `product + version` 的 tag 不得删除、移动或重新 build。提交前 failed attempt 可在受控清理后同版本重试；提交后重大失败需整版撤回（记入 `release/withdrawn-versions.json`、恢复 aliases、删除版本化对象），版本号永久作废。
- Windows 退出会等待 SidecarSupervisor 停止，再终止 Electron。
- beta 版本使用 `X.Y.Z-beta.N`，发布到 `ellamaka-desktop/beta/`。stable 发布到 `ellamaka-desktop/`。
- sidecar、Electron Main/Renderer、图标和 electron-builder 共用同一组 channel/version 环境变量。
- macOS 公共包使用 ad-hoc 签名。它保证 bundle 签名结构完整，但用户仍需主动接受 Gatekeeper 风险。
- 版本化 R2 路径不可变。提交前 failed attempt 可清空自身 partial 对象后同版本重试；提交后 release 不得覆盖。整版撤回遵循 [Failed Attempt and Whole-Version Withdrawal](./docs/DESIGN-distribution.md#failed-attempt-and-whole-version-withdrawal)。
- 下载表展示 DMG、EXE、AppImage 和 deb。ZIP、blockmap 与 `latest-*.yml` 属于 updater 资产。

### Cordis 开发约束

- **依赖边界**：`@deepseek-ai/cordis` 只出现在 `@wopal/ellamaka-cordis` 包内（版本以该包 `package.json` 为准，不在文档中复述）；dsh 深耦合包（agent-loop/session/session-query/compaction/subagent/schedule）暂不进入主线运行时（见 [ellamaka 主设计](./docs/DESIGN.md) 现行约定——PoC 阶段无红线，变更需用户+Wopal 联合确认）；运行时加载探针（`forbidden-load.test.ts`）保留为观测工具
- **桥接形态**：Effect↔async 桥接一律遵守 [ellamaka 主设计](./docs/DESIGN.md) 中的桥接 API 规范（`Effect.forkIn(scope)(work)` 持有 work Fiber；中断经 `runtime.runFork(Fiber.interrupt(fiber))`；禁止 `runPromise` 驱动长任务）
- **契约纪律**：契约在 `@wopal/ellamaka-cordis` 内自持（形状借鉴 dsh，不 import dsh 契约包、不跟随 rc 演进）；外部插件须通过契约符合性冒烟测试方可挂载（见 [工具容器设计](./docs/DESIGN-ellamaka-tools.md)）
- **测试门禁**：桥接包自带测试放 `packages/ellamaka-cordis/test/`；跨包行为由 opencode 侧的 `test/cli/serve/dsh-mount.test.ts`、`test/cli/cmd/tui/dsh-mount.test.ts`、`test/server/dsh-single-port.test.ts` 等承接；桥接包变更保持这些测试零回归
- **事件折叠为最后者生效**：dsh 会话事件（`sandbox/mode`、`approval/policy`）按最后一条折叠。「恢复默认」必须显式追加默认值；「等于默认」与「未选择」是两种语义，绝不共用代码路径（见 [工具容器设计](./docs/DESIGN-ellamaka-tools.md) 的审批桥接与折叠不变量）。断言「值相同则不追加」的测试锁死了错误语义，除非日志中本就没有任何覆盖。
- **活家目录隔离（dsh in ellamaka）**：引擎运行期间，引擎进程之外的任何东西不得写入 `$WOPAL_HOME/dsh/home/profiles/` 之下——包括内容未变的"幂等"写入（loader 的常驻重建以组合文件的 mtime/size 为键而非内容，同内容写入会与引擎竞态，可能触发 tool-cordis 注册冲突错误风暴）。会触碰 profile 文件的测试、dump 与诊断一律经注入对临时 home 运行（`dumpDshConfig`/`mountDshWeb` 接受 `dshHome`/`installAnchor`）；CLI 测试只断言定义或使用注入的临时 home，绝不触碰真实 `Global.Path.wopalHome`。引擎重启是用户的动作；宿主不修理活 home。插件安装区就是 profile 自己的 `node_modules/` + profile `package.json` 声明（官方语义）——旧 `plugins/` 安装区与 `installed.json` 存储已退役（遗留 store 文件在下次 CLI 运行时一次性迁入 profile 清单）。
- **工具链隔离——dsh profiles vs wopal root**：dsh profile 插件由 Bun installer 安装进各 profile 自己的 `node_modules/`。官方 `dsh` CLI 是 pnpm 壳；任何命令都不得指向 `$WOPAL_HOME/dsh/home`——wopal root 下的 `pnpm-workspace.yaml` 会让 pnpm 上爬把 `$WOPAL_HOME` 当作 workspace root，列出 root 依赖而非 profile 插件，并在 add/remove 时摧毁 Bun 管理的拓扑（2026-09-09 实测）。`$WOPAL_HOME` root 依赖只归 npm/arborist 工具链所有（`package.json` + `package-lock.json`）；禁止在 wopal root 运行 `pnpm install` 或 `bun install`——它会覆盖 node_modules 布局，产生三锁文件污染（同一依赖集上 npm/pnpm/bun 三锁并存，2026-09-09 实测）。
- **宿主不修理运行中的 dsh home**：闭包物化归 Runtime Manager 在启动时完成，闭包缺失或损坏自动触发。禁止要求用户运行修复脚本，禁止手工编辑 `$WOPAL_HOME/dsh` 内容来修启动故障。
- **Bun 宿主兼容门禁**：发布态 `ellamaka serve` 是单 Bun 进程。用户插件不得要求 Node 私有模块加载器或 `--expose-internals`。`plugin add` 必须在写入 profile 声明与触碰运行中容器之前完成静态依赖扫描与隔离挂载预检；不兼容插件拒绝安装并给出可操作诊断。禁止伪造 `loader.internal`、禁止切换到 Node、禁止降级整台宿主来绕过。官方 Node 专用的 `cordis-plugin-hmr` 是宿主侧例外：Bun 路径以 Bridge 的 HMR 适配器替代，该例外不得转嫁给第三方插件。
- **插件安装零外部工具链**：安装器禁止转发 pnpm 或 npm。它复用 Runtime Manager 的 pacote 下载与 registry 测速基建，用户插件的依赖树由内置最小解析器在运行时解析。
- **安装共享、启用按 profile**：安装是进程级动作（安装/升级/卸载全局一次），激活按容器经 profile bundle 清单声明。禁止同一进程内运行同一包的两个版本。
- **工具容器不创建会话**：工具调用走专用 `ellamaka-tools` profile。容器不创建、不持有任何 dsh 会话，adapter 只传递工具实测消费的最小 per-call context。web 容器保持完整 profile，禁止复用为工具后端。禁用清单是 profile 的用户补丁层：ellamaka 仅在模板为空时播种，永不覆盖用户编辑。
- **`ELLAMAKA_DSH` 是唯一启用开关**：默认开启。serve、web、TUI 与 Desktop sidecar 统一经 `ELLAMAKA_DSH=0` 禁用。禁止引入第二条启用分支。
- **DSH 领地只有 `$WOPAL_HOME/dsh`**：依赖闭包、profile 定义与运行时数据都在这里。宿主在进程启动时设置 `DSH_HOME=$WOPAL_HOME/dsh/home`；集成代码不为自己的路径读取该环境变量。`~/.dsh` 归官方 dsh CLI，禁止在其中创建、修改或删除任何内容。
- **多 profile 隔离**：核心容器（web 与 `ellamaka-tools`）保持同进程。实验性第三方 profile 以独立进程运行并带独立 DSH_HOME，不进入主 Web 容器、不与主引擎共享 home 或 profiles——运行中引擎的 `profiles/` 是引擎领地。闭包只读、可共享；home 必须隔离。
- **壳单端口不变量**：renderer 只从唯一 http origin（server 端口）加载 UI。壳不承载引擎逻辑，不新开第二个监听端口。引擎产物只有一个形态——完整 CLI 二进制，禁止维护第二套分叉的引擎构建产物。`/dsh` 保持前缀挂载不升根，`/` 是设备协商前门（移动 UA → `/dsh/`，桌面 UA → `/workbench`）。

### 日志规范

- **插件日志**：cordis 插件内一律用内建 `ctx.logger`（自动以插件名命名），禁止 `console.log`、禁止手动创建 Logger；容器级 Exporter 在装配层统一桥接到 ellamaka `Log` 体系（见 [工具容器设计](./docs/DESIGN-ellamaka-tools.md)），插件不关心日志输出目标
- **必须打**：生命周期状态变更（init/created/disposed/mount/unmount）、错误与异常（含降级路径）、关键决策（选型/回退/跳过）
- **禁止打**：循环内逐项操作（逐文件/逐条）、成功路径的常规操作（每次加载/每次搜索）、可从上下文推导的信息
- **聚合**：循环内需观测时，循环外打一次汇总（`log.info("reverted", { count })`），不在循环体内逐项打
- **结构化**：上下文用 `extra` 字段携带（`log.info("reverting", { file, hash })`），禁止拼接进 message；message 用固定动词短语便于检索
- **禁止静默吞错**：catch 后必须打日志（error 或 warn），不得空 catch
- **级别**：默认 `INFO`；`debug` 仅诊断用，生产模式不输出
- **Trace 按类别 opt-in**：`TRACE` 是第五级，低于 `DEBUG`。它承载正常运行绝不输出的高容量生命周期记录。经 `log.trace(category, message, extra)` 输出（Effect 代码：`EffectLogger.create(...).trace(...)`）。仅有级别不会输出任何记录——只有类别被显式选中时才写入。类别是封闭注册表（`Log.TraceCategory`）：`bus`、`permission`、`session`、`llm`、`plugin`、`io`。新增类别必须同时有调用点和[日志设计](./docs/DESIGN-logging.md)中的一行记录，禁止例外。
- **Trace 不承载 payload 或用户数据**：bus trace 只记录事件类型；permission trace 记录权限名、决策 `action`（`allow|ask|deny`）、`escalated` 标记、计数与回复结果；session/LLM trace 记录步骤计数与 runtime/model 标识符。绝不写入事件 payload、prompt 或消息内容、tool 参数、求值后的 pattern、命令、路径、session id 或 pending request 内容。显式 `--log-level` 永远压过 `--trace` 提升
- **Authority**：[日志设计](./docs/DESIGN-logging.md) 是日志策略的详细版（路由、文件、channel、DSH 分类、trace 类别、脱敏）。任何日志行为修改必须同步更新它

### 调试日志

诊断 serve、TUI 或 sidecar 行为时，通过日志级别放宽输出，而不是往代码里加临时记录。级别机制全组件统一：`--log-level`（引擎进程树）> `ELLAMAKA_LOG_LEVEL` > `wopal.logging.level`（`$WOPAL_HOME/config/settings.jsonc`）> `INFO`。TRACE 总是带类别名；`--log-level TRACE` 不带 `--trace` 是被有意拒绝的。

| 场景 | 命令 | 说明 |
|----------|---------|-------|
| 列出 trace 类别 | `ellamaka serve --trace` | 打印注册表后退出 |
| 默认（安静、结构化） | `ellamaka serve` | 只有 `INFO`、warning 与失败 |
| 权限 + 事件生命周期 | `ellamaka serve --trace permission,bus` | 级别提升为 `TRACE`；其余类别保持静默 |
| Session/LLM 循环细节 | `ellamaka serve --trace session,llm` | 历史上刷爆日志的两个循环 |
| 插件与 I/O 启动 | `ellamaka serve --trace plugin,io` | 插件加载、MCP 连接、LSP/format 活动 |
| 全部类别（逃生口） | `ellamaka serve --trace all` | 必须显式；没有隐式 all |
| 实现诊断 | `ellamaka serve --log-level DEBUG` | 有界，仍脱敏 |
| 压过 trace 提升 | `ellamaka serve --log-level INFO --trace bus` | 显式级别生效；不输出 `TRACE` 记录 |

- 日志位置按角色分域：`serve`/`sidecar`（含 `web`）恒写全局 `$WOPAL_HOME/logs/`；交互角色 `tui` 在空间内启动时写 `<space>/.wopal-space/logs/`，空间外回落 `$WOPAL_HOME/logs/`。dev（`dev.sh`）以 `WOPAL_DEBUG_LOG_DIR` 覆盖目录到 `.wopal-space/logs/dev/<scope>/`，dev 文件名稳定为 `ellamaka-dev-<role>.log`。同一目录保留最新 10 个带时间戳文件。
- DSH 只有四级，宿主 `TRACE` 在边界映射为 DSH `DEBUG`；DSH 日志文件为 `$WOPAL_HOME/logs/dsh-runtime.log`（单文件）与每 profile 一个有界 `dsh-plugins-<profile>.log`（`web`、`ellamaka-tools`）。
- 若某类别的记录缺失，先确认类别在 selector 中（显式 `--log-level` 压过 `--trace`，未知类别启动即被拒绝）。

## Testing

- 代码类变更遵循 TDD：先写能失败的测试，再实现代码使其通过。
- 提交前运行 `bun run lint`（全仓存量 warning 作为 baseline 容忍）。**本次改动到的文件必须通过 `bunx oxlint --deny-warnings <files>`**（`<files>` 传改动文件列表，如 `git diff --name-only HEAD~1 \| grep -E '\.tsx?$' \| xargs bunx oxlint --deny-warnings`）：不得为改动文件新增任何 warning，与全仓 warning 总数无关。
- 改动文件用 `bunx prettier --write <files>` 格式化；`bunx prettier --check --ignore-unknown <files>` 必须通过。
- 修改任何 TypeScript 代码或新增文件后，必须运行 `bun run typecheck`（或对应 package 的 typecheck），确保零 TypeScript 类型错误。
- 尽量避免 mocks；测试真实实现，不要把实现逻辑复制进测试。
- 测试从对应 package 目录运行，不要从 repo root 运行。
- 修改 CLI/runtime/config/plugin/agent/TUI space mode 后，验证或说明：`WOPAL_SPACE` flag、`.wopal/config/settings.*`、TUI settings、plugin loading、theme loading。
- 选用 OpenCode 参考仓库代码时，区分参考实现的已知失败、环境问题和 ellamaka 特有问题。
- 测试安全运行规则（防挂起与孤儿进程）见空间 `REGULATIONS.md`。

### 手动验证入口

Agent 无法自动验证的行为（GUI 交互、引导流程、桌面壳）通过以下入口交给用户手动验证。

| 入口 | 命令 | 环境隔离 |
|------|------|----------|
| Desktop（常规） | `./scripts/dev.sh desktop` | 使用真实环境；首次需加 `--rebuild` 构建 sidecar |
| Workbench / 后端 | `./scripts/dev.sh serve` | 端口 4096；`--cdp-debug` 开启 9222 CDP |
| TUI | `./scripts/dev.sh tui` | 默认内嵌后端 |
| 停止 | `./scripts/dev.sh stop <backend\|frontend\|desktop\|all>` | — |

- 日志：`.wopal-space/logs/dev/<scope>/ellamaka-dev-{tui,serve,sidecar}.log`（`<scope>` 由 worktree 路径派生）。
- Plan 的 User Validation 必须引用本表并给出用户可直接复制执行的命令，不得只写"启动应用"之类的泛指。

## User-Supplied Rules

- JS SDK 重新生成：`./packages/sdk/js/script/build.ts`。
- 本仓库默认分支是 `main`。ellamaka 已停止跟踪 upstream OpenCode（2026-08-31）；`dev` 分支不再用于 upstream merge 集成。
- diff 基准使用 `main` 或 `origin/main`。需要参考 upstream OpenCode 模块代码时，读取空间内的 `labs/ref-repos/opencode/`。
- 优先自动执行明确请求；遇到缺少关键信息、安全风险或不可逆操作时先确认。
