# DSH Desktop 能力选择性吸收提案

> **Status**: Draft / Research Proposal
> **Updated**: 2026-11-16
> **Authority**: 本文是候选方案池，不是 Active DESIGN，也不是实施 Plan。
> **Research Source**: `../research/dsh-desktop-architecture-and-ellamaka-analysis.md`
> **Design Sources**: `../DESIGN-desktop.md`、`../DESIGN-distribution.md`、`../DESIGN-logging.md`、`../DESIGN-dsh-base.md`、`../DESIGN-dsh-web.md`

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

## Research Track — DSH Profile 能力跟踪与 Desktop 原生能力适配

### Scope and Evidence

本专题分两层。第一层研究 DSH 官方 Web 能力、可选 bundle 和版本升级时的能力变化；第二层研究官方 Electron 宿主能力与 Ellamaka 现有 Desktop 之间的适配。两层均为待选择的候选研究，本文不授权安装插件、修改运行中的 profile、替换 Desktop Host 或修改 Active DESIGN。

**当前对照基线为 DSH `0.2.2-rc.3`**：

- 官方发行配置以**安装的精确 RC.3 闭包**中 `@deepseek-ai/dsh-official-bundles/lib/index.js`、`@deepseek-ai/dsh-web-app/cordis.patch.yml` 为当前版本依据；源码仓的 `packages/util/official-bundles/src/bundles.ts` 和各插件实现用来解释其行为。用户机器上的 `~/.dsh/profiles/desktop` 只代表该用户已配置的 Desktop 实例，不等于官方出厂默认值。
- Ellamaka 内嵌闭包中的 `@deepseek-ai/dsh`、`@deepseek-ai/dsh-web-app` 和 Web profile 使用同一 RC.3 基线。Web profile 的 `dsh.profile.bundles` 为 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@wopal/dsh-web-fetch-http-fakeip`、`@wopal/dsh-sandbox-roots`、`@wopal/dsh-presets`。
- 当前用户的官方 Desktop profile 在两项核心 bundle 之外选入 Voice Input、Auto Review、Inspector 和 `@wopal/dsh-presets`；官方 Web profile 另外装有 `dsh-plugin-shop`、`dshmarket`。这些是实例级选项，不能直接认作每次升级的标准增量。
- 当前 Ellamaka Web 依赖中还存在 `dsh-codex-connect`，该扩展已有 RC.3 兼容性拒绝记录。升级审计必须分别报告“声明已安装”“bundle 已启用”“运行时已加载”和“实际功能可用”，不以存在于 `node_modules` 作为成功依据。

**基础判断**：`dsh-base` 与 `dsh-web-app` 属于官方发行内置层。Web profile 保持这两项的当前闭包解析时，新版本在它们内部新增的普通插件行会随闭包演进；没有必要把所有官方行复制进用户 `cordis.patch.yml`。持续治理的重点是官方对默认启停、entry ID、服务依赖、配置 schema、权限和宿主条件的调整，以及用户或 Ellamaka 覆盖层是否仍成立。

### Candidate J — Establish a DSH Capability Upgrade Gate (Stage One)

#### Problem

升级只检查 DSH 包版本、核心 Web Ready 和少量 preset，不足以反映升级后完整的产品能力。旧 Home 的本地 `file:` 插件快照、历史用户补丁、默认 preset、版本锁定和新的官方可选功能可能与新闭包不一致。反过来，复制新的官方 Desktop profile 也会覆盖用户设置，并把该用户安装的扩展误认成官方基线。

#### Proposed Capability

为每一次 DSH 版本升级产生一份**可复核的能力差异清单**，按以下真相源依次检查：

1. **发行内置层**：两个核心 bundle、官方 profile 模板、默认 entry ID、`disabled` 条件、所需服务和配置 schema；用升级前后锁定的安装制品比较，而不只依赖参考仓库 `main` 的文件。
2. **官方可选层**：`OPTIONAL_BUNDLES`、`ON_DEMAND_BUNDLES`、Plugin Manager 官方目录，以及这些 bundle 的运行平台、额外资源、凭据和实验性权限要求。
3. **实际 profile 层**：`package.json` 的依赖及有序 bundle、`cordis.patch.yml` 的覆盖 ID 和用户启停、实际安装快照的版本/内容、peer/engine 范围、跳过及损坏诊断、`selectedDefault` 指向的 preset。
4. **宿主能力层**：区分普通 Web 插件、依赖 Node/系统服务的 Host 插件，以及要求 Electron Main、preload、IPC 或原生窗口的 Desktop 插件。Web 可安装不等于 Ellamaka Desktop 已具备对应宿主能力。
5. **运行验收层**：在隔离的既有 Home 副本里检查有效完整组合、插件列表、注册/绑定、关键 UI、Workspace、认证与 WebSocket、主动取消和冷重载；针对原生能力再验证真正的 Desktop 打包制品。

差异报告至少包含：`runtimeVersion`、能力/包/entry 标识、旧版与新版状态、来源（官方默认/官方可选/用户覆盖/本体插件）、新建/移除/重命名/默认值或 schema 变化、实际兼容状态、用户影响、必要宿主能力、建议动作和验证证据。配置输出中隐藏密钥、Cookie 和用户私有参数值。

能力变化分成三类处理：

- **自动继承**：官方核心 bundle 内仍兼容的常规功能，沿用新闭包及用户覆盖；经有效组合和回归验证后记录。
- **需要产品选择**：新的可选功能、默认启停变更、危险权限和原生宿主适配；先向用户提供取舍和风险，再进入 DESIGN/Plan。
- **需要兼容修复**：已安装 bundle 与新 DSH 冲突、旧 entry ID/schema 失效、缺失 preset、旧 `file:` 快照；保留用户数据，按官方安装/兼容流程修复并复测，不通过全局版本豁免或覆盖 Home 掩盖问题。

**约束**：检查与兼容试运行使用隔离 Home/临时 profile。正式 Home 由产品升级流程和用户授权控制，不能在正在运行的 profile 上直接重装、同步官方 Desktop patch 或重写用户声明。升级是否完成以用户实际场景验证为准。

#### Recommended Decision

**第一阶段优先候选。** 先建立版本能力目录和差异审计，再决定启用哪些官方增强能力。是否作为每次 DSH 升级的强制门禁、何时阻断发布，由正式设计确定。

### Candidate K — Select Official Web Capabilities (Stage One)

以下是 RC.3 的**候选能力盘点**，不是已批准的启用清单。对于已由官方 `dsh-web-app` 装配的能力，首先检查有效配置和 UI，不应重复安装相同插件。

| 能力                         | RC.3 依据与当前判断                                                                                                       | Web profile 可承载性                                                                | 初步建议                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 右侧 Browser                 | `ui-sidebar-browser` 已由官方 Web bundle 声明，但 `profileContext.name !== 'desktop'` 时默认禁用；Ellamaka 当前无启用覆盖 | **可以**，Web 版本使用 sandboxed `iframe`，支持网页标签和地址栏；部分站点会拒绝嵌入 | 优先评估显式 opt-in，先验证内外网 URL、隔离、导航和关闭行为             |
| 右侧文档预览、文件树、终端   | `ui-sidebar-documentpreview`、`ui-sidebar-files`、`ui-sidebar-terminal` 已在官方 Web bundle 中                            | **已有基础插件**；须实际验证文件读取、Workspace 范围、终端会话                      | 先做能力冒烟测试，不重复装包                                            |
| Workspace 目录选择、插件管理 | `directory-picker-auto` 和 Web Plugin Manager 已在官方组合中；内嵌闭包含原生/浏览目录选择器                               | **已有**，Host 可以独立选择目录选择后端；官方 Electron 对话框属于另一层             | 先测试真实点击路径、重连与运行时服务；故障不以复制 Desktop profile 处理 |
| Voice Input                  | 官方可选 `@deepseek-ai/dsh-experimental-voice-input-bundle`；当前官方 Desktop 实例已选入                                  | **有 Web 插件路径**，但涉及麦克风授权、本地识别模型下载和原生依赖                   | 可选专题，先确认跨浏览器和 Ellamaka Desktop 的录音权限                  |
| Auto Review                  | 官方可选 `@deepseek-ai/dsh-experimental-auto-review`；明确支持 Web/headless                                               | **可以**，但审核结果允许 Full access 执行，增加模型调用成本与安全风险               | 默认不启用；先单独审查权限/审批政策                                     |
| Inspector / 统计             | 官方可选 `@deepseek-ai/dsh-experimental-inspector-profile`，提供 Session Inspector、统计和 NodeJS 调试                    | **Web 可承载**，但可能启用未脱敏抓包和本地代码执行                                  | 仅开发诊断场景候选，不作为普通用户默认能力                              |
| 会话与操作体验               | 官方可选 Session Search、Session Titles、Badge Skill、CoT Translation、Ralph、Persistent Terminal 等 bundle               | 主要是 Web/Host 组合，逐项核验插件的注入服务和实际平台条件                          | 按用户收益、安全与运行资源分组评估，避免把实验性能力一键全开            |
| 协作与工作流扩展             | 官方可选 LiveShare、Worktree、Forge、Plugin Market、Personalized Recommendations                                          | **待逐项验证**；部分会与 WopalSpace 的协作、工作树、插件分发或隐私模型重叠          | 先明确 owner、数据隔离和重复功能；无需求不默认启用                      |
| Computer Use / CUA           | 官方 `@deepseek-ai/dsh-cua-bundle` 是可选能力                                                                             | **宿主依赖与权限待审计**；不能因包可见就推断 Desktop 能执行                         | 单独做能力和安全边界研究，必要部分归第二阶段                            |
| 外部编码 Agent               | 官方按需安装 `@deepseek-ai/dsh-subagent-codex`、`@deepseek-ai/dsh-subagent-claude-code`                                   | **有正式按需 bundle**，需依赖相应 CLI、原生认证及运行环境                           | 可作为 Coding/Agent 增强候选，与现有 Wopal/Fae/Rook 委派分清职责        |
| DeepSeek 对话导入            | 精确 RC.3 发行清单另有可选 `@deepseek-ai/dsh-deepseek-chat-import`；当前参考仓旧快照清单不含它                            | **待核验完整导入契约**、数据来源、隐私和目标 Session 归属                           | 属于版本新增能力审计的代表案例；先研究再选择                            |
| 第三方市场插件               | 当前官方 Web 实例装有 `dsh-plugin-shop`、`dshmarket`；Ellamaka 已有官方 Plugin Manager                                    | 属于外部安装选项，**不是官方核心模板的缺失项**                                      | 先检查现有插件管理的功能缺口，再选择接入来源                            |

RC.3 实际发行版的 `OPTIONAL_BUNDLES` 包含 **16 个** bundle，`ON_DEMAND_BUNDLES` 包含 **2 个**外部子代理 bundle。表格不替代完整官方目录；Candidate J 的清单必须覆盖全部候选，并跟随被升级的发行制品更新。特别是 `dsh-deepseek-chat-import` 在已安装 RC.3 中出现、但不在当前参考仓的旧版源清单中，说明升级审计不能用参考仓 `main` 代替精确发布制品。

**第一阶段的建议顺序**：先验证/选择 Sidebar Browser 的 Web 版本；同步审计当前已装配的 Workspace、文档预览和终端；随后按需求评估 Session Search、Titles、外部子代理等生产收益较直接的能力；Voice、Auto Review、Inspector、CUA 及协作型实验插件按风险分别审批。此顺序仅供产品选择，不改变现有已批准任务。

### Candidate L — Adapt Native DSH Desktop Capabilities (Stage Two)

官方 Desktop 的 `desktop` profile 不只是额外 bundle 列表。它由自己的 Electron Main、`dsh-app://app` 页面、preload `dshDesktop`/`__DSH_DIRECTORY_PICKER__` 等受控桥接、打包运行时、独占 profile 和原生窗口生命周期共同支撑。

