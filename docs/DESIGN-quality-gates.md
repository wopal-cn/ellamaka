# DESIGN — Static Quality Gates

> **Status**: Active
> **Updated**: 2026-11-28
> **Parent**: `./DESIGN.md`
> **Parent Architecture**: `../../../docs/products/wopal-space/DESIGN.md`
> **Parent Product**: `../../../docs/products/wopal-space/PRD.md`
> **Scope**: 全仓已跟踪源文件的 lint、格式化与 CSS 检查；三者范围分别定义

本文件定义 Ellamaka 静态质量门禁的现时契约：哪些代码进入检查、哪些规则停检、存量债务如何记账、门禁从哪里触发。
跨项目编码规范与 TDD 语义由 WopalSpace 装配的 `testing.md` 拥有；本文只拥有 Ellamaka 特有的范围边界、停检取舍与基线语义。

## Overview and Scope

Ellamaka 的静态检查覆盖三类互相独立的检查：lint（`oxlint`）、格式化（`prettier`）、CSS（`stylelint`）。三者由不同工具提供，
失败语义不同，范围也不同，因此分别定义而不是合并成一张表。

**Owned Here**：检查范围、规则停检取舍、存量债务的基线契约、门禁入口与它们在 CI 和提交钩子中的归属。

**Handled Elsewhere**：通用编码规范与 TDD 判定由 WopalSpace 装配的 `testing.md` 拥有；测试隔离门禁由
[Test Isolation](./DESIGN-testing-isolation.md) 拥有；构建与发布流程由 [Distribution](./DESIGN-distribution.md) 拥有。

**Source Carrier**：lint 配置在仓库根 `.oxlintrc.json`，门禁检查器在 `packages/opencode/script/lint-gate/`，
提交钩子在 `.husky/pre-commit`，CI 定义在 `.github/workflows/ci.yml`，本地 CI 副本在
`packages/opencode/script/ci-local.sh`。

### 为什么门禁需要独立的失败语义

三类工具的默认行为都是「只报告、不阻断」：`oxlint` 的 `correctness` 类规则默认是 `warning` 严重级别，
`prettier` 的 `--check` 在接入前不参与任何流程，`stylelint` 的规则可被显式降级为 `warning`。这三者叠加的结果是
检查全绿但代码质量没有任何约束。

信噪比是这里唯一真正的成本。当多数诊断来自对合法代码的规则性误报时，少数真实缺陷会被完全淹没。因此本文的取舍
原则是：**让门禁的失败信号重新具备信息量**——新增违规必须失败，指向运行时缺陷的存量必须清零，
结构性无法修复的诊断必须显式排除而不是留在报告里当噪音。

## Usage and Interface Contracts

门禁通过仓库根 `package.json` 暴露以下命令，CI 与提交钩子共用同一份判断逻辑：

```text
bun run lint                       # 全仓门禁：新键 / 次数上升 / stale 三者任一或基线缺失即退出码 1
bun run lint:fix                   # 收缩基线；只允许删除条目或降低次数，出现新键或次数上升即失败
bun run lint:init                  # 只在从未建立过基线的仓库初始化一次；工作区或 Git 历史已有该文件时拒绝
bun run lint:files <file>...       # 只判断这些文件的键（提交钩子使用）；未选中文件不参与比较，也不改写基线
bun run test:lint-gate             # 门禁检查器自身单测
bun run format                     # 对格式化范围内的已跟踪文件执行 prettier --write
bun run format:check               # 对同一范围执行 prettier --check
```

调用方契约：

- **`must`**：所有入口使用 `git ls-files` 取得显式文件清单再传给工具，不依赖目录隐式遍历。目录遍历会继承祖先目录的
  `.gitignore` 规则，导致同一份代码在本地与 CI 得到不同结果。
- **`must not`**：任何入口不得以 `--max-warnings=<N>` 的数字预算作为门禁手段。数字预算停在被冻结的债务数额上、
  只能往上抬，且从报告里看不出债务分布。
- **`may`**：提交钩子可以在被排除路径上放行，因为那些文件不进入检查范围。

## Lint Scope and Rule Trade-offs

范围按「归属」划定，不按「是否容易修」划定。

| 范围                                                                                                         | 是否检查                   | 理由                                                                                  |
| ------------------------------------------------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------- |
| 自有 package（`ellamaka-*`、`llm`、`sdk`、`wopalspace`、`plugin`、`http-recorder`、`effect-drizzle-sqlite`） | 检查                       | 本仓拥有并负责                                                                        |
| `packages/opencode`、`packages/ui` 中的上游继承代码                                                          | 不检查                     | 上游文件只做最小定制；缺陷由上游维护                                                  |
| `packages/opencode/src/wopal/`、`packages/opencode/src/workbench/`                                           | 检查                       | 位于上游 package 内但由本仓开发；lint 只读诊断、不改文件，可安全纳入                  |
| 生成代码（`**/gen/`、`**/*.gen.ts`）                                                                         | 不检查                     | 改了下次生成即丢失；问题应在生成器或生成源修正                                        |
| `poc/`                                                                                                       | 不检查                     | 实验目录，生命周期单独决定                                                            |
| 测试代码                                                                                                     | 检查，但纯风格类型规则关闭 | `no-floating-promises` 等在测试里同样指向真实的漏 await；只有运行时零影响的规则才豁免 |

