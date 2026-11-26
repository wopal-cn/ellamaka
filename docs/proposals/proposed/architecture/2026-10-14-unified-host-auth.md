# Unified Host Authentication and DSH Single Sign-On Bridge

Status: proposed

- **Class**: architecture
- **Created**: 2026-10-14

## Problem

当前 Ellamaka 主 API 与 Workbench 使用可选 Basic Auth，而内嵌的 DSH Web 使用自己的 browser-auth（launch token 换取签名 HttpOnly cookie，叠加 Host/Origin 校验）。随着 Workbench、Onboarding 与远程访问场景增多，现有认证方式存在三处短板：

1. 本地启动或携带凭证连接 Workbench 时，存在长期 Server password 暴露在 URL 或浏览器历史中的风险；
2. Ellamaka 主入口与内嵌 DSH 缺乏统一的“单次登录、一次信任配置”桥接；
3. 主 Server 监听地址从 loopback 扩展到非回环网络地址时，缺少“未配密码默认拒绝访问”的强安全默认策略，且 `trustedHosts` 等网络信任配置尚未在 Host 与 DSH 之间统一收口。

## Proposal

在保持当前已生效认证安全基线（参见 [DESIGN.md](../../../DESIGN.md)）的基础上，在 Phase 3 将 Ellamaka 主浏览器认证统一为“一个 Ellamaka Server，一个登录入口；内部保留 Ellamaka Host Session 与 DSH Session 各自独立的凭证域”：

1. **Target Host Auth**：用短时一次性的 opaque launch token（`/workbench?token=...` 一次性换取签名 HttpOnly Host cookie）或人工登录表单替代 URL 中的长期密码；`ELLAMAKA_SERVER_PASSWORD` 继续作为长期 root credential 供人工登录与自动化调用使用，浏览器日常请求使用 Host session cookie。
2. **DSH Single Sign-On Bridge**：用户登录 Ellamaka 一次后，Browser 持已认证的 Host session 调用受保护的 `GET /workbench/dsh-url`，由后端向 DSH 申请短时 launch token（`/dsh/?token=...`），再交由 DSH 官方 BrowserAuth 换取 DSH 签名 cookie，实现无感单点登录且不篡改 DSH 上游协议。
3. **统一 Network Trust 与 CSRF 防护**：Host Auth 与 DSH 从同一份 Server network trust 配置派生可接受的 Host/Origin；基于 cookie 的状态变更请求强制叠加 `SameSite=Strict`、Host validation 与 Origin validation。
4. **收紧非回环暴露默认策略**：保持 `loopback + 无密码` 允许、`non-loopback + 有效认证` 允许，并将 `non-loopback + 无密码` 改为默认拒绝（仅允许显式 insecure opt-in，而非仅打印警告）。

## Scope Exclusions

本提案明确不设计用户/组织/角色系统、Space/Ontology 级细粒度 ACL、policy DSL、OAuth/OIDC 联合登录、多租户隔离，也不重写 DSH BrowserAuth 内部协议。

## Alternatives considered

- **强制 Ellamaka 与 DSH 共享同一枚签名 Cookie 与 signing secret**：会迫使修改 DSH 上游认证中间件与签名校验协议，耦合两个独立引擎的安全生命周期，因此不采用。
- **继续沿用 URL 参数传递密码或长期静态 Basic Auth**：长期密码会泄漏在浏览器历史、书签或日志中，且无法为浏览器会话提供可吊销、可限定 Origin/Host 的现代 cookie 边界，因此被淘汰。
- **在本次架构中直接引入完整多用户 RBAC 与 Space/Ontology 细粒度 IAM**：与当前单机/可信管理者宿主定位不匹配，会大幅推高实施与维护复杂度，因此明确排除。

## Acceptance criteria

1. **长期密码不入浏览器 URL**：自动化与端到端测试验证本地启动和登录流程中，长期 Server password 不出现在浏览器 URL 与历史记录中。
2. **Launch Token 不可重放**：Host 与 DSH 的 launch token 均具备短时有效期且一次性消费，过期或重放请求被拒绝。
3. **伪造凭据与跨站拦截**：伪造或过期的 Host cookie、DSH cookie，以及未经信任的 Host/Origin 发起的 HTTP/WebSocket 变更请求均被拒绝；未认证请求无法访问 `/workbench/dsh-url` 或任何带服务端状态的 API（仅静态 UI 资产可公开加载）。
4. **暴露默认策略收紧**：非 loopback 绑定且未配置密码时默认拒绝启动或拒绝服务，除非显式声明 insecure opt-in。

## Risks

- **自动化工具与既有脚本兼容成本**：引入强制 cookie + Host/Origin 校验以及收紧非回环默认策略后，依赖旧无密码局域网监听或裸 HTTP 调用的脚本需要切换为显式认证头或 opt-in 开关。
- **前端与开发环境代理配置复杂度**：开发态跨域端口下 `SameSite=Strict` cookie 与 Origin/Host 对齐要求严格，若 Vite 代理配置与生产路径不一致容易引发间歇性 401/403。

## Reference Documents

- [Ellamaka Architecture DESIGN](../../../DESIGN.md)
- [Ellamaka SDK DESIGN](../../../DESIGN-ellamaka-sdk.md)
- [Onboarding and Setup DESIGN](../../../DESIGN-onboarding.md)
- [WopalSpace Application Domain DESIGN](../../../DESIGN-wopalspace.md)
