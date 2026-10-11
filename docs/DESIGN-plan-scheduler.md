# Ellamaka — Plan Scheduler

> **Status**: Proposed
> **Updated**: 2026-10-10
> **Parent**: `./DESIGN.md`
> **Parent Architecture**: `../../../docs/products/wopal-space/DESIGN-plan-orchestration.md`
> **Parent Product**: `../../../docs/products/wopal-space/PRD.md`
> **Scope**: Workbench 空间级计划工作区、审批、依赖、排期、运行与人工接管

## Dependency Scope

本文属于阶段 4 的可选调度领域。其 CLI/Provider/Runner 版本协商只约束显式启用的调度功能，不构成 Ellamaka 基础 HTTP、初始化、空间服务、更新或发布的 Wopal CLI 最低版本前提；本轮 SDK/DSH Plan 不实施该领域。

## Scope and Ownership

本文定义待评审的目标设计，不表示所述页面或 API 已实现。Workbench 壳遵循 [Workbench 设计](./DESIGN-workbench.md)，调度端点以 [本设计的 API 草案](#api-proposal) 为唯一真相源。产品交互边界遵循 [Scheduler UI](../../../docs/products/wopal-space/DESIGN-plan-scheduler-ui.md)。

用户在同一个 Workbench、同一个 Space 内管理会话和计划。计划工作区拥有领域交互；壳拥有空间切换、布局、焦点和诊断。CLI 计算依赖、时间与运行资格，Provider 管审批，Runtime 管真实执行和 Session。

## Workbench Integration

### Space-Level Workspace

每个 Space 有两个主工作区：`sessions`（会话）和 `plans`（计划）。Activity Bar 的「计划」按钮打开当前 Space 的计划工作区，切回「会话」恢复原面板、视图、尺寸与焦点。Files 是辅助导航，不擅自切换主工作区。顶部 Space Tabs 与底部状态栏保持原位。

计划不是 TUI/Chat 的第三种面板视图，也不绑定 Session。没有会话的 Space 同样能管理计划；General 显示“计划属于空间，请先选择空间”。计划视图使用完整中央区域，DAG 不挤在窄 Inspector 中。

会话区域首次访问才挂载，访问后切到计划时采用 Workbench 隐藏空间的保活方式：离开排版流、不可见、inert，恢复时重新测量终端。切换不执行 PTY dispose、Session unbind 或面板替换。计划区域不抢占 1–3 个会话面板配额。

文件 Inspector 属于会话工作区；计划详情使用计划内部详情栏。两个区域各自保留打开状态与宽度，切换时不同时挤占中央空间。计划操作故障进入现有诊断中心，禁止抛出异常覆盖整个 Workbench。

### Navigation and Persistence

计划侧栏提供「全部计划」「待审批」「已排期」「运行记录」和项目筛选。中央区的「列表 / 依赖图」切换只改变同一批计划的表达。顶部显示当前 Space 名称，不在调度功能内再引入空间选择器。

每个 Space 持久化 `workspaceKind`、筛选、选中资源和详情栏宽度；DAG 缩放与位置按 graph ID 保存。领域快照、审批结果、运行状态、日志与未提交表单不写入布局存储。刷新后重新查询资源，资源消失则回到列表并解释原因。

可分享定位格式为 `/workbench?space=<spaceId>&workspace=plans&plan=<planKey>&run=<runId>`，图定位使用 `graph=<graphId>`。URL 参数均为 ID，经授权解析；不承载路径或执行指令。run 优先于 plan，图与 run 互斥；无效组合显示定位错误，不执行任何变更。

切换 Space 时，响应写回请求所属 Space 的缓存，只有匹配当前 generation 的响应能更新可见选择。草稿按 Space 隔离保留在内存；浏览器关闭或刷新前提示丢失风险。

## Interface Structure

### Plan List and Detail

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Ellamaka  [空间 A ×] [空间 B] [+]                      原 Workbench 顶栏 │
├────┬──────────────┬──────────────────────────────────────────────────────┤
│会话│ 计划 · 空间 A│ 计划                              [列表 | 依赖图]    │
│文件│ 全部计划  12 │ [搜索目标/名称] [项目 ▾] [状态 ▾]   [在会话中规划]   │
│计划│ 待审批     3 │ 服务：运行中 · 心跳 5 秒前         [管理服务]        │
│    │ 已排期     4 ├────────────────────────────┬─────────────────────────┤
│    │ 运行记录     │ 名称 / 项目                │ CLI 调度器               │
│    │              │ 工作流 · 调度 · 最近运行   │ [概览][依赖][排期][运行] │
│    │ 项目         │                            │ 目标、范围、验收         │
│    │ □ cli        │ CLI 调度器                 │ 当前修订 / 批准修订      │
│    │ □ ellamaka   │ 已批准 · 等待时间 · 未运行 │ 工作流：已批准           │
│    │              │                            │ 调度：明日 09:00         │
│    │              │ Workbench                  │ 最近运行：无             │
│    │              │ 已批准 · 等待依赖 · 未运行 │ [批准] [排期] [更多 ▾]   │
├────┴──────────────┴────────────────────────────┴─────────────────────────┤
│ 原 Workbench 状态栏        调度：1 运行 / 2 等待依赖       [诊断]       │
└──────────────────────────────────────────────────────────────────────────┘
```

单击行打开详情，双击不触发执行。列表每行分开显示 workflow、schedule eligibility、最近 run；无调度显示“未排期”，无运行显示“未运行”。多选仅用于加入依赖图，本期批准逐 Plan 确认，避免误批多个目标。

详情「概览」展示规范化目标、范围、验收、依赖、权限与执行策略，支持查看后端提供的原文。按钮由后端 `allowedActions` 驱动；不可用时给出具体理由。正文是只读评审，修改计划通过“在会话中讨论”，不在界面中直接改 Markdown 状态。

### Dependency Graph

```text
┌─ 依赖图：产品交付 ── [选择图 ▾] [添加计划] [校验] [保存更改] ───────────┐
│ 草稿：新增 1 条依赖                      [变更明细] [放弃更改]         │
├─────────────────────────────────────────┬───────────────────────────────┤
│ [O 规范] ──→ [C CLI] ──→ [E Workbench]  │ 所选依赖：C → E               │
│ 已交付        实施中       等待依赖      │ 原因：需要调度 API             │
│                 └──────→ [其他消费者]  │ 交付要求：已验收且已集成       │
│                                         │ 当前缺少：集成 commit          │
│ [缩小] [100%] [放大] [适应画布]         │ [打开 C] [查看证据] [移除依赖] │
├─────────────────────────────────────────┴───────────────────────────────┤
│ [图形 | 节点与依赖列表]   4 节点 · 3 条边 · 校验通过                    │
└─────────────────────────────────────────────────────────────────────────┘
```

从已选 Plan 构建草稿，后端解析声明依赖，显示缺失节点与理由。添加边采用“生产者 → 消费者”表单，可拖连但不是唯一操作方式。边必须包含理由、交付要求及 gate；环和跨空间引用定位到具体节点并阻止保存。

保存前展示节点、边和 gate 的 diff 及受影响时程。保存图不会批准 Plan 或启用时程。变更影响语义审批时，后端返回需要重新评审的节点；UI 明确标注，禁止用新图静默续跑。建议关系是待确认草稿，确定性保存不调用模型。

图有 revision，冲突保留本地草稿并展示远端 diff。“载入最新”后用户重新核对，禁止盲目覆盖。大图按项目和阻塞筛选，仍显示被隐藏的前置数量；键盘可通过节点/边表完成全部操作。

### Approval and Schedule

```text
┌─ 批准计划 ─────────────────────────────┐
│ CLI 调度器 · 修订 abc123                │
│ [目标与验收] [依赖] [权限范围]          │
│ 执行策略：● 新 worktree                 │
│           ○ 无 worktree ○ 复用已登记环境│
│ 批准仅授权；不会创建环境或启动 Agent。  │
│ [取消]                   [确认批准]    │
└────────────────────────────────────────┘

┌─ 设置排期 ─────────────────────────────┐
│ CLI 调度器 · 图：产品交付               │
│ 重复规则：[每天 ▾] [09:00]              │
│ 高级 cron：[0 9 * * *]                  │
│ 时区：[Asia/Shanghai ▾]                 │
│ 单次运行上限：[60] 分钟                 │
│ 下次触发：09-18 09:00 UTC+08:00         │
│ 随后两次：09-19 09:00 / 09-20 09:00     │
│ 依赖：等待 O 人工交付 [查看]            │
│ 服务：尚未安装；启用时按需安装          │
│ 停机不补跑，依赖满足后等待下次触发。    │
│ [取消] [预览]               [启用排期] │
└────────────────────────────────────────┘
```

简易规则与 cron 是同一值的两种输入；无法表达的 cron 切换为高级模式。时区显式选择 IANA 值，服务端返回 UTC instant、当地时间及 offset；预览是触发机会，不承诺一定执行。所有配置修改使前次预览失效。

批准对话框绑定正在审阅的 semantic revision。执行策略的复用选项仅从服务端批准可用的环境标识选择。普通批准完成后关闭弹窗并显示“已批准，尚未排期”。“批准并排期”是可选连续流程，显示两个独立步骤；后一步失败仍保留批准结果。

未批准计划可填写排期草稿；启用按钮说明需先批准。单 Plan 可以创建单节点图。每个 Plan 至多一条启用时程，重复创建返回现有时程。服务 readiness 错误阻止启用；依赖尚未交付可启用并显示等待。

### Run Detail and Takeover

```text
┌─ 运行记录 / CLI 调度器 / 09-18 09:00 ─────────── [取消本次运行] ─────────┐
│ 本轮：运行中   Plan：实施中   时程：已启用，下次明日 09:00               │
├───────────────────────────────────────────┬─────────────────────────────┤
│ [时间线] [日志] [自动验证] [产物]          │ 运行身份与批准修订          │
│ 09:00:00 获得执行资格                     │ 执行环境与基线              │
│ 09:00:02 准备环境                         │ 图修订 / 时程修订           │
│ 09:00:05 开始 Agent                       │ [查看执行会话]              │
│ 09:02:14 测试通过 18/18                   │ [复制脱敏诊断]              │
│ …                                        │                             │
├───────────────────────────────────────────┴─────────────────────────────┤
│ 本轮成功只代表自动实施结束，Plan 尚待人工交付。 [进入人工接管]          │
└─────────────────────────────────────────────────────────────────────────┘
```

日志支持按游标向前加载、跟随末尾、暂停跟随及截断标识；仅展示后端脱敏内容。运行详情先显示可用元数据，日志读取失败不改 run 结果。服务端未创建 Session 时，“查看执行会话”禁用并解释。

查看执行会话复用 Workbench 的 Session reveal 操作：已打开则激活，有空位则装载，面板满则请求选择替换位置。用户取消替换时保持计划页面；禁止静默覆盖面板。切到会话后保留“返回该次运行”入口。

人工接管首先暂停该 Plan 的未来时程；有活动 run 时用户选择等待结束或取消并等待进程树收尾。后端确认无活动写进程后，才允许进入可写交互会话。超时/失联时保持“等待安全接管”，不能仅凭浏览器取消成功开放写入。

接管页展示改动、自动验证和已知阻塞，再进入会话做人工审查、提交、集成与验收。UI 不提供绕过 dev-flow 的“标为完成”。交付后从 Provider 刷新可消费证据；恢复调度需要再次显式确认，不能因退出会话自动恢复。

## Action and State Contract

| 操作          | 前提与确认内容                     | 成功后                          | 失败/中断                      |
| ------------- | ---------------------------------- | ------------------------------- | ------------------------------ |
| 批准          | reviewing、修订一致、展示范围/策略 | approved；不建树、不启动        | 保留评审内容，冲突重新评审     |
| 撤回批准      | 显示影响的排期与活动 run           | 阻止未来执行；活动 run 安全取消 | 展示 operation，直到真实收尾   |
| 现在实施      | 批准有效、图/依赖/资源可用         | 准备环境后启动一次 run          | 不补跑、不绕依赖、不启用 cron  |
| 启用/修改排期 | 新鲜预览、审批与图有效             | 显示未来 slot 与等待原因        | 保留输入，展示服务/冲突错误    |
| 暂停/删除排期 | 明示“仅停止未来触发”               | 保留运行历史与活动 run          | 活动 run 单独提供取消          |
| 恢复排期      | 重新检查审批、图、服务             | 从未来 slot 恢复                | 展示拒绝原因                   |
| 取消 run      | 指定运行 ID                        | cancelling → cancelled 或已终结 | 长操作继续追踪，不能提前报终态 |
| 停止服务      | 展示所管空间及活动运行总数         | 停止领取并收尾全部所管运行      | 保持 stopping，提供诊断        |

服务是 host 级资源，不是当前 Space 私有。服务卡展示“影响此主机所有受管空间”；全局操作要求 host-control 权限。没有该权限的用户只看到获授权空间的影响，不泄露其他空间名称，也不能停服务。

按钮 loading 仅覆盖当前动作，重复点击复用同一幂等键。批准、排期和运行终态等待服务端确认，采用悲观提交；筛选、折叠等纯 UI 动作可即时更新。

## Data and Module Boundaries

```text
Workbench Shell / Space Tabs / Statusbar
  ├─ Session workspace → 原面板 / PTY / Chat
  └─ Plans workspace → list / graph / detail / dialogs
                         ↓ scheduler actions
                    generated SDK
                         ↓ Root scheduler API
                 CLI adapter / Provider / Runner
```

WorkbenchStore 只增加空间级工作区选择与布局。调度领域使用独立 reader/writer 投影和 actions 模块，避免把业务操作堆入会话 actions。跨工作区导航通过现有 Workbench actions port；HTTP 写入、刷新与响应合并由调度 actions 统一处理。

投影按 server identity + space ID 分区，服务状态按 host 分区。列表分页，详情按需请求；订阅按 Space 复用，隐藏页面停止日志跟随但不终止后台任务。失联保留最后快照并展示时间，写操作禁用。

首屏读取快照与事件游标，再订阅增量；发现游标过期、序号断层或重连时重新读取快照。事件只使相关资源失效，详情通过版本检查刷新，过期响应不覆盖新 revision。事件不可用时活跃页 5 秒有界轮询，隐藏页暂停轮询，恢复可见立即刷新。

## Responsive and Accessibility

中央可用宽度 ≥1000px 时列表与详情并列；700–999px 时详情覆盖列表且有返回按钮；小于 700px 时侧栏折叠、详情单列、图默认节点列表。宽度判断以中央可用区域为准，适配侧栏拖动与 Desktop 窗口尺寸。

沿用 Workbench 字体、间距、语义色、按钮和主题 token。状态同时用文字与图标表达。对话框约束焦点，Escape 关闭非执行确认态，关闭后焦点回到触发按钮。图形的所有操作都有键盘可用的列表替代；屏幕阅读器只播报关键状态变更，不逐行朗读日志。

## Failure Recovery

| 场景                      | 界面响应                                                         |
| ------------------------- | ---------------------------------------------------------------- |
| 空 Space                  | 解释计划由规划流程产生；“在会话中规划”只打开会话，不自动创建文件 |
| 无批准                    | 显示评审入口，不能把状态按钮当审批凭据                           |
| 审批失效 / graph-stale    | 显示变化范围和受影响节点，要求复核                               |
| revision 冲突             | 保留输入，展示差异，用户重新预览确认                             |
| 网络超时                  | 查询原 operation / 幂等请求，禁止用新键盲目重试                  |
| needs-input               | 显示缺失输入/权限，进入安全接管；不弹后台无限问询                |
| 服务故障 / runtime 不兼容 | 显示版本、缺失能力和修复指引，历史仍可读                         |
| 运行身份不确定            | recovery-required，禁用再次启动与可写接管                        |

## Review Criteria

设计验收覆盖：空会话 Space 进入计划；会话与终端在切换前后保持；跨空间慢响应不串数据；批准不启动；排期不提前建树；依赖图与列表解释一致；冲突不丢输入；重连不重复动作；取消确认真实收尾；服务停机解释全局影响；人工接管不与后台并行写入。Desktop 与 Web 使用同一 SDK 和交互规则。

## API Proposal

本节是与 [计划工作区设计](./DESIGN-plan-scheduler.md) 一起评审的新增契约，不宣称以下端点已提供。所有端点属于 Root 控制面，只有查看执行 Session 时才使用 Instance API。CLI 领域 schema 由 adapter 校验并映射到 Effect schema；OpenAPI 与 SDK 从服务端定义生成。

### Resource Identity and Authorization

空间级前缀 `B = /workbench/spaces/{spaceId}/scheduler`。spaceId 是 Runtime 从授权注册表提供的稳定不透明标识；planKey 是单路径段的不透明 API 标识，响应同时提供 Provider 的 `project/plan-stem` planId。二者的对应由服务端解析，浏览器不编码任意路径作为身份。

每次请求校验登录、空间访问权限、资源归属和能力。外部未知资源和跨空间资源统一 404；已知资源上的操作权限不足返回 403。所有变更拒绝客户端 executionPath、shell、prompt、任意文件路径和自报审批者字段。复用环境使用服务端返回的 environmentId。

### Endpoint Table

下表路径相对 B；预览 POST 只读，无幂等键要求。所有领域写入使用下一节的 Mutation 结构。

| 方法与路径                          | operationId               | 请求要点                                              | 成功结果                                   |
| ----------------------------------- | ------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| GET /capabilities                   | scheduler.capabilities    | 无                                                    | 协议版本、功能、权限、缺失能力             |
| GET /snapshot                       | scheduler.snapshot        | 无                                                    | 各状态数量、eventCursor、资源集合 revision |
| GET /plans                          | scheduler.plans           | project、workflow、eligibility、search、cursor、limit | Page<PlanSummary>                          |
| GET /plans/{planKey}                | scheduler.plan            | 无                                                    | PlanDetail                                 |
| POST /plans/{planKey}/approvals     | scheduler.approve         | semanticRevision、executionPolicy                     | Operation                                  |
| POST /plans/{planKey}/revocations   | scheduler.revoke          | approvalId、reason                                    | Operation                                  |
| POST /plans/{planKey}/starts        | scheduler.start           | approvedRevision、graphId、graphRevision              | Operation，完成后关联 runId                |
| GET /graphs                         | scheduler.graphs          | cursor、limit                                         | Page<GraphSummary>                         |
| GET /graphs/{graphId}               | scheduler.graph           | 无                                                    | Graph                                      |
| POST /graph-previews                | scheduler.previewGraph    | planKeys、候选 nodes/edges                            | 草稿、diff、问题、受影响节点               |
| POST /graph-validations             | scheduler.validateGraph   | 完整候选图、sourceRevisions                           | Validation                                 |
| POST /graphs                        | scheduler.createGraph     | name、nodes、edges、sourceRevisions                   | Operation                                  |
| PATCH /graphs/{graphId}             | scheduler.updateGraph     | 完整候选图、sourceRevisions                           | Operation                                  |
| POST /schedule-previews             | scheduler.previewSchedule | planKey、graphId、cron、timezone、timeoutMs           | Preview                                    |
| GET /schedules                      | scheduler.schedules       | planKey、state、cursor、limit                         | Page<Schedule>                             |
| POST /schedules                     | scheduler.createSchedule  | planKey、graphId、配置、previewToken                  | Operation                                  |
| PATCH /schedules/{scheduleId}       | scheduler.updateSchedule  | 配置、previewToken                                    | Operation                                  |
| POST /schedules/{scheduleId}/pause  | scheduler.pauseSchedule   | reason                                                | Operation                                  |
| POST /schedules/{scheduleId}/resume | scheduler.resumeSchedule  | 无额外字段                                            | Operation                                  |
| DELETE /schedules/{scheduleId}      | scheduler.deleteSchedule  | Mutation                                              | Operation；保留 run 历史                   |
| GET /runs                           | scheduler.runs            | planKey、scheduleId、outcome、cursor、limit           | Page<Run>                                  |
| GET /runs/{runId}                   | scheduler.run             | 无                                                    | RunDetail                                  |
| GET /runs/{runId}/logs              | scheduler.logs            | cursor、limit                                         | LogPage                                    |
| POST /runs/{runId}/cancellations    | scheduler.cancelRun       | reason                                                | Operation                                  |
| POST /plans/{planKey}/takeovers     | scheduler.takeover        | activeRunPolicy: wait/cancel                          | Operation，安全收尾后返回接管上下文        |
| GET /operations/{operationId}       | scheduler.operation       | 无                                                    | Operation                                  |
| GET /requests/{idempotencyKey}      | scheduler.request         | 无                                                    | 与当前用户/Space 绑定的 Operation 或 404   |
| GET /events                         | scheduler.events          | cursor                                                | SSE 事件流                                 |

host 服务使用 `/workbench/scheduler/service`：GET 返回 Service；POST `/starts`、`/stops` 使用 Mutation 返回 Operation。其启动、停止和首次按需安装要求 host-control 权限。当前 Space 的排期界面通过 capabilities/readiness 获得服务可用性，无该权限时请求管理员准备服务。

### Common Schemas

时间均为 ISO 8601 UTC，时区为 IANA 名称。revision 是不透明字符串。分页 limit 默认 50、最大 100，返回 `{items,nextCursor,snapshotRevision}`；游标绑定筛选条件，失效后重新读第一页。

| 类型            | 必需字段与语义                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Mutation<T>     | `{expectedRevision: string                                                                                                                                   | null, data:T}`；创建资源 revision 为 null，更新为目标资源 revision；HTTP `Idempotency-Key` 必填 |
| Action          | `{name,enabled,reasonCode?,reason?}`，服务端计算；UI 不凭本地 workflow 推断权限                                                                              |
| Blocker         | `{code,message,planKey?,requiredRevision?,evidenceIds:[]}`                                                                                                   |
| PlanSummary     | `{planKey,planId,title,project,revision,semanticRevision,workflow,approval,scheduleSummary,lastRun,blockers,allowedActions}`                                 |
| PlanDetail      | PlanSummary 加 `{goal,scope,acceptance,dependencies,permissionSummary,executionPolicy,availableEnvironments,sourceText}`                                     |
| ExecutionPolicy | `{mode:new-worktree/direct/reuse,environmentId?}`；reuse 必填已登记 ID                                                                                       |
| Approval        | null 或 `{approvalId,approvedRevision,valid,invalidReason?,approvedAt}`                                                                                      |
| Graph           | `{graphId,name,revision,nodes:[{planKey,semanticRevision}],edges:[{id,producer,consumer,reason,gate}],sourceRevisions}`                                      |
| Gate            | `{kind:verified-integrated-deliverable/artifact,producerRevision,requiredArtifacts:[],consumerBaseline?}`；artifact gate 需明确审批                          |
| Validation      | `{valid,issues:[{code,message,nodeIds,edgeIds}],affectedPlanKeys,sourceRevisions}`                                                                           |
| Preview         | `{previewToken,expiresAt,inputHash,sourceRevisions,triggers:[{instant,localTime,offset}],readiness,blockers}`；至少未来三次                                  |
| Schedule        | `{scheduleId,planKey,graphId,revision,cron,timezone,timeoutMs,state,eligibility,nextTriggerAt,blockers,activeRunIds}`                                        |
| Run             | `{runId,executionId,planKey,scheduleId?,revision,state,outcome?,createdAt,startedAt?,finishedAt?,approvedRevision,graphRevision,scheduleRevision?,blockers}` |
| RunDetail       | Run 加 `{sessionRef?,environment?,timeline,validationSummary,artifacts,error?,logCursor}`；sessionRef 含服务端解析的 instance/session 身份                   |
| LogPage         | `{entries:[{cursor,time,stream,text}],nextCursor,hasMore,truncated,redacted}`；limit 默认 200 最大 1000，单页另限 256KiB                                     |
| Service         | `{revision,desiredState,actualState,heartbeatAt,version,targetVersion?,upgradeState,activeRunCount,readiness,allowedActions}`                                |

workflow、schedule.state、eligibility、run.state/outcome 采用产品编排契约的独立枚举。run.state 额外允许控制过程 `cancelling`，仅真实进程树结束才进入终态。nextTriggerAt 是 cron 机会，blockers 决定届时资格；UI 不将它称为保证开工时间。

Preview token 绑定用户、Space、输入 hash、审批/图/时程 revision 与有效期，提交时重新校验全部源状态。预览不占锁、不创建环境、不安装服务。图保存与审批存在并发时 CAS 失败，不能自动替换 sourceRevisions。

### Mutation and Operation Protocol

所有写操作成功接收返回 HTTP 202，`Location` 指向 operation URL。Operation 为 `{operationId,kind,state:pending/running/succeeded/failed,createdAt,updatedAt,resourceRefs,result?,error?}`。业务同步完成也返回同一结构，state 可直接为 succeeded。

幂等记录按认证主体、Space（或 host）、键隔离，绑定 HTTP 方法、目标和完整 payload hash。相同键同请求返回原 operation；相同键不同请求返回 409。持久记录必须先于副作用建立；进程重启后查询仍有效。完整结果保留至少 30 天，之后保留键及请求 hash 的拒绝重放标记；旧键返回 IDEMPOTENCY_EXPIRED，客户端重新读取资源后要求用户确认新操作。

expectedRevision 比较目标对象；data 内的 semanticRevision、graphRevision 和 preview token 比较依赖对象。部分成功必须通过 Operation.result 明示，例如撤回已生效而运行仍在收尾。operation succeeded 只表示该操作完成，不表示 Plan 验收完成。

接管 operation 先暂停未来领取，再等待/取消活动运行；后端以资源锁串行校验并转移写入所有权，返回 `{planKey,pausedScheduleId?,sessionRef,executionId,evidenceRefs}`。接管期间恢复排期返回 RESOURCE_BUSY。只读查看 Session 不获取写权限；交互写权限由服务器确认接管状态后开放。

### Errors and Events

错误沿用 Effect TaggedError 响应：`{_tag:"SchedulerError",code,message,requestId,retryable,currentRevision?,diff?,operationId?,details?}`。diff 只含当前用户有权读取的内容。

| HTTP      | code                                                           | 客户端行为                       |
| --------- | -------------------------------------------------------------- | -------------------------------- |
| 400       | INVALID_INPUT / GRAPH_CYCLE / INVALID_CRON                     | 标记字段或边，保留草稿           |
| 401 / 403 | UNAUTHENTICATED / SPACE_FORBIDDEN / HOST_CONTROL_REQUIRED      | 登录或提示权限，不重试写入       |
| 404       | RESOURCE_NOT_FOUND                                             | 关闭无效选择，保留返回列表入口   |
| 409       | REVISION_MISMATCH / GRAPH_STALE / APPROVAL_STALE               | 展示最新 revision/diff，重新审阅 |
| 409       | IDEMPOTENCY_CONFLICT / RESOURCE_BUSY / OPERATION_PENDING       | 定位原操作或忙碌资源             |
| 410       | CURSOR_EXPIRED / IDEMPOTENCY_EXPIRED                           | 重读快照；变更操作要求重新确认   |
| 422       | NEEDS_INPUT / DEPENDENCY_UNSATISFIED                           | 给出输入或依赖详情               |
| 503       | RUNTIME_INCOMPATIBLE / SERVICE_UNAVAILABLE / RECOVERY_REQUIRED | 保留只读页面，显示修复指引       |

SSE 每条包含 `{id,spaceId,type,resourceKind,resourceId,revision,time}`，类型为 resource.changed、operation.changed、resync-required；服务事件通过获授权 Space 的服务摘要失效通知分发，不暴露其他空间资源。每个 Space 流单调有序，允许重复投递；客户端按 id 去重。快照 eventCursor 与后续订阅必须覆盖读取期间变更；游标过期返回 410 并要求重读，服务端不得悄悄跳过事件。

授权撤销立即终止相应流，客户端清除无权访问的缓存。断线重连从最后确认游标恢复；operation 继续在服务端执行。无法订阅时按设计采用有界轮询，使用 revision 合并，禁止把 HTTP 超时当作业务失败并重新启动。
