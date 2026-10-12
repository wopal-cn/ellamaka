# Ellamaka SDK — Runtime HTTP Contract

> **Status**: Active
> **Updated**: 2026-10-12
> **Parent**: `./DESIGN.md`
> **Parent Architecture**: `../../../docs/products/wopal-space/DESIGN.md`
> **Parent Product**: `../../../docs/products/wopal-space/PRD.md`
> **Scope**: `@wopal/ellamaka-sdk` 的 Runtime HTTP 契约、OpenAPI 3.1 真相源、生成客户端、版本规则与完整契约发现方式
> **Sibling DESIGNs**:
>
> - `./DESIGN-wopalspace-sdk.md` — trusted-local application SDK 与 local contract
> - `./DESIGN-onboarding.md` — Onboarding Journey 的 HTTP/local SDK 组合
> - `./DESIGN-distribution.md` — SDK npm train 与 package publication

## Purpose

`@wopal/ellamaka-sdk` 是 Ellamaka Runtime 的公开网络 SDK。它让 Workbench、Desktop Renderer、Node 客户端、Agent 工具和远程调用方通过同一套 HTTP/SSE 契约访问 Runtime，而不是直接依赖 Ellamaka 内部模块。

它只表达 **Runtime remote surface**。WopalSpace 的本机 Git、filesystem、setup、Space/Ontology application workflow 与产品安装事务属于 [`@wopal/wopalspace-sdk`](./DESIGN-wopalspace-sdk.md)。两套 SDK 可以在同一宿主中组合，但互不伪装成对方的 transport。

## OpenCode Lineage and Compatibility Policy

`@wopal/ellamaka-sdk` 延续 OpenCode SDK 的 package 结构、生成方式和调用习惯，但公开兼容性由 **Ellamaka 自己已经发布的 SDK contract** 定义。OpenCode 只作为只读参考实现与选择性代码来源；具体 fix 或功能按需 cherry-pick 或手工移植，并由 Ellamaka 的 Git 变更记录保留来源。

SDK 演进遵循以下原则：

- Ellamaka SDK SemVer 对已经发布的 `@wopal/ellamaka-sdk` surface 负责；同一 major 内维持向后兼容。
- Ellamaka 品牌名称是公开 SDK 的 canonical API；`createEllamakaClient`、`EllamakaClient`、`createEllamakaServer`、`createEllamakaTui`、`createEllamaka` 以及对应 config/type 名称用于文档、示例和新代码。现有 `createOpencodeClient`、`OpencodeClient`、`createOpencodeServer`、`createOpencodeTui`、`createOpencode` 保持为同一实现的兼容 alias，并按 Ellamaka SemVer 管理。
- OpenCode 的目录布局、codegen 工具和 client conventions 在不妨碍 Ellamaka 架构时继续复用，以降低 fork 维护成本。
- 从 OpenCode 选择 fix 或功能时，只评估该项变更对 Ellamaka contract、codegen 与消费者的影响；上游 surface 不自动成为 Ellamaka 的兼容承诺。

`@wopal/wopalspace-sdk` 与本 SDK 属于同一个 Wopal SDK family。它遵循相同的 client 组织、错误处理、契约生成、测试与 npm 发布纪律，但不继承 OpenCode SDK 的公开 surface 或命名包袱。

## Ownership Boundary

```text
Effect domain schemas + HttpApiGroup + OpenAPI metadata
                    │
                    ▼
                 PublicApi
                    │
          ┌─────────┴──────────┐
          ▼                    ▼
    OpenAPI 3.1            HTTP Runtime
          │                    │
          ▼                    └── GET /doc
@wopal/ellamaka-sdk
 generated client/types
```

Runtime domain service 拥有业务状态和行为；HttpApi handler 只负责鉴权、transport 与 DTO 映射。WopalSpace HTTP handler 可以调用 `@wopal/wopalspace-sdk` 的 application operation，但 HTTP 层不重新实现 Space/Ontology/Evolution workflow。

Ellamaka build、start、HTTP、Onboarding、Desktop 与 release pipeline 的 SDK 契约均来自本仓库。它们不依赖 Wopal CLI binary、Wopal CLI protocol version 或 Wopal CLI 发布的 schema package。

