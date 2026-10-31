# DSH Desktop 能力选择性吸收提案

> **Status**: Draft / Research Proposal
> **Updated**: 2026-10-30
> **Authority**: 本文是候选方案池，不是 Active DESIGN，也不是实施 Plan。
> **Research Source**: `../research/dsh-desktop-architecture-and-ellamaka-analysis.md`
> **Design Sources**: `../DESIGN-desktop.md`、`../DESIGN-distribution.md`、`../DESIGN-logging.md`

本文提出 Ellamaka Desktop 选择性吸收 DeepSeek Harness Desktop 成熟机制的候选方案。后续由产品/架构决策者从本文挑选条目；被选中的内容先进入对应正式 DESIGN，设计确认后再进入 Issue/Plan 与实施流程。

---

## Proposal Goal

让 Ellamaka 继续拥有自己的 Desktop 产品架构，同时减少对已经由 DSH Desktop 成熟解决的底层 Electron/Host 问题的重复实现和重复踩坑。

目标关系是：

```text
DSH Desktop
  │
  │ 成熟机制参考 / 选择性移植
  ▼
Ellamaka Desktop
  ├─ Ellamaka Workbench
  ├─ Ellamaka branding
  ├─ Ellamaka Server sidecar
  ├─ WopalSpace + DSH integration
  └─ Ellamaka release/update identity
```

提案不把 DSH Desktop 当成 Ellamaka 的新产品壳，也不引入第二个 DSH Host。

---

## Current Architecture To Preserve

当前正式 Desktop 结构保持：

```text
Electron Main
      │
      ├─ Window / Menu / Native platform / Updater
      │
      └─ utilityProcess.fork(sidecar.js)
                    │
                    ▼
           Ellamaka sidecar process
                    │
                    ├─ Ellamaka Server.listen()
                    ├─ Runtime / PTY
                    ├─ WopalSpace integration
                    ├─ DSH Web profile
                    └─ DSH Tools profile

ellamaka-app Renderer
      │
      └─ HTTP / SSE / WebSocket → same Ellamaka sidecar
```

这里有两个必须保持的事实：

1. `sidecar` 就是 Desktop 管理的 Ellamaka Server host，不存在“sidecar 下再启动一个 OpenCode Server 进程”。
2. Ellamaka Renderer/Workbench 与 DSH Desktop Renderer 是两个不同产品 UI；本提案不替换 Workbench。

---

## Integration Principles

### Port mechanisms, not the whole product

吸收对象是 DSH Desktop 中可以独立解释、独立测试的工程机制，而不是整个 `apps/desktop`。

优先采用：

```text
理解机制
  ↓
提取 Ellamaka 需要的最小行为
  ↓
按 Ellamaka owner/contract 重写或小范围移植
  ↓
由 Ellamaka tests 固化
```

而不是长期维护大段未消化的 upstream copy。

### Ellamaka product ownership remains authoritative

以下所有权继续由 Ellamaka 保持：

- Workbench Renderer；
- Onboarding；
- Ellamaka Server sidecar；
- WopalSpace integration；
- Ellamaka appId / productName / protocol；
- icons / logos / installer branding；
- stable/beta/main/local channel vocabulary；
- Ellamaka update feed；
- Ellamaka release identity；
- Ellamaka logging policy。

### DSH Desktop is a reference upstream, not a release baseline

DSH Desktop 的实现可以像 OpenCode reference 一样成为 Desktop 基础设施参考源，但 Ellamaka 不声明自己运行某个 DSH Desktop release，也不把 DeepSeek product identity 纳入 Ellamaka release identity。

### Design before implementation

本文每个候选项只有被用户选中后，才写入对应 Active DESIGN。正式设计未更新前，不把候选项视为实现目标。

---

## Candidate A — Replace the fragile login-shell environment probe

### Problem

当前 `packages/ellamaka-desktop/src/main/shell-env.ts` 使用较简单的一次性 shell probe。

Issue #263 已证明：一次 transient failure 就可能让整个 Desktop 运行期继续使用 GUI minimal PATH，所有后续 sidecar/sandbox shell 都跟着缺失用户 CLI 环境。

### Proposed Capability

用 DSH Desktop 的 `login-shell-environment.ts` 行为作为参考，重新定义 Ellamaka 的 Desktop shell environment subsystem。

