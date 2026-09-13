---
name: Ellamaka Docs AGENT RULES
description: Ellamaka 文档目录资产地图、权威层级与维护职责
---

# Agent Development Rules

## Canonical References

- DESIGN: `./DESIGN.md`
- API CONTRACT: `./API-CONTRACT.md`
- 父规范: `../AGENTS.md`

## 目录资产

本目录是 ellamaka 的设计与文档资产集合。文档按职责分四类。

### 设计真相源

| 文档 | 职责 | 维护职责 |
|---|---|---|
| `DESIGN.md` | 架构概览与定制索引：运行时职责、品牌身份、空间检测、配置契约、ontology 加载、状态归属 | 架构变更时同步 |
| `DESIGN-desktop.md` | 官方桌面应用架构：Electron 主进程、sidecar 承载、窗口与 PTY 生命周期 | 桌面实现变更时同步 |
| `DESIGN-distribution.md` | 分发与版本身份唯一真相源：产品 SemVer、upstream lock、build identity、manifest、workflow、R2 CDN | 发布机制变更时同步 |
| `DESIGN-ellamaka-dsh.md` | ellamaka 与 dsh 融合架构：双引擎集成、插件供应链、生产物化 | 融合机制变更时同步 |
| `DESIGN-onboarding.md` | Desktop onboarding 目标实现：入口判定、状态机、CLI machine 调用 | onboarding 流程变更时同步 |
| `DESIGN-workbench.md` | Workbench 架构选择、状态模型与交互流程 | Workbench 产品设计变更时同步 |

`DESIGN.md` 是文档树入口，头部枚举全部子设计；子设计头部以 `上级: ./DESIGN.md` 指回。新增或删除子设计时两侧同步。

### 配套文档

| 文档 | 职责 | 维护职责 |
|---|---|---|
| `API-CONTRACT.md` | Runtime API 与 SDK 契约：端点分层、领域语义、schema、错误与兼容性 | 新增或修改端点时同步 |

配套文档是独立的真相源，不属于 `DESIGN-<topic>.md` 命名体系，在 `DESIGN.md` 中以「配套文档」声明。

### 研究与参考材料

| 资产 | 职责 | 维护职责 |
|---|---|---|
| `references/ellamaka-config-mechanism.md` | 配置机制深度参考 | 配置机制变更时同步 |
| `research/deepseek-harness-architecture-and-integration-research.md` | dsh 全景调研，`DESIGN-ellamaka-dsh.md` 的技术依据 | 不主动更新；变更时保持链接一致 |
| `research/opencode/` | 上游 OpenCode 架构、机制与 SDK 专题分析 | 不主动更新；变更时保持链接一致 |
| `research/claude-code/` | Claude Code 架构与 agent SDK 对比研究 | 不主动更新；变更时保持链接一致 |
| `research/hermesAgent/` | hermes-agent 深度调研 | 不主动更新；变更时保持链接一致 |
| `research/kilocode-upstream-merge-analysis.md` | kilocode 上游合并分析 | 不主动更新；变更时保持链接一致 |
| `research/workbench-git-files-review-analysis.md` | Workbench Git 文件评审分析 | 不主动更新；变更时保持链接一致 |
| `research/session-timeline-virtual-scroll-issue.zh-CN.md` | Session 时间线虚拟滚动问题分析 | 不主动更新；变更时保持链接一致 |

研究材料承载论证与分析，为设计和实现提供依据，可被设计文档作为权威依据引用。

### 进度索引

| 文档 | 职责 | 维护职责 |
|---|---|---|
| `PLAN-TODOS.md` | dsh 双引擎融合的进度索引与批次管理 | 批次推进时更新 |

`PLAN-TODOS.md` 只管总览与执行顺序。设计真相归 `DESIGN-ellamaka-dsh.md`，跨文件、多任务的大步实施归 dev-flow Plan。

## Implementation Rules

### 真相源唯一

- 每类事实只有一个权威文档。设计真相在 `DESIGN*.md`，API 契约在 `API-CONTRACT.md`。`DESIGN.md` 保留定制索引并指向权威章节，不重复细节。
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