## Canonical Contract

每个 Runtime operation 的权威定义由 Effect Schema、`HttpApiEndpoint` / `HttpApiGroup` 与 OpenAPI metadata 共同组成，合并进 `PublicApi`。以下事实都必须从同一个声明链生成：

- HTTP method 与 path；
- Root / Instance scope；
- path/query/header/body schema；
- success response 与媒体类型；
- domain error 与 HTTP status；
- authentication / authorization metadata；
- `operationId`、group、description；
- SSE/event stream 的 wire schema。

生成的 **OpenAPI 3.1 document 是完整的公开网络契约清单**。Markdown 只解释长期设计规则和主要 API 家族，不维护完整端点表。

`operationId` 是 SDK 生成与 Agent discovery 的稳定机器身份。已发布 operation 不通过改名来表达重构；真正 breaking 的语义变化遵循 SDK SemVer。

## Major API Families

下表只给出主要能力边界，**不是完整清单**：

| API family                               | 主要职责                                                   | Scope           |
| ---------------------------------------- | ---------------------------------------------------------- | --------------- |
| global / control                         | Runtime 状态、全局控制、健康与生命周期控制面               | Root            |
| instance / project / file / search / VCS | 当前工作目录相关资源与只读/受控操作                        | Instance        |
| session / message                        | Session、消息、执行与历史资源                              | Instance        |
| permission / question                    | 人机审批与问题交互                                         | Instance        |
| PTY                                      | 终端创建、读写、关闭与状态                                 | Instance        |
| provider / runtime discovery             | provider、模型与运行时可发现能力                           | Root / Instance |
| tool / capability discovery              | 运行时实际可用的 skill/rule/tool 等 effective capability   | Instance        |
| event                                    | Runtime event 与 SSE                                       | Root / Instance |
| wopalspace                               | WopalSpace local application service 的远程管理投影        | Root            |
| workbench                                | Workbench 专用的 Session projection、Space UI 资源与管理面 | Root / Instance |
| onboarding                               | `state/probe/execute/cancel/complete/stream` Journey       | Root            |

真正的 method/path/input/output/error 列表始终从 OpenAPI 3.1 获取。

`global.health` 是 Runtime 自身状态的公开只读事实。它保留 `dsh` 状态，并提供结构化 DSH detail（稳定 reason code、target/home generation 与安全缩写的 fingerprint）。Wopal 管理的 `serve` 还可在启动时注入随机 `managedInstanceId`，health 原样回显该值和当前 PID，供 `wopal status/stop` 证明“这个 endpoint 仍是我启动的实例”。读取 health 不触发 Core preparation、closure materialization 或 Home 写入。

## Client Contract

`@wopal/ellamaka-sdk` 保留现有生成客户端的 resource-grouped `data/error` 调用模型与 `throwOnError` 语义。调用者提供连接信息与鉴权；生成 method 接收 OpenAPI 定义的 serializable input，返回生成 DTO。SDK 不通过 shell 调用 `ellamaka` 或 `wopal` 来模拟网络 operation。

### Public Branding

公开 TypeScript API 以 Ellamaka 品牌名称为 canonical surface：

| Canonical API          | Compatibility alias    | Contract                                                |
| ---------------------- | ---------------------- | ------------------------------------------------------- |
| `EllamakaClient`       | `OpencodeClient`       | 同一个 generated client class；alias 不生成第二个 class |
| `EllamakaClientConfig` | `OpencodeClientConfig` | 同一个 client config type                               |
| `createEllamakaClient` | `createOpencodeClient` | 同一个 client factory；连接已有 Runtime                 |
| `createEllamakaServer` | `createOpencodeServer` | 同一个 local process launcher；启动 `ellamaka serve`    |
| `createEllamakaTui`    | `createOpencodeTui`    | 同一个 local TUI launcher                               |
| `createEllamaka`       | `createOpencode`       | 同一个 convenience helper；启动 Runtime 后创建 client   |

codegen 的 canonical instance name 使用 `EllamakaClient`。兼容名称通过静态 export alias 或零逻辑 forwarding wrapper 暴露，不能维护第二份 generated source、schema 或 transport 行为。兼容 alias 与 canonical API 必须通过 identity/behavior contract tests 证明返回同一类型和相同行为。

