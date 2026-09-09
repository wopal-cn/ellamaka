# Ellamaka Workbench 设计规范

> **状态**：核心设计文档，描述 Workbench 的架构选择、状态模型与交互流程。
> **更新时间**：2026-08-12
> **相关文档**：`DESKTOP.md`（Electron 桌面承载与共享 PTY 生命周期）、`packages/ellamaka-app/AGENTS.md`（开发规则）
>
> 本文专注"是什么"和"为什么"——架构选择、状态模型、交互流程与异常处理设计。具体开发规则（状态所有权边界、事务一致性、effect 竞态防护等）见 `packages/ellamaka-app/AGENTS.md`。

---

## 1. 方向与核心理念

Ellamaka Workbench 是由 `packages/ellamaka-app` 承载的独立产品界面（fork 自上游 `packages/app`）。

**根本边界**：ellamaka 已放弃跟踪上游（见 `BRANDING.md` §12），`packages/ellamaka-app` 是 Ellamaka 自有的应用副本，独立演进，完整拥有 Workbench 与 Chat 的产品体验，可以根据目标体验重组页面、组件、状态与样式。需要参考上游 UI 实现时，从 `labs/ref-repos/opencode/packages/app` 读取，不再依赖 `packages/app` 副本或上游同步。

**核心概念**：

- **Space（空间）** 是 Workbench 的核心管理对象。每个 Space 拥有独立的标签页、面板排版、终端实例、对话状态和布局偏好。
- **对话界面** 包含两种核心内容模式：**TUI**（终端用户界面）与 **Chat**（聊天对话）。
- **布局设计** 不提供独立的 Split（分屏）模式，Split 融入为一种多面板水平排版布局状态。
- **Split Terminal** 是面板内底部的辅助终端区域，不是独立面板，不能承载 Chat 会话，但拥有独立的状态保持。

---

## 2. 目标架构模型

```
Ellamaka App
├─ Official App（官方应用）
│  ├─ Home
│  └─ Session
└─ Workbench
   ├─ Workbench Shell
   ├─ Space Rail（左侧空间栏与会话浏览器）
   ├─ Space Tabs（顶部空间标签页）
   ├─ Panel Workspace（面板工作区：支持 1~3 个水平面板）
   │  └─ 每个 Panel 可选包含 Split Terminal（底部辅助终端子区域）
   └─ Workbench Statusbar（工作台状态栏）
```

面板工作区是产品核心。每个激活的空间可包含 1 到 3 个水平面板，每个面板支持独立的 TUI 或 Chat 视图，可分别定位到 WopalSpace 内任意目录。每个面板可选在底部展开一个 Split Terminal 辅助终端区域。

---

## 3. 壳与路由设计

### 3.1 路由定义

路径 `/workbench` 使用独立的 Workbench Shell 渲染。官方应用页面继续使用继承的 `Layout`。在 `RouterRoot` 中通过条件 `Show` 判断，若当前路径以 `/workbench` 开头，则跳过 `Layout` 的外层包裹。

### 3.2 架构与目录结构

```
packages/ellamaka-app/           ← ellamaka 定制 web UI
  ├── src/pages/workbench/         ← 三栏 IDE 工作台壳、面板与运行时适配
  │   ├── index.tsx                  主布局与事件总线连接
  │   ├── view-store.tsx             工作台视图与面板布局状态管理
  │   ├── workbench-store.ts         唯一持久化布局所有者（同步纯状态变更）
  │   ├── space-store.tsx            Space 工作空间与 Tab 状态管理
  │   ├── session-store.tsx          会话实例及绑定投影状态管理
  │   ├── pty-manager.tsx            PTY 运行时管理器（非持久化）
  │   ├── view-registry.tsx          视图注册表（工厂 + ViewId 枚举）
  │   ├── workbench-actions.ts       跨所有者事务入口
  │   ├── workbench-actions-ports.ts Store/Pty/Session port 构造器
  │   ├── workbench-runtime.tsx      HTTP health / SSE 状态与恢复代次
  │   └── parts/                     顶栏、侧边栏、面板、状态栏等组件
  ├── src/pages/session/           ← Ellamaka 自有 Session 与 Chat 呈现层
  ├── src/components/              ← Ellamaka 应用组件与上游能力适配
  └── src/context/                 ← 应用级上下文与目录范围状态
```

### 3.3 与上游关系

- **上游参考来源**：ellamaka 已放弃跟踪上游（2026-08-31）。需要观察上游产品变化或审查差异时，从 `labs/ref-repos/opencode/packages/app` 读取对应实现。
- **选择性参考**：从参考仓库的 `packages/app` 中，通过差异审查，将符合 Ellamaka 产品方向的能力重新实现或移植到 `packages/ellamaka-app/`。Ellamaka 已形成独立体验的区域继续由自有设计主导。
- **依赖维护**：`package.json` 中的 `workspace:*` 依赖由本仓库统一维护，不再与上游对齐。

---

## 4. 面板工作区与视图隔离

### 4.1 面板状态定义

每个面板通过 `slotState` 处于以下两种状态之一：

| 槽位状态 | 含义 | 主视图能力 | 绑定 Session |
|----------|------|-----------|--------------|
| `empty` | 槽位为空，等待装载 | 显示 `PanelLoader` 装载器 | 无 |
| `bound` | 槽位绑定了 Session | 支持 TUI / Chat / Context 主视图切换，可在面板底部展开 Split Terminal | 有 |

不存在"裸 Terminal 面板"状态。终端体验由 Split Terminal 子区域提供。

面板的持久化结构定义：

```ts
type PanelMode = "tui" | "chat"
type PanelSlotState = "empty" | "bound"
type PanelViewMode = string // "tui" | "chat" | "context"

type WorkbenchPanel = {
  id: string
  slotState: PanelSlotState
  boundSessionId?: string     // 当 slotState === "bound" 时，绑定的 Session ID
  viewMode?: PanelViewMode    // 当前激活的主视图（可选，向前兼容）
  mode: PanelMode             // 面板模式，与 viewMode 同步但持久化必需
  directory: string           // 面板当前的 CWD（工作路径）
  width: number               // flex 占比分配（列宽）
  splitTerminal: boolean      // 面板底部 Split Terminal 是否打开
  splitHeight?: number        // Split Terminal 的高度（像素值）
  // PTY IDs — 作为重连提示持久化，使用前必须由 PTY Manager 探测验证
  tuiPtyId?: string           // TUI 进程的 PTY ID
  termPtyId?: string          // Terminal 模式 PTY ID
  splitPtyId?: string         // Split Terminal 的 PTY ID
}
```

### 4.2 Panel 子区域：Split Terminal

Split Terminal 是面板的**底部辅助终端子区域**，不是独立面板。它拥有以下特征：

- **从属关系**：依附于其所属面板，生命周期随面板走。面板关闭时 Split Terminal 资源释放。
- **不可承载 Chat**：只能运行裸 Shell 终端，不能放置 Chat 会话或 TUI 视图。
- **独立状态保持**：可见性（`splitTerminal` 布尔值）与高度（`splitHeight` 像素值）持久化；PTY 进程由 sidecar 管理，刷新后 Renderer 重建终端渲染状态，并在宽限期内重新连接原 PTY。
- **视图切换不释放**：在 `bound` 槽位中切换主视图（TUI ↔ Chat ↔ Context）时，Split Terminal 的 PTY 进程保持运行，只切换可见性。切回时复用同一终端连接。
- **操作行为**：面板头部右侧的终端图标用于切换 `splitTerminal` 的开关。收起时只隐藏渲染区域，Terminal 连接继续作为 subscriber 存活，保留 PTY 进程与终端上下文；再次展开时复用同一终端。
- **进程存活高亮**：终端图标不采用右侧小绿点形式，而是**直接以图标本身的颜色进行状态指示**。当辅助终端 PTY 进程存活时，图标渲染为高亮绿；进程退出或被销毁时恢复为默认 muted 灰色。该颜色状态与 `splitTerminal` 本身的折叠/展开（pressed 灰色背景）在视觉上解耦。

### 4.3 视图注册机制 (View Registry)

为保持视图的横向可扩展性（如后续追加 `file` 或 `diff` 视图），任何面板视图都必须通过 `view-registry.tsx` 进行注册：

```ts
type PanelViewCtx = {
  panel: WorkbenchPanel
  session?: Session
  directory: string
  sdk: DirectorySdk                 // 由 Panel 的唯一 Provider 注入
  spaceName: string
  spacePath: string
}

type PanelViewDef = {
  id: string
  label: string
  requiresSession: boolean     // 渲染是否必须绑定 Session
  showContext: boolean         // 是否在面板头部呈现 Context 状态环
  render: (ctx: PanelViewCtx) => JSX.Element
}
```

系统已默认注册 `tui`、`chat` 和 `context` 视图。`bound` 槽位的头部呈现 `TUI / Chat / Context` 主视图按钮，并在 `TUI` 左侧提供终端图标，用于切换面板底部的 Split Terminal。

**视图组件不拥有 PTY 生命周期**。视图只把"确保、关闭、连接断开"的意图交给 `WorkbenchActions`；Action 再调用 `PtyManager` 和目录 SDK。PTY 的创建、复用、存活探测、释放、布局提交和视图回退必须是同一个 Action 的一致性边界。视图的 `onCleanup` 只能断开前端连接（WebSocket 等），不得直接调用 `pty.remove`、`PtyManager` 或 Workbench Store。

### 4.4 Canvas 终端的无缝贴边尺寸规则

Workbench 内嵌终端由 `ghostty-web` 的 canvas 渲染。canvas 只能按完整的字符列和字符行绘制，而 Panel 的可用宽高可以是任意像素值。因此，不能把 `FitAddon` 的默认尺寸结果直接作为 Workbench 的视觉尺寸：它会固定预留 canvas 滚动条宽度，并在按字符格向下取整后，于右侧或底部留下可见的深色空带。

**渲染约束**：

