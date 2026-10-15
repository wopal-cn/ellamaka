# Ellamaka SDK — Unified Public API and Client Transport

> **Status**: Active
> **Updated**: 2026-10-15
> **Parent**: `./DESIGN.md`
> **Parent Architecture**: `../../../docs/products/wopal-space/DESIGN.md`
> **Scope**: `@wopal/ellamaka-sdk` 的统一公开 API、OpenAPI 3.1、generated client、HTTP/local transport、契约发现与发布边界
> **Sibling DESIGNs**:
>
> - `./DESIGN-wopalspace.md` — private `@wopal/wopalspace` application implementation
> - `./DESIGN-onboarding.md` — Setup/Onboarding 如何消费统一 SDK
> - `./DESIGN-distribution.md` — SDK npm 发布与产品分发
> - `./DESIGN-auth.md` — Phase 3 统一认证方向（Draft）

## Purpose

`@wopal/ellamaka-sdk` 是 Ellamaka 产品体系唯一公开的 service SDK。

它公开两类可复用平台能力：

- **Ellamaka Runtime**：health、Session、Agent、PTY、Tool、Provider、Runtime discovery、events 等运行时能力；
- **WopalSpace**：Setup、Ontology、Space 及其通用查询/文件能力。

这两类能力共享一个 SDK，不代表内部业务 owner 合并。Runtime service 仍由 Ellamaka Runtime 拥有；WopalSpace implementation 仍只存在于 private `@wopal/wopalspace`。官方 `@wopal/ellamaka-app` 的 Workbench/Onboarding 产品投影属于 App BFF，不构成第三方平台 SDK。

设计原则是：

> **一个公开 Platform SDK、一套公开 API 定义来源、同一 public generated client model；Server 可以同时挂载 app-private API，但 app-private contract 不进入公开 SDK。**

## Ownership Boundary

```text
Ellamaka Runtime schemas/services        private @wopal/wopalspace
              │                                  │
              └──────────────┬───────────────────┘
                             ▼
                 Public Platform HttpApi
                             │
                       OpenAPI 3.1
                             │
                             ▼
                  @wopal/ellamaka-sdk
                  generated client/types

Runtime + WopalSpace facts
              │
              ▼
       Official App BFF HttpApi
              │
              ▼
      ellamaka-app private client
```

边界规则：

- Runtime domain service 不 import WopalSpace application service。
- Server composition root 可以同时挂载 Public Platform HttpApi 与 Official App BFF HttpApi。
- App BFF 可以同时读取 Runtime facts 和 WopalSpace facts，并只服务官方 `ellamaka-app`。
- public SDK 不实现业务逻辑，也不包含官方 App 专用 projection/use-case contract。
- private `@wopal/wopalspace` 不作为 npm consumer package 发布。

## OpenCode Lineage

SDK 延续 OpenCode 已成熟的生成客户端结构、调用习惯和可复用 codegen，但公开兼容性由 Ellamaka 自己已发布的 contract 定义。

Ellamaka 品牌 API 是 canonical surface：`EllamakaClient`、`createEllamakaClient`、`createEllamakaServer`、`createEllamakaTui`、`createEllamaka`。已有 OpenCode 命名只作为同一实现的兼容 alias，不维护第二份 generated source。统一模型采用现有 v2 调用形状；保留名字不表示保留旧 root/v1 的嵌套参数协议。旧调用形状若改变，按 MAJOR 发布并提供升级说明，本仓 v2 调用的行为保持。

## Plugin Client Compatibility

公开SDK的root调用形状与引擎注入的 `PluginInput.client` 是两个兼容边界。SDK统一为canonical v2 model时，不能把现有插件接收的client一起改成另一种参数形状。