OpenAPI code sample、Developer Reference、README、新测试与新应用代码只展示 Ellamaka 品牌名称。已有 OpenCode 命名继续可编译运行，但不作为新示例的首选入口。SDK 自己产生的用户可见错误和诊断使用 Ellamaka 品牌，例如 `Ellamaka Server`；兼容函数名不改变 Runtime 品牌或错误文案。

Browser 与 Node 使用同一生成 contract。只在 transport 适配层允许环境差异，例如 base URL、fetch implementation、credential injection；领域 DTO 与 operation identity 不因运行环境分叉。

Runtime SDK 不直接执行本地 Git / filesystem application workflow、`$WOPAL_HOME` 产品安装事务、CLI/Desktop binary 替换、DSH closure materialization/Home backup 或 Wopal CLI machine capability；这些能力由各自 owner 提供。

## Full Contract Discovery

Agent 和工具必须有三条等价的完整契约发现路径。

### Running Runtime

运行中的 Ellamaka 提供：

```text
GET /doc
```

它返回该进程实际 `PublicApi` 生成的 OpenAPI 3.1，是判断“这个正在运行的实例真正支持什么”的首选来源。

### Published SDK Package

`@wopal/ellamaka-sdk` 的 npm artifact 必须包含与该 SDK 版本对应的不可手改 OpenAPI snapshot，并通过稳定 package export 暴露：

```text
@wopal/ellamaka-sdk/openapi.json
```

Agent 在没有运行 Runtime 时，从已安装 package 解析该文件即可获得完整 operation、schema、error 与 metadata。package 还提供 `@wopal/ellamaka-sdk/openapi` 的 JS export 方便程序直接读取 document；二者来自同一生成物。

### Source Tree

SDK workspace 提供 side-effect-free 的 contract export entry。它只装配 schema / `PublicApi` 并输出 OpenAPI，不启动 HTTP server、DSH、Home preparation、模型或任何用户资源。`packages/sdk/js` 的 `contract:export` script 是源码树的稳定入口，可输出到 stdout 或指定文件。

这三种来源必须 canonicalize 后具有相同 contract digest。发布与测试不接受“运行时 `/doc` 一份、SDK codegen 一份、仓库 snapshot 又一份”的漂移。

### Agent Discovery Procedure

Agent 按环境选择最直接的真相源：

| Environment           | Procedure                                                                  | Meaning                                              |
| --------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| running Runtime       | `GET /doc`                                                                 | 当前进程实际支持的完整 HTTP contract                 |
| installed npm package | `node -p "require.resolve('@wopal/ellamaka-sdk/openapi.json')"` 后读取文件 | 该 exact SDK package 的完整发布 contract             |
| Ellamaka source tree  | 在 `packages/sdk/js` 运行 `contract:export --stdout`                       | 当前 source `PublicApi` 的 side-effect-free contract |

Agent 需要列 API、生成调用代码、判断字段或错误码时，必须先读取上述 OpenAPI。`DESIGN-ellamaka-sdk.md` 的 API family 表和 Wopal CLI 的 `capability spec` 都不能代替完整 Runtime contract。

### Developer Reference Presentation

Runtime OpenAPI 与 WopalSpace local SDK 的 discovery contract 保持两个独立文档。统一 Developer Reference Portal 可以同时展示两套契约，但 Runtime 页才提供真实 HTTP `Try it`；local SDK 页展示 method、schema、错误与 TypeScript 调用示例，不把 local operation 伪装成 HTTP endpoint。

## OpenAPI Publication

SDK generation 使用一次生成的 OpenAPI snapshot 作为唯一输入：

```text
PublicApi
  → side-effect-free OpenAPI export
  → packages/sdk/openapi.json
  ├─→ @hey-api generated client/types
  ├─→ npm package openapi.json
  ├─→ Scalar/docs tooling
  └─→ contract digest / compatibility checks
```

生成文件不可手改。发布包至少包含 generated JS client、generated TypeScript declarations、`openapi.json` 与可读取的 package version / contract digest metadata。

`GET /doc` 同样从 `PublicApi` 生成，不维护第二份 YAML/JSON schema。

## Authentication and Scope

