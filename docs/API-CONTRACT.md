# Ellamaka API 与 SDK 契约

> **Status**: Active
> **Updated**: 2026-09-17
> **Parent Architecture**: [`../../../docs/products/wopal-space/DESIGN.md`](../../../docs/products/wopal-space/DESIGN.md)（架构与职责边界）

## 目的

Ellamaka 的 HTTP API 是 Workbench、官方客户端和外部集成使用运行时能力的唯一网络表面。每个端点同时是服务端契约、OpenAPI 描述和生成 SDK 的来源。

本契约延续 OpenCode 当前的 Effect HttpApi 架构：领域 schema 定义请求、响应和可预期错误；`HttpApiGroup` 定义端点；handler 调用领域服务；OpenAPI 由 API 树生成；JavaScript SDK 从 OpenAPI 自动生成。WopalSpace 定制沿用这条链路，而不是创建旁路 API 或手写客户端。

## Plan Scheduler API Proposal

本节是与 [计划工作区设计](./DESIGN-plan-scheduler.md) 一起评审的新增契约，不宣称以下端点已提供。所有端点属于 Root 控制面，只有查看执行 Session 时才使用 Instance API。CLI 领域 schema 由 adapter 校验并映射到 Effect schema；OpenAPI 与 SDK 从服务端定义生成。

### Resource Identity and Authorization

空间级前缀 `B = /workbench/spaces/{spaceId}/scheduler`。spaceId 是 Runtime 从授权注册表提供的稳定不透明标识；planKey 是单路径段的不透明 API 标识，响应同时提供 Provider 的 `project/plan-stem` planId。二者的对应由服务端解析，浏览器不编码任意路径作为身份。

每次请求校验登录、空间访问权限、资源归属和能力。外部未知资源和跨空间资源统一 404；已知资源上的操作权限不足返回 403。所有变更拒绝客户端 executionPath、shell、prompt、任意文件路径和自报审批者字段。复用环境使用服务端返回的 environmentId。

### Endpoint Table

下表路径相对 B；预览 POST 只读，无幂等键要求。所有领域写入使用下一节的 Mutation 结构。

| 方法与路径 | operationId | 请求要点 | 成功结果 |
|---|---|---|---|
| GET /capabilities | scheduler.capabilities | 无 | 协议版本、功能、权限、缺失能力 |
| GET /snapshot | scheduler.snapshot | 无 | 各状态数量、eventCursor、资源集合 revision |
| GET /plans | scheduler.plans | project、workflow、eligibility、search、cursor、limit | Page<PlanSummary> |
| GET /plans/{planKey} | scheduler.plan | 无 | PlanDetail |
| POST /plans/{planKey}/approvals | scheduler.approve | semanticRevision、executionPolicy | Operation |
| POST /plans/{planKey}/revocations | scheduler.revoke | approvalId、reason | Operation |
| POST /plans/{planKey}/starts | scheduler.start | approvedRevision、graphId、graphRevision | Operation，完成后关联 runId |
| GET /graphs | scheduler.graphs | cursor、limit | Page<GraphSummary> |
| GET /graphs/{graphId} | scheduler.graph | 无 | Graph |
| POST /graph-previews | scheduler.previewGraph | planKeys、候选 nodes/edges | 草稿、diff、问题、受影响节点 |
| POST /graph-validations | scheduler.validateGraph | 完整候选图、sourceRevisions | Validation |
| POST /graphs | scheduler.createGraph | name、nodes、edges、sourceRevisions | Operation |
| PATCH /graphs/{graphId} | scheduler.updateGraph | 完整候选图、sourceRevisions | Operation |
| POST /schedule-previews | scheduler.previewSchedule | planKey、graphId、cron、timezone、timeoutMs | Preview |
| GET /schedules | scheduler.schedules | planKey、state、cursor、limit | Page<Schedule> |
| POST /schedules | scheduler.createSchedule | planKey、graphId、配置、previewToken | Operation |
| PATCH /schedules/{scheduleId} | scheduler.updateSchedule | 配置、previewToken | Operation |
| POST /schedules/{scheduleId}/pause | scheduler.pauseSchedule | reason | Operation |
| POST /schedules/{scheduleId}/resume | scheduler.resumeSchedule | 无额外字段 | Operation |
| DELETE /schedules/{scheduleId} | scheduler.deleteSchedule | Mutation | Operation；保留 run 历史 |
| GET /runs | scheduler.runs | planKey、scheduleId、outcome、cursor、limit | Page<Run> |
| GET /runs/{runId} | scheduler.run | 无 | RunDetail |
| GET /runs/{runId}/logs | scheduler.logs | cursor、limit | LogPage |
| POST /runs/{runId}/cancellations | scheduler.cancelRun | reason | Operation |
| POST /plans/{planKey}/takeovers | scheduler.takeover | activeRunPolicy: wait/cancel | Operation，安全收尾后返回接管上下文 |
| GET /operations/{operationId} | scheduler.operation | 无 | Operation |
| GET /requests/{idempotencyKey} | scheduler.request | 无 | 与当前用户/Space 绑定的 Operation 或 404 |
| GET /events | scheduler.events | cursor | SSE 事件流 |