1. `<Terminal>` 容器必须是无 padding 的满尺寸、`overflow: hidden` 容器；不要用全局滚动条 CSS 或额外 margin 来遮挡空带。
2. 禁用 `ghostty-web` canvas 自带的滚动条绘制，并以容器的完整内容宽度计算列数，不保留默认的滚动条宽度。
3. 终端尺寸必须从容器实际 `clientWidth` / `clientHeight` 扣除 CSS padding 后计算，不允许写死字符宽高、滚动条宽度或补偿像素。
4. **TUI（`isTui`）采用 full-bleed 策略**：列数与行数向上取整（`ceil`）到完整字符网格。canvas 的宽高始终覆盖容器；超出边缘的不足一格部分由容器裁切，右侧和底部不留下任何正向余量。
5. **普通 terminal 和 Split Terminal 采用 strict 策略**：列数与行数向下取整（`floor`），保证所有字符格完整可见。该策略不继承 TUI 的裁切行为。
6. Electron WebView 缩放或显示器缩放可能让字符格边界落在分数物理像素上。`ghostty-web` 逐行清底色、逐格填背景时，必须在 Renderer adapter 中向右和向下多覆盖一个物理像素；相邻行/格随后覆盖重叠区，避免透明 canvas 形成整屏横竖纹理。补偿不得修改 PTY 字符网格尺寸。

用户也可以在普通 terminal 或 Split Terminal 内手动启动 `ellamaka`。此时该终端不能仅凭 alternate screen 判断为 TUI（vim、less 等也会使用 alternate screen）；必须同时满足：TUI 通过 OSC 标题将终端标为 `Ellamaka` / `ellamaka | …`，且 `ghostty-web` 当前 buffer 为 alternate。满足后动态切换为 full-bleed，并把滚轮映射为 TUI 的 `Ctrl+Alt+Y` / `Ctrl+Alt+E` 消息历史滚动命令；退出 TUI 切回 normal buffer 后立即恢复普通 terminal 行为。

该规则集中在 `src/components/terminal-scrollbar.ts`，并由 `src/components/terminal.tsx` 对 `FitAddon.proposeDimensions()` 和 Ghostty Renderer 注入。适配器必须先检查私有 Renderer 的运行时形状，依赖升级后形状不匹配时安全跳过。禁止在 Panel、TUI 视图或主题 CSS 中重复实现尺寸补偿。

**回归验收**：

- 打开 TUI 后，Panel 的右边和底边不得出现由字符网格或 canvas 滚动条预留造成的可见空带。
- 改变浏览器窗口、Panel 列宽、Split Terminal 高度后，TUI 仍贴齐右边与底边。
- 改变 Electron zoom 或在非整数缩放显示器上运行时，统一背景区域不得出现字符格大小的横竖缝隙。
- 普通 terminal 与 Split Terminal 不出现横向/纵向滚动条，也不因 TUI 的满铺规则裁切字符行。
- 单元测试至少覆盖：默认滚动条预留被移除、TUI 在小于半格余量时仍向上补足一行/列、普通 terminal 保持向下取整，以及分数 DPR 只多覆盖一个物理像素。

### 4.5 终端中文输入法预编辑

`ghostty-web` 通过隐藏 textarea 接收键盘和 composition 事件；其默认样式使用 `clip-path` 完全裁切，因此系统候选窗可以定位、`compositionend` 也能把汉字发送给 PTY，但 composition 期间的拼音等 preedit 文本不会自动出现在 Canvas 上。

`<Terminal>` 必须把隐藏 textarea 与当前光标字符格同步定位，并在同一位置维护独立的 preedit overlay：

1. `compositionstart` 进入预编辑，`compositionupdate` 显示浏览器提供的 `event.data`；不得提前把 preedit 字符发送到 PTY。
2. `compositionend` 由 Ghostty 的输入处理器提交最终文本，overlay 立即清空；textarea `blur` 时也必须清空，避免残留。
3. overlay 使用当前终端字体、前景色、背景色和字符行高，允许文本横向超出一个字符格，但不参与布局和鼠标命中。
4. textarea 继续保持隐藏和裁切，只用于焦点、输入事件及系统候选窗锚点；不得依赖浏览器显示被裁切 textarea 的内容。

回归测试至少覆盖 composition 的 start → update → end 状态序列以及 blur 清理。桌面端人工验收需确认：输入拼音时可见 preedit，候选窗跟随终端光标，选词后只向 TUI 提交一次最终汉字。

### 4.6 Chat 视图：对话轮、内容分块与视觉语言

Workbench Chat 是面向长时间 Agent 协作的结构化工作界面。它将一次用户请求及其后续 Agent 活动组织为一个完整对话轮，让用户能够快速区分最终回复、思考过程、工具执行、文件变更、子代理工作与异常状态。

Chat 的信息组织借鉴 Kilo Code 在紧凑开发界面中的成熟经验：以对话轮建立第一层边界，以内容块表达 Agent 活动类型，以展开状态控制信息密度。Ellamaka 负责自己的视觉语言。所有内容块继续使用 Workbench 现有字体、主题色、边框、圆角和交互状态，形成与 Headbar、Panel、Session Tree、Composer 和 Statusbar 一致的产品体验。

#### 4.6.1 设计原则

1. **最终答案优先**：自然语言回复是对话的主内容。思考、工具执行和过程信息提供可追溯证据，并以更低视觉权重呈现。
2. **类型决定形态**：正文、思考、Shell、文件编辑、上下文读取和子代理拥有稳定且可辨认的内容块形态。用户无需阅读文本即可判断活动类型。
3. **间距建立主边界，表面建立次边界**：对话轮和内容块主要通过垂直节奏分隔。卡片表面用于需要展开、状态表达或内部结构的内容，避免整条回复被大量边框切碎。
4. **流式过程保持稳定**：新 Part 到达时追加到当前对话轮。已渲染内容的字体、宽度和折叠状态保持稳定，避免生成期间出现视觉跳动。
5. **Ellamaka 视觉原生化**：Chat 使用 `--font-family-sans`、`--font-family-mono`、`--text-*`、`--surface-*`、`--border-*`、`--icon-*` 与既有 radius token。Kilo Code 提供信息架构参考，Workbench 主题提供最终视觉表达。

#### 4.6.2 所有权与组件边界

`packages/ellamaka-app/` 拥有 Workbench Chat 的完整呈现层，可根据产品目标深入定制。上游实现参考 `labs/ref-repos/opencode/packages/app`（已放弃跟踪，见 `BRANDING.md` §12）。

**核心决策：`packages/ui` 零修改；内容块在自建与复用官方组件之间务实选择。**

`packages/ui/` 作为基础组件供应商（Markdown、Diff、File、Icon、Accordion、Card、主题 token 与官方工具渲染器），永远不被 Workbench 修改。所有适配都在 `ellamaka-app` 内完成，手段包括组件包装、扩展点注入与作用域 CSS 覆盖。

Workbench Chat 的信息架构、转录行模型、Part 分类、时间线和导航完全由 `ellamaka-app/src/pages/session/` 下的自有组件实现。单个内容块优先自建；当自建成本过高、流式稳定性不足或官方渲染器即为最佳选择时，复用官方组件链并适配接入。每个块的最终取舍记录在 §4.6.6 对应小节，随验证与调优持续校准。

Workbench Chat 不复刻 Kilo Code 专有实现；Kilo Code 提供信息架构参考，Workbench 主题提供最终视觉表达。

展示层以 Ellamaka 自己的 SDK v2 契约为唯一数据依据。会话消息由 `session.messages` / `session.message` 返回的 `MessageV2.WithParts` 提供；Assistant 通过 `parentID` 归属用户消息；`message.updated`、`message.part.updated`、`message.part.delta` 和 `message.part.removed` 驱动实时更新；`session.diff` 和用户消息的 `summary.diffs` 提供变更汇总。`task` 工具完成或运行时在 `state.metadata.sessionId` 中提供子 Session ID，展开子代理活动时通过现有 Session 消息 API 按需读取该子 Session。Chat 不依赖 Kilo Code 的后端扩展、消息排序补丁或专有 WebView 消息。

新增文件：
- `chat-transcript.ts`：Turn 投影、转录行切分、稳定 key 与实时尾部划分
- `chat-render.utils.ts`：基于 Ellamaka SDK 的 Part 过滤、工具分类和摘要提取
- `chat-turn.tsx`：跨转录行共享的 ChatTurn 视觉边界与 AgentResponse 容器
- `chat-blocks/`：各内容块组件目录
- `prompt-navigator.tsx`：提示词导航组件

目标组件关系如下：

```text
PanelChat
└─ WorkbenchChatTimeline
   ├─ VirtualHistory
   │  └─ TranscriptRowView
   ├─ LiveTranscriptTail
   │  └─ TranscriptRowView
   ├─ ChatTurnFrame
   │  ├─ UserMessageBlock
   │  ├─ AgentResponse
   │  │  ├─ NarrativeBlock
   │  │  ├─ ReasoningBlock
   │  │  ├─ ContextToolBlock
   │  │  ├─ ShellActivityBlock
   │  │  ├─ FileChangeBlock
   │  │  ├─ SubagentActivityBlock
   │  │  └─ GenericToolBlock
   │  ├─ TurnChangeSummary
   │  └─ TurnOutcome
   └─ PromptNavigator
      ├─ PromptRail
      └─ PromptNavigationPopover
```

展示模型只派生 Message 与 Part，不持久化消息副本。Session Projection 和目录 SDK 继续拥有服务端数据真相。组件本地状态只保存折叠、选中、复制反馈和滚动交互等瞬态视图信息。

#### 4.6.3 对话轮结构

一个 `ChatTurn` 由一条用户消息和所有以该消息为 `parentID` 的 Assistant 消息组成。多条 Assistant Message 在视觉上属于同一个回复过程，不重复制造 Agent 气泡或独立消息外框。上下文压缩产生的用户消息形成可见的压缩边界；历史分页暂未加载到父消息时，Assistant 先进入稳定的 partial turn，父消息到达后再归并到正式 Turn。

