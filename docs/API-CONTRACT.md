# Ellamaka API 与 SDK 规则

> **Status**: Active
> **Updated**: 2026-10-10
> **Parent Architecture**: `./DESIGN.md`

## Single Source

服务的端点、参数、请求与响应 schema、状态码、鉴权声明、operationId 和说明，统一由领域 Effect Schema 与 HttpApiGroup 定义，经 PublicApi 生成 OpenAPI 3.1。本文只承载长期通用规则，不维护逐个端点清单。API 详情使用生成规范及其文档视图。

```text
领域 schema + HttpApiGroup + OpenAPI metadata
  → PublicApi
  → OpenAPI 3.1 JSON
  → SDK 类型/客户端 + API 文档与调试工具
```

## Publication

运行中服务的 `/doc` 返回本服务的实际契约。同一生成链保存 `packages/sdk/openapi.json`，作为对应产品/SDK版本的发布快照；SDK生成和文档视图消费同一结果。快照不手改，发布记录包含产品/SDK版本及规范摘要。静态导出不启动 DSH、不准备 Home、不请求模型。

已有 `scripts/scalar-doc.ts` 可渲染生成规范；服务地址与鉴权由实际连接提供。实现自动校验生成快照、SDK和服务契约一致，不新增另一套手工 YAML 或 DTO。

## Scope and Naming

Root 管理能力先于空间、DSH 与模型就绪；Instance 能力要求明确的工作目录与授权上下文。鉴权与资源授权由服务端执行，路径前缀不构成安全边界。

本轮新增的 WopalSpace 管理命名空间为 `/wopalspace`，新 operationId/local SDK 分组为 `wopalspace`。已发布的 `/wopal-space`、`/workbench/spaces` 和 `/experimental/workspace` 资源继续保持兼容；实验工作目录与 WopalSpace 注册资源各有语义，不做批量名称替换。

onboarding 页面位于 `/onboarding`，其现有网络接口前缀为 `/api/onboarding`。该前缀区分页面与接口，并供开发代理路由；既有客户端、代理与挂载使用同一路径。它不代表鉴权、远程能力或 API 版本。

## SDK and Local Services

统一包为 `@wopal/ellamaka-sdk`。HTTP 客户端由 OpenAPI 生成，保留既有客户端入口和 data/error 包装；本地入口 `/local` 调用同一业务服务，提供 Node/Bun 可用的本地管理能力。业务 DTO 与校验规则同源，CLI 的 machine envelope 仍由 CLI 拥有。

local 进度回调和 AbortSignal 是执行选项，不放进 HTTP JSON。HTTP 进度与取消使用现有 SSE/取消机制。需要真实引擎的 Session、工具与能力发现不能由 local 入口伪造。安装 Ellamaka 制品由外部安装渠道负责。

## Behavioral Rules

服务 Home 在启动时固定；远程操作作用于服务器机器。请求不能切换服务 Home、产品固定的 DSH 版本或执行程序路径。秘密不回显，不进入可读规范示例。

只读探测不物化资源。重复准备复用已有结果；取消或失败不报告完成。同一 Home 的管理写操作共享互斥，沿用现有进度/取消机制。领域服务校验身份、路径范围和输入，handler 只做传输适配。

声明准确的 required、nullable、响应媒体类型、鉴权与领域错误。既有 SDK 兼容变换保持已发布契约，但不能静默删掉新端点的必填/可空/鉴权语义。新增端点经过真实客户端调用和拒绝路径验收。

## Evolution and Delivery

新增可选字段和资源维持兼容；删除、改名、类型或语义变化按产品版本策略提供明确迁移窗口。未发布的新端点在计划阶段确定名字，不为放弃的名字增加别名。

公开 OpenAPI 和发布 SDK 只包含真实交付的能力。阶段 3 Config Engine、阶段 4 Plan Scheduler 的提案不作为当前公开端点，也不生成占位方法。未来阶段的草案保存在其对应设计/Plan。

新能力的业务意图和验收写在对应设计/Plan；实施时将精确 HTTP 契约落到 schema，重新导出规范和 SDK，并审阅生成差异。只有分层、权限、版本或业务语义发生变化时更新本文，普通端点添加不要求维护 Markdown 清单。