排除的含义是「整个路径不进入检查」，不是「关闭规则后仍报出来当噪音」。

### 停检规则

停检必须同时给出数量、误报证据和保留的替代保护。停检是**明确的权衡**，不等于原保护被等价替换。

| 规则                                  | 停检理由                                                                                                             | 保留的保护                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `typescript/no-unsafe-type-assertion` | 标记所有 `as` 类型收窄。抽样全部为显式边界断言（外部输入的运行时归一化），规则无法区分「必要收窄」与「危险断言」     | TypeScript strict 类型检查覆盖断言之外的类型一致性；review 时新增 `as` 仍可见     |
| `typescript/consistent-return`        | strict TS 下混合返回值已推为 `T \| undefined`，规则只要求多写一句显式 `return undefined`                             | 类型检查覆盖返回类型一致性；如需覆盖真实漏 return，应评估开启 `noImplicitReturns` |
| `typescript/unbound-method`           | 抽样 20 条全部为误报：Effect 静态方法引用、SolidJS `createSimpleContext` 的解构 `use`、显式 `.call(this)` 绑定的捕获 | review；`src/wopal/` 与 `src/workbench/` 之外的 class 实例方法调用由各自测试覆盖  |

`unbound-method` 指向的问题（方法脱离接收者后 `this` 为 undefined）在以纯函数和工厂函数为主的代码中不会自发产生，
但类型检查无法证明这个性质。这一缺口是承认的，不描述成「已被类型检查等价覆盖」。

测试路径额外关闭八条运行时零影响的纯风格类型规则（`no-unnecessary-type-assertion`、`no-unnecessary-type-arguments`、
`no-unnecessary-type-conversion`、`no-unnecessary-type-parameters`、`no-unnecessary-boolean-literal-compare`、
`no-redundant-type-constituents`、`no-duplicate-type-constituents`、`no-extraneous-class`）与 `await-thenable`，
合计九条。这些规则在测试夹具里对可读性的伤害大于收益，且不指向任何运行时后果。`no-floating-promises`、
`no-base-to-string`、`restrict-template-expressions`、`no-unused-vars` 在测试路径下保持开启。

## Formatting Scope

格式化与 lint 的范围不同，因为它们对代码的改动方式不同。

| 范围                                                                                 | 是否检查 | 理由                                                                                  |
| ------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------- |
| 自有 package 与仓库根的自有配置、脚本                                                | 检查     | 本仓拥有并负责                                                                        |
| `packages/opencode`、`packages/ui` 整个 package（含 `src/wopal/`、`src/workbench/`） | 不检查   | 格式化会重写整文件，在上游文件上做无关格式化直接制造合并冲突；根 `AGENTS.md` 明确禁止 |
| 生成代码、构建产物（`out/`、`dist/`、`release/` 下的生成清单）                       | 不检查   | 非手写内容，重写无意义                                                                |
| 测试代码                                                                             | 检查     | 与 lint 一致，测试也是本仓维护的代码                                                  |
| Markdown 文档（`*.md`） | 不检查 | 保留作者编排的文档格式，提交与 CI 共用此排除规则；密钥扫描仍覆盖暂存的文档 |

**`src/wopal/` 与 `src/workbench/` 只纳入 lint，不纳入格式化。** 代价是这两个目录不享受格式化门禁，换取的是不与上游
产生整文件格式冲突。这是明确权衡，不是遗漏。

## Baseline Contract

存量债务用基线接纳。基线是**精确债务清单**，每条记录「文件 + 规则 + 诊断消息 + 次数」，存放在 `.ci/oxlint-baseline.json`：

```jsonc
{
  "version": 1,
  "generatedWith": { "oxlint": "1.60.0" },
  "entries": [
    // file 为仓库相对路径；rule 为诊断码（无 code 的诊断使用固定占位符）；
    // message 为折叠空白后的诊断消息；count 为同文件同规则同消息的出现次数
    {
      "file": "packages/ellamaka-app/src/pages/layout.tsx",
      "rule": "typescript-eslint(no-floating-promises)",
      "message": "Promises must be awaited, add void operator to ignore.",
      "count": 2,
    },
  ],
}
```

判定规则四条，缺任何一条都会留下回归通道：

- **`must` 新键失败**：当前诊断出现基线中不存在的「文件 + 规则 + 消息」组合时，检查退出码非 0。
- **`must` 次数上升失败**：同一键的当前次数高于基线记录时失败。
- **`must` 次数下降（stale）同样失败**：修复后必须运行 `lint:fix` 同步扣除。这一条是必需的——否则「修掉一条、
  日后同键再加一条」会复用已修复债务的额度，门禁在总数不变的情况下放行回归。