Root API 承载全局控制与 WopalSpace 管理能力；Instance API 绑定明确 directory/context。路径前缀不是安全边界，认证和资源授权由服务端 middleware / domain service 执行。

远程请求始终作用于服务器机器。请求不得通过参数切换服务 `WOPAL_HOME`、可执行程序路径或产品固定的 DSH closure。秘密不得出现在 response、OpenAPI example、progress event 或 error detail 中。

只读 operation 不因读取而物化资源。需要 Runtime Core 的 operation 在 Core 未 ready 时返回明确的领域状态/错误，不通过 Wopal CLI 做隐式修复。

## Errors and Streaming

每个公开 endpoint 在 schema 中声明实际可能返回的 domain errors；生成 SDK 的 error union 必须与 HTTP response 保持一致。新增稳定错误语义时同步 schema、OpenAPI、generated SDK 与 contract tests。

SSE operation 明确声明 `text/event-stream` 与 event payload schema。Progress/event 流只承载可公开的状态；取消属于对应 domain operation 的生命周期，不用关闭进程或 CLI 子进程来模拟。

## Versioning and Compatibility

SDK npm SemVer 表达 **Runtime network contract**，独立于 Ellamaka CLI/Desktop Product SemVer：

- PATCH：不改变公开 schema/语义的实现修复；
- MINOR：向后兼容的新 operation、新可选字段、新 error variant 或能力；
- MAJOR：删除/改名 operation，改变必填输入、已有字段类型/语义、鉴权要求或已发布错误语义。

Wopal CLI、Workbench 和其他二进制消费者固定经过验证的 exact SDK version。SDK version 不等于 HTTP `operationId` version，也不参与 DSH closure fingerprint。`@wopal/ellamaka-sdk` 与 `@wopal/wopalspace-sdk` 各自拥有独立 SemVer；二者共享发布基础设施和质量门禁，但不要求同版本或同时 bump。SDK version 也不镜像 Ellamaka CLI/Desktop 产品版本。

已有兼容 route 可以继续存在，但 contract source 仍只有一份。未发布 operation 不为了内部改名保留 alias。

### Selective Upstream Adoption

OpenCode 只提供候选 fix 与功能来源。每次选择性 cherry-pick 或手工移植都以 Ellamaka 当前 contract 为边界，评估 package exports、client helpers、OpenAPI operations、request/response/error schema 与 codegen pipeline 的实际影响。Ellamaka 已发布 contract 优先；不相关的上游 surface 不进入本 SDK。

## WopalSpace Remote Projection

当某个 WopalSpace local application operation 需要被 Browser/远程调用方访问时，Ellamaka 定义对应 HTTP resource，handler 调用 `@wopal/wopalspace-sdk`：

```text
remote caller
  → @wopal/ellamaka-sdk
  → Ellamaka HttpApi handler
  → @wopal/wopalspace-sdk operation
```

HTTP DTO 应与 local contract 在语义上等价；transport 特有字段只存在于 HTTP 层。契约测试用 `@wopal/wopalspace-sdk` 的 JSON Schema/operation fixtures 验证共享 DTO 的等价性，而不是手工维护两套业务规则。

产品安装/更新等 trusted-local mutation 不因为存在 local SDK 就自动进入 HTTP surface；是否暴露必须由 Runtime API 设计明确授权。

## Contract Gates

SDK 或 PublicApi 变更至少通过以下门禁：

1. source schema → OpenAPI 3.1 export 成功；
2. `operationId` 唯一且稳定；
3. OpenAPI snapshot 与生成 SDK 同一轮生成，无 dirty drift；
4. `/doc` 与发布 snapshot canonical digest 一致；
5. required / nullable / media type / auth / error response 没有在 codegen 中丢失；
6. generated client 对成功与拒绝路径做真实调用验证；
7. `npm pack` 后在 source tree 外 clean-install，能解析 client、types 与 `openapi.json`；
8. Ellamaka build/start/release 在没有 Wopal CLI 与任何 Wopal CLI schema package 时完成；
9. Ellamaka 品牌 API 与 OpenCode 命名兼容 alias 指向同一 generated client/helper 实现；npm clean-install smoke 同时验证 canonical imports 与 compatibility imports。