`PluginInput.client` 保持当前Plugin SDK公开的原生操作调用合同：旧的 path/query/body封装、构造时的directory/认证、自定义选项、取消、data/error结果与事件流行为。引擎在这个既有入口提供薄调用适配，实际请求仍由唯一canonical generated client编码；不保留第二套generated DTO/业务client，不新建HTTP端点或历史SDK框架。Plugin SDK的client类型应描述这个注入合同，不再从可独立发生MAJOR变化的SDK root factory自动推导。

例如 auth.set 的 `{path:{id},body}` 转成canonical `{providerID:id,auth:body}`；session.get/messages的path.id转sessionID，query/body按对应operation定义转换。转换依据实际公开operation，不能仅靠方法名或类名猜参数。数据schema仍从同一canonical contract取得。

兼容范围以当前Plugin SDK公开且当前Runtime支持的原生操作为准，覆盖内置认证插件及现有ontology插件真实调用。原SDK中已无当前Runtime对应的陈旧声明应明确诊断/升级范围，不能悄悄制造成功。SDK/root的MAJOR升级说明不替代引擎插件兼容验收；引擎注入方式、类型与适配必须在同一Task验证后切换。ontology插件源码在本轮保持只读，不靠迁移它们来掩盖产品内断裂。

## Canonical Contract

公开 operation 的权威定义来自 Effect Schema、`HttpApiEndpoint` / `HttpApiGroup` 与 OpenAPI metadata。它必须统一描述：

- operation identity；
- HTTP method/path；
- Root / Instance / WopalSpace resource scope；
- input/output；
- error 与 HTTP status；
- authentication metadata；
- SSE/event stream schema。

Public Platform HttpApi 是公开 operation 的唯一 composition。运行中 Server 的 `GET /doc` 和发布 SDK 自带的 OpenAPI 都从这份 public composition 生成，不包含 Official App BFF route，也不维护第二份手写 YAML/JSON。

Official App BFF 使用独立的私有 schema/HttpApi composition，并可为 `ellamaka-app` 生成内部 client。它不发布 npm SDK、不进入 public OpenAPI，也不参与 `@wopal/ellamaka-sdk` SemVer。

内部可以用 domain metadata 区分 Runtime 与 WopalSpace operation，供文档、测试和代码组织使用；**domain metadata 不用于分裂公开 npm SDK。**

## API Families

下表只说明 ownership。WopalSpace 的完整 endpoint catalog、输入输出语义和 operation business semantics 由 `DESIGN-wopalspace.md#public-operations` 定义；SDK 不复制第二份业务合同：

| API family | Owner | 主要职责 |
| --- | --- | --- |
| global / health / control | Ellamaka Runtime | Server 与 Runtime 状态、诊断 |
| session / message / agent | Ellamaka Runtime | Agent 会话与执行 |
| PTY | Ellamaka Runtime | 终端生命周期与连接 |
| provider / tool / capability discovery | Ellamaka Runtime | effective Runtime 能力 |
| event | Ellamaka Runtime | Runtime events / SSE |
| wopalSpace.setup | private `@wopal/wopalspace` | 初始化计划、执行、状态、进度 |
| wopalSpace.ontology | private `@wopal/wopalspace` | Ontology lifecycle |
| wopalSpace.space | private `@wopal/wopalspace` | Space lifecycle、registry、query、selection |

Product 安装/更新不进入 WopalSpace API；继续由 Wopal CLI 拥有。Evolution 全部在 Wopal CLI 本机执行，不消费 SDK 的 Ontology/Space operations，也不增加 Evolution 提交或恢复 API。

## One Generated Client Model

平台调用方使用统一的 `EllamakaClient`。公开业务按 namespace/resource group 组织，例如：

```text
client.global.*
client.session.*
client.pty.*
client.wopalSpace.setup.*
client.wopalSpace.ontology.*
client.wopalSpace.space.*
```

同一个 public operation 的 method、input、output、error 不因 transport 变化。

HTTP client 访问 Server 的 **Public Platform surface**；它不承诺 Server 上的 app-private/internal route。本机 WopalSpace client 从同一 public generated source/type 中暴露 `wopalSpace` application subset，不复制一套 DTO 或业务方法定义。

