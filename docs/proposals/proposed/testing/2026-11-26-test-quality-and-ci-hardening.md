# Test Quality, Gate Enforcement, and CI Coverage Hardening

Status: approved

- **Class**: testing
- **Created**: 2026-11-26
- **Approved**: 2026-11-27 — Sam (愚佛)
- **Authorized scope**: Decisions 1–4 (`TISO010` static gate with `--seed-rule` and `--files` pre-commit hook, closing non-E2E CI coverage blind spots and reordering CI steps, unifying `home-preload` harness after clearing `ellamaka-core` env leaks, and zeroing out the `TISO010` baseline); excludes clearing legacy 615 isolation debt, running `bun test` in pre-commit, changing nightly/manual CI trigger policy, and cross-repo `.wopal` rule updates (tracked separately via `ontology-evolution`).
- **Delivery**: plan

## Problem

当前仓库已有测试隔离基座（`bun run check:test-isolation`，静态扫描全仓 790 个测试文件耗时约 2 秒，当前基线记账 615 处存量隔离债务），但测试质量、本地拦截时机、CI 实际覆盖面与多包 preload 基座仍存在四个结构性缺口：

1. **“读取产品源码做字符串匹配”的假测试反复产生并误伤重构**：全仓 790 个测试文件中存在一批（约 30 余个）直接读取仓库内产品源码文件（`.ts`/`.tsx`/`.js`/`.jsx`/`.sh`/`.css`）并执行 `toContain`/`toMatch`/`indexOf`/`RegExp.test` 断言的测试，其中近半数一行产品代码都未 `import`（例如 `packages/ellamaka-app/src/build-config.test.ts`、`packages/opencode/test/config/plugin-contract-pin.test.ts`、`packages/opencode/test/plugin/auth-override.test.ts` 等；不同于通过 `Function(src)()` 真实执行浏览器脚本并验证 DOM 的 `packages/ellamaka-app/src/theme-preload.test.ts`）。这类测试在逻辑损坏时不能稳定报警，却会在正常重构时碎裂。典型事故是 CI Run `45530536471`：重构 `scripts/dev.sh` 中的 `dev_entry_url` 后，行为测试 `scripts/lib/dev-entry-url-integration.test.ts` 全部通过，但跨在 `packages/ellamaka-app/src/build-config.test.ts` 中的源码字面量断言在 `Test order isolation` 步骤失败，连带跳过了后续全部 `Unit tests`。
2. **本地提交缺少隔离门禁拦截，CI 顺序反馈失真**：秒级静态门禁 `bun run check:test-isolation` 尚未接入 `.husky/pre-commit`，新增隔离违规只能在夜间 CI 才暴露；同时 `.github/workflows/ci.yml` 先跑 `Test order isolation`（全量正反跑两遍前端单测），再跑常规 `Unit tests`，导致普通逻辑断言失败被包装成顺序隔离失败。
3. **夜间 CI 存在约 200 个非 E2E 测试文件的执行盲区**：`.github/workflows/ci.yml` 通过 `bunx turbo run test:ci` 执行单元测试，但全仓仅 7 个 package 定义了 `test:ci`（且 `packages/ellamaka-cordis` 的 `test:ci` 仅硬编码运行 7 个文件）。`wopalspace`（37 文件，含 17 unit + 20 integration）、`ellamaka-desktop`（34 文件）、`ellamaka-release`（34 文件）、`llm`（26 文件）、`ellamaka-cordis` 未列入的 54 个文件（含 3 个既不在 `test:unit` 也不在 `slow` job `test:tools` 的集成文件）、`sdk/js`（5 文件）、根 `scripts`（4 文件）与 `ellamaka-brand`（2 文件），合共 196 个非 E2E 测试文件未进入夜间常规 CI；且工作流从未调用任何包的 `test:integration`。
4. **各包 `home-preload` 基座防护严重不对称**：只有 `packages/opencode/test/preload.ts` 配备了仓库外 `TMPDIR` 重定向与孤儿 worktree 检测（`TISO102`）、环境变量与 `cwd` 泄漏守卫（`TISO101`）、Git 定位环境变量剥离、API key 清理以及 `exit`/`ESRCH` 目录回收；`packages/ellamaka-core/test/preload.ts` 与 `packages/ellamaka-desktop/test/preload.ts` 仅重定向了 `WOPAL_HOME`，缺少上述运行时守卫与异常退出回收。

