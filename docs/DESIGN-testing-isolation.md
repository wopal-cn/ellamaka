# DESIGN — Test Isolation

> **Status**: Active
> **Updated**: 2026-11-25
> **Parent**: `./DESIGN.md`
> **Parent Architecture**: `../../../docs/products/wopal-space/DESIGN.md`
> **Parent Product**: `../../../docs/products/wopal-space/PRD.md`
> **Scope**: 全仓所有拥有可执行测试文件的 package（含 `test/`、`src/`、`script/` 与嵌套包）的隔离模型、Home 基座契约、静态/运行时门禁与验证边界

本文件定义 Ellamaka 测试隔离的现时契约：隔离模型选择、包级 Home 基座、TISO 门禁判定、收缩基线与稳定性验证边界。跨项目测试原则与 TDD 语义由 WopalSpace 装配的 `testing.md` 统一拥有；Agent 日常命令与执行守则由根 `AGENTS.md` 拥有；本文只拥有 Ellamaka 特有的进程隔离规则、门禁语义与校验契约。

## Overview and Scope

单个 Bun 测试进程中的所有测试文件共享同一份 `process.env`、模块注册表、文件系统路径以及 Effect 单例与缓存。任何进程级变更如果在文件结束前未可靠还原，污染就会沿后续加载顺序扩散，典型表现为因文件加载顺序差异引起的「本地通过、CI 失败」或随机失败。

**Owned Here**：三种隔离模型的优先级与适用边界、包级 Home 隔离基座契约、`TISO001`–`TISO009` 与 `TISO101`–`TISO102` 门禁语义、四元组收缩基线契约、故障模拟与稳定性验证规则。

**Handled Elsewhere**：通用测试原则与 TDD 判定由 WopalSpace 装配的 `testing.md` 拥有；Agent 测试行为守则写在根 [AGENTS.md](../AGENTS.md)；lint、格式化与 CSS 门禁由 [Static Quality Gates](./DESIGN-quality-gates.md) 拥有；CI 触发策略由 [Distribution](./DESIGN-distribution.md) 拥有。

**Source Carrier**：门禁检查器在 `packages/opencode/script/test-isolation/`，基线账本在 `.ci/test-isolation-baseline.json`，OpenCode 运行时基座在 `packages/opencode/test/preload.ts` 与 `packages/opencode/test/lib/temp-root.ts`，环境变量 scoped helper 在 `packages/opencode/test/fixture/process-env.ts`、`packages/ellamaka-core/test/fixture/process-env.ts` 与 `packages/ellamaka-cordis/test/fixture/process-env.ts`，顺序隔离检查在 `packages/ellamaka-app/script/check-test-order-isolation.ts`，CI 与本地副本在 `.github/workflows/ci.yml` 与 `packages/opencode/script/ci-local.sh`。

## Usage and Interface Contracts

门禁通过仓库根 `package.json` 与 `packages/ellamaka-app/package.json` 暴露以下入口：

```text
bun run check:test-isolation                         # 全仓静态扫描 + 基线校验；新违规、次数上升或 stale 均退出码 1
bun run check:test-isolation -- --fix                # 仅允许收缩扣除已修债务；发现任何新违规或次数上升时拒绝写入并退出码 1
bun run test:isolation-gate                          # 运行门禁检查器自身单测与策略测试（baseline / scan / policy / preload-exit）
bun run --cwd packages/ellamaka-app check:test-order-isolation  # ellamaka-app 正序、倒序与成对组合顺序隔离回归检查
```

调用方契约：

