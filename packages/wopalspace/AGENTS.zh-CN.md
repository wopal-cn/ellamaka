---
name: WopalSpace 模块开发规则
description: WopalSpace 应用层模块长期适用的架构、实现、测试、调试与验证约束
maintenance: 仅当模块出现长期有效且无法由代码、测试或 DESIGN 自身承载的开发、测试、调试或验证约束变化时维护本文件；只记录会影响未来 Agent 决策的规则，禁止写入一次性任务、实现事实、故障记录或可从代码直接得出的说明。
---

# Agent Development Rules

## Canonical References

- 上位项目规则：[../../AGENTS.md](../../AGENTS.md)。
- WopalSpace 业务边界与行为契约：[../../docs/DESIGN-wopalspace.md](../../docs/DESIGN-wopalspace.md)。
- Public Platform API、HttpApi、OpenAPI 与生成 SDK 边界：[../../docs/DESIGN-ellamaka-sdk.md](../../docs/DESIGN-ellamaka-sdk.md)。
- 本文件只记录在本模块内长期有效、会影响开发质量的工作约束；详细流程、数据模型和 API 定义以 DESIGN 为准。

## Architecture and Directories

`@wopal/wopalspace` 是 Ellamaka 内部的 private WopalSpace application service。它实现 WopalSpace 业务规则，由 Server 组合并通过统一 Public Platform contract 暴露；Runtime、Session、Agent、PTY、Tool 等底层模块不得反向依赖本模块。

### Source organization

- `src/` 第一拆分维度是业务域。当前稳定 owner 是 Setup、Ontology、Space、Product Settings；一个域从单个内聚文件增长到多个职责时，再收敛到对应的 `src/<domain>/`，不要为了目录对称提前创建空层级。
- 不按 Web、CLI、Desktop 等调用方复制业务实现，也不在包顶层按 `services/`、`models/`、`adapters/` 这类技术层横切所有业务域；领域代码应从路径直接看出 owner。
- 每个领域自行拥有其 domain types、规则、service 和领域专属 adapter/helper。领域之间只通过明确导出的 contract/service 依赖，禁止 deep import 另一个领域的内部实现。
- `src/index.ts` 只定义 package export boundary；不得承载业务流程、I/O、bootstrap、资源生命周期或复杂状态判断。
- 只有两个以上领域确实复用、且语义已经稳定的能力才提升为 shared；shared 必须按具体职责命名。禁止把无明确 owner 的代码堆进泛化 `utils`、`common`、`helpers`。
- Git、filesystem、process、credential 等低层能力保持窄接口并隐藏在业务 operation 后面；只有真正跨领域复用的基础能力才共享，不能让低层 adapter 反过来成为业务组织中心。
- 拆分以“职责独立、变化原因不同、可单独测试”为依据。不要为了形式引入只有一个实现、没有替换需求的 factory/interface/layer，也不要让单个 service 长期同时承担多个独立业务职责。

### Test organization

- `test/` 先按测试层级组织，再按业务域组织：unit 与 integration 分开；域内测试应与 `src/` 的业务 owner 对应，而不是按调用方或具体实现文件机械镜像。
- 随测试规模增长，unit/integration 测试分别收敛到对应领域目录；跨领域 package contract、import purity 等真正属于包边界的测试可以保留在独立 boundary/contract 位置，不强行归入某个领域。
- 领域专属 fixture/helper 放在该领域测试附近；只有多个领域真正复用的临时 Home、Git repo、remote/worktree 等构造能力才进入共享 `test/fixtures`。共享 fixture 只负责构造和清理环境，不得隐藏业务判断或断言。
- 测试名称和路径应表达“层级 + 业务行为”，使 Agent 不打开文件也能判断 owner 和执行层；内部源码重构不应迫使无行为变化的测试大规模搬家。
- 测试目录结构服务于自动发现，不以逐文件登记维持覆盖；新增领域测试必须自然进入 package-local 和 root runner 的对应测试层。

## Development Commands (build format test)

以下命令均使用仓库现有工具，不为本模块另建测试框架。

| 场景                 | 命令                                                                                          | 执行位置               |
| -------------------- | --------------------------------------------------------------------------------------------- | ---------------------- |
| Unit tests           | `bun run test:unit`                                                                           | `packages/wopalspace/` |
| Integration tests    | `bun run test:integration`                                                                    | `packages/wopalspace/` |
| 全部包内测试         | `bun test`                                                                                    | `packages/wopalspace/` |
| Typecheck            | `bun run typecheck`                                                                           | `packages/wopalspace/` |
| Test isolation gate  | `bun run check:test-isolation`                                                                | 仓库根目录             |
| 根级定向 unit        | `bun run packages/opencode/script/run-tests-root.ts --layer unit --package wopalspace`        | 仓库根目录             |
| 根级定向 integration | `bun run packages/opencode/script/run-tests-root.ts --layer integration --package wopalspace` | 仓库根目录             |

## Implementation Rules