`ellamaka-app` 可以从 Official App BFF contract 生成自己的 private client。该 client 的 projection DTO 只服务官方 App，不是 Runtime/WopalSpace domain DTO 的第二份来源。


## Official App BFF Boundary

`@wopal/ellamaka-app` 同时拥有前端体验和为该体验定制的 BFF contract。BFF 与 Public Platform API 挂载在同一个 Ellamaka Server，并共享统一认证/监听器，但 publication boundary 独立。

App BFF 只承载需要跨领域组合或直接服务界面结构的 contract，例如：

- Session Tree：把 General/Space/Project/Session facts 投影成官方 Workbench 导航树；
- creation locations：把 registered Space、project、recent directory 等事实投影成官方创建会话候选；
- Session provision use case：把 General/Space 目标校验与 Runtime Session 创建组合成一个官方 App 动作；
- DSH embed entry：向官方 App 提供当前宿主的受控 iframe entry。

可独立复用的领域能力不得只存在于 App BFF。Space 文件读取属于 WopalSpace public contract；Session 状态与 metadata 属于 Runtime public contract。App BFF 优先组合这些 public/domain service，而不是复制业务状态机。

App-private HttpApi 可以拥有生成的内部 client 和 build-time contract 校验。它不导出到 `@wopal/ellamaka-sdk`、不出现在 `GET /doc`、不为第三方提供兼容承诺。

## Public Entrypoints

目标公开入口：

| Entrypoint | 用途 |
| --- | --- |
| `@wopal/ellamaka-sdk` | generated client/types、无副作用 contract metadata、通用 client factory |
| `@wopal/ellamaka-sdk/http` | 连接已经存在的 Ellamaka Server，使用 HTTP/SSE/WebSocket |
| `@wopal/ellamaka-sdk/local` | trusted-local WopalSpace application transport，供 Wopal CLI 等本机 consumer 使用 |
| `@wopal/ellamaka-sdk/openapi.json` | 当前 SDK 版本完整公开 OpenAPI contract |
| `@wopal/ellamaka-sdk/openapi` | 程序化读取同一 OpenAPI document |

root import 不能因为被 import 就启动 Worker、Server、DSH 或扫描用户目录。

## HTTP Transport

Browser、Desktop Renderer、远程 CLI/Agent 通过同一个 Ellamaka Server 使用公开 SDK 的 Platform surface：

```text
EllamakaClient
    │ HTTP / SSE / WebSocket
    ▼
Ellamaka Server
    ├─ Public Runtime handlers
    ├─ Public WopalSpace handlers
    └─ Official App BFF handlers  <- ellamaka-app private client
```

Server composition 内部直接调用 private `@wopal/wopalspace`，不绕 SDK loopback 调用自己。Official App BFF 也直接组合内部 domain services，不经 public HTTP 回调同一进程。

HTTP 调用作用于 Server 所在机器。请求不能通过普通参数替换 Server 的 `WOPAL_HOME`、产品固定 runtime descriptor 或 DSH closure identity。

## Local WopalSpace Transport

Wopal CLI 需要复用 Ontology/Space 业务，但不应该为了本机调用启动 localhost Server，也不能依赖 unpublished private package。

`@wopal/ellamaka-sdk/local` 使用 Worker transport：

```text
Wopal CLI / trusted local consumer
        │
        ▼
Ellamaka generated WopalSpace methods
        │ custom fetch
        ▼
      Worker RPC
        │
        ▼
   app.fetch(Request)
        │
        ▼
private @wopal/wopalspace handlers
```

本机 transport 仍使用标准 Request/Response contract，因此本机与 HTTP 不产生两套 WopalSpace API。

Local Worker 可以注入 `$WOPAL_HOME`、cwd、Git/filesystem adapter 等可信本机能力，但这些只是 execution environment，不是另一套业务状态机。Setup 只通过运行中的 Server `/onboarding` 使用，不在 `/local` 建立第二种 presentation。