host 服务使用 `/workbench/scheduler/service`：GET 返回 Service；POST `/starts`、`/stops` 使用 Mutation 返回 Operation。其启动、停止和首次按需安装要求 host-control 权限。当前 Space 的排期界面通过 capabilities/readiness 获得服务可用性，无该权限时请求管理员准备服务。

### Common Schemas

时间均为 ISO 8601 UTC，时区为 IANA 名称。revision 是不透明字符串。分页 limit 默认 50、最大 100，返回 `{items,nextCursor,snapshotRevision}`；游标绑定筛选条件，失效后重新读第一页。

| 类型 | 必需字段与语义 |
|---|---|
| Mutation<T> | `{expectedRevision: string|null, data:T}`；创建资源 revision 为 null，更新为目标资源 revision；HTTP `Idempotency-Key` 必填 |
| Action | `{name,enabled,reasonCode?,reason?}`，服务端计算；UI 不凭本地 workflow 推断权限 |
| Blocker | `{code,message,planKey?,requiredRevision?,evidenceIds:[]}` |
| PlanSummary | `{planKey,planId,title,project,revision,semanticRevision,workflow,approval,scheduleSummary,lastRun,blockers,allowedActions}` |
| PlanDetail | PlanSummary 加 `{goal,scope,acceptance,dependencies,permissionSummary,executionPolicy,availableEnvironments,sourceText}` |
| ExecutionPolicy | `{mode:new-worktree/direct/reuse,environmentId?}`；reuse 必填已登记 ID |
| Approval | null 或 `{approvalId,approvedRevision,valid,invalidReason?,approvedAt}` |
| Graph | `{graphId,name,revision,nodes:[{planKey,semanticRevision}],edges:[{id,producer,consumer,reason,gate}],sourceRevisions}` |
| Gate | `{kind:verified-integrated-deliverable/artifact,producerRevision,requiredArtifacts:[],consumerBaseline?}`；artifact gate 需明确审批 |
| Validation | `{valid,issues:[{code,message,nodeIds,edgeIds}],affectedPlanKeys,sourceRevisions}` |
| Preview | `{previewToken,expiresAt,inputHash,sourceRevisions,triggers:[{instant,localTime,offset}],readiness,blockers}`；至少未来三次 |
| Schedule | `{scheduleId,planKey,graphId,revision,cron,timezone,timeoutMs,state,eligibility,nextTriggerAt,blockers,activeRunIds}` |
| Run | `{runId,executionId,planKey,scheduleId?,revision,state,outcome?,createdAt,startedAt?,finishedAt?,approvedRevision,graphRevision,scheduleRevision?,blockers}` |
| RunDetail | Run 加 `{sessionRef?,environment?,timeline,validationSummary,artifacts,error?,logCursor}`；sessionRef 含服务端解析的 instance/session 身份 |
| LogPage | `{entries:[{cursor,time,stream,text}],nextCursor,hasMore,truncated,redacted}`；limit 默认 200 最大 1000，单页另限 256KiB |
| Service | `{revision,desiredState,actualState,heartbeatAt,version,targetVersion?,upgradeState,activeRunCount,readiness,allowedActions}` |

