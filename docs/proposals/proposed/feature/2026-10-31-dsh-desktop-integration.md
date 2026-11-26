# DSH Desktop Capabilities and Host Hardening Candidates

Status: proposed

- **Class**: feature
- **Created**: 2026-10-31

## Problem

Ellamaka Desktop 与基于 DeepSeek Harness（DSH）的内置能力之间仍存在三组尚未选型和落地的产品级缺口：

1. **Desktop 宿主成熟度缺口**：现有的 `electron-updater` 多阶段状态协同、崩溃/异常退出恢复与窗口引导、以及 macOS/Windows 安装包签名公证与安装后校验工程仍有加固空间；
2. **DSH 版本升级后的能力盲区**：DSH 闭包升级目前侧重基础包版本、Core Ready 与少量 preset，缺少对发行内置层、官方可选层（`OPTIONAL_BUNDLES` / `ON_DEMAND_BUNDLES`）及用户既有 profile 兼容性的自动化差异审计；
3. **Web 与原生 Desktop 能力适配缺失**：DSH Web 官方自带的右侧 Browser、文档预览、文件树、终端、Voice Input 等能力，以及 DSH Desktop 原生的受控 `<webview>` guest、文件拖放/目录选择器等宿主能力，目前尚未在 Ellamaka Workbench 与 Electron Main 之间完成产品选型和接口设计。

_注：原候选池中的 login-shell 环境探测（A）、Main 与 sidecar 宿主环境边界分离（B）、禁止持久化完整环境缓存（D）、启动诊断脱敏（E）以及不叠加重复 scrubber 的审计结论（C）已落地并纳入现行 [DESIGN-desktop.md](../../../DESIGN-desktop.md) 与 [DESIGN-logging.md](../../../DESIGN-logging.md)；长期凭据模型方向由产品级提案 [credential-broker-transition-proposal.md](../../../../../../docs/products/wopal-space/proposals/credential-broker-transition-proposal.md) 统一承载。_

## Proposal

在保留 Ellamaka 自身 Workbench Renderer、Onboarding、Ellamaka Server sidecar、WopalSpace 集成与产品发布身份不变的前提下，参考 DSH Desktop（[研究报告](../../../research/dsh-desktop-architecture-and-ellamaka-analysis.md)）的成熟机制进行**选择性、分阶段吸收**，由产品决策者按以下三个轨道逐项挑选并转入对应正式设计：

### Track 1 — Desktop Host Hardening Candidates (F–I)

1. **Candidate F — Updater 协同状态机**：参考 DSH `DesktopUpdateCoordinator`，评估显式 check/download/install 分阶段状态、精确候选版本确认、install 前 Host 任务停止协调、update journal 与监听器显式释放（落点：[DESIGN-distribution.md](../../../DESIGN-distribution.md)、[DESIGN-desktop.md](../../../DESIGN-desktop.md)）。
2. **Candidate G — 崩溃、退出与异常恢复**：按 Ellamaka 实际暴露的产品缺口逐项评估 crash report、fatal recovery、退出前活跃任务确认与 Windows 后台托盘生命周期（落点：[DESIGN-desktop.md](../../../DESIGN-desktop.md)）。
3. **Candidate H — 打包、签名与安装后校验**：独立开展发布加固审计，参考 DSH 的 hardened runtime、entitlements、notarization、Windows 代码签名与安装后运行时树校验（落点：[DESIGN-distribution.md](../../../DESIGN-distribution.md)）。
4. **Candidate I — 共享桌面基础设施包（长期观察）**：仅当至少 2–3 个通用宿主机制在 Ellamaka 经过充分实践验证并出现维护重复时，再单独评估是否抽取无产品身份的共享包，当前不提前抽象。

### Track 2 — DSH Capability Upgrade Gate and Web Selection (J–K)

1. **Candidate J — 建立 DSH 升级能力差异门禁（第一阶段优先）**：每次 DSH 版本升级时，以实际锁定安装制品（而非参考仓 `main`）为真相源，对比发行内置层、官方可选层、实际 profile 层、宿主能力层与隔离 Home 运行验收，输出结构化差异清单（归类为自动继承 / 需产品选择 / 需兼容修复），且测试仅在隔离 Home 运行（落点：[DESIGN-dsh-base.md](../../../DESIGN-dsh-base.md)、[DESIGN-dsh-web.md](../../../DESIGN-dsh-web.md)）。
2. **Candidate K — 选配官方 Web 能力（第一阶段）**：先验证已在官方 `web-app` 中的文档预览、文件树与终端；优先评估显式 opt-in 右侧 Browser（sandboxed `iframe`）；按需评估 Session Search、Titles 与外部编码子代理 bundle；Voice Input、Auto Review、Inspector、CUA 与协作类实验插件按风险分别审批，不默认全开（落点：[DESIGN-dsh-web.md](../../../DESIGN-dsh-web.md)、[DESIGN-workbench.md](../../../DESIGN-workbench.md)）。