### Local Surface

`/local` 的目标是 WopalSpace trusted-local application 调用，不是替代完整 Ellamaka Runtime host。当前用于 Ontology、Space 等 CLI 需要的本机 operation；Setup 只通过 Server-hosted Web Onboarding 使用。

Session、PTY、Agent 等真正 Runtime operation 仍由运行中的 Ellamaka Runtime 提供；调用这些能力应连接现有 HTTP Runtime、TUI Worker Runtime 或显式启动 host。

## Self-contained Local Artifact

发布后的 `/local` 必须可以被 Wopal CLI 独立安装和使用。消费者不能被要求再安装 private：

```text
@wopal/wopalspace
@wopal/ellamaka-core
@wopal/ellamaka-cordis
```

构建时把 local Worker 真正需要的 private implementation 和 runtime primitives 组装进 publish artifact；npm runtime dependency graph 只出现公开可安装依赖。

这条规则不意味着把整个 Ellamaka product binary 打进 SDK。Worker 只携带执行 WopalSpace local application contract 所需的代码。

本机 `space.init` 在同一 Worker 内调用 Core 的 instance contributor，完成 `.wopal` path-plugin 依赖准备与 preflight；它不需要运行中的 Server、产品 descriptor 或 DSH。该路径只组合无启动副作用的原语，不能通过导入完整 AppRuntime/Global 启动链来初始化 Worker。

Worker 生命周期覆盖 operation 及其受管子进程收尾。取消消息传到 operation signal；退出前等待安全提交和清理完成。HTTP 与 local 共用 operation schema/error，但 local 只注册 Ontology/Space handlers，Setup 与 Runtime 请求在进入业务前拒绝。Node SEA 消费者使用发布物携带的 Worker 资源，资源定位和启动方式必须通过真实 SEA clean-consumer 验证。

## Setup Transport Boundary

Setup 没有 trusted-local/Terminal presentation。`wopal setup` 不调用 `/local` Setup operation，也不存在跨产品 runtime prewarm helper。

```text
wopal setup
  -> start/reuse ellamaka serve
  -> open /onboarding
  -> @wopal/ellamaka-sdk/http
  -> private @wopal/wopalspace/setup
```

每个 Ellamaka product/build 的 CorePreparation 由该产品自己启动时完成。SDK 不接受“另一个产品的位置/descriptor”去替它离线准备 Runtime。

## TUI Local Runtime Transport

TUI 的现有 local Worker 模式继续使用同一 SDK contract：

```text
TUI UI thread
  -> EllamakaClient
       -> custom fetch / Worker RPC
       -> Server app.fetch(Request)
```

默认本机模式不要求 TCP loopback；显式 network/attach 模式改用真实 HTTP/SSE。这里的 Worker 承载真正 Runtime，与 `/local` 的 WopalSpace application Worker用途不同，但两者复用同一 generated Request/Response contract 思想。

## Host Lifecycle

client、transport 和 host process lifecycle 是三件事：

- `createEllamakaServer` / `createEllamakaTui` 等 helper 可以管理本机进程；
- `/http` 只连接已经存在的 Server；
- `/local` 为允许 trusted-local 的 WopalSpace Ontology/Space 等 operations 建立调用期 Worker；
- Desktop Main 负责 packaged sidecar 生命周期；
- 业务 API 不因为宿主方式不同而改变。

## Contract Discovery

同一个完整公开 contract 可以从三个地方取得：

| Environment | Source |
| --- | --- |
| running Server | `GET /doc` |
| installed npm package | `@wopal/ellamaka-sdk/openapi.json` |
| source tree | side-effect-free contract export |

三个来源 canonicalize 后必须表示同一 **Public Platform SDK contract**。Agent 判断公开 API 是否存在时读取 OpenAPI，不从 CLI/Desktop 产品版本或 Server 的内部 route 集合猜测。