对话轮按以下顺序组织：

1. **用户消息**：右对齐气泡，表达请求边界。
2. **Agent 响应区**：左对齐、全宽的结构化 Part 流。
3. **变更汇总**：会话产生文件变更后，在响应末尾提供可点击的文件数与增删行摘要。
4. **结果状态**：错误、中断、重试和完成状态位于对应活动附近或对话轮末尾。

对话轮之间使用 16px 垂直间距。用户消息与 Agent 响应之间使用 12px 间距。Agent 内容块之间使用 6px 间距；同类连续正文段落由 Markdown 自身的段落节奏组织。间距属于虚拟列表测量高度的一部分，滚动定位与缓存高度始终包含这些边界。

**转录行与虚拟化策略**：保留现有 Virtualizer，并采用 Kilo Code 已验证的“稳定历史 + 直接渲染实时尾部”结构：

- 一个 Turn 投影为独立的用户行、若干 Assistant 分段行、变更汇总行和错误行。Assistant Message 按固定数量的可见 Part 切分为稳定分段；行 key 由 Turn、Message 和首个 Part ID 组成。
- 已完成历史和稳定的实时前缀进入 Virtualizer。当前仍在增长的 Assistant 分段及其后续结果作为 `LiveTranscriptTail` 直接渲染，避免高频文本 delta 持续改变虚拟行测量并造成跳动。
- Turn 仍是语义和视觉边界，而不是单个超大虚拟行。所有同属一个 Turn 的转录行共享 `turnID`，通过连续间距形成完整回复。
- 消息前插分页时保留稳定 row key、测量缓存与首个可见行偏移。字体、Panel 宽度或设备像素比变化时更新布局指纹并使旧测量失效。
- 导航索引保存 `userMessageID → 首个转录行 key`。历史目标通过虚拟行索引定位；位于实时尾部的目标通过同一导航入口定位到直接渲染的 DOM 锚点。

所有 Chat 内容共享同一条可读内容轨道。用户消息、Agent 回复、工具块、变更摘要、实时状态和 Composer（含 Question、Permission、Todo、Revert Dock）使用相同的水平基准和 `98ch` 最大轨道宽度；禁止消息区限宽而 Composer 继续铺满 Panel。轨道在宽 Panel 下居中并保留 20px 内边距，在窄 Panel 下占满可用宽度；内容块保持 `min-width: 0` 和安全换行。正文行宽上限约为 76ch，工具输出和 Diff 可使用完整轨道宽度。

#### 4.6.4 字体层级

Workbench Chat 使用现有字体体系收敛层级，不建立独立于产品的字号系统：

| 语义层级 | 字体 | 字号与字重 | 行高 | 用途 |
|----------|------|------------|------|------|
| 正文 | `--font-family-sans` | 14px / regular | 165% | 用户消息、Agent 最终回复、说明文本 |
| 块标题 | `--font-family-sans` | 14px / medium | 150% | Shell、编辑、子代理、错误等块标题 |
| 次级信息 | `--font-family-sans` | 13px / regular | 150% | 模型、耗时、路径、参数、状态说明、思考内容 |
| 次级标签 | `--font-family-sans` | 13px / medium | 130%–150% | 思考标签、工具类型、计数和小节标签 |
| 代码与输出 | `--font-family-mono` | 13px / regular | 150% | Shell 命令与输出、代码、路径细节、Diff |

正文与工具标题保持同一 14px 基准，通过字重、颜色和容器关系建立层级。元数据统一为 13px，并使用 `font-variant-numeric: tabular-nums` 显示耗时、Token 和计数。Chat 内不使用 11px 或 12px 承载常规信息，确保中文、复杂路径和窄面板下仍有稳定可读性。

Agent 名称、模型和耗时位于响应尾部的轻量元数据行。该行使用 13px、`--text-weak` 和单行省略，作为回复归属信息，不与正文争夺注意力。流式阶段可显示运行状态与累计耗时；完成后收敛为静态元数据。

#### 4.6.5 色彩、表面与形状

Chat 从 Workbench 主题继承颜色，不引入 VS Code 专用色或 Kilo 品牌色：

- 主正文使用 `--text-strong`，一般说明使用 `--text-base`，元数据和折叠摘要使用 `--text-weak`。
- 普通活动块使用 `--surface-base` 或透明背景。可展开内容使用 `--surface-weak` / `--surface-raised-base` 建立轻微层次。
- 边界使用 `--border-weaker-base` 或 `--border-weak-base`。边框表达结构，不装饰整个 Agent 回复。
- 运行、成功、警告和错误状态沿用 Workbench 的 `--icon-*` 与语义色 token。
- 用户气泡、工具块和交互表面沿用 6px 圆角。连续的正文回复保持无框，呈现为清晰文档流。
- Hover、Focus 和 Pressed 状态沿用现有 Button、Accordion 与 Card 交互反馈。键盘焦点使用主题已有 focus ring。
- 所有工具块展开内容（Shell、上下文输出、通用工具、文件变更 Diff）统一滚动条策略：默认隐藏滚动条，鼠标进入内容区域时显示 8px 细滚动条；内容超宽时水平滚动，超长时限制最大高度内部垂直滚动，保证块与块之间视觉一致、默认状态安静。
- 顶部活动会话进度条始终绘制在工具块内容之上（`z-index` 高于工具块定位内容），展开块不得遮挡进度指示。

#### 4.6.6 Agent 内容块类型

**Part 类型映射表**（基于 Ellamaka SDK v2）：

Part 分类同时读取所属 Message 的 `role`。`file`、`agent` 和 `subtask` 属于用户输入模型；Assistant 活动以 `text`、`reasoning`、`tool`、`retry` 与 Message 结果状态为主。未知组合进入安全的 Generic 展示，不因 SDK 后续扩展丢失内容。

| SDK Part Type | Chat Block | 说明 |
|--------------|-----------|------|
| `text` | NarrativeBlock | 最终回复正文 |
| `reasoning` | ReasoningBlock | 思考过程 |
| `tool` (tool=read/glob/grep/list) | ContextToolBlock | 每次读取或检索独立展示 |
| `tool` (tool=bash/shell) | ShellActivityBlock | Shell 命令与输出 |
| `tool` (tool=edit/write/apply_patch) | FileChangeBlock | 文件编辑 |
| `tool` (tool=task/wopal_task) | SubagentActivityBlock | 子代理任务（内联展开） |
| `tool` (tool=todowrite/todoread) | **隐藏** | 由 Composer 上方 SessionTodoDock 独占展示，不进入时间线 |
| `tool` (其他) | GenericToolBlock | 通用工具/MCP |
| `subtask` | UserMessageBlock | Slash Command 触发的子任务输入，显示 command、description 或 prompt 摘要 |
| `agent` | UserMessageBlock | 用户提示词中的 Agent 选择，不属于 Assistant 活动 |
| `file` | UserMessageBlock | 用户提示词的附件、文件引用或资源引用，不代表文件变更 |
| `compaction` | TurnDivider | 上下文压缩分隔 |
| `retry` | TurnOutcome | 模型重试记录；实时重试同时读取 Session Status |
| `step-start` / `step-finish` | **隐藏** | 不进入时间线，仅用于状态同步 |
| `snapshot` / `patch` | **隐藏** | 内部快照/补丁，不展示 |
| `tool` (tool=question) | InteractionBlock | 已回答问题的历史摘要；待回答状态由 Question SSE 请求拥有 |
| Permission Request | Composer 上方 Permission Dock | 独立 SSE 请求，不属于 Part |
| `text.synthetic` | NarrativeBlock 临时状态 | 仅在所属 Assistant Message 运行时显示，完成后隐藏 |

##### NarrativeBlock：自然语言与最终回复

`text` Part 渲染为无框 Markdown 文档块。它使用正文层级和舒适段落间距，支持标题、列表、表格、引用、代码块、文件链接、复制操作，以及 `$...$` 行内和 `$$...$$` 块级 KaTeX 公式。标题、列表、分隔线、内联代码、公式和表格各自拥有稳定的语义节奏，但不引入独立于 Workbench 的字体或颜色体系。

连续 `text` Part 在保持 SDK 顺序的前提下形成连续叙事。工具活动位于它们实际发生的位置，因此用户能够阅读“说明 → 执行 → 结果”的过程。最后一个有效文本块承载整条回复的复制与反馈操作。

##### ReasoningBlock：思考过程

`reasoning` Part 使用独立的可折叠思考块：

- 头部由思考图标、`思考` 标签和从内容提取的简短标题组成。
- 运行中保持展开，并限制在可滚动预览高度内；内容越过高度上限时持续跟随最新内容，用户主动滚动查看上文时才暂停跟随。
- 完成后自动折叠为单行摘要。用户手动展开或折叠后，该选择在当前会话挂载期间保持。
- 内容使用 13px、`--text-weak` 和轻量 inset 表面。思考与最终答案拥有明确层级差，不伪装成正文。
- 加密、脱敏或空 reasoning 不进入时间线。

##### ContextToolBlock：读取与检索

`read`、`glob`、`grep`、`list` 等上下文获取活动各自形成一个紧凑块，并按 SDK Part 顺序留在实际发生位置。头部显示工具类型、文件名或 pattern、路径与运行状态。

- `read` 渲染为非交互信息条：只显示读取的文件名与运行状态，不展示文件内容、不可点击展开（Kilo Code 行为）。
- `glob`/`grep`/`list` 保持可折叠块：运行中展开，完成后折叠；展开态显示该次调用的输入和结果，输出限制在约 240px 最大高度内内部滚动。只有用户手动切换的展开状态被记忆并跨虚拟列表重挂载保持。

独立工具块延续 Kilo Code 的扁平、可追溯结构。用户能够准确看到 Agent 依次读取和搜索了什么。错误状态保留在对应调用上。Workbench Chat 不再把连续读取合并成 Gathered context 摘要。