workflow、schedule.state、eligibility、run.state/outcome 采用产品编排契约的独立枚举。run.state 额外允许控制过程 `cancelling`，仅真实进程树结束才进入终态。nextTriggerAt 是 cron 机会，blockers 决定届时资格；UI 不将它称为保证开工时间。

Preview token 绑定用户、Space、输入 hash、审批/图/时程 revision 与有效期，提交时重新校验全部源状态。预览不占锁、不创建环境、不安装服务。图保存与审批存在并发时 CAS 失败，不能自动替换 sourceRevisions。

### Mutation and Operation Protocol

所有写操作成功接收返回 HTTP 202，`Location` 指向 operation URL。Operation 为 `{operationId,kind,state:pending/running/succeeded/failed,createdAt,updatedAt,resourceRefs,result?,error?}`。业务同步完成也返回同一结构，state 可直接为 succeeded。

幂等记录按认证主体、Space（或 host）、键隔离，绑定 HTTP 方法、目标和完整 payload hash。相同键同请求返回原 operation；相同键不同请求返回 409。持久记录必须先于副作用建立；进程重启后查询仍有效。完整结果保留至少 30 天，之后保留键及请求 hash 的拒绝重放标记；旧键返回 IDEMPOTENCY_EXPIRED，客户端重新读取资源后要求用户确认新操作。

expectedRevision 比较目标对象；data 内的 semanticRevision、graphRevision 和 preview token 比较依赖对象。部分成功必须通过 Operation.result 明示，例如撤回已生效而运行仍在收尾。operation succeeded 只表示该操作完成，不表示 Plan 验收完成。

接管 operation 先暂停未来领取，再等待/取消活动运行；后端以资源锁串行校验并转移写入所有权，返回 `{planKey,pausedScheduleId?,sessionRef,executionId,evidenceRefs}`。接管期间恢复排期返回 RESOURCE_BUSY。只读查看 Session 不获取写权限；交互写权限由服务器确认接管状态后开放。

### Errors and Events

错误沿用 Effect TaggedError 响应：`{_tag:"SchedulerError",code,message,requestId,retryable,currentRevision?,diff?,operationId?,details?}`。diff 只含当前用户有权读取的内容。

| HTTP | code | 客户端行为 |
|---|---|---|
| 400 | INVALID_INPUT / GRAPH_CYCLE / INVALID_CRON | 标记字段或边，保留草稿 |
| 401 / 403 | UNAUTHENTICATED / SPACE_FORBIDDEN / HOST_CONTROL_REQUIRED | 登录或提示权限，不重试写入 |
| 404 | RESOURCE_NOT_FOUND | 关闭无效选择，保留返回列表入口 |
| 409 | REVISION_MISMATCH / GRAPH_STALE / APPROVAL_STALE | 展示最新 revision/diff，重新审阅 |
| 409 | IDEMPOTENCY_CONFLICT / RESOURCE_BUSY / OPERATION_PENDING | 定位原操作或忙碌资源 |
| 410 | CURSOR_EXPIRED / IDEMPOTENCY_EXPIRED | 重读快照；变更操作要求重新确认 |
| 422 | NEEDS_INPUT / DEPENDENCY_UNSATISFIED | 给出输入或依赖详情 |
| 503 | RUNTIME_INCOMPATIBLE / SERVICE_UNAVAILABLE / RECOVERY_REQUIRED | 保留只读页面，显示修复指引 |

SSE 每条包含 `{id,spaceId,type,resourceKind,resourceId,revision,time}`，类型为 resource.changed、operation.changed、resync-required；服务事件通过获授权 Space 的服务摘要失效通知分发，不暴露其他空间资源。每个 Space 流单调有序，允许重复投递；客户端按 id 去重。快照 eventCursor 与后续订阅必须覆盖读取期间变更；游标过期返回 410 并要求重读，服务端不得悄悄跳过事件。

授权撤销立即终止相应流，客户端清除无权访问的缓存。断线重连从最后确认游标恢复；operation 继续在服务端执行。无法订阅时按设计采用有界轮询，使用 revision 合并，禁止把 HTTP 超时当作业务失败并重新启动。

## API 分层