- **`must not` 收缩时放大**：`lint:fix` 检测到新键或次数上升时拒绝写入并失败，基线文件内容保持不变。
  不存在「接纳新违规」的开关。

**基线文件本身缺失时一律失败，即使当前诊断为空。** 否则删除基线就等于重置门禁：先记录债务、再删除文件、
再重新生成，被删除的违规会作为合法存量原样回到新基线里。首次生成因此不能与日常收缩共用路径：
只有显式 `bun run lint:init` 才会写出新基线，而它以「可访问 Git 历史上是否建立过基线」为判据——
工作区已有文件、`HEAD` 已有文件、或历史提交曾记录过该文件（哪怕删除本身已被提交）都拒绝。已建立的基线只能
用 `git checkout <commit> -- .ci/oxlint-baseline.json` 恢复。日常 `lint:fix` 在文件缺失时失败，不写任何内容。

判定必须失败关闭：Git 探测失败、或处于历史被截断的浅克隆、因而无法证明「从未建立」时，按已建立处理并拒绝初始化，
由操作者补全历史后再判断。宁可挡住一次合法初始化，也不能把已建立的账本当成空白账本重开。

### 精度边界

基线按聚合计数工作。同一次检查中删掉一条同键违规、同时新增另一处同键违规时最终计数不变，门禁无法区分。
因此门禁的准确表述是「不允许新增键、不允许逐键次数上升、不保留退休额度」，而不是「每一个新增违规都必然失败」。
要做到后者需要逐行指纹，代价是每条诊断必须稳定携带源码位置，与格式化、行号漂移和批量重构直接冲突。

诊断消息是键的一部分：固定工具版本下稳定；跨版本升级时文案可能变化，会产生新键从而**失败关闭**而非静默放行。
基线文件记录 `generatedWith` 保存生成它的 lint 工具版本；升级 lint 工具时把消息变化当作一次需要审阅的基线迁移，
不允许直接整份重新生成。

## Data and State Model

| State      | Location                                                | Owner                                            | Lifecycle & Rules                                    |
| ---------- | ------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| lint 基线  | `.ci/oxlint-baseline.json`                              | 门禁检查器 `packages/opencode/script/lint-gate/` | 随代码提交；只能通过 `lint:fix` 收缩，不接受手工放大 |
| lint 配置  | `.oxlintrc.json`                                        | 仓库根                                           | 范围、停检、测试路径 override 的唯一来源             |
| 格式化配置 | 根 `package.json` 的 `prettier` 字段、`.prettierignore` | 仓库根                                           | `semi: false`、`printWidth: 120` 固定                |
| CSS 规则   | `packages/ellamaka-app/.stylelintrc.json`               | `packages/ellamaka-app`                          | 规则为 error 级，违规即失败                          |

门禁本身不持有数据库或缓存状态；每次运行从已跟踪文件与基线文件重新推导结果。

## Business Rules and Failure Boundaries

**检查范围必须与门禁能力一致。** 本文只对上表中标注「检查」的范围承诺「新增零告警」。上游 package 中
`src/wopal/`、`src/workbench/` 以外的本地定制文件既不在 lint 保护内、也不在格式化范围内，这是为避免与上游
合并冲突而接受的已知缺口，不得据此宣称上游代码同样受保护。

**新增门禁必须同时进入两处。** CI 只在 nightly 与手动触发运行（CI 额度是明确的产品约束，不在 push/PR 上触发）；
实时拦截由提交钩子承担，nightly 覆盖 `--verify` 绕过与本地环境漂移。`bun run ci:local` 是 nightly 的手写步骤副本，
不读取 workflow 定义。新增任何门禁步骤必须同步加入 `ci-local.sh`，否则会出现「本地预检全绿、nightly 失败」的错位。

**提交钩子的已知限制。** 钩子读取工作区内容而非索引内容，部分暂存（同一文件既有已暂存改动又有未暂存改动）
存在漏检。修复路径是显式运行 `bun run format`，不接受钩子改写索引。钩子内的密钥扫描、lint、格式化三项相互独立执行，
任一项失败整体即失败。

**失败后果。** lint 失败时输出每个违规的文件、规则、消息与「基线/当前」次数，并区分新键、次数上升、stale 三类；
stale 提示运行 `lint:fix`。`lint:fix` 在检测到放大时拒绝写入，基线文件逐字节不变。格式化失败时提示运行
`bun run format`。CSS 违规由 stylelint 直接报错。

## Reference Documents

| Document                                        | Purpose                                                       |
| ----------------------------------------------- | ------------------------------------------------------------- |
| [Test Isolation](./DESIGN-testing-isolation.md) | 测试隔离的同形门禁契约：四元组基线与 stale 判定语义的既有实现 |
| [Distribution](./DESIGN-distribution.md)        | 发布流程与 CI 触发策略的产品约束来源                          |