## Proposal

在不推翻现有测试隔离架构的前提下，本提案提出四项决策与对应边界。除“存量源码匹配测试清零依赖 `TISO010` 及基线初始化机制上线”外，其余三项彼此独立；具体交付路径（`Delivery: direct | plan`）与分批节奏在批准时由用户决定。

### Decision 1 — Add `TISO010` Static Gate, Controlled Rule Seeding, and Pre-Commit Hook

1. **新增静态 AST 门禁 `TISO010`（禁止读产品源码做字面匹配）**：
   - 在 `packages/opencode/script/test-isolation/` 新增规则 `TISO010`：通过 TypeScript AST 识别测试文件对仓库已追踪产品源码（`.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`/`.sh`/`.css`，排除 `fixtures/`、测试文件自身 `*.test.*`/`*.spec.*` 及 `*.yml`/`*.json`/`*.md`）的读取，当读取结果变量流向文本匹配断言或检索（`toContain`/`toMatch`/`indexOf`/`includes`/`match`/`matchAll`/`RegExp.test`）时判定违规。
   - **最小必须支持的路径构造形态**：覆盖仓库内真实主流写法——`Bun.file(new URL("<rel>", import.meta.url))`、`Bun.file(path.join/resolve(..., "<lit>"))`、`readFileSync`/`readFile` 的同构两种写法，以及经单层本地包装函数（如 `readSource(url)` / `source(path)`）转发的读取。
   - **防误报与失败开放边界**：
     - 读取静态脚本后仅传入 `Function(...)` / VM / 子进程执行（如 `packages/ellamaka-app/src/theme-preload.test.ts`），或交给 AST/结构分析器（如 `packages/ellamaka-cordis/src/runtime/home-generation.test.ts` 的 `scanSource`）且无源码文本匹配时，必须放行；
     - 无法静态解析出目标路径的动态路径（如测试自行在临时目录生成的文件）采取失败开放策略（不判违规），由代码审查兜底；
     - 仅校验 `.github/workflows/*.yml`、`.husky/pre-commit` 或发布清单元数据等非产品源码契约的静态测试不属于产品源码读取；如确有特殊静态源码审计例外，必须登记在 `rules.ts` 的精确单文件路径白名单中并附理由。
2. **受限的首次基线种子命令 `--seed-rule <RuleId>`**：
   - 现有 `bun run check:test-isolation -- --fix` 严格遵循「只许减不许增」，在存在新增违规时必然拒绝写入，因此无法直接为全新规则建立初始基线。
   - 为 `packages/opencode/script/test-isolation/check.ts` 新增一次性种子选项 `--seed-rule <RuleId>`，并施加硬性防滥用约束：**仅当 `.ci/test-isolation-baseline.json` 中该 `<RuleId>` 当前条目数为 0 且 `<RuleId>` 已注册时才允许写入存量条目**；一旦该规则已有任意基线记录，或试图借此新增/抬高其他规则计数，命令必须失败退出。日常清理与扣除继续只走 `--fix`（只许减不许增）。