| 层 | API | 适用领域 | 上下文 |
|---|---|---|---|
| Global / control | `RootHttpApi` | 全局配置、控制面和不依赖工作目录的 WopalSpace 能力 | Authorization |
| Instance | `InstanceHttpApi` | Session、文件、项目、PTY、工具及工作目录相关能力 | Instance Context 与 Workspace Routing |
| Streaming | Event / PTY connect | SSE、WebSocket 与长连接传输 | 专用传输契约 |

端点按领域归入现有 group。一个新 group 代表清晰、独立的领域边界。WopalSpace 的全局注册表和 CLI 集成能力属于 Root API。Session 工作目录、消息和 PTY 属于 Instance API。

## 领域语义与路径

HTTP 路径表达领域资源与自然从属关系。集合使用复数名词，单个资源以稳定标识寻址，筛选和排序使用 query 参数。

| 语义 | HTTP 表达 |
|---|---|
| 集合读取 | `GET /resources` |
| 单项读取 | `GET /resources/{id}` |
| 创建领域资源 | `POST /resources` |
| 更新领域资源 | `PATCH /resources/{id}` |
| 删除领域资源 | `DELETE /resources/{id}` |
| 资源从属集合 | `/resources/{id}/children` |

领域操作以其所属资源和产生的领域状态命名。服务端内部的文件系统、Shell、任意目录创建和 CLI 执行属于领域服务实现，不形成浏览器可直接调用的通用原语。General Session 工作目录由 Session Runtime 内部 provisioner 管理。

视图专用投影仍是明确的读模型。它声明所属领域、输入、输出和刷新边界，并使用资源范围表达归属。产品设计决定投影名称和路径，避免以临时 UI 名称扩展公共 API。

`GET /workbench/session-groups` 是 Workbench 左侧会话列表的 Root 级读模型。它按 Space/General 分组，只返回数据库中 `time_archived IS NULL` 且 `parent_id IS NULL` 的 Session；归档会话和子会话不得进入响应、`sessionCount` 或客户端 Session Projection。

以下 Workbench Root 级读模型仅继承 Authorization，绝不经由 Instance Context、Workspace Routing 或按目录创建 Instance：