候选能力：

1. 从 OS account record 获取真实 login shell。
2. 依次 fallback `/bin/zsh`、`/bin/bash`、`/bin/sh`。
3. 使用 interactive login shell 读取用户环境。
4. 使用 delimiter 包围 `env -0` 输出，避免 rc stdout 污染解析。
5. 对 oh-my-zsh auto update、tmux autostart 等已知非终端阻塞源设置 probe-only 抑制变量。
6. 每个候选独立 timeout。
7. timeout/abort 杀整个 probe process group。
8. 记录每个失败候选及失败原因。
9. 成功后只使用第一份有效环境，不重复初始化多个 Host。
10. Windows 维持原生 inherited environment 路径，不引入 POSIX probe。

### Recommended Decision

**优先级：最高。**

这是 #263 的直接根因层，且 DSH 已有成熟源码和专项测试可参考。

### Design Impact If Selected

需要更新：

- `DESIGN-desktop.md`：Desktop Host environment bootstrap ownership。
- `DESIGN-logging.md`：shell probe 的诊断事件和禁止记录内容。

可能涉及实现：

- `packages/ellamaka-desktop/src/main/shell-env.ts` 或新 `login-shell-environment.ts`；
- `shell-env.test.ts`；
- Desktop startup wiring。

---

## Candidate B — Separate Electron Main env from sidecar Host env

### Problem

当前 Ellamaka `preferAppEnv()` 会把 shell merge 后的环境写回 Electron Main `process.env`，随后 `createSidecarEnv()` 再从 Main 全局环境复制。

这使两个概念混在一起：

- Electron Main 自己需要的 launcher/product environment；
- Ellamaka Server sidecar 需要的用户开发环境。

### Proposed Capability

参考 DSH 的 `hostEnvironment` 模型：

```text
Electron inherited env
       │
       ├─ Main 自己继续使用
       │
       └─ login-shell merge
                  ↓
          sidecarEnvironment
                  ↓
        utilityProcess.fork(env)
```

候选接口方向：

```text
resolveDesktopHostEnvironment(baseEnv)
        ↓
createSidecarEnv(password, hostEnvironment)
```

而不是依赖先修改 Main `process.env` 再复制。

### Value

- 明确环境 owner。
- 降低 Main 与 sidecar 间隐式共享状态。
- 测试更容易注入明确 env，而不是依赖 process-global mutation。
- 与项目 test-isolation 规则更一致。

### Risk

Ellamaka Main 当前可能还有少量逻辑依赖 merge 后的 `process.env`，选中此项时必须逐项识别，而不能机械删除现有行为。

### Recommended Decision

**优先级：高，但建议与 Candidate A 分开确认。**

A 可以解决 #263 的主要可靠性问题；B 是进一步整理所有权边界，价值更长期。

---

## Candidate C — Define a canonical sidecar child-environment policy

### Problem

DSH 对所有 Harness child 使用统一的 `scrubbedParentEnv()`，再叠加调用者显式 env。

Ellamaka 当前 sidecar 本身已经对 Server credential 做了专门生命周期保护，但“哪些普通用户环境应继续传给 Agent child、哪些敏感变量默认不能传”仍更多依赖现有 Engine/DSH 各自实现。

### Proposed Capability

研究 Ellamaka 的 Engine child、PTY、MCP、LSP、DSH subprocess 实际传递链后，决定是否需要定义 Ellamaka 自己的 canonical child-environment policy。

候选语义：

```text
ambient host env
     ↓
central scrub policy
     +
explicit tool/runtime env
     ↓
child
```

### Constraint

这个候选项不能通过“再写一套与 DSH 重复的 scrubber”草率实现。

Ellamaka 当前 DSH tool path 已使用 DSH subprocess 规则；Native Runtime/PTY 也已有自己的环境契约。只有确认存在真实重复、漂移或凭据风险后，才应该抽统一 seam。

### Research Result and Decision

调用链审计确认两个核心已经存在不同且有 owner 的 child-env 语义：

- Ellamaka Native PTY/Shell 从 sidecar `process.env` 与调用层 overlay 派生环境。
- DSH Web Browser Terminal 与 Tools/sandbox subprocess 走官方 `subprocess-local`，由 DSH `scrubbedParentEnv()` 统一构造 child base，再叠加显式 env；`PATH` 保留，因此 Desktop Host Environment 的 PATH 修复会自然进入 DSH。