3. **接入 `.husky/pre-commit` 静态隔离检查（分层语义）**：
   - 为 `check.ts` 增加 `--files <path>...` 局部模式：**仅运行文件级规则（`TISO001`–`TISO006`、`TISO008`、`TISO010`）的新增违规检测，显式跳过全仓 `TISO007`（stale 基线）报错与包级图分析规则 `TISO009`**，避免未暂存文件的陈旧债务阻断无关提交，也避免对局部文件给出错误的包级放行结论。
   - `.husky/pre-commit` 的触发分两档：
     - 当暂存变更触及 `bunfig.toml`、任何 `preload` 文件或 `packages/opencode/script/test-isolation/` 时，直接运行全量 `bun run check:test-isolation`（约 2 秒），完整覆盖 `TISO009` 与门禁规则变更；
     - 当暂存变更仅包含测试文件或 test fixture 时，运行 `bun run check:test-isolation -- --files <staged-files>`（毫秒级）；
     - 两者均未触及时零额外开销。
   - 同步更新 `packages/ellamaka-release/test/precommit-hook-integration.test.ts` 钩子回归测试。

### Decision 2 — Close Non-E2E CI Coverage Blind Spots and Reorder CI Steps

1. **明确夜间 CI 覆盖边界并补全所有可执行非 E2E 测试**：
   - 规则边界：**凡不依赖外网、密钥、真实 OS 沙箱或 Playwright 浏览器的非 E2E 测试文件，全部纳入夜间 `checks` job**；需要真实 OS 沙箱的测试留在 `slow` job（`test:tools`）；Playwright E2E（如 `packages/ellamaka-app/e2e` 与 `packages/ellamaka-desktop/e2e`）继续归属 E2E 层。
   - 按包补齐：
     - 为 `packages/wopalspace`（覆盖 `test/unit` 与 `test/integration` 全部 37 文件）、`packages/ellamaka-desktop`（34 文件）、`packages/ellamaka-release`（34 文件）、`packages/llm`（26 文件）、`packages/sdk/js`（5 文件）与 `packages/ellamaka-brand`（2 文件）配置 `test:ci`；
     - **显式前置核查与构建依赖**：
       - `packages/sdk/js/test/local-worker-integration.test.ts` 直接导入被忽略的 `../dist/local.js`，因此必须为 `@wopal/ellamaka-sdk` 的 `test:ci` 配置构建前置（在 `turbo.json` 声明 `"@wopal/ellamaka-sdk#test:ci": { "dependsOn": ["build"], ... }` 或在脚本内前置构建）；
       - `packages/llm` 的 26 个用例须在无密钥、离线环境中实测，如有依赖真实外网或 `API_KEY` 的用例须显式拆分分层，不得混入离线 `test:ci`；
       - 其余新纳入包在合入前须在 CI 同构干净环境（`ci-local` / 无密钥）实测通过。
     - 对 `packages/ellamaka-cordis`：不能仅把 `test:ci` 对齐到 `test:unit` 而留下 `test/plugins-runtime.test.ts`、`test/dsh-virtual-webserver-integration.test.ts`、`test/web-child-failure-integration.test.ts` 三个既不在 `test:unit` 也不在 `test:tools` 的孤儿集成测试；实测核定这 3 个文件的沙箱依赖：无真实 OS 沙箱依赖的并入 `checks` job（扩展 `test:ci` 或增设 `test:integration` 步骤），依赖真实 OS 沙箱的并入 `slow` job 的 `test:tools`，确保该包全部 61 个文件零漏跑。
     - 在 `.github/workflows/ci.yml` 与 `packages/opencode/script/ci-local.sh` 增加根 `scripts/lib/*.test.ts`（4 文件）执行步骤。
2. **文件级 CI 覆盖防漂移门禁**：
   - 在 `packages/opencode/script/test-isolation/policy.test.ts` 中新增策略测试：不仅检查每个含非 E2E 测试文件的 workspace package 定义了 `test:ci`，还核对每个包（尤其是带排除规则或显式文件列表的 `ellamaka-cordis`、`wopalspace`）的所有非 E2E 测试文件均归属于 `test:ci`、CI 集成步骤或 `slow` job 之一，防止脚本存在但文件漏跑的假绿。