### Track 3 — Native Desktop Host Adapters (L, Stage Two)

- **Candidate L — 适配原生 DSH Desktop 宿主能力（第二阶段）**：研究在保留 Ellamaka `web` profile 身份（不改名为 `desktop` 或直接复制官方 `desktop/cordis.patch.yml`）的前提下，由 Electron Main 与可信 preload 提供受控原生能力桥接（如 Browser `<webview>` guest ownership、原生目录/文件选择器、文件拖放/路径授权、快捷键/焦点协同与麦克风权限），严禁向嵌入页暴露裸 Electron IPC 或 Host Cookie（落点：[DESIGN-desktop.md](../../../DESIGN-desktop.md)、[DESIGN-workbench.md](../../../DESIGN-workbench.md)）。

## Alternatives considered

- **整体用 DSH Desktop 替换 Ellamaka Desktop**：会同时替换 Renderer、Host、更新身份、打包体系与品牌资产，收益与重构范围严重失衡，因此排除。
- **在 Ellamaka sidecar 旁额外启动 `dsh-desktop-host`**：会制造双 Host 所有权冲突，使端口、凭据、生命周期与环境状态难以同步，因此排除。
- **用 DSH Renderer 替换 Ellamaka Workbench，或用 DSH 值替换 Ellamaka 更新渠道**：Workbench 与独立发布渠道是 Ellamaka 核心产品边界，不因基础设施复用而放弃，因此排除。
- **将整棵 DSH `apps/desktop` 目录复制到 Ellamaka**：会引入大量 DeepSeek 产品耦合与长期上游同步负担，应坚持文件级与能力级选择性移植。
- **提前抽取共享的桌面基础设施 npm 包**：在仅完成少数机制移植前提前抽象会增加无谓中间层，因此推迟至多项机制验证后再议。

## Acceptance criteria

1. **候选入设计前不越权落地**：未获得用户选中并同步写入对应正式 `DESIGN-*.md` 前，本提案中的 F–L 候选不得进入代码实施计划。
2. **第一阶段升级门禁可复核**：Candidate J 落地后，DSH 升级审计报告必须基于真实锁定安装制品覆盖内置层、官方可选层（含 16 个 `OPTIONAL_BUNDLES` 与 2 个 `ON_DEMAND_BUNDLES` 核对）、实际 profile、宿主条件与隔离 Home 实测证据，且不泄露密钥或 Cookie。
3. **Web 与原生适配不破坏产品边界**：Candidate K/L 选中并实施后，必须保持单 sidecar Host、Workbench 主控权与现有 DSH `/dsh/*` 认证/代理边界，原生桌面能力需在真实 macOS 与 Windows 打包制品上验证通过。

## Risks

- **参考仓与实际安装闭包版本漂移**：若直接对照参考仓库 `main` 而非实际锁定的 DSH 安装制品（如 `dsh-deepseek-chat-import` 的出现差异），会导致能力清单失真。
- **未经门禁批量开启实验插件**：Voice Input、Auto Review（含 Full access 风险）、Inspector（含抓包与本地代码执行）及 CUA 具有高权限或高资源风险，盲目全开会引入安全与稳定性隐患。
- **原生桥接安全越界**：第二阶段若为省事向 DSH iframe 开放宽泛 Electron IPC 或 `webviewTag: true`，将直接破坏 Renderer 沙箱边界。

## Reference Documents

- [DSH Desktop Architecture and Ellamaka Analysis](../../../research/dsh-desktop-architecture-and-ellamaka-analysis.md)
- [Ellamaka Desktop DESIGN](../../../DESIGN-desktop.md)
- [Ellamaka Distribution DESIGN](../../../DESIGN-distribution.md)
- [Ellamaka DSH Base DESIGN](../../../DESIGN-dsh-base.md)
- [Ellamaka DSH Web DESIGN](../../../DESIGN-dsh-web.md)
- [Ellamaka Workbench DESIGN](../../../DESIGN-workbench.md)
- [WopalSpace Credential Broker Proposal](../../../../../../docs/products/wopal-space/proposals/credential-broker-transition-proposal.md)