| Endpoint                                       | 语义                              | 关键约束                                                                                                                                                                                                                                 |
| ---------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /workbench/session-statuses`              | 已初始化 Session 的运行状态快照   | 仅返回非 idle 的 `busy` / `retry` 状态，`{ directory, sessionID, status }` 与 `SessionStatus` 的每实例 canonical 状态共享同一写入者；状态变更先更新快照再发布事件，实例 dispose 时删除快照。查询不能初始化目录，重连客户端读取当前快照。 |
| `GET /workbench/session-summaries/{sessionID}` | 通知筛选所需的 Session 元数据     | 直接读取 canonical `SessionTable`，返回 `{ id, title, directory, parentID?, agent? }` 或不存在时 `null`；子 Session 与归档 Session 均可读取，不调用 `Session.get` 或创建 Instance。                                                      |
| `GET /workbench/files?spacePath=&path=`        | 已注册 Space 根或相对目录的文件树 | `spacePath` 必须是注册 Space 根；`path` 为可选的相对路径，默认根目录。直接使用受限文件系统读取，保持 `File.Node[]` 的隐藏文件、`.git` / `.DS_Store` 排除、ignore 标记及目录优先排序语义；不创建 File runtime 或 Instance。               |
| `GET /workbench/file-content?spacePath=&path=` | 已注册 Space 内文件的预览内容     | `path` 必须为相对文件路径；复用 `File.Content` 的文本、二进制、图片 base64 和 MIME payload 语义，但不为预览运行 git diff、LSP 或 Instance 服务。                                                                                         |

文件树和文件内容的 `spacePath` 都先在 `SpaceRegistry` 中解析；空快照时可刷新同一根能力快照。服务端拒绝未知根、绝对或 `..` 路径、非目录/非文件目标和 realpath 后越出 Space 的符号链接（`WorkbenchSpaceNotFound` 404、`WorkbenchSpaceFileNotFound` 404 或 `WorkbenchSpaceFileAccessDenied` 403）。这两个端点不是通用任意文件系统表面。

下列 Workbench 接口目前编排在 `WorkbenchInstanceApi` 组中，但该组仅声明 Authorization，不挂载 Instance Context 或 Workspace Routing。树与候选位置读取不初始化目录；创建会话时由 provisioner 按已验证的目标目录获取运行环境：

| Endpoint | 语义 | 关键约束 |
|---|---|---|
| `GET /workbench/session-tree?limitPerScope=` | `Scope → 工作位置 → Session` 的三层只读投影 | General 固定在首位；注册 Space 即使为空也返回；仅返回未归档根会话；每个 Scope 最多 500 项。 |
| `GET /workbench/locations?spacePath=&query=` | Space 内可创建 Session 的受控候选位置 | `spacePath` 必须 canonical 精确匹配已注册 Space；候选经 realpath 与 Space 边界二次过滤，不能作为任意文件浏览器。 |
| `POST /workbench/sessions` | 创建 General 或 Space Session | `requestID` 幂等；新客户端使用 `target.spacePath`，旧 `target.space` 仅兼容一个发行周期；`target.directory` 只能是 Space 内安全相对路径。 |

`POST /workbench/sessions` 对相同 `requestID` 和相同 payload 返回已有 Session；同一 ID 配不同 payload 返回 `WorkbenchRequestConflict`（409）。可预期领域错误为 `InvalidSpaceTarget`（400）、`WorkbenchSpaceNotFound`（404）、`SessionDirectoryUnavailable`（409）、`WorkbenchRequestConflict`（409）、`CapabilityContractError`（502）和 `SpaceControlUnavailable`（503）。

Global API 为 Workbench 提供运行时与 CLI 健康边界：

| Endpoint | 语义 | 关键约束 |
|---|---|---|
| `GET /global/health` | 服务端存活与 Wopal CLI 状态 | 始终以服务端健康响应。`cli` 包含 `ok`、`missing`、`incompatible` 或 `broken`，并声明 `requiredVersion`。 |
| `POST /global/cli/repair` | 修复已检测到的 Wopal CLI 问题 | 只由用户确认的界面操作调用。服务端选择已有 CLI 更新或第一方 installer，并返回新的探测结果。 |

## Schema、错误与版本

### Schema 是契约真相源

每个端点在 API group 中声明 query、payload、success 和 error schema。领域模型或 group-local schema 同时服务运行时校验、OpenAPI 和 SDK 类型生成。

- API 输入与输出使用 Effect Schema 表达准确类型和可选性。
- 可预期领域失败使用显式 `Schema.ErrorClass` 或 `Schema.TaggedErrorClass`，提供稳定 code 与调用方可处理的语义。
- `HttpApiError` 适用于通用 HTTP 失败。SDK 可见的领域失败使用具名 schema。
- handler 返回领域 schema 所声明的结果，不以 `any`、未声明对象或字符串解析替代契约。

### 兼容性

当前主版本内的 API 通过新增可选字段和新增端点演进。字段删除、重命名、类型变化、语义变化、默认行为变化和可选变必填构成破坏性变更。

破坏性变更创建新的明确 API 版本或并行的替代资源。旧契约在声明的迁移窗口内保持可用，并在 OpenAPI 中标记替代关系。调用方忽略未知可选字段，并以公开错误 schema 而非错误文案处理失败。

API 路径版本只服务破坏性版本演进。局部字段变化不通过临时 query 参数、隐式响应分支或手写 SDK 补丁表达。

## OpenAPI 与生成 SDK

`OpenCodeHttpApi` 是 API 组合根。每个 group 提供稳定的 OpenAPI identifier，端点提供稳定的 operation identifier。OpenAPI 生成流程从运行中 API 树导出规范，`packages/sdk/js/script/build.ts` 使用 `@hey-api/openapi-ts` 生成 `packages/sdk/js/src/v2/gen/` 的类型和客户端。

```text
Effect Schema + HttpApiGroup
  → OpenCodeHttpApi
  → OpenAPI document
  → generated TypeScript types + OpencodeClient methods
  → ellamaka-app / external consumers
