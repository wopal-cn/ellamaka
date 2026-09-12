# Ellamaka Workbench Git 状态、文件树与会话审查架构研究报告

## 摘要

本报告针对 **Ellamaka Workbench** 项目在 Git 状态展示、文件树探查、空间级多 Repo 嵌套架构兼容性，以及 Session 闭环内部代码审查（Code Review）与批注系统的可行性与架构进行了深入调研与系统分析。

调研明确了 Ellamaka 现有的前端组件能力及其边界，剖析了在 Wopal 空间多仓库嵌套架构下的底层缺陷，纠正了脱离真实 DOM 结构的 UI 假设，并提出了两个方向的架构方案：基于当前 `Session.tsx` 页面结构的会话内代码审查与批注闭环（[Session 内部文件审查与批注闭环架构方案](#session-内部文件审查与批注闭环架构方案)），以及覆盖空间全部仓库的仓库总览与 Git API 服务（[空间仓库总览与 Git API 服务架构方案](#空间仓库总览与-git-api-服务架构方案)）。两个方向共享同一后端地基 `Git.Service`，按 [重构与实施建议](#重构与实施建议) 的分期推进。

---

## 现有前端组件与能力现状

通过对 `projects/ellamaka/packages/app/src` 的源码分析，Ellamaka 已经具备了良好的 UI 基础与底层渲染组件：

### 文件树组件 (`FileTree`)
* **源文件**: `packages/app/src/components/file-tree.tsx`
* **现有能力**:
  - 支持多层级目录的树状折叠/展开与状态记忆。
  - 支持 `kinds` 映射表，能够根据 Git 状态（`A` 新增 / `M` 修改 / `D` 删除）自动高亮标注节点颜色与状态字母。
  - 支持 `all`（全量文件）与 `changes`（仅变动文件）的视图模式切换。
  - 基于 `@thisbeyond/solid-dnd` 支持文件与目录的拖拽（Drag & Drop）操作。

### Git 差异对比组件 (`SessionReview` / `SessionReviewTab`)
* **源文件**: `packages/app/src/pages/session/review-tab.tsx` / `@opencode-ai/ui/session-review`
* **现有能力**:
  - 支持解析并展示 VCS/Git 补丁差异。
  - 支持 `unified`（单栏统一）与 `split`（双栏并排对比）两种视图格式切换。
  - 具备代码差异高亮、行号锚定以及行级批注（Line Comments）互动能力。

### 多文件选项卡组件 (`FileTabs`)
* **源文件**: `packages/app/src/pages/session/file-tabs.tsx`
* **现有能力**:
  - 基于 `file.pathFromTab` 呈现多文件选项卡，支持标签页拖拽重排与切换。
  - 接入了代码阅读器，支持语法高亮、代码滚动位置持久化与选中行高亮。

### 行级选区与批注存储机制 (`useComments`)
* **源文件**: `packages/app/src/context/comments.tsx`
* **工作机制**:
  1. 用户在代码或 Diff 视图中划选代码行，产生 `SelectedLineRange` 选区对象。
  2. 弹出行内输入框，用户提交批注内容（`comment`）。
* **存储位置与载体**:
  - **完全不修改磁盘上的源代码文件**。
  - 采用前端持久化库 `Persist.scoped(dir, id, "comments")`，保存在**客户端浏览器的 IndexedDB / LocalStorage 缓存**中。
  - 数据结构记录了 `id`（UUID）、`file`（文件路径）、`selection`（起始行 `start` 与结束行 `end`）以及 `comment`（批注内容）。

---

## Wopal 空间级多 Repo 架构兼容性与后端缺陷

### Wopal 空间多仓库特征
在 `wopal-workspace` 空间架构中：
- **空间根仓库 (Space Root)**：位于空间根目录（如 `space/wopal-workspace` 分支），管理 `.wopal-space/` 与空间级规则。
- **嵌套项目仓库 (Project Repos)**：位于 `projects/*` 目录下（如 `projects/ellamaka`, `projects/gesp`, `projects/space-flow` 等），每一个子项目都是独立且自治的 Git 仓库。

### 后端 VCS 服务与 `vcsQuery` 的现实缺陷
分析 `packages/opencode/src/project/vcs.ts` 和 `packages/app/src/pages/session.tsx` (L485) 发现：
- 前端 `reviewDiffs()` 底层调用的 `vcsQuery` 仅针对单一工作目录（`cwd`）执行 `git status` 或 `git diff`。
- **缺陷**：在多 Repo 嵌套空间中，如果单个 AI 会话同时修改了位于不同子项目 Repo 中的文件，当前的后端 `vcs` 无法跨多个 Repo 归集修改，会导致代码改动的漏报与错报。

### 已有 `Git.Service` 的能力边界
`packages/opencode/src/git/index.ts` 已提供完整的 `Git.Service`（Effect service，`@opencode/Git`），核心为通用执行原语：

```ts
run(args: string[], opts: { cwd, env?, maxOutputBytes?, stdin? }): Effect<Result>
```

并封装 `branch / status / diff / stats / patch / patchAll / patchUntracked / statUntracked / applyPatch / show / mergeBase / hasHead / defaultBranch / prefix` 等便捷方法。

能力边界结论：
- `cwd` 是每个方法的入参，服务本身不绑定任何特定仓库，**天然支持任意仓库路径**（等价 `git -C` 语义），多仓库调用不构成架构障碍。
- `run()` 是万能底层，`log / commit / push / stage` 等缺失原语可作为薄封装逐步补充，无需新建平行服务。
- 仓库发现（枚举空间根与 `projects/*`）不在该服务职责内，由上层复用 `SpaceRegistry`。

---

## Ellamaka Workbench 真实界面 DOM & 路由结构剖析

为避免脱离实际代码的抽象套用，本调研重新对 `app.tsx` 和 `layout.tsx` 的 DOM 结构进行了摸排：

### 真实 DOM 层级结构
```
[最外层 Layout (layout.tsx)]
 ├── 1. 顶部 Titlebar (44px, 包含 Logo、空间/项目下拉切换器)
 └── 2. 主 Flex 容器
      ├── 2.1 最左侧 sidebar-rail (64px 宽度图标导航轨)
      ├── 2.2 左侧 SidebarPanel (可伸缩面板，装载工作区与会话列表)
      └── 2.3 路由容器 {props.children}
           └── 路由 /:dir/session/:id 对应装载的【Session 页面 (session.tsx)】
                ├── SessionHeader (会话头部)
                ├── SessionSidePanel (会话侧边栏)
                ├── MessageTimeline (聊天对话历史)
                ├── TerminalPanel (终端面板)
                └── PromptInput (底部提示词输入框)
```

### 界面架构结论
目前的 Ellamaka Workbench 结构中，`{props.children}` 区域在主要使用路径下**完全由 `Session` 页面驱动**。系统中目前并不存在一个独立于 Session 之外的“通用主工作区”。

---

## Session 内部文件审查与批注闭环架构方案

基于真实 Session 页面架构，用户提出了在 Session Panel 内部集成代码审查与批注的痛点与需求。

### 方案设计：Session 内部 Header 视角切换
在 `Session.tsx` 页面内部，保持底部的 `PromptInput` 固定，在顶部 Header 或侧栏增加视图切换：

```
+-----------------------------------------------------------------------------------+
| Session Panel Header                                                              |
| 会话标题: "重构文件树组件"  |  切换菜单: [ 💬 对话 (Chat)  |  🔍 审查 (Review) ]  |
+-----------------------------------------------------------------------------------+
| Panel Body (当前在 [🔍 审查 (Review)] 视角)                                       |
|                                                                                   |
| ▾ 📂 本会话受影响的文件清单 (2 files changed)                                       |
|   ├── 📄 packages/app/src/components/file-tree.tsx (+5, -2)                       |
|   └── 📄 packages/app/src/pages/layout.tsx (+12, -0)                             |
| --------------------------------------------------------------------------------- |
| [ 🔍 Diff 对比视图 (SessionReviewTab) ]                                            |
|                                                                                   |
| 194  const file = useFile()                                                       |
| 195+ const spaceVcs = useSpaceVcs()                                               |
| 196+ // 💬 用户划线批注: "这里的 hooks 传入参数好像漏掉了 typescript 类型定义"      |
| 197  const level = props.level ?? 0                                               |
|                                                                                   |
+-----------------------------------------------------------------------------------+
| Panel Footer (当前 Session Panel 底部固定的 Prompt 输入框)                           |
| 📎 已附加上下文: [ 📄 file-tree.tsx:L195-196 - "这里的 hooks 传入参数好像漏掉..." ]   |
| 💬 [ 按照上面的审查批注，帮我修复类型定义                     ] [ ⬆ 发送给 AI ] |
+-----------------------------------------------------------------------------------+
```

### 交互闭环三步骤
1. **视图切换**：用户在 Session 头部将视角从 `对话` 切至 `审查`，消息流区域替换为 `SessionReviewTab`。
2. **划线批注与 Context 联动**：在 Diff 差异行划选并提交批注时，触发：
   ```ts
   onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
   ```
   批注内容（包含文件路径、选区代码片段预览与批注文本）自动注入到当前 Session 运行中的 `prompt.context` 中。
3. **闭环修复**：用户切回 `对话` 视角或直接在底部输入框按下发送，AI Agent 读取批注上下文并针对特定行号进行第二轮精细修复。

---

## 空间仓库总览与 Git API 服务架构方案

### 目标

在 Workbench 中呈现空间及其全部项目仓库的变更情况：空间根仓库与 `projects/*` 下每个仓库的分支、未提交变更、ahead/behind 状态一屏总览，并支持查看 diff、暂存、提交、推送。后端以 HTTP API 服务提供这些能力，管理仓库的变更、提交、push 与 diff。

### 后端分层

| 层 | 组件 | 职责 |
|---|---|---|
| 原语层 | `Git.Service`（已有，`@opencode/Git`） | git 命令执行与输出解析，`cwd` 定位仓库；扩展 `log / stage / unstage / commit / push / aheadBehind` 原语（均为 `run()` 薄封装） |
| 聚合层 | `Vcs`（已有，`@opencode/Vcs`） | 会话级 diff 聚合与批注依赖，保持现状 |
| API 层 | 新增 `/git/*` HttpApi group（Root 级） | 把 `Git.Service` 原语暴露为 HTTP API；handler 只做 HTTP 到领域服务的翻译，注册于 `server.ts` 组合根，继承现有 Authorization |

不新建平行 git 服务，`Git.Service` 是唯一原语提供者；`/git/*` 是唯一的网络入口。

### 仓库发现

仓库清单复用 `SpaceRegistry`（消费 wopal CLI `space.projects.list` v2，返回注册 projects 与 linked worktrees），空间根仓库作为固定条目补充。后端不重复实现仓库发现逻辑，CLI 清单是事实来源；未能发现的仓库不出现在总览中。

### API 端点草案

| 端点 | 语义 | 关键约束 |
|---|---|---|
| `GET /git/repos` | 全部仓库状态摘要（分支、变更文件数、ahead/behind） | 总览主数据；仓库按 registried 顺序排列 |
| `GET /git/repos/{repoId}/status` | 单仓库详细状态（变更文件列表与类型） | `repoId` 为空间相对路径，realpath 二次过滤，仅接受已注册 space 内的 projects |
| `GET /git/repos/{repoId}/diff?path=&staged=` | 指定文件 diff 文本 | 复用 `Git.patch` 能力 |
| `GET /git/repos/{repoId}/log?limit=` | 提交历史 | 默认 20 条 |
| `POST /git/repos/{repoId}/stage` / `unstage` | 暂存/取消暂存 `{paths[] \| all}` | 写操作 |
| `POST /git/repos/{repoId}/commit` | 提交 `{message}` | **确认流** |
| `POST /git/repos/{repoId}/push` | 推送 | **确认流** |

### 写操作确认流

`commit` / `push` 采用两阶段：

1. **preview**（`POST .../preview`）：dry-run，返回将执行的完整 git 命令与影响摘要（commit：staged 变更 + message；push：ahead 数量 + 待推送 commit 列表）。
2. **execute**（`POST .../execute`）：带 `requestId` 幂等执行，复用 `POST /workbench/sessions` 的 requestID 先例；重复提交同一 `requestId` 返回同一结果。

前端交互：用户点击提交/推送 → 展示 preview 内容 → 确认 → execute。

### 安全与并发

| 风险 | 对策 |
|---|---|
| 路径穿越（伪造 repoId 读任意目录 git） | repoId 仅接受已注册 space 的 projects 相对路径，realpath 二次过滤（复用 `/workbench/locations` 边界模式） |
| shell 注入（commit message 等） | git 命令一律 `args[]` 数组 spawn，不经 shell，天然免疫 |
| 同仓库并发写 | 写操作过 Effect Semaphore 按 repo 串行化；`.git/index.lock` 兜底，冲突返回 409 |
| push 长操作 | 同步执行 + 超时；后续经 `/global/event` SSE 做进度推送 |

### 前端视图挂载

Workbench 已有 `ViewRegistry` 多视图机制（`view-registry.ts` + `registerDefaultViews`），总览视图注册为独立视图。文件树与 diff 分别复用现有组件：

- `FileTree`：git 状态着色（A/M/D）与 changes/all 视图切换，直接用于仓库变更文件树。
- `SessionReviewTab`：unified/split diff 展示与行级批注，直接用于 diff 查看。

不新建平行 UI 组件；总览视图是现有组件的编排层。

### 与 [Session 内部文件审查与批注闭环架构方案](#session-内部文件审查与批注闭环架构方案) 会话审查方案的关系

两个方案共享同一后端地基 `Git.Service`，投影维度不同：

- [Session 内部文件审查与批注闭环架构方案](#session-内部文件审查与批注闭环架构方案) 会话审查：**file-centric**——本次会话跨仓库改了哪些文件，供 `reviewDiffs` 归集。
- [空间仓库总览与 Git API 服务架构方案](#空间仓库总览与-git-api-服务架构方案) 空间总览：**repo-centric**——每个仓库的分支与变更状态，供总览视图展示。

status 数据按仓库组织，file-centric 是前端聚合维度，不增加后端负担。

## 重构与实施建议

1. **P1 后端地基（仓库总览 API）**：
   - 扩展 `Git.Service`：`log / stage / unstage / commit / push / aheadBehind` 原语（`run()` 薄封装）。
   - 新增 `/git/*` HttpApi group（Root 级），含 preview/execute 确认流；按 API-CONTRACT.md 门禁：Schema 声明、错误映射、SDK 重新生成、测试。
   - 仓库清单接入 `SpaceRegistry`，空间根仓库作为固定条目补充。
2. **P2 空间总览视图（Workbench）**：
   - 在 `ViewRegistry` 注册总览视图，复用 `FileTree` 与 `SessionReviewTab` 展示仓库变更与 diff。
   - 提交/推送走确认流（preview 弹窗 → execute）。
3. **P3 会话跨仓库归集（[Session 内部文件审查与批注闭环架构方案](#session-内部文件审查与批注闭环架构方案) 闭环）**：
   - 增强 `Vcs`：会话归集时发现多仓库 → 逐仓库调 `Git.Service` 聚合，修复 `reviewDiffs` 跨仓库漏报。
   - 按 [Session 内部文件审查与批注闭环架构方案](#session-内部文件审查与批注闭环架构方案) 在 `SessionHeader` 增加对话/审查视角切换，批注联动 Prompt。

---

*报告生成时间: 2026-07-30* ｜ *更新: 2026-08-12 融合空间仓库总览与 Git API 服务方案（[已有 `Git.Service` 的能力边界](#已有-gitservice-的能力边界)、[空间仓库总览与 Git API 服务架构方案](#空间仓库总览与-git-api-服务架构方案)、[重构与实施建议](#重构与实施建议)）*