##### ShellActivityBlock：Shell 与后台进程

`bash`、shell 类 MCP 工具和后台进程活动使用 Shell 块：

- 折叠头部显示终端图标、`Shell`、模型随工具输入提供的动作说明、状态和耗时。原始命令只进入展开内容；不得用截断后的长命令替代动作说明。旧记录缺少动作说明时使用稳定的通用标题，不在头部铺开原始命令。
- “展开 shell 工具部分”只决定新出现 Shell 块的初始状态。已经挂载或被虚拟列表回收的调用保持首次解析出的展开状态和用户选择；切换设置不得批量改变当前时间线行高或造成视口跳闪。
- 命令与输出使用 13px mono。命令、标准输出和错误输出拥有清晰的小节关系。
- 命令区与输出区各自限制在最高 240px，并分别允许内部滚动。任一长区域都不得继续撑高主时间线；运行中仅在输出区内部跟随最新内容。复制命令和复制输出属于块级操作。
- 后台进程以结构化字段呈现命令、PID、cwd、状态和最后输出，不把字段列表伪装成普通终端文本。

##### LiveActivityStatus：运行阶段提示

Session 处于忙碌状态时，Chat 在实时尾部持续表达当前阶段，避免工具之间或首个 Part 到达前出现无反馈空档：

- 首个模型 Part 尚未到达或 reasoning 正在增长时显示“正在思考”。
- 文本正在增长时显示“正在组织回复”。
- 一次工具已经完成、下一 Part 尚未到达时显示“正在考虑下一步”。
- Shell、编辑等工具处于 pending/running 时，对应工具行继续显示自身状态；实时尾部同时保留“正在运行命令”“正在编辑文件”等阶段提示。工具完成而下一 Part 尚未到达时切换为“正在考虑下一步”。
- 阶段提示使用轻量活动标记和整轮忙碌计时，不在 Part 之间重置，不伪造模型自然语言内容，也不把 `step-start` / `step-finish` 暴露为转录正文。忙碌结束后保留一个最小高度的尾部槽位，避免状态消失时内容发生跳动。

##### FileChangeBlock：文件编辑与补丁

`edit`、`write`、`apply_patch` 等活动统一为文件变更块：

- 头部显示文件图标、操作类型、目录、文件名、状态和增删行统计。
- 单文件操作使用一个可折叠块。多文件 patch 使用父级摘要与逐文件 Accordion。
- `edit`、`write`、`apply_patch` 复用 OpenCode App 原有完整展现链路（`MessagePart → edit-tool / write-tool / apply-patch-tool → BasicTool → ToolFileAccordion 或逐文件 Accordion → FileComponent`），不得只把内层 `FileComponent` 嵌入 Workbench 自定义工具外壳，也不得把 unified patch 当作普通 `<pre>` 文本直接铺开。`edit` 渲染 hunk Diff，`write` 渲染完整新内容，`apply_patch` 逐文件渲染 Diff。
- 单文件块隐藏冗余的文件 Accordion 头，以工具触发行为唯一头部；所有头部不 sticky 悬浮。多文件 patch 保留逐文件 Accordion 头。
- 展开内容优先显示 hunk 范围内的 Diff，并限制在约 400px 最大高度内内部滚动，不撑高主时间线；超长 Diff 依靠 `content-visibility` 跳过屏幕外渲染，保持快速滚动。
- 初始展开状态遵循 Workbench“展开编辑工具”设置；运行中默认展开，完成后默认折叠；失败时展开错误摘要，并保留已成功文件的结果。
- 点击文件名打开对应文件；Diff 行可定位到具体行。

##### SubagentActivityBlock：子代理任务

`task` 工具使用子代理活动块。`state.metadata.sessionId` 是子 Session 的规范关联；标题匹配仅用于读取旧历史数据时的兼容回退。该块表达一个独立工作单元，而不是把子会话完整消息树嵌入主对话：

- 头部显示 Agent 类型、任务描述、运行状态、耗时和子活动计数。
- 运行中默认展开，并通过现有 Session 消息 API 按需加载或同步子 Session。内部以紧凑时间轴列出子代理的工具活动。每个条目显示工具图标、动作标题、路径或命令摘要和状态。
- 子时间轴对读取、Shell、编辑和错误使用与主时间线一致的图标和语义色，但以 13px 紧凑行呈现。
- 子代理的最终结果在时间轴末尾显示为摘要。完整子会话通过“打开详情”进入独立视图或标签页。
- 完成后的子代理块默认折叠为任务标题、结果状态和活动计数。失败与等待用户输入的状态保持醒目。

##### Todo 工具：Composer Dock 独占展示

`todowrite` / `todoread` 不进入时间线。任务进度由 Composer 输入框上方的 `SessionTodoDock` 独占展示（进行中项、进度数与完整列表），时间线内不再重复投影 Todo 块，避免双重呈现同一份状态。

##### InteractionBlock：问题与权限

需要用户响应的 Question Request 和 Permission Request 来自 Ellamaka 的独立 SSE 事件，并由现有 Composer 上方交互 Dock 持有。活动请求与所属 Session 关联，保持在滚动区域之外可见。完成后的 `question` Tool Part 以只读摘要块留在对应对话轮中。Permission Request 没有历史 Part；响应后从活动 Dock 消失。Ellamaka 当前 API 不提供 Kilo Code 的 Suggestion Request，Chat 设计不虚构该能力。

##### GenericToolBlock：通用工具与 MCP

未注册专用渲染器的工具使用统一通用块，任何工具都不会从时间线丢失。头部由工具图标、工具名与最具说明性的输入字段组成：按 `command → action → description → query → url → filePath → path → pattern → name` 的优先级提取第一个有值字段作为副标题（借鉴 Kilo Code 的 GenericTool 启发式，并将 `command`/`action` 提前以适配 WopalSpace 工具生态）；无描述字段时降级展示至多 3 个结构化参数（如 `limit=5`）。展开内容以 JSON/文本输出呈现，限制在约 240px 最大高度内内部滚动。通用块遵守相同的字体、间距、状态与折叠规则，保证新工具自然融入 Chat。

##### TurnChangeSummary 与 TurnOutcome

文件变更汇总位于对话轮末尾，显示修改文件数、增删行和进入 Review 的操作入口。它使用无框的紧凑摘要行，与单次文件编辑块形成“过程—结果”关系。

错误位于产生错误的活动块内。无法归属具体 Part 的 Assistant 错误由 `TurnOutcome` 在回复末尾展示。中断与上下文压缩使用带标签的水平分隔，重试状态紧邻当前活动显示。

#### 4.6.7 默认展开策略

默认展开状态由内容类型与生命周期共同决定：

| 内容块 | 运行中 | 刚完成 | 历史回放 |
|--------|--------|--------|----------|
| 正文 | 展开 | 展开 | 展开 |
| 思考 | 展开预览 | 自动折叠 | 折叠 |
| 上下文读取 | 当前调用展开 | 折叠 | 折叠 |
| Shell | 展开并跟随输出 | 保持当前选择 | 折叠 |
| 文件变更 | 展开当前文件 | 折叠 | 折叠 |
| 子代理 | 展开时间轴 | 折叠为摘要 | 折叠 |
| 错误 | 展开错误摘要 | 展开错误摘要 | 展开错误摘要 |

Shell 和文件编辑的用户设置覆盖表中的初始默认值。设置值只在一个新 Part 首次进入呈现层时读取一次，不作为已经挂载块的实时受控状态。

用户手动选择优先于自动策略。折叠状态由 Chat 呈现层的有上限运行时 Map 保存，key 使用 `sessionID + tool + callID/partID`；Map 同时缓存每个 Part 首次解析出的默认状态。虚拟列表回收和重挂载组件时可恢复相同几何状态；刷新应用后按当时设置与默认策略重新计算。Map 达到上限时淘汰最早条目。Session 数据、WorkbenchStore 和 `localStorage` 均不承载折叠状态。

#### 4.6.8 流式更新、虚拟化与滚动

消息时间线使用“稳定历史虚拟化 + 实时尾部直接渲染”。已完成历史按稳定转录行 key 维持测量缓存。当前增长中的 Assistant 分段离开 Virtualizer 后持续接收 `message.part.delta`，完成并稳定后再进入虚拟历史。Markdown 按稳定顶级块增量更新；流式结束时保留可复用块的 DOM，已高亮且源码未变化的代码块原地保留，避免完成瞬间的整段重排或普通代码/高亮代码闪替。未闭合的公式定界符保持普通文本，直到 `$...$` 或 `$$...$$` 完整闭合后才原地渲染，避免流式过程发生公式几何抖动。新增输出不会重建整个消息列表，也不会改变其它块的展开状态。

自动滚动遵循用户意图：用户位于底部时跟随流式输出；用户主动向上滚动、选择文字、聚焦工具块或打开菜单后暂停粘底；“回到底部”操作恢复跟随。子代理与 Shell 的内部输出在自己的滚动容器内跟随，不抢夺主时间线滚动位置。用户手动展开或收起工具块时，先记录工具头部的视口位置，并在下一帧按位置差补偿主滚动容器，保持当前阅读锚点不动。

隐藏的 Space 和非活动 Panel 继续接收必要的数据更新，但只有当前 Space 的活动 Chat Panel 获得 Prompt 焦点和主动滚动控制。视图切换与 Panel keep-alive 保留草稿、时间线位置和当前应用生命周期内的内容块展开状态。

#### 4.6.9 提示词导航

长对话在时间线两侧提供常驻的 `PromptNavigator`。左侧刻度用于快速确认和跳转历史用户请求，右侧目录入口用于浏览完整对话目录；两者共享同一份 turn 索引，并使用 Ellamaka Workbench 的视觉 token 完成呈现。

`PromptNavigator` 只管理已提交的对话历史。底部 Composer 完整保留 Ellamaka 当前实现与样式。模型选择、Agent 选择、附件、权限 Dock、问题 Dock、输入草稿和发送行为均由现有 Composer 负责。