Developer Reference 可以按 Runtime、WopalSpace 等 domain 分组展示，但这些分组都来自同一份 public OpenAPI 和同一个 SDK package。Official App BFF 的 contract 只用于 App 自身开发与构建校验。

## Authentication

当前阶段使用 Ellamaka Server 的统一认证边界。WopalSpace HTTP operation 不再拥有独立 onboarding/auth 体系，也不增加细粒度 Space/Ontology IAM。

`/local` 是 trusted-local transport。HTTP caller 获得 Server credential 后视为该 host 的受信管理者；各业务 operation 仍必须自己保证 path confinement、目标合法性和 secret redaction。

Phase 3 将把 Browser 登录向 DSH 已采用的 launch-token + signed-cookie 思路收敛，见 `DESIGN-auth.md`。

## Errors and Streaming

每个公开 endpoint 声明真实可能发生的稳定 domain error。generated client 的 error union 与 HTTP response 保持一致。

Setup/CorePreparation 等长任务的 progress 使用明确的 stream/event schema；事件不包含 secret。取消属于 operation 生命周期，不通过杀 CLI subprocess 模拟。

## Versioning

`@wopal/ellamaka-sdk` 只有一条 SemVer 版本线，覆盖 Runtime 与 WopalSpace 公开 contract。

- PATCH：不改变公开 schema/语义的实现修复；
- MINOR：向后兼容的新 operation、可选字段或 error variant；
- MAJOR：删除/改名 operation，改变已有必填输入、字段语义或认证要求。

SDK SemVer 不镜像 Ellamaka CLI、Desktop 或 Wopal CLI 产品版本，也不决定 DSH Home closureVersion。

private `@wopal/wopalspace` 不拥有独立外部 SemVer。

## Publication

SDK 发布物至少包含：

- generated JS client；
- generated TypeScript declarations；
- 完整 `openapi.json`；
- package version / contract digest metadata；
- `/http` helper；
- self-contained `/local` WopalSpace Worker artifact。

CLI/Desktop product release 与 SDK release 是不同概念。产品 workflow 不因为发产品就隐式改变 SDK contract version；SDK 也不决定产品版本。

## Cross-Project Development

Wopal CLI 与 Ellamaka 分属不同项目时，本地联调仍使用 **publish-shaped `@wopal/ellamaka-sdk` artifact**：

```text
Ellamaka source
  -> build publish-shaped @wopal/ellamaka-sdk
  -> local dev overlay points Wopal CLI at that artifact
  -> Wopal CLI still imports only public SDK
```

原则：

- Wopal CLI 不直接 import `@wopal/wopalspace` 源码；
- 联调 artifact 的目录结构和 exports 与 npm tarball 一致；
- 临时 overlay 不成为 package.json/lockfile 中永久的 `file:`/`link:` 依赖；
- 正常 install 后回到固定的已发布 SDK version。

## Invariants

1. 对外只有 `@wopal/ellamaka-sdk` 一个 platform service SDK。
2. Runtime 与 WopalSpace application 的内部 owner 保持分离。
3. Public Platform API 只有一份 schema/OpenAPI 来源；Official App BFF 使用独立私有 contract。
4. HTTP 与 local WopalSpace transport 复用同一 public generated operation/DTO/error 定义。
5. `/local` 不启动 localhost Server，也不形成私有业务协议。
6. `/local` 发布物不能要求消费者安装 unpublished private packages。
7. Wopal CLI 不直接依赖 `@wopal/wopalspace`，也不通过 Ellamaka CLI subprocess 复用业务。
8. Server composition 内部直接调用 private WopalSpace service，不通过 SDK/HTTP loopback。
9. Official App BFF 不进入公开 SDK、`GET /doc` 或 SDK SemVer。
10. Product 安装/update 不进入 WopalSpace SDK surface。
11. SDK 不拥有 Desktop/Server/Wopal CLI 的产品生命周期。