- **`must`**：任何改动测试文件、fixture、preload 或测试配置的变更，在运行所属 package 测试前必须在仓库根执行 `bun run check:test-isolation`。
- **`must`**：临时测试文件或目录只能写入 `.wopal-space/.tmp/` 或所属 package 的 scoped 临时目录 fixture，并在 `finally` 或异步销毁钩子中清理；禁止对仓库根 `.tmp` 或任何 `packages/*/.tmp` 创建目录（由 `policy.test.ts` 拦截）。
- **`must not`**：禁止手工放大 `.ci/test-isolation-baseline.json` 中的条目、次数或新增目标；禁止复制或通过重命名环境变量名/API 来继承旧基线额度。
- **`may`**：固定 process preload（如 `packages/ellamaka-desktop/electron-mock.ts`）与精确单文件扫描器负样本（如 `packages/ellamaka-app/script/fixtures/src/leaky.test.ts`）通过 `rules.ts` / `scan.ts` 中的精确路径白名单登记，不进入债务基线。

## Isolation Models and Selection Rules

测试需要替换外部依赖或控制运行环境时，按以下优先级从高到低选择隔离模型。

### Dependency Injection

优先将外部依赖抽象为可注入接缝（service、factory、`Layer.mock`），生产环境提供真实实现，测试注入替身。这是同进程内最可靠的隔离方式：替身作用域限定于当前 Effect layer 或单个测试用例，不依赖全局还原，也不受文件加载顺序影响。

仓库现行模式包括：

- `Layer.mock(Service, { ... })`：只实现测试关心的服务方法，其余方法抛 `UnimplementedError`，用于捕获意外调用。
- `MCP.ClientFactoryService`：默认装配真实 SDK，测试通过替换 factory layer 注入 client/transport 替身。

**适用条件**：被替换对象为模块、单例、共享服务、网络出口、文件系统路径或任何其他测试也可能访问的资源。

### In-Process Scoped Mutation and Restoration

仅对修改后能够可靠且完全还原的状态使用同进程临时覆盖：

- `spyOn(obj, "method")`（配合 Bun 的 `mock.restore()` 恢复）
- 读取发生在**调用时**而非 import 时的少数 `process.env` 键，通过各包 `test/fixture/process-env.ts` 导出的 `scopedEnv` 修改与还原
- fake timers
- 落在**任何 Git 仓库之外**的每测试独占临时目录
- 明确由单个测试用例/helper 拥有的 `globalThis` 槽位

**外部临时目录约束**：本工作区要求 Agent 将临时文件写在 `<space>/.wopal-space/.tmp`，但该路径位于空间仓库内部。若测试 fixture 在仓库内部创建临时 Git 仓库并执行 `git rev-parse` / `git worktree add`，Git 会向真实 checkout 的 `.git/worktrees` 注册工作树；删除临时文件后，幽灵 worktree 注册仍残留在真实仓库中。因此 `packages/opencode/test/lib/temp-root.ts::resolveTempRoot()` 会跳过落在任何仓库内部的候选路径，`packages/opencode/test/preload.ts` 在创建任何目录前先将 `process.env["TMPDIR"]` 重定向至该外部根，并在 `afterAll` 结束时同时检查进程所在仓库与原 `TMPDIR` 所在仓库是否存在孤儿 worktree 注册。

**进程独占测试 Home 与清理**：OpenCode preload 为每个测试进程创建带 PID 与随机后缀的临时 Home 目录（`<tempRoot>/opencode-test-data-<pid>-*`），并写入归属标记文件 `.opencode-test-owner`。正常结束由 `afterAll` 关闭数据库、触发 GC 并带重试删除目录；显式调用 `process.exit()` 时由同步 `exit` 钩子清理；针对无法触发退出钩子的 `SIGKILL` 残留，下一次 preload 启动时仅回收「标记匹配且原 PID 已不存在（`ESRCH`）」的目录，无标记或原进程仍存活的目录保持不动。该机制只处理自身标记的目录，不按名称前缀批量清理。

**Effect 配置缓存限制**：Effect `ConfigProvider` 默认层会在首次读取时快照 `process.env` 并缓存在模块级引用中，事后修改 `process.env` 对其无效。需要按调用读取环境配置时，必须在调用路径显式构造新 provider（如 `packages/opencode/src/server/server.ts` 中的模式），不能依赖全局环境变量变更。