PromptNavigator 不依赖新的后端目录接口。初始目录使用当前已加载的用户消息。用户打开目录后，导航通过现有 `session.messages({ before })` 分页能力和 Session History Loader 逐页水合更早历史，保持主时间线的前插锚点；加载期间在目录顶部显示“正在加载更早消息”。全部分页完成后，刻度轨和目录覆盖完整会话。尚未加载的消息不生成虚假刻度，也不可被直接跳转。

##### PromptRail：左侧消息刻度轨

- 刻度轨贴在 Chat 时间线内容区域左侧，以窄条浮层存在，不压缩正文可读轨道，也不改变 Composer 宽度。
- 每条已加载用户消息对应一个水平刻度。刻度按当前已加载对话的顺序在有限轨道内紧凑排列，不依赖虚拟列表当前挂载节点；历史分页完成后，刻度覆盖完整会话。
- 当前视口所在对话轮使用较长、较强的刻度，其他消息使用较短、较弱的刻度。
- Hover 单个刻度显示对应用户提示词的非交互速览，帮助用户确认目标，而不需要打开完整目录。
- 点击刻度直接将对应用户消息滚动到时间线中央。拖动或连续点击不会破坏虚拟列表测量缓存。

##### PromptDirectoryTrigger：右侧目录入口

- Chat 视窗右侧保留 16px 宽的目录热区；hover 时显示手型和目录标识，点击打开完整消息目录。
- 左侧刻度轨不再承担打开目录的职责，避免“单条速览/直接跳转”和“完整目录浏览”争夺同一窄小点击区域。
- 目录打开时右侧入口保持可见；关闭、选择目录项或按 Escape 后，焦点回到该入口。

##### PromptNavigationPopover：浮层消息目录

浮层从右侧目录入口向左展开，覆盖消息内容而不引发布局重排。目标宽度为 360px，并受当前 Panel 可用宽度约束；最大高度约为 Chat 视口的 70%，内部独立滚动。

浮层结构如下：

1. **标题栏**：仅显示“提示词导航”。不提供上一条、下一条或关闭按钮；用户点击浮层外部即可关闭，Escape 是对应的键盘操作。
2. **消息目录**：每条用户消息形成一个目录项。点击目录项会跳转主时间线，但保持浮层打开，便于连续浏览；仅点击浮层外部或按 Escape 关闭。
3. **当前项**：当前视口对应目录项使用 `--surface-raised-base` / `--surface-raised-base-hover` 层级高亮，并自动滚动到浮层可见区域。

目录项包含两层文本：

- 第一行是用户提示词摘要，使用 14px medium、`--text-strong`，最多两行。
- 第二行是对应 Agent 回复的摘要，使用 13px regular、`--text-weak`，最多两行。
- 摘要移除 Markdown 装饰、工具日志、思考文本和系统生成状态。用户摘要优先取首个有效文本 Part；Agent 摘要优先取最后一个有效 Narrative 文本块的开头。
- 空回复、运行中回复和错误回复使用稳定的状态摘要，例如“正在回复…”、“等待用户输入”或错误标题。

目录项使用 6px 圆角、8–12px 内边距和 4px 文本间距。普通项保持透明背景，Hover 与当前项使用现有 Workbench surface token。浮层使用 `--surface-raised-stronger-non-alpha`、`--border-weak-base` 和现有阴影 token，不复制 Kilo/VS Code 的灰色面板皮肤。

##### 活动消息与跳转

活动消息由主时间线视口中的用户消息锚点决定：优先选择最接近视口上方内容基准线且仍有内容可见的对话轮。滚动时更新刻度与目录高亮，不更新 URL，也不改变 Session 的服务端状态。

跳转复用转录层的 `userMessageID → firstRowKey` 映射。目标位于虚拟历史时，先把 row key 解析为当前索引并调用 `Virtualizer.scrollToIndex()`；目标位于实时尾部时，滚动到对应 DOM 锚点。目录点击、刻度点击、上一条和下一条操作使用同一入口。跳转后用户保持手动滚动控制；系统不会立即恢复流式粘底。活动对话仍在生成时，导航只改变视口，不影响 Agent 运行。

导航支持以下键盘交互：

- `ArrowUp` / `ArrowDown` 在目录项间移动。
- `Enter` 跳转并关闭浮层。
- `Escape` 关闭浮层并把焦点还给刻度轨。
- `Home` / `End` 移到第一条或最后一条消息。

##### 响应式行为

- 单 Panel 与宽 Panel 显示完整刻度轨和 360px 浮层。
- 双 Panel、三 Panel 或窄窗口下，浮层宽度收敛为 `min(360px, Panel 可用宽度 - 24px)`，目录项保持两层文本并执行省略。
- 当 Panel 宽度不足以安全容纳浮层时，目录以 Panel 内全宽 overlay 呈现，仍保留左侧返回/关闭入口。
- 触摸设备扩大刻度命中区域；视觉刻度保持细小，不因触摸尺寸变粗。
- Composer、交互 Dock 和底部操作区始终位于导航作用域之外。

#### 4.6.10 响应式与无障碍

- 64ch 以上宽度保持完整工具标题、路径和状态；更窄面板按“标题 → 状态 → 路径/参数”的优先级省略次要信息。
- 工具块头部是语义化按钮，使用 `aria-expanded` 表达展开状态。运行状态通过文本和图标共同表达。
- 流式正文使用受控 `aria-live`。高频工具输出不逐行播报；状态变化通过简短状态文本通知辅助技术。
- 所有可点击文件、复制、展开和打开详情操作支持键盘访问。焦点进入内部滚动区后可自然返回块头部。
- 颜色作为辅助信息。错误、成功、运行和等待状态同时具备图标或文字标识。
- 动画遵守 `prefers-reduced-motion`。折叠动画只改变内容可见性和高度，不造成主内容横向位移。

#### 4.6.11 体验验收

Workbench Chat 达到以下目标状态：

1. 用户在不阅读内容的情况下，可以分辨最终回复、思考、Shell、文件编辑、子代理和错误。
2. 同一视觉层级使用稳定字号。正文与块标题为 14px，元数据与过程详情为 13px，代码与 Shell 输出为 13px mono。
3. Agent 最终回复保持连续文档感。过程块形成清晰节奏，并避免每个段落都成为独立重卡片。
4. 亮色、暗色和自定义主题均由 Workbench token 驱动，不出现 Kilo/VS Code 专用颜色或独立皮肤。
5. 单 Panel、双 Panel 和三 Panel 下，标题、路径、工具输出和 Composer 保持可读且不横向溢出。
6. 长回复、连续 Shell 输出、多文件 patch 和子代理运行期间，虚拟列表滚动稳定，用户选择与焦点不被流式更新清除。
7. 历史会话默认呈现简洁摘要。用户可按需展开并追溯每项 Agent 活动；PromptNavigator 打开后通过现有分页能力覆盖完整历史。
8. 长对话左侧显示消息刻度轨。用户可以从刻度或浮层目录跳转到任意历史提示词，并清楚看到用户提示词与 Agent 回复摘要。
9. 提示词导航使用 Ellamaka 的字体、配色、圆角与阴影；底部 Composer 的布局、样式和交互保持不变。
10. Chat 只调用 Ellamaka 现有 Session、Message、Question 和 Permission SDK 能力。实现不以补充后端端点或 Kilo Code 专有事件为前提。
11. 转录投影测试覆盖 `parentID` 归属、partial turn、上下文压缩、历史前插、全部 SDK Part 类型、未知工具和未知 Part 的安全回退。
12. 实时测试覆盖 `message.updated`、`message.part.updated`、`message.part.delta`、`message.part.removed`、`session.diff`、Question/Permission 请求和子 Session 活动，确保顺序稳定、内容不重复且完成态不丢失。

---

## 5. 状态管理与持久化设计

Workbench 状态管理的核心目标：

1. **全局刷新不丢失面板布局与绑定状态**，并在宽限期内重新连接仍然存活的 PTY。
2. **切换 Space Tab 不销毁 Panel 子树**——所有已打开 Tab 的 Panel、Chat 草稿、终端进程保持挂载，只是切换可见性。
3. **切换视图模式不释放 PTY**——TUI PTY、Split Terminal PTY 在视图切换时保持运行。
4. **高频对话生成期间左侧导航树保持绝对稳定**。

### 5.1 状态模型分层设计

Workbench 不再把布局、服务端会话和运行时资源塞进一个控制器。每类状态只有一个规范所有者：

- **WorkbenchStore** (`workbench-store.ts`)：唯一持久化布局所有者，保存 Display、Space Tab、Panel 布局、活动 Panel、`boundSessionId`、Split Terminal 设置和 PTY 重连提示；只做同步纯状态变更。
- **View Store adapter** (`view-store.tsx`)：负责水合、`localStorage` 写入和短暂 UI 消息；不是第二个领域 Store，不能拥有 SDK、PTY、router、Dialog 或 Toast 副作用。
- **Workbench Runtime** (`workbench-runtime.tsx`)：在首次连接完成后组合 HTTP health 与 SSE 连接状态，表达 `online | degraded | recovering | offline`。`degraded` 表示 HTTP 仍可用但事件流正在重连，保留可写能力并显示状态；断线不清空已加载数据；从非 online 回到 online 时递增恢复代次，Space Store 与 Session Tree 各刷新一次。
- **WorkbenchActions** (`workbench-actions.ts` / `workbench-actions-ports.ts`)：唯一跨所有者事务入口。创建、装载、替换、fork、解绑、关闭 Panel/Space、PTY 创建、PTY 断连恢复都先由 Action 分配 generation，再执行资源副作用，最后一次性提交布局或 Projection。`createWorkbenchActions` 是纯逻辑函数；`WorkbenchActionsProvider` 为每个 Workbench provider tree 创建独立实例，禁止模块级缓存跨 server、重挂载或多实例复用。runtime gate 是写操作的唯一保护边界，离线时返回 typed `offline` 结果。port 构造逻辑（`buildStorePort`/`buildPtyPort`/`buildSessionPort`）提取到 `workbench-actions-ports.ts`，store port 由 `view-store.tsx` 暴露的 `wb` 直接实现。
- **Session Projection** (`session-store.tsx`)：只在内存中保存服务端会话的只读投影。Action 的服务端响应和 Shell/SessionTree 的 SSE 对账是唯一 writer；组件、Dialog、命令和持久化层只能读取。
- **Directory SDK/sync**：插件、MCP、LSP 和配置按规范化 directory 缓存，不持久化。Panel 使用该 Panel 的 directory；TopBar 与 StatusPopover 通过活动 `SpaceScope` 和活动 Panel selector 获得同一 directory。
- **Space Store** (`space-store.tsx`)：读取可打开 Space 的目录列表，用于校验和展示；已打开 Tab 及其布局归 WorkbenchStore 所有。