Ellamaka 的产品结构不同：Ellamaka Workbench 是自己的 Renderer，DSH Web 通过 `/dsh` 加载在嵌套 iframe 中，Electron Main 与 sidecar 均由 Ellamaka 拥有。Ellamaka 的 `window.api` 已有文件/目录选择等能力，但它不是官方 `dshDesktop` 协议；当前 DSH iframe 也没有获得官方的 Browser guest lease / `<webview>` 桥接。

| 官方 Desktop 原生能力             | 当前 Ellamaka 对应面                                                                                           | 第二阶段需要研究的适配                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser `<webview>`               | 主窗口 + DSH iframe；没有官方 `dshDesktop.browser` lease API，也未启用对应受控 guest 附着                      | Electron Main 的 Browser guest ownership、存储分区、导航/权限检查、快捷键转发及 DSH iframe 到宿主的可信消息通道；不能仅设置 `webviewTag: true` |
| 原生目录与文件操作                | Ellamaka 已有自有目录/文件对话框 IPC；DSH Web 有 `directory-picker-auto`                                       | 决定复用 Host 目录选择器，还是为 DSH 映射受控原生对话框；要处理取消、窗口焦点及来源鉴权                                                        |
| 文件拖放、路径引用和保存          | Ellamaka Renderer 有自己的 preload 能力；官方 DSH 提供独立的 `fileDrag`、`fileActions` 和 `__DSH_HOST_PATHS__` | 明确 Session/Workspace 授权与资源归属，提供最小可验证的跨 iframe 桥接                                                                          |
| 原生快捷键与浏览器焦点            | Ellamaka 已有菜单/窗口/快捷键；官方 Browser 可给受控 guest 转发快捷键                                          | 协调 Workbench、DSH UI、浏览器 guest 与终端的焦点和按键所有权                                                                                  |
| 麦克风及平台权限                  | Ellamaka 有自有 Electron 窗口和权限流程                                                                        | 按页面 origin、用户授权和签名权限支持需要的 DSH 语音功能                                                                                       |
| Platform/更新/恢复/CLI 打包运行时 | 由 Ellamaka 已有产品身份、sidecar、更新和发布体系负责                                                          | 只吸收有明确用户需求的原生机制；保留 Ellamaka 的版本、渠道、账户与产品责任                                                                     |