当前版本不新增 Ellamaka canonical scrubber，也不修改 DSH 官方 scrub。#263 只负责把可靠、同一份 Host Environment 送到 sidecar，让 Native 与 DSH 共享共同上游；各自的 child-env policy 保持在现有 owner 中。

更长期的 Secret 使用模型改为独立研究 Credential Broker，而不是继续扩张名称猜测式 scrub。该方向记录在 [`credential-broker-transition-proposal.md`](./credential-broker-transition-proposal.md)。

### Recommended Decision

**#263 不实施 Candidate C 的统一 scrubber。**

保留 Runtime owner 边界；下一版从 Broker/capability 方向解决 Secret 暴露问题。

---

## Candidate D — Do not persist the complete login-shell environment

### Context

Issue #263 当前候选思路包含“成功后缓存环境，下一次 probe 失败时使用 cache”。

DSH Desktop 当前实现没有把完整 login-shell environment 原样持久化到磁盘。

### Proposal

不采用“完整 env JSON 缓存到 userData”作为默认修复方案。

原因是 shell environment 可能包含：

- API keys；
- tokens；
- cloud credentials；
- 私有代理或内部服务凭据；
- 其他只应存在于当前进程的 secrets。

若后续实测证明 retry/fallback 仍不足，需要 last-known-good cache，则单独设计安全 cache：

- 采用 allowlist，而不是靠 credential-name denylist 猜；
- 优先只缓存 PATH 等明确安全、确有必要的值；
- 不把完整 env 作为可序列化状态对象。

### Recommended Decision

**建议明确拒绝完整 env cache。**

这可以直接作为 #263 正式设计时的安全约束候选。

---

## Candidate E — Strengthen shell/bootstrap observability

### Problem

#263 的直接触发事件无法从历史生产日志还原，说明当前 shell bootstrap failure 的诊断能力不足。

### Proposed Capability

从 DSH 的 per-candidate failure report 吸收以下思想，并按 Ellamaka logging 规则实现：

- probe lifecycle 的失败必须进入持久结构化日志；
- 记录 candidate 类型、mode、failure reason category、timeout 等；
- 不记录完整 PATH；
- 不记录完整 environment；
- 不记录用户 shell 配置内容；
- 不记录命令正文或凭据。

建议只表达类似：

```text
desktop.shell_env.probe_failed
candidate=zsh
reason=timeout
attempt=1
```

而不是 dump `env`。

### Recommended Decision

**优先级：高。**

应与 Candidate A 一起进入设计，否则以后同类 transient failure 仍难以调查。

---

## Candidate F — Adopt selected updater coordination patterns

### Current Ellamaka Ownership

Ellamaka 当前已有自己的 `electron-updater`、stable/beta feed、发布通道和 `quitAndInstall()` 路径。

这些产品规则继续由 `DESIGN-distribution.md` 拥有。

### DSH Patterns Worth Considering

DSH `DesktopUpdateCoordinator` 中有几类机制可以单独评估：

1. check / download / install 显式分阶段状态机。
2. 用户确认绑定到 exact candidate version，避免 stale confirmation。
3. download 与 install 分离。
4. progress / verifying / ready 状态明确。
5. install 前对 Host/tasks 做授权与停止协调。
6. update journal。
7. installed-update qualification。
8. updater listeners 的显式 dispose。

### What Must Stay Ellamaka-Owned

- `stable / beta / main / local`；
- `download.coursedao.com/ellamaka-desktop/...` feed；
- Ellamaka product SemVer；
- Ellamaka release identity；
- Sidecar shutdown semantics；
- Ellamaka update UI；
- Ellamaka signing policy。

### Recommended Decision

**优先级：中。**

这不应与 #263 混在同一 Plan。应单独审计当前 updater 的实际缺口后，再选择具体机制进入 `DESIGN-distribution.md` / `DESIGN-desktop.md`。

---

## Candidate G — Review crash, quit and recovery patterns

DSH Desktop 已有大量 Desktop 产品成熟度工程：