`SpaceScope` 在领域边界明确表示 General 或 Space。General 空间的规范路径固定为空字符串 `""`，但在逻辑识别上必须使用 Tagged Union 类型 `scope.kind === "general"`，严禁依赖空字符串真假判断（如 `if (spacePath)` 或 `path || fallback`）来区分空间。General 的 Panel directory 可以是后端生成的 General task 目录或空字符串，但能力组成仍只来自全局配置。Space 的能力是全局能力与该 Space 定义能力的并集；验收必须核对完整来源路径，而非数量。

会话树（Session Tree）双击与会话装载交互必须经由 `WorkbenchActions` 暴露的单事务 API（如 `replaceSession` / `loadSessionIntoPanel`）统一处理。严禁在组件层或零散 Helper 中编写自定义异步流程直接修改 Store 或跨层调用 SDK，以保证目标面板决议、替换、冲突确认与投影更新的原子性与确定性。

PTY ID（`tuiPtyId`、`splitPtyId`、`termPtyId`）作为**重连提示**随 Workbench 布局持久化。Sidecar 的 PTY Session Registry 是进程存活状态的真相源。刷新后 PTY Manager 先探测旧 ID：存活则重连，已回收则清除旧 ID 并按需创建新 PTY。浏览器 Tab 关闭后没有新连接，sidecar 在断连宽限期结束时终止对应 PTY；下次打开时持久化的旧 ID 会在探测阶段自然失效。

### 5.2 水合门控与协同 (allStoresReady)

WorkbenchStore 完成水合后，`index.tsx` 以 `wb.ready()` 作为唯一的 **Workbench Bootstrap Gate**：

```tsx
const allStoresReady = () => wb.ready()
```

> [!IMPORTANT]
> **水合完成前（allStoresReady 为 false）禁止行为**：
> - 不渲染 `Workspace` 与侧栏/标题栏主体（渲染 Splash 占位）。
> - 不执行 `ensureSpace()`（避免写入默认布局覆盖持久化数据）。
> - 不创建 PTY，不连接终端。
> - 不处理任何可能引发布局或生命周期副作用的事件。
>
> **水合完成后**：
> - 一次性挂载并渲染恢复的布局。
> - PTY Manager 对持久化的 PTY ID 发起探测，存活的重连，已死的标记为待重建。视图挂载时通过 `ptyManager.ensure()` 按需创建或复用。

这消除了刷新后"先显示空 Panel 再跳变到恢复布局"的闪烁问题。

### 5.3 Space Keep-Alive 容器

`Workspace` 不再只渲染当前激活的 Space，而是为**每个已打开的 Tab** 建立稳定的 `SpaceWorkspace` 容器：

- 所有已打开的 Space Tab 保持挂载，Panel、PTY、Chat 草稿、滚动位置全部在内存中存活。
- 当前 Space 可见。非当前 Space 使用 `position: absolute; visibility: hidden; inert` 隐藏。
- **禁止使用 `display: none`** 隐藏终端容器（Ghostty 尺寸会归零，恢复时触发 reflow 和 fit）。
- 切换 Tab 只改变可见性，不销毁任何子组件或 PTY。
- 用户显式关闭 Tab 时才销毁该 Space 的全部 DOM、Chat 状态和 PTY。

每个 `SpaceWorkspace` 接收固定的 `spacePath` 作为身份，不读取动态的 `activeTab()` 作为自身 key。

### 5.4 PTY 运行时管理器

Renderer 中的 PTY 关联由 `pty-manager.tsx` 统一管理，后台进程生命周期由 sidecar 的 PTY Service 统一管理。Web 与 Desktop 使用同一套创建、探测、重连、显式删除和断连宽限语义。

**资源键**：`spacePath + panelId + resourceKind`（`resourceKind` 为 `"tui" | "term" | "split"`）

**Renderer 核心操作**：

| 操作 | 行为 |
|------|------|
| `ensure()` | 检查持久化的 PTY ID 是否存在。存在则**先探测**：向服务端验证该 PTY 是否存活。存活则复用（终端上下文完整保留）。已死则清除旧 ID、创建新 PTY、更新 PTY ID。不存在则直接创建。创建请求附带 generation token，异步返回时检查 generation 是否过期。同时记录 PTY 真实 cwd（`ptyDirectories` Map），用于后续 DELETE 的正确路由。 |
| `delete()` | 从 Renderer 内存缓存移除 PTY 关联。该操作只管理前端引用，不把普通 WebSocket 断连解释为进程销毁。 |
| `disposePty()` / `disposePanel()` / `disposeSpace()` | 用户显式关闭 PTY、Panel 或 Space 时立即请求 sidecar 终止对应进程，并清除 `ptyDirectories` 与持久化 PTY ID。 |

**探测机制**：PTY Manager 在 `ensure()` 或 Terminal 断连恢复时，若持久化状态中存在 PTY ID，先向服务端发起探测请求。结果分为三态：2xx → `alive` 并复用；明确 404 → `dead`，清除旧 ID 并按需创建；`Failed to fetch`、超时和其他非权威响应 → `unknown`，保留 PTY ID 与布局，等待传输重连或 sidecar generation 对账。禁止把 transport failure 当作 PTY 进程退出。

**PTY 真实目录追踪**：PTY 的 `x-opencode-directory` routing header 必须指向 PTY 在服务端的实际 cwd（如 `session.directory`），而非 workbench 的 spacePath（如 General space 的 `""`）。`ptyDirectories` Map 在 `ensure()` 时记录 `ptyId → cwd`，所有 DELETE 操作优先使用该映射的值。

**Sidecar 断连宽限机制**：

- 每个 PTY Session 维护当前 WebSocket subscribers 和一个可取消的回收任务。
- 新 PTY 创建后在第一个 subscriber 建立前处于 Grace，防止创建成功但页面来不及连接时产生孤儿进程。
- 最后一个 subscriber 断开时进入 10 秒 Grace，PTY 进程继续运行。
- 同一 PTY 在 Grace 内重新连接时取消回收任务并继续使用原进程。
- Grace 结束仍无 subscriber 时，sidecar 自动终止并删除该 PTY。
- 显式 DELETE 和 Instance finalizer 立即终止 PTY，不等待 Grace。
- 多个 subscribers 共享 PTY 时，单个连接断开不会启动回收。
- Workbench 对需要继续运行的隐藏 TUI 和收起的 Split Terminal 保持 subscriber 连接；普通视图切换不会误触发 Grace。

**生命周期规则**：

| 事件 | 行为 |
|------|------|
| 视图切换（TUI ↔ Chat ↔ Context） | **不释放 PTY**。已挂载的 TUI Terminal 与 WebSocket subscriber 保持存活，切回时复用同一终端。 |
| Split Terminal 收起 | **不释放 PTY**。只隐藏渲染区域并保持 WebSocket subscriber，终端上下文保留。再次展开复用同一连接。 |
| Panel 关闭 | `disposePanel()`：释放该面板所有 PTY，清除持久化 ID。 |
| Space Tab 关闭 | `disposeSpace()`：释放该 Space 全部 PTY，清除持久化 ID。 |
| 浏览器或 Electron Renderer 刷新 | `pagehide` 只 flush 布局和 PTY ID 提示。WebSocket 断开后进入 Grace，新 Renderer 探测并重连原 PTY，取消回收任务。 |
| 浏览器 Tab 或桌面窗口关闭 | WebSocket 断开后进入 Grace。没有新连接时，sidecar 在 10 秒后自动终止 PTY。 |
| Electron 应用退出 | Main Process 停止 sidecar，Instance finalizer 立即终止全部 PTY。 |
| Panel 绑定到新 Session | 释放旧 Session 的 TUI PTY，清除旧 ID，为新 Session 创建新 PTY。 |

**异步安全**：创建 PTY 的 Promise 必须携带 generation token。若 Promise resolve 时 Panel 已关闭或 Session 已变更，立即释放该 PTY，禁止将失效 ID 写入持久化状态。

### 5.5 TUI 进程关闭与自愈机制

WebSocket 连接关闭与 PTY 进程退出是两个独立事件。前端先确认 sidecar 中的 PTY 状态，再决定重连或回退：

- **瞬时断连**：刷新、Renderer 重载或短暂网络中断只关闭 WebSocket。前端保留 PTY ID，sidecar 进入 Grace，Terminal 在宽限期内重新连接原 PTY。
- **进程退出**：用户在 TUI 或 Shell 中输入 `exit` 后，sidecar 发布 `pty.exited` / `pty.deleted` 并从 Session Registry 删除 PTY。前端探测得到 404 后清除 PTY ID，并将 TUI 主视图回退到 `chat`。
- **连接关闭处理**：`<Terminal>` 的普通 `onClose` 不直接调用 `pty.remove`。它进入断连状态并触发探测或重连；只有确认 PTY 已退出时才清理持久化关联。
- **原子状态回退**：确认 PTY 已退出后，前端先清 PTY Manager 缓存，再通过 SolidJS `batch` 提交布局守卫与 PTY ID。TUI 必须先切 `viewMode=chat` 再清 `tuiPtyId`；Split Terminal 必须先设 `splitTerminal=false` 再清 `splitPtyId`，避免创建 effect 观察到中间状态并抢跑创建新 PTY。
- **组件 Keyed 实例化隔离**：终端 `<Show>` 使用 `keyed`。PTY ID 变化时卸载旧 Terminal 实例并创建新实例，防止 WebSocket 与终端对象跨 PTY 复用。