3. **调整 CI 步骤顺序并同步工作流断言**：
   - 在 `.github/workflows/ci.yml` 与 `packages/opencode/script/ci-local.sh` 中将常规 `Unit tests`（`turbo run test:ci`）移至 `Test order isolation` 之前，确保单文件行为回归在主单测步骤直接暴露；
   - 同步更新 `packages/ellamaka-release/test/ci-workflow.test.ts` 中“要求 `turbo run test:ci` 必须是 `checks` job 最后一步”的旧断言，改为校验 `Unit tests` 先于 `Test order isolation` 执行。

### Decision 3 — Unify `home-preload` Harness and Clear Core Env-Leak Prerequisites

1. **抽取共享测试基座 helper**：
   - 将 `packages/opencode/test/preload.ts` 中的通用进程隔离原语（仓库外 `resolveTempRoot()`、`mkdtemp` 随机后缀 + 归属标记文件 + `exit`/`ESRCH` 回收、`stripGitLocatorVars()`、以及 `processStateBaseline` + `afterEach`/`afterAll` 自动恢复并拦截泄漏的 `TISO101` 守卫）抽取为共享测试夹具模块，供 `opencode`、`ellamaka-core`、`ellamaka-desktop` 三个 `home-preload` 包复用。
2. **先清前置 env 泄漏再接入 `TISO101` 守卫**：
   - 实测将 `TISO101` `afterEach` 守卫预加载至 `packages/ellamaka-desktop` 当前全绿（253 pass / 0 fail），但预加载至 `packages/ellamaka-core` 会因 `test/models.test.ts`（3 例）与 `test/effect/observability.test.ts`（3 例）在用例/beforeEach 改写 `process.env` 却仅在 `afterAll` 恢复而触发 6 处 `TISO101` 失败。
   - 因此，本提案规定**必须先将 `packages/ellamaka-core` 中触发 `TISO101` 的存量环境改写迁移至 `scopedEnv` 或 `afterEach` 级恢复**（并同步扣除对应 `TISO002` 基线条目），再启用共享 preload 守卫，不得通过把 `TISO101` 降级为仅告警来绕过失败。
   - 为 `ellamaka-core` 与 `ellamaka-desktop` 补充独立进程集成测试，验证环境变量/`cwd` 泄漏拦截与异常退出后的临时目录回收。

### Decision 4 — Triage and Zero Out `TISO010` Baseline (Driven by Actual Scan Output)

1. **以 `TISO010` 实际扫描基线为唯一清单**：
   - 不在提案中固化易漂移的手工文件清单。`TISO010` 上线并通过 `--seed-rule TISO010` 生成精确基线后，以基线中的实际文件集为唯一清理清单，逐批改造并运行 `check:test-isolation -- --fix` 扣除，直至基线中 `TISO010` 条目清零。
2. **三类处置标准（按保护价值判定）**：
   - **直接删除**：仅匹配 CSS 类名、JSX 片段或仅断言已删源码符号不在文件内、无行为保护价值的测试（例如 `packages/ellamaka-app/src/components/prompt-input/composer-surface.test.ts`、`settings-keybinds.test.ts`、`packages/opencode/test/cli/cmd/dsh-init-removed.test.ts`）。
   - **抽纯函数接缝并改写为行为测试**：测试意图保护真实配置、路由、参数组装或错误隔离行为，但被入口胶水耦合而退化为读源码匹配的测试（例如 `packages/ellamaka-app/src/build-config.test.ts`、`packages/opencode/test/plugin/auth-override.test.ts`、`packages/opencode/test/config/plugin-contract-pin.test.ts`、`packages/ellamaka-desktop/src/main/desktop-cdp.test.ts`、`packages/ellamaka-cordis/test/dsh-mount-audit.test.ts`）。优先抽取无副作用的纯参数/配置构造或组装函数进行真实调用验证，避免引入多余抽象层。
   - **拆分混合文件与精确白名单核定**：对同时校验 `.github/workflows/*.yml`/`.husky/pre-commit`/发布清单又跨读 `.ts`/`.sh` 产品源码的混合测试（例如 `packages/ellamaka-release/test/workflow-desktop-repair.test.ts`、`workflow-desktop.test.ts`、`npm-publish-exports.test.ts`、`precommit-hook-integration.test.ts`），将产品源码部分改为接缝行为测试，非产品源码契约校验保留原样。