**禁止手写恢复逻辑**：禁止在测试文件中各自手写 `try/finally` 还原 `process.env`；统一收口到所属 package 的 `scopedEnv` helper（缺失时先在对应 package 补充同类非测试 fixture），且禁止在并发测试间重叠修改同一个进程级变量。

### Separate Process

当依赖无法在同进程内安全隔离或还原时，必须将测试运行在独立子进程中：

- 测试 `mock.module` 本身或 module loader 行为
- 目标模块在 **import 阶段**读取 `process.env` 或全局配置
- process preload / bootstrap 流程校验
- `process.exit`、进程信号处理器或 `process.chdir`
- 无法引入 DI 接缝的第三方模块替换
- 同一测试进程内需要互相冲突的多套全局模块定义（例如 `packages/ellamaka-desktop/electron-mock.ts` 作为固定 process preload 占用了 `electron` 替换；若测试需要另一种 `electron` 替身，必须在独立进程中运行）

## Package-Level Home Harness Contract

多包协作环境下，真实 `$WOPAL_HOME` 污染与「本地目录已存在可通过、CI 干净环境报 `ENOENT`」的问题来源于缺少统一的包级基座约束。包发现与基座校验覆盖仓库内全部拥有可执行测试文件的 package，不以顶层是否存在 `test/` 目录为前提，按最近 `package.json` 归属。

### Harness Classification

每个拥有可执行 Bun 测试文件或 Playwright e2e 入口（`test/`、`src/`、`script/`、嵌套包如 `packages/sdk/js`、e2e 入口如 `packages/ellamaka-app/e2e/*.spec.ts`）的 package 必须满足下列两类契约之一：

1. **`home-preload`**：该包真实测试命令通过 `bunfig.toml` `[test].preload` 加载 package-local Home preload（如 `packages/opencode`、`packages/ellamaka-core`、`packages/ellamaka-desktop`），在任何读取 `Global.Path` 的模块求值前将 `WOPAL_HOME` 重定向至进程独占临时目录，且在测试脚本与清理路径中不覆盖或泄露回外部 Home。参考实现见 `packages/opencode/test/preload.ts`。
2. **`no-global-paths`**：扫描器从该包所有测试入口及其沿 import 链可达的测试 helper 出发，均未发现对 `Global`、`Global.Path.*` 或 Home-bound `defaultLayer` 的引用（例如与 Home 无关的 `AppFileSystem.defaultLayer` 不算 Home 绑定）。一旦引入全局路径依赖，必须先升级为 `home-preload`。

**运行时哨兵验证判据**：当调用方将 `WOPAL_HOME` 指向一个独立、空且不存在的哨兵目录时，运行该包的真实测试命令必须全绿；测试结束后该哨兵目录仍未被创建，且调用方真实 Home 未被修改。对 `home-preload` 包，还须在独立 Bun 进程中验证 `Global.Path.wopalHome` 等于 preload 分配的临时 Home（与调用方值不同）且进程退出后临时目录已清理。

### Prohibited Patterns

- 无 `home-preload` 的测试通过绑定 `Global.defaultLayer` 的真实持久化 service `defaultLayer` 进行装配；应改用 `Global.layerWith(...)` 注入临时目录或 `Layer.mock` 注入替身。
- 测试断言隐式依赖开发机预先存在的用户目录或文件。
- 依赖目标父目录碰巧已存在才写入成功。必须遵循「先保证生产写入方自建父目录，再补包级基座，最后迁移测试」的修复顺序。

## Rule-to-Gate Mapping and Baseline Contract