- 本模块只实现 WopalSpace application 业务。不得把 Runtime、CLI presentation、Product lifecycle、Evolution、Skill lifecycle、Scheduling 等其他 owner 的职责吸收到这里。
- Domain/service 层不得依赖 HTTP、CLI 或 UI 类型。transport、认证、HttpApi error mapping 和 presentation 留在外层 adapter/host。
- 可复用的公开能力只通过 canonical contract → Server HttpApi → Public Platform SDK 暴露；不得另造第二套 HTTP/RPC/DTO contract。
- 不提供任意 filesystem、Git、Shell 或 process 执行能力。所有底层能力必须被具体业务 operation 约束并限制在其拥有范围内。
- 所有路径操作从可信宿主上下文解析，执行规范化、realpath 与业务范围校验；调用参数不得替换宿主根目录或扩大访问范围。
- Query / inspect 类型操作保持只读，不因查询而创建 Runtime、启动后台任务或产生隐藏持久化副作用。
- 带 preview/apply 语义的写操作必须复用同一套判定逻辑；preview 零写入，apply 在第一处持久化前重新读取并验证关键事实。
- 多步骤写操作必须定义清晰的提交、取消和恢复边界；失败后返回可解释状态，不留下无法判断来源的半完成结果。
- 用户已有文件、无关 dirty changes 和已持久化状态默认受保护；只能修改当前 operation 明确拥有的 touch-set。
- Secret 只进入确实需要它的执行边界，禁止写入 plan、持久状态、事件、错误详情或日志。
- Package import 必须保持纯净：仅 import 本模块不得创建目录、修改 `$WOPAL_HOME`、启动进程、访问网络或注册后台任务。
- 并发工作必须有明确 owner。相同资源上的 single-flight、取消、清理和 retry 使用可测试的 service/state 边界，不依赖不可控的进程级隐式状态。

## Testing

- Unit test 只覆盖纯领域规则和通过依赖注入可完全控制的 service 行为。真实 Git、网络、子进程、filesystem watcher 和真实时钟不得进入 unit 层。
- Integration test 覆盖真实 filesystem、Git repository/remotes/worktree/sparse、持久化、受控进程和外部 adapter 边界；全部使用临时环境与临时仓库。
- 测试不得读取或修改真实用户 `$WOPAL_HOME`、真实 Space、真实工作仓库或真实远端写资源。测试需要 Home 时必须显式创建并传入隔离目录。
- 对 preview/apply、partial success、cancel/retry、dirty-state protection、path confinement、secret redaction 等长期业务 invariant，必须保留自动化回归覆盖。
- Preview 测试必须同时证明结果正确和零写入；apply 测试必须验证实际副作用与 preview 判定一致，并覆盖失败后的保留/恢复状态。
- 新测试必须自动进入所属 unit 或 integration layer。测试入口不得长期依赖逐文件手工登记，从而允许新增测试被静默漏跑。
- 修改 test、fixture、preload、test config 或测试入口时，必须运行根级 `bun run check:test-isolation`；同时确认根级 test orchestration 仍包含本模块，且执行文件集合没有意外缩水。

## Debugging and Verification

- 调试、手工验证和真实进程 smoke 一律使用隔离 `WOPAL_HOME`、临时仓库和受控 credential；不得拿真实用户 Home/Space 作为测试环境。
- 修改本模块 TypeScript 必须通过 `bun run typecheck`；改动代码文件还必须遵循上位规则的 `oxlint --deny-warnings` 与 Prettier 检查。
- 修改 Server/SDK contract 时，除本模块 service 测试外，还必须在真实 HttpApi/生成 SDK consumer 边界验证；内部 service 绿灯不能替代跨边界验证。
- 修改测试层级、runner 或 package scripts 时，分别运行 package-local 与根级定向命令，确认两条入口执行同一预期测试层。
- 日志、错误和诊断输出遵循 Ellamaka 根日志规范；不得为调试记录 secret、用户文件内容、命令参数或无界子进程输出。

## Code Review Rules

代码变更评审使用空间已装配的 `df-implement-review`；Plan / 提案评审使用 `df-proposal-review`。只报告当前 diff 引入、具有明确触发条件和行为影响的缺陷；不要把既有问题、风格偏好或已经由 CI 机械保证的事项当成评审缺陷。

### WopalSpace 专项检查

- 检查职责是否越过 WopalSpace application owner 边界，或形成第二套公开 contract。
- 检查源码是否按业务 owner 保持内聚，是否出现跨域 deep import、调用方复制、技术层横切、万能 shared 目录或没有实际价值的提前抽象。
- 检查 query/import 是否引入隐藏副作用、Runtime bootstrap、网络或进程活动。
- 检查路径是否始终受宿主根和业务边界约束，是否存在 realpath/符号链接逃逸。
- 检查 preview 与 apply 是否共享判定逻辑，写前重验、partial-success、cancel/retry 与失败恢复是否仍可解释。
- 检查用户内容、dirty changes、持久状态和 secret 是否保持受保护边界。
- 检查测试是否落在正确层级、使用隔离 fixture，并确认新增测试不会被 package-local 或 root runner 静默漏掉。

## User-Supplied Rules

- 本模块继承上位 `../../AGENTS.md` 中的用户规则；没有额外的模块专属用户规则。
