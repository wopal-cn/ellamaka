---
name: Ellamaka Docs AGENT RULES
description: Ellamaka 文档目录资产地图、权威层级与维护职责
---

# Agent Development Rules

## Canonical References

- DESIGN: `./DESIGN.md`
- ELLAMAKA SDK: `./DESIGN-ellamaka-sdk.md`
- WOPALSPACE SDK: `./DESIGN-wopalspace-sdk.md`
- 父规范: `../AGENTS.md`

## 目录资产

本目录是 ellamaka 的设计与文档资产集合。文档按职责分三类。

### 设计真相源

| 文档                       | 职责                                                                                                              | 维护职责                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `DESIGN.md`                | 架构概览与定制索引：运行时职责、品牌身份、空间检测、配置契约、ontology 加载、状态归属、ellamaka 与 dsh 双核心架构 | 架构变更时同步                  |
| `DESIGN-desktop.md`        | 官方桌面应用架构：Electron 主进程、sidecar 承载、窗口与 PTY 生命周期                                              | 桌面实现变更时同步              |
| `DESIGN-distribution.md`   | 分发与版本身份唯一真相源：产品 SemVer、build identity、manifest、workflow、R2 CDN、选择性上游参考策略             | 发布机制变更时同步              |
| `DESIGN-dsh-base.md`       | dsh 融合基础：固定 Active Home、generation lease、Onboarding/Setup 中的 Core Preparation 与快速 Activation        | 融合机制变更时同步              |
| `DESIGN-dsh-web.md`        | Web profile：插件供应链、插件市场、Wopal 声明式 preset bundle、多 profile 解耦、Workbench 融合                    | Web profile 变更时同步          |
| `DESIGN-ellamaka-sdk.md`   | Runtime HTTP SDK：PublicApi、OpenAPI 3.1、生成客户端、契约发现与兼容性                                            | Runtime API/SDK 变更时同步      |
| `DESIGN-wopalspace-sdk.md` | trusted-local application SDK：operation registry、本地契约、发现产物与 CLI 投影                                  | 本地 application SDK 变更时同步 |
| `DESIGN-ellamaka-tools.md` | 工具容器 profile：能力采用、工具投影、沙箱、按空间配置                                                            | 工具容器变更时同步              |
| `DESIGN-onboarding.md`     | Ellamaka Server GUI Onboarding + Terminal Setup：共享初始化状态、步骤计划、认证 HTTP/SSE 与 Core Preparation 编排 | onboarding 流程变更时同步       |
| `DESIGN-workbench.md`      | Workbench 架构选择、状态模型与交互流程                                                                            | Workbench 产品设计变更时同步    |

`DESIGN.md` 是文档树入口，头部枚举全部子设计；子设计头部以 `Parent: ./DESIGN.md` 指回。新增或删除子设计时两侧同步。

### Deferred Design Drafts

| 文档                       | 范围                                    |
| -------------------------- | --------------------------------------- |
| `DESIGN-config-engine.md`  | 阶段 3 草稿，不属于当前 SDK/DSH 实施    |
| `DESIGN-plan-scheduler.md` | 阶段 4 可选调度草稿，不构成核心启动依赖 |

### 研究与参考材料

| 资产                                                                 | 职责                                    | 维护职责                       |
| -------------------------------------------------------------------- | --------------------------------------- | ------------------------------ |
| `references/ellamaka-config-mechanism.md`                            | 配置机制深度参考                        | 配置机制变更时同步             |
| `research/deepseek-harness-architecture-and-integration-research.md` | dsh 全景调研，dsh 设计文档的技术依据    | 不主动更新；变更时保持链接一致 |
| `research/opencode/`                                                 | 上游 OpenCode 架构、机制与 SDK 专题分析 | 不主动更新；变更时保持链接一致 |
| `research/claude-code/`                                              | Claude Code 架构与 agent SDK 对比研究   | 不主动更新；变更时保持链接一致 |
| `research/hermesAgent/`                                              | hermes-agent 深度调研                   | 不主动更新；变更时保持链接一致 |
| `research/kilocode-upstream-merge-analysis.md`                       | kilocode 上游合并分析                   | 不主动更新；变更时保持链接一致 |
| `research/workbench-git-files-review-analysis.md`                    | Workbench Git 文件评审分析              | 不主动更新；变更时保持链接一致 |
| `research/session-timeline-virtual-scroll-issue.zh-CN.md`            | Session 时间线虚拟滚动问题分析          | 不主动更新；变更时保持链接一致 |

研究材料承载论证与分析，为设计和实现提供依据，可被设计文档作为权威依据引用。

## Implementation Rules

### 真相源唯一

- 每类事实只有一个权威文档。设计真相在 `DESIGN*.md`；Runtime 端点契约在生成 OpenAPI 3.1 与 `DESIGN-ellamaka-sdk.md`；trusted-local operation 契约在 WopalSpace SDK registry 与 `DESIGN-wopalspace-sdk.md`。`DESIGN.md` 保留定制索引并指向权威章节，不重复细节。
- 配套文档不得改名为 `DESIGN-<topic>.md`，也不进入子设计枚举。
- 新增顶层文档前，先在 `DESIGN.md` 的「设计文档关系」表中声明其职责与关系，再创建文件。

### 文档集一致性

- 修改任一设计文档时，同步检查其上级、子设计与同级文档，修正与本次变更冲突的陈述，并保持双向索引一致。
- 顶层文档集更新后，运行 `dev-doc-master` 技能的质量门控（`scripts/verify-docset.py`）并确保通过。

### 研究材料维护

- 研究文档不主动更新；内容保持不变。
- 研究文档发生改名、移动、增删时，同步修正全部引用点，保持链接一致。
- 历史文档归入 `done/` 或 `archive/` 目录，不以研究材料的名义存放。

## User-Supplied Rules