| 规则                                         | 门禁    | 判定方式                                                                                                                           |
| -------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 普通测试不出现 `mock.module`                 | TISO001 | TypeScript AST 扫描，排除精确白名单文件后命中基线外记录即失败                                                                      |
| 环境变量变更必须走 scoped helper             | TISO002 | AST 扫描测试中的 `process.env` / `Bun.env` 赋值或 `delete`                                                                         |
| 不用固定延迟替代同步信号                     | TISO003 | AST 扫描等待型固定延迟调用（`sleep` / `delay` / `setTimeout` / `waitFor` / `Effect.sleep` 等）                                     |
| unit 层不含真实 I/O                          | TISO004 | AST 扫描非 integration 层的子进程执行、`fs.watch`、`@parcel/watcher` 或网络调用                                                    |
| 禁用 `.only`，禁止新增 `.skip` / `.todo`     | TISO005 | AST 扫描 `.only` 与基线外新增的 `.skip` / `.todo`                                                                                  |
| 共享路径必须走 ownership-aware fixture       | TISO006 | AST 扫描直接引用 `Global.Path.*` 或固定 `/tmp` 路径写入                                                                            |
| baseline 不得保留已修复的 stale 条目         | TISO007 | 对比当前源码违规数，任何基线条目出现剩余未命中额度即失败                                                                           |
| 普通测试不直接启用 Bun 进程内 `.concurrent`  | TISO008 | AST 识别 `bun:test` 控制器（含别名、namespace 与链式调用）的 `.concurrent`                                                         |
| 全局路径装配必须具备有效的 Home 基座         | TISO009 | 静态枚全仓测试入口与可达 helper 的 `Global` / Home-bound layer 绑定，核对 `bunfig.toml` preload、脚本参数与赋值顺序                |
| OpenCode 测试不得泄漏 `process.env` 或 `cwd` | TISO101 | `packages/opencode/test/preload.ts` 在 `afterEach`/`afterAll` 比对并校验 `processStateBaseline` 变化，先强制恢复再抛错             |
| worktree 与测试临时根不得污染真实 Git 仓库   | TISO102 | OpenCode preload 重定向 `TMPDIR` 至仓库外并在 `afterAll` 扫描双仓库孤儿 worktree 注册；`policy.test.ts` 断言重定向先于首次目录创建 |

### Special Gate Semantics

- **并发豁免边界（`TISO008`）**：`TISO008` 禁止直接调用 `test.concurrent` / `describe.concurrent`，不禁止在单个测试用例内部对其自身独占资源发起并发操作。`packages/opencode/test/lib/cli-process.ts::cliIt.concurrent` 是当前审查通过的 owner-aware 例外：每次调用独占临时 Home、Effect scope、随机端口测试服务器与子进程生命周期。新增同类 helper 必须证明完全资源所有权并在定义处记录隔离契约。
- **Home 基座静态+运行时闭环（`TISO009` 与 `TISO101`）**：`TISO101` 目前只在装载了 `packages/opencode/test/preload.ts` 的测试运行中生效。`TISO009` 补齐全仓校验：对存在 `Global` 路径依赖的包静态核对 `bunfig.toml` 的 `[test].preload` 配置、命令参数是否覆盖 preload、目标文件是否存在、以及在 `Global.Path` 模块求值前是否已完成有效临时目录重定向（赋值给原值或固定真实目录均不放行）；遇到无法静态判定的动态构造或间接调用时失败关闭，要求补充可验证的基座或隔离测试。
- **行为级顺序隔离检查**：`packages/ellamaka-app/script/check-test-order-isolation.ts` 作为 CI 门禁对前端单测集运行正序、倒序以及共享状态的成对文件组合，拦截仅依赖特定文件顺序才能通过的隐藏污染。

### Shrink-Only Baseline and Integration Boundary

`.ci/test-isolation-baseline.json` 以四元组 `(rule, file, detail, count)` 记录存量技术债。`detail` 精确到模块名、env 键名或 API 名称，配合出现次数 `count` 确保同一文件内新增同类违规无法借用既有条目蒙混过关：

