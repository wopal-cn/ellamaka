# Authentication

> **Status**: Draft
> **Updated**: 2026-10-13
> **Parent**: `./DESIGN.md`
> **Scope**: Phase 3 Ellamaka Serve / Workbench / WopalSpace / DSH 认证统一方向；不属于当前阶段实施范围

## Purpose

当前 Ellamaka 主 API 使用可选 Basic Auth，DSH Web 使用自己的 browser-auth：launch token 换取 signed HttpOnly cookie，并叠加 Host/Origin fence。

Phase 3 的目标不是建设复杂 IAM，而是把用户体验和信任入口统一成：

> **一个 Ellamaka Server，一个登录入口；内部允许 Ellamaka Host Session 与 DSH Session 各自保留。**

本阶段不实现本文，只保留目标方向，避免当前重构锁死未来认证结构。

## Current Safety Baseline

当前必须继续保持：

- 默认监听 loopback；
- 配置 Server password 后 Runtime/Workbench API 必须认证；
- Onboarding/WopalSpace 目标态复用同一 Server auth，不再维护独立认证；
- DSH `/dsh` mount 明确使用自己的完整 browser-auth，不把绕过 Host middleware 误当作“无认证”；
- DSH tokenless index 请求被拒绝；
- DSH browser session 使用 signed HttpOnly cookie 与 Host/Origin fence；
- PTY 等特殊连接可以继续使用窄用途、短时 capability token。

当前阶段不建设 Space/Ontology/resource 级细粒度授权。持有有效 Server credential 的调用方视为该 host 的受信管理者。

## Target Host Auth

Phase 3 将 Ellamaka 主浏览器认证改成与 DSH 类似的模式：

```text
long-lived server credential
        │
        ├─ local launch -> short-lived opaque launch token
        │                    │
        │                    ▼
        │              /workbench?token=...
        │                    │ exchange once
        │                    ▼
        │            signed HttpOnly host cookie
        │                    │
        └─ manual login ─────┘
```

真实 Server password 不再直接放进 Workbench URL。

`ELLAMAKA_SERVER_PASSWORD` 可以继续作为长期 root credential，用于人工登录或 automation；Browser 日常请求使用 Host session cookie。

## DSH Single Sign-On Bridge

不要求 Ellamaka 与 DSH 强行共用同一枚 cookie。

推荐流程：

```text
Browser already owns Ellamaka Host session
        │
        ▼
GET /workbench/dsh-url
        │ Host Auth verifies caller
        ▼
request short-lived DSH launch token
        │
        ▼
/dsh/?token=...
        │
        ▼
official DSH BrowserAuth
        │
        ▼
DSH signed cookie
```

用户只登录 Ellamaka 一次；DSH 继续使用它自己的成熟 BrowserAuth session，不要求共享 signing secret，也不修改 DSH 上游认证协议。

## Network Trust

Host Auth 与 DSH 应从同一份 Server network trust 配置派生可接受的 Host/Origin，而不是维护多套 `trustedHosts` 设置。

Cookie-based mutation 至少依赖：

- `SameSite=Strict`；
- Host validation；
- Origin validation；
- 仅受信来源可以发起状态修改请求。

这部分同时承担 CSRF 防护，不能只依赖“cookie 已签名”。

## Exposure Defaults

Phase 3 倾向采用更稳健的默认策略：

```text
loopback + no password        -> allowed
non-loopback + valid auth     -> allowed
non-loopback + no password    -> rejected by default
```

如果未来确实需要无认证网络监听，应要求显式 insecure opt-in，而不是只打印警告后继续。

## Security Regression Focus

Phase 3 至少验证：

- password 不出现在 browser URL/history；
- launch token 短时且不可无限 replay；
- forged/expired Host session 被拒绝；
- forged DSH token/cookie 被拒绝；
- untrusted Host/Origin 的 HTTP/WebSocket 请求被拒绝；
- `/workbench/dsh-url` 只能由已认证 Host session 获取；
- static UI 可以公开加载，但任何带服务端状态的 API 都保持认证边界。

## Out of Scope

本文暂不设计：

- 用户/组织/角色系统；
- Space/Ontology ACL；
- policy DSL；
- OAuth/OIDC identity federation；
- 多租户隔离；
- DSH BrowserAuth 内部协议重写。

## Invariants

1. Phase 3 的目标是统一登录入口和 Host trust，不是强制所有子引擎共享同一个 cookie。
2. DSH 保留官方 BrowserAuth；Ellamaka 通过受保护的 launch-token bridge 实现单登录体验。
3. 真实长期 password 不进入 Workbench URL。
4. 非 loopback 暴露必须有明确认证或显式 insecure opt-in。
5. Cookie auth 必须与 Host/Origin fence 一起使用。