> **开发规则**：effect 守卫、action 顺序、DELETE 幂等性等实现约束见 `packages/ellamaka-app/AGENTS.md` §5.6。

### 5.6 Session 状态收敛

服务端 Session 是 Session 标题、归档状态、消息内容的**唯一事实来源**。

本地持久化只保存：Panel 绑定了哪个 Session ID（存储在 Panel 布局状态中）。Session Projection 只存在于内存中，刷新后必须从服务端和 SSE 重新构建。

不持久化：

- Session `status`（bound / idle / archived）——从 Panel 布局绑定和服务端归档字段派生。
- Session `boundPanelId`——从 Panel 布局反向查找。
- Session title、副本、目录、时间戳和状态——由服务端投影提供，UI 不做 optimistic 伪造。
- Session 列表——由 SessionTree 的服务端加载和 Shell SSE 对账写入内存 Projection。`GET /workbench/session-groups` 只返回 `time_archived IS NULL` 且 `parent_id IS NULL` 的未归档根会话；归档会话和子会话不得进入列表、`sessionCount` 或客户端 Projection。

**事件处理规则**：

| 事件 | 行为 |
|------|------|
| `session.created` | 使对应 Space 的 SessionTree 加载失效；服务器返回后写入 Projection。 |
| `session.deleted` | 通过 Action 解绑所有引用该 Session 的 Panel、释放对应 PTY，再删除 Projection。 |
| `session.updated`（含 `timeArchived`） | 将归档视为服务端权威状态变化：使 SessionTree 加载失效，通过 Action 解绑所有引用该 Session 的 Panel、释放对应 PTY、删除 Projection，并向用户显示状态变化提示。 |
| `session.updated`（标题变更） | Shell SSE 只 patch 对应 Projection 项；不伪造 Session 或触发无关树级重载。 |
| `message.part.*` | 仅更新对应 `PanelChat` 的消息流，不触发树或其它 Panel 的更新。 |

Panel 绑定只能由显式的用户关闭/替换操作、服务器 `session.deleted` 事件或带归档时间的 `session.updated` 事件解除。外部删除或归档已经装载的 Session 时，Workbench 必须释放对应 PTY 和 Panel 绑定，并向用户显示状态变化提示。远端数据加载完成前不得根据空列表解绑 Panel，避免初始空数组误判。Projection 的失效信号只用于通知树重新拉取，不能承载会话领域数据，也不能写入持久化。

### 5.7 持久化性能优化

拖拽过程中的尺寸变更（Panel 宽度、Split Terminal 高度、Sidebar 宽度）只在内存 draft 中更新，`pointerup` 时一次性提交到持久化 Store。

持久化写入采用：

- 150ms trailing debounce。
- latest-wins 语义（同一 key 的新值覆盖旧未写出的值）。
- 串行写队列。
- `visibilitychange` / `pagehide` 时同步 flush 未写出的数据。

禁止每次 `mousemove` 序列化整个 Workbench 状态。

### 5.8 持久化与 Tab Pin 策略

- `workbench`：统一的 Workbench 状态快照。使用 `localStorage` 持久化，确保关 Tab 重开时布局保持。包含显示设置、已打开与已 Pin 的 Space Tabs、当前激活 Space Path、每个 Space 的 Panel 布局、Session 绑定、Split Terminal 配置和 PTY ID 重连提示。
- **Tab Pin (钉住) 规约**：
  - `General (日常对话)` Tab 固定钉住，不允许被关闭（UI 屏蔽关闭按钮，Store 层拦截删除请求）。
  - 物理项目 Space Tabs 支持用户自主 Pin 钉住。已 Pin 的 Tab 不允许关闭，必须解除 Pin 钉住后方可关闭。
  - 在 Desktop 桌面端，**已钉住的 Tab 拦截并禁止使用 `Cmd + W` 快捷键关闭**。

### 5.9 Headbar 标题栏、单空间 Session Tree 与侧栏架构

- **Headbar 标题栏与 Web 兼容性**：
  - **macOS 红绿灯避让与双层 Layout 契约**：Workbench 顶栏 `<header>` 必须保持 `flex-col` 双层结构。第一层为 `workbench-macos-window-chrome`（28px 高度），在 macOS 桌面端为红绿灯提供专有拖拽避让高度；第二层为 `workbench-titlebar-toolbar`。Logo、Space Tabs 与右侧操作按钮必须全部收纳于第二层 toolbar 内，严禁绝对定位逃逸至第一层拖拽区。
  - 保持原有的品牌 Logo 样式，与空间 Tabs 在第二行 Headbar Toolbar 中平行布设。
  - Headbar 右侧增加 `空间列表` 下拉框与 `用户登录 Logo (头像预留)`，确保网页版 Web 界面与 Electron 桌面端具备完全一致的控件呈现与交互。
  - Tab 栏末尾的 `+` 按钮**严格锁定为添加 Panel (面板) 的功能**，不改变其既有逻辑。
- **侧栏 44px 固定竖向 Activity Bar 架构**：
  - 侧栏最左侧为 44px 固定的竖向图标列 (Vertical Activity Bar)，绝无横向菜单。
  - 垂直方向保留 `💬 会话 (Sessions)` 与 `🔧 空间维护 (Maintenance)` 图标，支持用户切换侧栏视图或展开/收起面板。
- **单空间会话隔离 (Current-Space Session Tree)**：
  - 会话树在视图层**永远只显示当前激活的空间相关会话**，跨空间会话不混排展现。
  - 保留所有既有的图标（圆点 / Git 分支 / 文件夹）、状态颜色（muted 灰 / accent 绿）、`dirHealth` 提示、Pin 置顶、右键上下文菜单与拖拽体验。
- **内置独立会话的工作目录 ($WOPAL_HOME/general_tasks/)**：
  - 后端 Session 存在关联物理目录的强约束限制（`directory` 为 `notNull()`）。
  - 通用日常对话由 `POST /workbench/sessions` 的服务端 provisioner 创建 `$WOPAL_HOME/general_tasks/` 下隔离目录。

### 5.10 Statusbar 真实代码契约与异常诊断中心

Statusbar 实现集中于 `status-bar.tsx`、`status-bar-segments.ts` 与 `status-bar-diagnostics.tsx`，采用响应式三分区结构：

- **左区（元数据层级链）**：由 `getStatusBarSegments` 动态算出当前激活 Panel 的工作现场元数据层级链。
  - **格式**：`P{激活面板序号}/{面板总数} / 会话标题`
  - 各层级段用斜杠 `/` (`text-v2-text-text-faint`) 分隔。
  - 若未绑定 Session，仅展示 `P{激活面板序号}/{面板总数}`。
- **中区（居中异常诊断与提示中心 `StatusBarDiagnosticsCenter`）**：
  - **定位与安全防护**：采用绝对居中定位 (`absolute left-1/2 -translate-x-1/2`)。只读订阅全局消息队列 `wb.diagnostics`，防范冒泡导致面板 ErrorBoundary 卸载。
  - **缺省淡出提示**：无消息时，前 5 秒呈现默认引导文本（“提示：双击会话或拖拽会话到面板中即可在工作台打开”），5 秒后自动淡出清空。
  - **消息等级与图标分类**：支持 `error` (图标 `circle-x`, 颜色 `text-icon-critical-base`)、`warning` (图标 `warning`, 颜色 `text-icon-warning-base`) 与 `info` (图标 `bubble-5`) 三级。触发按钮仅渲染最新一条消息 `latest().text`，超出 1 条时显示气泡统计徽章（如 `+2`）。
  - **交互式诊断 Popover**：点击居中按钮展开顶部 Popover（宽 400px，最大高 320px，倒序 `[...list()].reverse()` 渲染）。
  - **可恢复与清除机制**：每个条目呈现图标、文本、时间戳 (`formatTime`) 及 `source` 来源；若携带 `onRetry` 句柄，提供异步重试操作（重试成功后自动剔除该条目）；右侧支持单条目关闭与底部一键 `clearAllDiagnostics()`。
- **右区（服务器状态与控制）**：带有左边框分割 (`border-l border-v2-border-border-base pl-2`)，结合 `StatusBarStatusPopover` 呈现在线指示器（小绿点）与服务器名称 `server.name`。

### 5.11 浏览器生命周期与单 Tab 互斥

**单 Tab 互斥（Web Locks API）**：

- `WorkbenchSingletonGuard` 组件在 Workbench 初始化时通过 `navigator.locks.request(..., { ifAvailable: true })` 获取独占锁。
- 第二个 Tab 尝试打开同一 workbench 时，锁被占用，显示"工作台已在其他标签页打开"提示页，不初始化 workbench。
- Tab 关闭/刷新时浏览器自动释放锁，无需 `beforeunload` 参与（比心跳方案更可靠，不会因崩溃残留锁状态）。
- 浏览器不支持 `navigator.locks` 时降级为不限制（边缘场景，不影响功能）。

**页面生命周期**：

- Workbench 不使用 `beforeunload` 阻止刷新或关闭，也不推断浏览器离开的具体原因。
- `pagehide` 只调用 `wb.flushPersisted()`，把包含 PTY ID 重连提示的最新布局同步写入 `localStorage`。
- 页面销毁使 PTY WebSocket 自然断开。Sidecar 在最后一个 subscriber 断开后进入 10 秒 Grace。
- 刷新后的页面在 Grace 内探测并连接原 PTY，sidecar 取消回收任务。
- Tab 关闭后没有新连接，sidecar 在 Grace 结束时终止 PTY。
- Panel 和 Space 的显式关闭继续调用 `disposePty()` / `disposePanel()` / `disposeSpace()`，立即释放进程。