### Explicit Exclusions and Cross-Repository Follow-Up

- **不在本提案范围内**：
  - 不一次性清零 `.ci/test-isolation-baseline.json` 中既有的 615 处历史隔离债务（仅在 Decision 3 为启用 `TISO101` 清理 `ellamaka-core` 的阻塞性 env 泄漏）；
  - 不在 `.husky/pre-commit` 中运行 `bun test` 或顺序隔离套件；
  - 不改变现有 `ci.yml` “仅 nightly + manual 触发、不在 push/PR 触发”的产品成本边界。
- **跨仓库规则同步（批准后另行经 `ontology-evolution` 处理，不在本仓库提交中直接修改）**：
  - 更新 `.wopal/rules/testing.md`，明确禁止以读取产品源码做字面/正则匹配替代行为测试；
  - 更新 `.wopal/skills/df-implement-review/SKILL.md` 的 Q4 评审清单，将无正当静态契约理由的源码文本匹配测试明确列为 **Blocker**。
- **现状设计文档同步**：各对应能力落地时，在同交付同步更新 [DESIGN-testing-isolation.md](../../../DESIGN-testing-isolation.md) 与 [DESIGN-quality-gates.md](../../../DESIGN-quality-gates.md)。

## Alternatives considered

- **仅依靠文档规范与人工 Review 约束** — [AGENTS.md](../../../../AGENTS.md) 与 `.wopal/rules/testing.md` 虽已存在“断言行为而非实现细节”的原则，但缺少 AST 门禁与本地 `pre-commit` 拦截时，Agent 在追求快速过关时仍会持续产生源码文本匹配测试；只有“静态门禁 + 收缩基线 + 审查兜底”才能实现零新增。
- **允许 `check:test-isolation -- --fix` 在新规则上线时自动增写基线** — 会直接破坏「基线只许减不许增」的安全不变量，让任何开发者误跑 `--fix` 时把新引入的违规合法化；采用仅在“目标规则当前计数为 0”时才放行的 `--seed-rule <RuleId>`，既解决新规则初始化死锁，又守住存量规则不可膨胀的底线。
- **在 `ellamaka-core` 中以“仅告警不失败”灰度启用 `TISO101`** — 虽可绕过现有的 6 处环境泄漏失败，但会让 `core` 与 `opencode`/`desktop` 长期处于不对等的防护状态，且告警在 CI 日志中极易被忽略；直接迁移 2 个文件的 6 处用例成本极低且能立即闭环。
- **一次性清零 `.ci/test-isolation-baseline.json` 中既有的 615 处隔离历史债务** — 现有债务已有收缩基线兜底且涉及上百个旧单测改造，短期一次性清零工程量极大，收益远低于优先补齐 CI ~200 个测试盲区与阻断新增假测试。
- **在 `.husky/pre-commit` 中运行 `bun test` 或跨包顺序测试** — 会显著拖慢本地每次提交并诱发 `--no-verify` 绕过；仅接入秒级静态 `check:test-isolation`（且普通测试改动走 `--files` 局部模式）能兼顾即时拦截与提交体验。

## Acceptance criteria