**关键设计选择**：官方 Desktop 的主页面是有自身 preload 的 `dsh-app://app`；Ellamaka 将 DSH 放入子 iframe。需要研究 DSH Browser 是继续在 Web 中使用 iframe，还是由 Ellamaka Main 在受控位置承载原生 guest，并通过限定来源、会话和能力的消息协议与 DSH UI 连接。安全边界由 Electron Main/可信 preload 拥有，不能把裸 Electron IPC、Node API、任意网址访问或 Host Cookie 暴露给嵌入页。

第二阶段还需决定 profile 身份是否保持 `web`，以及哪些能力依据真实宿主能力检测而非仅靠 `profileContext.name === 'desktop'` 启用。**将 profile 改名为 `desktop` 或复制官方 `desktop/cordis.patch.yml` 都不足以获得原生功能**，还可能破坏当前 Home/实例及升级所有权。

#### Recommended Decision

**列入下一阶段候选，当前不实施。** 由用户决定是追求 Web 功能覆盖还是官方 Desktop 等级的原生体验；正式设计须逐一确定安全接口、Renderer 嵌入方式和打包验收，不引入第二个 DSH Host，也不替换 Ellamaka Workbench。

### Proposed Validation and Delivery Boundary

- 第一阶段成果应是一次完整的发行能力矩阵、差异报告和经过用户选择的 Web 功能清单。每项注明官方支持程度、实际启用状态、权限风险、验证方式及是否进入 `DESIGN-dsh-web.md` / `DESIGN-dsh-base.md`。
- 第二阶段成果应是原生宿主接口与最小安全边界的设计方案，按功能分别进入 `DESIGN-desktop.md`、`DESIGN-workbench.md` 与对应发布设计；通过真正的 macOS/Windows Desktop 制品和用户交互验证后才能认定完成。
- 两阶段均不复制官方用户配置或默认开启全部实验功能。现有 DSH WebSocket 代理的连接问题按独立缺陷和真实打包回归验收，不将 profile 能力扩充当作其修复手段。

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