- 当前源码出现基线未覆盖的键 → 检查失败。
- 同一四元组键在源码中的出现次数高于基线 `count` → 超出部分判定为新增违规，检查失败。
- 源码中的违规减少或消失 → 多余额度触发 `TISO007`（stale），检查失败，必须通过 `bun run check:test-isolation -- --fix` 同步扣除，不得留作后续新增违规的缓冲额度。
- `--fix` 只允许删除或缩小已有记录；一旦检测到任何新增键或次数增加，直接拒绝改写文件并退出码 1。若基线文件缺失，检查按空基线对比当前源码，全部存量违规立即显式失败。

**Integration 边界与例外规则**：`rules.ts` 中的 `INTEGRATION_ROOTS` 与 `INTEGRATION_FILES` 分别从 `packages/opencode/script/run-tests.ts::INTEGRATION_DIRS` 与 `packages/ellamaka-cordis/package.json::test:integration` 同步推导，并由 `packages/opencode/script/test-isolation/policy.test.ts` 每次门禁测试强校验两边完全一致，同时核对 `ellamaka-cordis` 的 `test:unit` 确实忽略了所有已登记的 integration 文件。测试文件亦可使用 `-integration.test.ts(x)` 或 `-e2e.test.ts(x)` 后缀标记分层。扫描器负样本例外仅按精确文件路径登记，禁止对整个 `fixture` 或 `e2e` 目录作整片豁免。

## Fault Simulation and Stability Verification

静态规则与包级基座之外，测试编写与评审遵循以下稳定性和故障验证契约：

- **可控故障注入**：验证拒绝写入时，在文件系统 service 或可恢复 spy 上注入 `EACCES` 以覆盖真实调用链；避免仅用 `chmod 0444` 假设写入必然失败（受 root、ACL 与挂载策略影响）。验证权限位本身时单独声明执行身份与平台前提。
- **命中目标错误路径**：异常路径断言不能只检查“报错”，必须验证具体错误码/消息及原有持久化数据未被破坏，避免因其他意外异常碰巧通过。spy 优先配合 `using` 或测试作用域自动还原。
- **门禁与操作同址**：测试若先探测环境状态（如路径可写性、挂载就绪、沙箱允许根）再选分支，真实 I/O 必须发生在被探测的同一路径/资源上，防止软链或跨卷映射造成探测与操作分离。沙箱拒绝测试的探针路径经规范化后必须位于所有允许写入根之外。
- **资源先停止再清理**：在 `finally` 或 `afterAll` 清理中先等待 watcher、server、容器与子进程完全退出并释放句柄，再删除临时目录；断言失败时走同一释放路径。
- **偶发失败复现协议**：不得以重跑绿灯关闭间歇性失败。保留原始命令、提交与错误输出，分别在单文件、正反组合与冷进程场景下定位根因并补齐稳定复现的回归用例；验证分组内任意一次失败即判整体失败。
- **macOS FSEvents 沙箱边界**：部分 Seatbelt 沙箱会使 `@parcel/watcher` 启动 `FSEventStreamStart` 失败，而其他受限环境仍可正常启动；不得仅凭嵌套沙箱探针失败跳过测试或掩盖错误，遇到 FSEvents 启动失败时保留原始失败并在支持 FSEvents 的环境（或通过 `bun run ci:local` 的沙箱检测入口）复验。
- **分层调迁不降覆盖**：将 unit 层测试迁往 integration/e2e 层时，必须核对目标层级 runner 与 CI 实际执行列表，确保用例不会被静默移出执行范围。
- **可定位断言与外部前提**：结构化工具失败需验证错误类型、错误码与核心内容，涉及底层调用链时确认探针真实命中。fixture 严禁包含真实凭证；缓存、权限或系统依赖前提必须显式建立或校验。
- **跨运行时进程边界契约**：涉及子进程与 bootstrap 的测试不能只断言退出码，还需验证 stdin/stdout/stderr 继承、超过管道容量（如 256 KiB）的完整输出、取消及退出回收语义；错误文件路径与系统调用归因必须沿真实调用链验证。