1. **`TISO010` 与受限种子机制有效且防滥用**：`bun run check:test-isolation` 与 `bun run test:isolation-gate` 全部通过；门禁单元测试覆盖 `TISO010` 的 4 类核心读取形态（`new URL(..., import.meta.url)`、`path.join/resolve`、同步/异步 `fs` 读取、单层 helper 包装）与 3 类放行边界（`Function(src)()` 执行型如 `theme-preload.test.ts`、AST 扫描型如 `home-generation.test.ts`、临时文件读写），且验证 `--seed-rule` 在目标规则基线非零或尝试增写其他规则时必然失败退出。
2. **`pre-commit` 增量/全量分层拦截可验证**：`packages/ellamaka-release/test/precommit-hook-integration.test.ts` 与实操验证证明——暂存含新增文件级违规（如 `TISO010`）的测试文件时 `.husky/pre-commit` 通过 `--files` 拒绝提交且不受未暂存文件的 `TISO007` 陈旧条目干扰；暂存 `bunfig.toml`/preload/门禁脚本变更时触发全量 `check:test-isolation`；未触及相关路径时不调用隔离扫描。
3. **非 E2E CI 覆盖零盲区且顺序正确**：`.github/workflows/ci.yml` 与 `packages/opencode/script/ci-local.sh` 覆盖全仓所有可执行非 E2E 测试文件（含新补齐的 6 个 package、`ellamaka-cordis` 全量 61 文件分工覆盖、根 `scripts/lib/*.test.ts` 4 文件），`@wopal/ellamaka-sdk` 的 `test:ci` 在干净无 `dist` 状态下自动构建并通过；`policy.test.ts` 在文件级别锁定无新增漏跑；`Unit tests` 先于 `Test order isolation` 执行且 `ci-workflow.test.ts` 同步通过。
4. **`home-preload` 基座对等且全绿**：`packages/ellamaka-core/test/preload.ts`、`packages/ellamaka-desktop/test/preload.ts` 与 `packages/opencode/test/preload.ts` 共享同一套仓库外 `TMPDIR` 与 `TISO101` 状态守护原语；`ellamaka-core`（修复 6 处前置 env 泄漏后）与 `ellamaka-desktop` 全量测试通过，并有独立进程集成测试证明 env/`cwd` 泄漏会被硬拒绝且异常退出后临时目录被回收。
5. **`TISO010` 存量债务清零与文档同步**：`.ci/test-isolation-baseline.json` 中 `TISO010` 条目数为 0（仅合规非产品源码契约与白名单例外保留），且 [DESIGN-testing-isolation.md](../../../DESIGN-testing-isolation.md) 与 [DESIGN-quality-gates.md](../../../DESIGN-quality-gates.md) 在同交付同步反映新规则、种子边界与门禁入口。

## Risks

- **`TISO010` 误报率失控或漏报过多**：
  - **边界与观测**：上线后若合法行为测试需要通过 `rules.ts` 白名单豁免的数量超过 5 个，或复审中发现主流 `new URL` / `path.join` 写法被漏检，即表明数据流判定需回看调整。
  - **缓解**：坚持“仓库已追踪产品源码路径 + 文本匹配消费”双重条件，对动态路径失败开放，并用覆盖真实仓库写法的 AST 单元测试集固化边界。
- **CI 补全后暴露存量环境缺陷与 nightly 耗时膨胀**：
  - **边界与观测**：新纳入的 ~196 个测试在 Linux 无密钥容器下首次执行可能暴露 macOS/密钥假设，且 `checks` job 总耗时需保持在现有 `timeout-minutes: 90` 的合理余量内（目标增幅不超过 10 分钟，否则需评估拆分或并行）。
  - **缓解**：合入前逐包在无密钥沙箱环境（`ci-local`）实测并修复前置假设；对 `packages/llm` 依赖真实密钥的用例显式拆分分层；为 `packages/sdk/js` 显式声明 `build` 前置。
- **清理源码匹配测试时引入过度抽象**：
  - **边界与观测**：若为改写单一胶水测试新增了仅供测试使用的 DI 容器或仅有一个生产实现的接口层，即视为过度抽象，应在实现审查（`df-implement-review` Q4）阶段拦截回退。
  - **缓解**：优先抽取无副作用的纯参数/配置组装函数，对无行为价值的纯样式/已删符号断言直接删除而非强行造接缝。