**新的 DSH 能力整合专题独立于上述 #263 环境修复排序**：建议先选 J（升级能力差异门禁），再从 K（Web 功能候选）逐项选择，L（原生宿主能力）留到下一阶段。选项不等于批准；批准后分别转入正式 DESIGN 与实施 Plan。

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

| 候选                        | 正式设计 owner                                                                 |
| --------------------------- | ------------------------------------------------------------------------------ |
| A login-shell subsystem     | `DESIGN-desktop.md`                                                            |
| B Host env ownership        | `DESIGN-desktop.md`                                                            |
| C child env policy          | `DESIGN-desktop.md` + 实际 Runtime owner DESIGN（视审计结果）                  |
| D env cache safety          | `DESIGN-desktop.md` / `DESIGN-logging.md`（按最终机制）                        |
| E bootstrap observability   | `DESIGN-logging.md` + `DESIGN-desktop.md`                                      |
| F updater coordination      | `DESIGN-distribution.md` + `DESIGN-desktop.md`                                 |
| G crash/quit/recovery       | `DESIGN-desktop.md`                                                            |
| H packaging/signing         | `DESIGN-distribution.md`                                                       |
| I shared package            | 单独架构提案，确定 owner 后再入 DESIGN                                         |
| J profile capability gate   | `DESIGN-dsh-base.md` + `DESIGN-dsh-web.md`（版本与能力验收）                   |
| K official Web capabilities | `DESIGN-dsh-web.md` + `DESIGN-workbench.md`（UI 选择与承载）                   |
| L native Desktop adapters   | `DESIGN-desktop.md` + `DESIGN-workbench.md`（必要时 `DESIGN-distribution.md`） |