- crash report；
- fatal recovery；
- Host startup failure handling；
- quit confirmation；
- active task inspection；
- update/restart coordination；
- Windows background tray lifecycle；
- update attention。

这些不应批量复制。

建议未来按 Ellamaka 已出现的真实产品问题逐项对照：

```text
Ellamaka 有明确缺口
    ↓
查 DSH 是否已有成熟机制
    ↓
比较产品语义
    ↓
只吸收对应机制
```

### Recommended Decision

**优先级：低到中，按实际缺口触发。**

---

## Candidate H — Review packaging, signing and installed-update verification

DSH Desktop 的 packaging pipeline 对 macOS 与 Windows 做了大量真实发布工程，包括：

- hardened runtime；
- entitlements；
- notarization；
- Windows code signing；
- installer signing；
- copied runtime signature preservation；
- installed-update verification；
- target-specific runtime tree verification。

Ellamaka 已有自己的 build/release identity 和渠道体系，因此这部分应作为“发布质量机制参考”，不是替换发布 pipeline。

### Recommended Decision

**优先级：中长期。**

建议未来独立做一次 Desktop distribution hardening audit，再决定哪些机制值得进入 `DESIGN-distribution.md`。

---

## Candidate I — Consider a shared Desktop infrastructure package only after repeated reuse

如果 Ellamaka 后续连续吸收多项 DSH Desktop 通用能力，例如：

- login-shell environment；
- child process lifecycle；
- updater coordinator；
- crash report；

那么长期维护两份近似实现会重新产生 upstream drift。

届时可以单独评估把真正无产品身份的部分抽成共享 package，例如概念上的：

```text
desktop-host-env
desktop-process-lifecycle
desktop-update-core
```

由 DSH Desktop 和 Ellamaka Desktop 各自消费。

### Constraint

现在不提前抽象。

至少应先有两到三个经过 Ellamaka 实际使用验证的重复机制，再根据真实公共面定义 package。否则容易为了“共享”制造新的抽象层。

### Recommended Decision

**当前不实施，仅作为长期观察项。**

---

## Explicit Non-Candidates

以下方向不建议进入当前整合路线。

### Replace Ellamaka Desktop wholesale with DSH Desktop

不建议。

它会同时替换或重新解释：

- Renderer；
- Host；
- Welcome/account；
- runtime layout；
- update identity；
- packaging；
- protocol；
- branding。

收益与重构范围不匹配。

### Add `dsh-desktop-host` beside the Ellamaka sidecar

不建议。

Ellamaka sidecar 已经是正式 Server host，并且 DSH Web/Tools 已在其中集成。再启动一个 DSH Host 会形成双 Host ownership，增加端口、凭据、生命周期、环境与 Runtime 状态同步问题。

### Replace Ellamaka Workbench with DSH Renderer

不建议。

Workbench 是 Ellamaka 产品层，不属于 Desktop 基础设施问题。

### Replace Ellamaka update feeds or channels with DSH values

不建议。

Ellamaka distribution design 已拥有独立产品版本和 stable/beta/main/local 语义。

### Copy the whole DSH `apps/desktop` tree into Ellamaka

不建议。

这会带来大量 DeepSeek 产品耦合和长期同步成本。选择性移植应保持文件级和 capability 级边界。

---

## Suggested Selection Order

用户后续可以按以下顺序从本提案挑选进入正式设计。

| 顺序 | 候选项                         | 主要收益                             | 主要风险                      | 建议             |
| ---- | ------------------------------ | ------------------------------------ | ----------------------------- | ---------------- |
| 1    | A — login-shell subsystem      | 直接解决 #263 根因层                 | Desktop startup 行为变化      | 优先选           |
| 2    | E — bootstrap observability    | 可诊断 transient failure             | 日志需严格脱敏                | 与 A 同选        |
| 3    | B — explicit sidecar host env  | 清晰 owner、减少 global env mutation | 需要审计 Main 依赖            | 推荐后续选       |
| 4    | D — 禁止完整 env cache         | 避免凭据持久化风险                   | retry/fallback 若不足需另设计 | 建议作为安全约束 |
| 5    | C — canonical child env policy | 统一 child 安全边界                  | 可能与现有 DSH/Native 重复    | 先研究           |
| 6    | F — updater patterns           | 更新流程更稳                         | 与 distribution 设计耦合      | 单独专题         |
| 7    | G — crash/quit/recovery        | 提升 Desktop 产品成熟度              | 范围容易扩大                  | 按真实缺口       |
| 8    | H — packaging hardening        | 提升发布可信度                       | 平台发布工程复杂              | 中长期           |
| 9    | I — shared package             | 减少未来双份维护                     | 过早抽象风险                  | 暂不实施         |