### Assertion Strength Review

`.only` 与新增 `.skip` / `.todo` 由 `TISO005` 自动阻断；删除断言、缩短观察窗口、或靠放宽超时/重试掩盖时序竞态属于实施评审关注项，由代码与测试评审人工把关，不启用高误报的 `expect` 计数规则。

## Data and State Model

| State                     | Location                                                                        | Owner                               | Lifecycle & Rules                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| 隔离违规基线账本          | `.ci/test-isolation-baseline.json`                                              | `script/test-isolation/check.ts`    | 随代码提交；记录 `(rule, file, detail, count)`；只允许 `--fix` 收缩，禁止放大                     |
| 集成边界与白名单          | `packages/opencode/script/test-isolation/rules.ts`                              | `script/test-isolation/`            | 与 `run-tests.ts` 及包 `package.json` 同步；由 `policy.test.ts` 强制对账                          |
| 进程独占测试 Home         | `<tempRoot>/opencode-test-data-<pid>-*/.opencode-test-owner`                    | `packages/opencode/test/preload.ts` | 进程启动创建并写归属标记；正常由 `afterAll`/`exit` 清理，SIGKILL 残留由后续 preload 按 ESRCH 回收 |
| OpenCode 进程基线内存快照 | 进程内存 `processStateBaseline`                                                 | `packages/opencode/test/preload.ts` | 测试初始化后捕获 `process.env` 与 `cwd`；`afterEach`/`afterAll` 校验并强制恢复                    |
| 包级环境作用域助手        | `packages/{opencode,ellamaka-core,ellamaka-cordis}/test/fixture/process-env.ts` | 各所属 package                      | 各包独立拥有；同包测试修改 `process.env` 的唯一入口                                               |

## Business Rules and Failure Boundaries

- **保护面声明**：`TISO009` 与 `home-preload` 对明确的 `WOPAL_HOME` / `Global.Path` / Home-bound layer 路径提供静态拦截与进程级临时目录重定向保障，并由 `TISO102` 兜底 Git worktree 隔离；它们不能证明任意未接入接缝的第三方库对其他宿主路径零写入，因此非 `WOPAL_HOME` 外部路径仍须遵循本文隔离模型审查。
- **运行时哨兵覆盖面**：`TISO101`（env/cwd 泄漏拦截）与 `TISO102`（worktree 孤儿检测）随 `packages/opencode/test/preload.ts` 生效；其他未装载该 preload 的包依赖静态 `TISO001`–`TISO009` 门禁及自身 `home-preload` 契约与顺序测试。
- **双处门禁同步**：CI（`.github/workflows/ci.yml`）按产品决策仅在 nightly 与手动触发执行，不包含 push/PR 门禁；`packages/opencode/script/ci-local.sh` 是 CI 步骤的手写本地副本。凡新增或调整测试隔离检查步骤，必须同步更新两处入口（包括 `check:test-isolation`、`test:isolation-gate` 与 `packages/ellamaka-app` 的 `check:test-order-isolation`）。
- **失败行为与恢复**：`check:test-isolation` 检测到新违规或 stale 条目时打印规则编号、文件路径、行号（或 stale 条目详情）及修复建议并退出码 1；遇到 stale 时先核对确属已修复债务，再执行 `bun run check:test-isolation -- --fix` 同步基线；遇到新违规时直接迁移测试或补充 DI/scoped helper，禁止试图扩大基线。

## Reference Documents

| Document                                          | Purpose                                                 |
| ------------------------------------------------- | ------------------------------------------------------- |
| [Static Quality Gates](./DESIGN-quality-gates.md) | 静态 lint、Prettier 与 CSS 门禁的同形四元组基线实现参考 |
| [Distribution](./DESIGN-distribution.md)          | CI 触发策略与发布流水线约束来源                         |
| [AGENTS.md](../AGENTS.md)                         | 全仓日常测试隔离命令与 Agent 操作守则                   |