进入正式设计后，再由 Issue/Plan 承载实施进度和任务拆分。

---

## Source Material

主要研究依据：

- `../research/dsh-desktop-architecture-and-ellamaka-analysis.md`
- `../DESIGN-desktop.md`
- `../DESIGN-distribution.md`
- `../DESIGN-dsh-base.md`
- `../DESIGN-dsh-web.md`
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
- workspace reference: `labs/ref-repos/deepseek-harness/packages/util/official-bundles/src/bundles.ts`
- installed RC.3 reference: `@deepseek-ai/dsh-official-bundles/lib/index.js` in the pinned DSH closure
- workspace reference: `labs/ref-repos/deepseek-harness/packages/util/official-bundles/src/catalog.generated.ts`
- workspace reference: `labs/ref-repos/deepseek-harness/packages/bundle/web-app/cordis.patch.yml`
- workspace reference: `labs/ref-repos/deepseek-harness/packages/client/ui-sidebar-browser/README.md`
- workspace reference: `labs/ref-repos/deepseek-harness/packages/client/ui-sidebar-browser/src/client/index.ts`
- workspace reference: `labs/ref-repos/deepseek-harness/apps/desktop/src/browser-guests.ts`
- workspace reference: `labs/ref-repos/deepseek-harness/apps/desktop/src/preload-app.ts`

---

## Proposal Summary

本提案的核心不是把 Ellamaka Desktop 变成 DSH Desktop，而是建立一种长期吸收原则：

> **Ellamaka 保留产品层和 Server ownership；对 DSH Desktop 已成熟解决的通用宿主问题，优先理解并移植机制，而不是独立重复造轮子。**

当前最值得进入下一轮正式设计选择的是 login-shell environment、启动诊断和环境持久化安全边界。Updater、crash/recovery、packaging 等能力可以作为独立专题逐步审计，不应借 #263 一次性扩大范围。

DSH 能力整合另按 **J → K → L** 分阶段选择：升级先获得官方能力差异和兼容性证据，再确定 Web profile 应提供的选配能力；原生 Desktop 宿主适配由下一阶段承担。这条路线保留 Ellamaka 的 Workbench、sidecar、Home 与发布所有权。