**刷新时序**：

1. `pagehide` 同步 flush Workbench 布局和 PTY ID 提示。
2. WebSocket 断开，sidecar 启动 PTY Grace。
3. 新页面水合布局并通过 `ptyManager.ensure()` 探测旧 ID。
4. 探测成功后重新连接，sidecar 取消 Grace 回收任务。

浏览器关闭、Renderer 崩溃和 Electron 窗口关闭使用相同的断连回收语义。桌面应用退出时由 Electron Main Process 停止 sidecar，立即释放全部 PTY。详见 `DESKTOP.md`。

---

## 6. 关键交互流程

### 6.1 开启新会话（以 Empty 槽位为例）

1. 点击 "Add Panel" 新增面板，槽位为 `empty` 状态。
2. 显示 `PanelLoader`，用户选定 Project Path 及类型（默认为 Chat）。
3. 点击 "开始会话"，触发 SDK 创建 session 得到 ID。
4. 通过 `viewStore.bindSession(spacePath, panel.id, sessionId)` 将绑定写入持久化布局。
5. 槽位状态切为 `bound`，渲染对应的 `PanelChat` 并开始交互。PTY 运行时管理器按需创建资源。

### 6.2 拖拽会话恢复

1. 左侧树的 idle 状态会话节点支持 Drag。
2. 拖入任意 `empty` 状态的 Panel 释放。
3. 通过 `viewStore.bindSession(spacePath, panel.id, sessionId)` 修改持久化槽位状态，恢复会话。目标 Panel 若已有 PTY 则先释放旧资源。

### 6.3 切换视图模式

1. 在 `bound` 槽位的面板中，点击头部 `TUI | Chat | Context` 主视图按钮，或点击 `TUI` 左侧的终端图标展开/收起下方 Split Terminal。
2. 主视图按钮仅切换 `panel.view`。终端图标仅切换 `panel.splitTerminal`，不会抢占当前主视图。
3. **切换视图不释放任何 PTY**：
   - 从 TUI 切到 Chat：已挂载的 TUI Terminal 保持隐藏和连接状态，前端同时挂载 `PanelChat` 导入聊天数据。
   - 切回 TUI：恢复同一 Terminal 的可见性，终端上下文保持不变。
   - Split Terminal 收起时只隐藏渲染区域并保留 WebSocket subscriber；再次展开时复用同一连接。

### 6.4 切换 Space Tab

1. 用户点击顶部 Space Tab 切换激活 Space。
2. 当前 Space 变为 `visibility: hidden; inert`，新激活 Space 变为可见。
3. **不销毁任何 Panel、PTY、Chat 状态**。切回原 Tab 即恢复全部上下文。
4. 若当前 Space 有正在运行的会话，切换不会中断它们。

### 6.5 关闭面板与会话解绑

1. 面板头部右侧提供直观的 "关闭" 按钮，取代复杂的菜单。
2. 当槽位处于 `bound`（绑定会话）时，展示关闭按钮。
3. 点击关闭按钮时：
   - 若为 `bound`：弹出二次确认框。确认后解绑 Session（在左侧树中保留可重新恢复），调用 `ptyManager.disposePanel(spacePath, panelId, sdk)` 释放该面板全部 PTY 并清除持久化 PTY ID，从布局中移除该 Panel。
   - 若移除的是空间内最后一个 Panel：保留该 Panel 并将其重置为 `empty` 状态，确保工作区不为 0。

### 6.6 关闭 Space Tab

1. 用户点击 Tab 上的关闭按钮。
2. 弹出确认框，列出资源释放清单：面板数量、绑定会话数量、终端实例。
3. 确认后：`ptyManager.disposeSpace(spacePath)` 释放该 Space 全部 PTY，解绑所有 Session，销毁 `SpaceWorkspace` DOM 及子组件，从持久化状态中移除该 Space 布局，关闭 Tab。

### 6.7 跨空间智能 Tab/Panel 分发与定位

- **重复绑定拦截**：在双击或单击会话的第一时间，优先检索该会话是否已在工作台的任何面板（包括当前或其它空间）中打开。若已打开，工作台拒绝发起重复绑定，而是自动执行跨空间 Tab 切换聚焦，并精准闪烁高亮对应的面板。
- **自适应 Tab 开辟**：双击 A 空间下的会话时，工作台自动寻找 A 空间的 Tab。若 A 空间 Tab 尚未在顶部打开，工作台自动在顶栏"开辟"（创建并激活）该 Tab 页，保证会话与空间的强隔离。
- **弹性扩容与兜底覆盖**：
  - 切换到正确的 Tab 后，优先在空间面板里分发至 `empty` 槽位。
  - 若全在忙，且当前面板数量未达最大值 3，自动横向"扩容"新增一个面板分栏并绑定。
  - 若 3 个面板已满载且都在忙，则询问用户覆盖：
    - 若有聚焦选中的面板，询问是否覆盖该聚焦面板。
    - 若无任何聚焦面板，询问是否覆盖第一个面板（Panel 1）。确认后方可安全覆盖装载。

---

## 7. 异常处理与健壮自愈机制

为了保证 Workbench 在各种运行状况（网络抖动、CLI 版本变化、环境配置损坏）下均能稳定可靠运行，系统遵循本章的异常防御与诊断设计。

### 7.1 异常分类与应对原则

| 严重性等级 | 典型场景 | 前端渲染表现 | 自愈/应对机制 |
| :--- | :--- | :--- | :--- |
| **运行时完整性错误 (Fatal)** | 数据库损坏或无法恢复的应用根异常 | 全局 `ErrorPage`（独占式阻断） | 停止会破坏运行时事实的操作，并提供恢复与日志入口。 |
| **空间控制不可用 (Degraded)** | `wopal-cli` 缺失、损坏或版本不兼容 | 状态栏诊断中心 | General Session、Chat、TUI 与 PTY 保持可用；Space Control 暂停，用户确认修复后自动恢复。 |
| **瞬态连接丢失 (Connection)** | WebSocket 断连 / 服务端 API 失去响应（抖动） | 模态遮罩层 (Modal Overlay) | 在视口覆盖半透明遮罩，阻断全部用户输入保护状态；启动指数退避自动重连，连接恢复后自动闭合。 |
| **局部非阻塞错误 (Warning)** | 空面板选择受控目录时 `locations` 接口拉取失败 | 状态栏局部错误区 + 局部重试 | **严禁抛出至面板 ErrorBoundary**！保持面板可操作，在底部状态栏指示错误并提供"重试/清除"入口。 |

### 7.2 网络断连与模态保护

为防止用户在离线状态下发生错误输入导致本地状态与数据不一致：

1. **自动挂载**：一旦系统检测到与后端的物理连接中断，即刻在 Workbench Shell 最上层挂载半透明的**连接保护遮罩**，显示"连接已断开，正在尝试重连…"。
2. **输入隔离**：遮罩层拦截所有的鼠标、键盘和拖放操作，并将工作台表面设为 `inert`。
3. **静默水合**：后台自动重连。连接成功后，自动关闭遮罩并恢复之前的操作现场，无需用户刷新页面。

### 7.3 CLI 健康握手与可恢复修复

系统确立 CLI 的健康与版本握手机制：

1. **启动与健康握手**：`GET /global/health` 同时返回服务端版本与 Wopal CLI 状态。CLI 状态包含 `ok`、`missing`、`incompatible` 和 `broken`，并携带最低兼容版本与已检测版本。
2. **运行时保持**：CLI 状态不改变服务端健康语义。CLI 不可用时，Session Runtime 继续服务 General Session、Chat、TUI 与 PTY。Session Projection 将无法归属 Space 的会话作为 General 返回。
3. **受控降级**：Space 列表刷新、受控 Space location 和其他 CLI 控制能力在 CLI 不可用期间暂停。状态栏诊断中心保留修复入口，并说明最低兼容版本。
4. **用户确认的修复**：用户点击修复后，`POST /global/cli/repair` 对不兼容 CLI 执行 `wopal update`，并在需要时调用第一方 installer。服务端重新探测 CLI；Workbench 在探测成功后自动恢复 Space Control，不重启 sidecar 或当前 Workbench。

### 7.4 状态栏居中诊断与信息中心

为了简化 UI 结构并提供随时可见的系统诊断与信息，我们将侧边栏底部的提示信息区移除，并在常驻状态栏的**正居中位置**建立统一的"信息与异常诊断中心"：

1. **防爆隔离**：对 SolidJS 的 `createResource` 异步接口使用 `createMemo` 包裹安全读取，当 error 发生时返回空值，严禁冒泡导致面板 ErrorBoundary 崩溃卸载。
2. **全局消息队列 Store**：在全局 Store 中维护一个全局消息队列（`messages: LogMessage[]`），支持三种消息类型：
   - **信息 (Info)**：如"刷新成功"、"会话已归档"等瞬态系统提示。支持配置自动淡出定时器（如 5 秒后自动清除）。
   - **警告 (Warning)**：如"工作目录不存在"等非阻塞限制提示。
   - **错误 (Error)**：如"目录列表加载失败"等组件级异步接口报错。
3. **居中信息提示区 UI**：
   - 在状态栏正中央（使用绝对定位居中，保证不受左右侧边栏折叠与路径长度影响）常驻显示**最新的一条消息**。
   - 伴随对应类型的图标（信息、警告、错误），文字精简。若消息数 $> 1$，在右侧附加徽标件数显示（如 `+2`）。
4. **交互式气泡列表 (Interactive Popover)**：
   - 用户点击状态栏居中消息区时，在状态栏上方弹出一个**气泡弹出框 (Popover)**。
   - 气泡框中以垂直列表形式展示所有当前的活动消息。
   - 每个错误和警告条目右侧提供 **"重试"**（若支持，如 API 重新请求）和 **"清除"**（Dismiss）操作链接。
   - **自愈消除**：重试操作必须明确返回成功结果后才删除条目。后台恢复同样自动清除对应诊断。