```

生成目录由 SDK 构建管线拥有。应用代码通过生成客户端调用端点。新增或修改端点后，实施者重新生成 SDK、审阅生成 diff，并让消费端使用生成方法。手写生成文件无法形成稳定契约。

## Wopal CLI 集成

Ellamaka 的 Wopal CLI adapter 是 Runtime API 的领域服务。它以绝对可执行路径和参数数组调用已登记的 `wopal ... --api-version` capability，验证结构化结果，映射稳定 CLI 错误码，并维护非权威查询快照。adapter 位于 sidecar（serve 进程）内部，直接 spawn wopal 进程；不引入专门的 wopal 常驻 worker——wopal 调用是无状态进程边界，sidecar 已是常驻承载者，Workbench renderer 的所有 CLI 调用都经过它。

CLI 健康契约由 `CliContract` 服务负责。它使用同一安装路径检查 `wopal --version` 版本兼容，修复完成后失效缓存重新检测。CLI 控制能力不可用时，Session Runtime 继续提供 General Session；Space 投影以空 Space 集合降级。

Runtime API 面向 Workbench 暴露 Ellamaka 领域资源与投影，而不是透传 CLI 命令、CLI JSON envelope 或底层 filesystem 参数。CLI 管理的 settings、Git 和 ontology 状态保持事实来源。Session、PTY、消息和 General Session 工作目录由 ellamaka 直接拥有。

### 消费侧 schema 来源

消费侧 schema 从共享契约包导入，与 wopal 契约同源：wopal-cli 以 TypeBox 声明的能力 schema（真相源）发布为共享契约包，ellamaka 从共享包导入，编译期与 wopal 契约同步。运行时的 envelope 解码与错误映射保持现有 adapter 形态不变；具体转换方式（Effect Schema 包装或直接 TypeBox 校验）属落地阶段决策。共享包与 wopal-cli 同版本发布，ellamaka 锁版本消费。

### 当前消费的 CLI capability

| Capability | 版本 | 消费方 | 用途 |
|---|---|---|---|
| `space.list` | v1 | SpaceRegistry | 枚举已注册 Space |
| `space.projects.list` | v2 | SessionProjection / SpaceRegistry | 获取 Space 内 `projects/` 下的注册项目及其 linked worktree；worktree 数据完全由 CLI 提供，后端不再自行调用 `git worktree list` |
| `space.search` | v1 | SessionProjection / SpaceRegistry | Space 内目录、repo 和文件搜索；替代已删除的 `space.directories.search` |

`space.projects.list` v2 返回的 `worktrees[]` 已经过滤主工作树并限定在 `<spaceRoot>/.worktrees/` 下，Session Projection 直接消费用于 session marker 分类（`worktree` / `directory` / 普通），无需在后端重复执行 git 命令。

## 端点设计门禁

新增或修改 API 时，实施者完成以下检查：

1. 确认领域 Owner、Root/Instance 层级和现有 group，选择最小的扩展点。
2. 在设计中说明资源语义、路径、输入、成功结果、可预期错误和兼容性。
3. 使用 Effect Schema 和 `HttpApiGroup` 定义契约；handler 只负责 HTTP 到领域服务的转换。
4. 在 API 组合根和 handler layer 注册 group，继承正确的 Authorization 与 Instance Context middleware。
5. 重新生成 SDK，不手写 `src/v2/gen/**`。
6. 测试 schema 验证、成功路径、领域错误、授权或工作区路由边界，以及生成客户端调用。
7. 更新对应领域设计、本契约的变更记录，以及受影响的品牌身份描述（见 `DESIGN.md` 品牌身份）。

## 现有端点迁移

本契约适用于所有新端点。已有 WopalSpace 端点在其下一次相关功能变更时按本契约审查和迁移。迁移保持已发布消费者可用，并将 schema、operation identity、SDK 生成与领域所有权收敛到同一条链路。

## 相关文档

| 文档 | 职责 |
|---|---|
| `docs/DESIGN.md` | Ellamaka 的运行时职责、状态归属、品牌身份和 API 架构概览。 |
| `../../../projects/wopal-cli/docs/DESIGN-capability.md` | CLI capability 的机器输入、JSON 输出和版本规则。 |
| `packages/opencode/src/server/routes/instance/httpapi/AGENTS.md` | Effect HttpApi 的实现模式。 |
| `packages/sdk/js/script/build.ts` | OpenAPI 到 JavaScript SDK 的生成入口。 |