---

## Suggested First Design Slice

当前 #263 的最小但完整正式设计切片为：

```text
A  login-shell subsystem
B  explicit sidecar Host Environment ownership
E  bootstrap observability
D  不缓存完整 shell env
```

这组选择保持：

- sidecar 架构不变；
- Workbench 不变；
- DSH integration 不变；
- updater 不变；
- release identity 不变；
- branding 不变。

只重构 Electron Main → sidecar 的宿主环境 bootstrap 与 ownership，不统一 Native/DSH 的 child-env policy。

兼容路径默认完整继承成功的 login-shell environment；用户可通过 Desktop 全局 allowlist 模式主动限制额外 shell 变量导入。这个选择不使用 credential-name denylist，也不改变 `.env` 的既有支持。

---

## Design Landing Map

被选中的候选项应分别落入正式设计，而不是让本文长期承担产品契约。

| 候选                      | 正式设计 owner                                                |
| ------------------------- | ------------------------------------------------------------- |
| A login-shell subsystem   | `DESIGN-desktop.md`                                           |
| B Host env ownership      | `DESIGN-desktop.md`                                           |
| C child env policy        | `DESIGN-desktop.md` + 实际 Runtime owner DESIGN（视审计结果） |
| D env cache safety        | `DESIGN-desktop.md` / `DESIGN-logging.md`（按最终机制）       |
| E bootstrap observability | `DESIGN-logging.md` + `DESIGN-desktop.md`                     |
| F updater coordination    | `DESIGN-distribution.md` + `DESIGN-desktop.md`                |
| G crash/quit/recovery     | `DESIGN-desktop.md`                                           |
| H packaging/signing       | `DESIGN-distribution.md`                                      |
| I shared package          | 单独架构提案，确定 owner 后再入 DESIGN                        |

进入正式设计后，再由 Issue/Plan 承载实施进度和任务拆分。

---

## Source Material

主要研究依据：

- `../research/dsh-desktop-architecture-and-ellamaka-analysis.md`
- `../DESIGN-desktop.md`
- `../DESIGN-distribution.md`
- `packages/ellamaka-desktop/src/main/shell-env.ts`
- `packages/ellamaka-desktop/src/main/server.ts`
- `packages/ellamaka-desktop/src/main/sidecar.ts`
- `packages/ellamaka-desktop/src/main/updater.ts`
- `packages/ellamaka-desktop/electron-builder.config.ts`
- workspace reference: `labs/ref-repos/deepseek-harness/apps/desktop/src/login-shell-environment.ts`
- workspace reference: `labs/ref-repos/deepseek-harness/apps/desktop/src/main.ts`
- workspace reference: `labs/ref-repos/deepseek-harness/apps/desktop/src/host-process.ts`
- workspace reference: `labs/ref-repos/deepseek-harness/apps/desktop/src/update-coordinator.ts`
- workspace reference: `labs/ref-repos/deepseek-harness/apps/desktop/scripts/electron-builder-config.mjs`
- workspace reference: `labs/ref-repos/deepseek-harness/packages/subprocess/subprocess/src/index.ts`
- workspace reference: `labs/ref-repos/deepseek-harness/packages/shell/bash-local/src/index.ts`
- workspace reference: `labs/ref-repos/deepseek-harness/packages/shell/bash-sandbox/src/index.ts`

---

## Proposal Summary

本提案的核心不是把 Ellamaka Desktop 变成 DSH Desktop，而是建立一种长期吸收原则：

> **Ellamaka 保留产品层和 Server ownership；对 DSH Desktop 已成熟解决的通用宿主问题，优先理解并移植机制，而不是独立重复造轮子。**

当前最值得进入下一轮正式设计选择的是 login-shell environment、启动诊断和环境持久化安全边界。Updater、crash/recovery、packaging 等能力可以作为独立专题逐步审计，不应借 #263 一次性扩大范围。
