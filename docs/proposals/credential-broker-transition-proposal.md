# Credential Broker 与 Secretless Workspace 后续提案

> **Status**: Draft / Research Proposal
> **Updated**: 2026-10-30
> **Authority**: 本文描述 #263 之后的下一版安全方向，不改变当前 Active DESIGN 的 `.env` 与环境变量兼容契约。
> **Design Sources**: `../DESIGN.md`、`../DESIGN-desktop.md`、`../DESIGN-dsh-base.md`、`../DESIGN-dsh-web.md`、`../DESIGN-ellamaka-tools.md`
> **Research References**: Infisical Agent Vault、Infisical、OpenBao、平台原生 credential stores

## Proposal Goal

下一版把 Agent 使用凭据的模型从“把 Secret value 放进 workspace 文件或通用进程环境”逐步提升为“Agent 获得受控 capability，真实凭据由 Credential Broker 在实际使用边界处理”。

目标不是为 Ellamaka 自造一套密码库，而是定义稳定的 Broker contract，使本地系统凭据库、团队 Secret 平台和动态凭据服务都能作为后端。

## Current Compatibility Baseline

当前版本继续支持现有工作方式：

- `$WOPAL_HOME/.env` 与 Space `.wopal/.env` 保持既有用途和优先级。
- Desktop #263 默认以 `inherit` 模式恢复完整 Host Environment，使现有 shell export、CLI 与 SDK 继续工作。
- 用户可主动切换 Desktop `allowlist` 模式，限制从 login shell 额外导入的变量。
- Ellamaka 不根据 `TOKEN`、`SECRET`、`KEY` 等名称猜测用户 Secret，也不在 #263 中新增统一 child-env scrubber。
- DSH Web/Tools 继续使用 DSH 官方 `scrubbedParentEnv()` child policy；Native Runtime 保持自己的既有环境契约。

因此 Broker 是兼容能力之上的下一步，不是 #263 的前置条件。

## Problem

明文 `.env` 与长期 Secret 环境变量的共同问题，是 Secret value 与 Agent 可执行环境处在同一可读边界。只要 Agent 可以读取文件、打印环境或运行任意脚本，就无法同时保证“真实 Secret 作为普通变量可读”和“Agent 永远看不到真实 Secret”。

沙箱可以减少文件与网络访问面，但无法可靠判断任意文件是否含敏感信息，也无法通过变量名穷举所有 Secret。后续设计因此把重点从“识别并隐藏 Secret 文件/变量”转向“避免把真实 Secret value 交给通用 Agent 环境”。

## Target Architecture Direction

```text
WopalSpace / project configuration
        │
        │ credential reference / service capability
        ▼
Ellamaka Credential Broker contract
        │
        ├── local native credential store
        ├── Infisical / team vault adapter
        ├── OpenBao / dynamic credential adapter
        └── other provider adapters
        │
        ▼
real credential value
        │
        ├── HTTP(S) request injection / proxy
        ├── signing / ssh-agent style operation
        ├── short-lived cloud or database credential
        └── narrowly scoped compatibility injection
                │
                ▼
          target service / child

Agent / PTY sees capability metadata, broker session facts or dummy credentials,
not the long-lived Secret value whenever the target protocol permits it.
```

## Broker Contract

Ellamaka 拥有与 provider 无关的 Credential Broker contract，而不是绑定某一个第三方产品。上层按“要使用什么能力”请求 Broker；底层 provider 决定真实凭据存储、刷新与注入方式。

第一版 contract 重点覆盖：

- service identity：目标服务/host 与 credential reference；
- capability scope：允许的服务和必要的路径/操作范围；
- session lifetime：短期 broker session，随 Agent/PTY 生命周期释放；
- audit facts：只记录 capability 使用结果与非敏感身份，不记录 Secret value；
- provider boundary：本地凭据库、Infisical/OpenBao 等后端互不泄漏实现细节给 Agent。

不提供通用的 Agent-facing `getSecretValue()` 接口。必须以明文环境变量工作的旧程序走明确的 compatibility path，并把注入范围限制在实际需要该值的 child 生命周期内。

## Infisical Agent Vault Reference

Infisical Agent Vault 值得作为首个参考实现和可选 provider，因为它已经验证了“dummy credential + HTTP(S) proxy + 最后一刻真实 credential 注入”的 Agent 使用模型，并覆盖常见 HTTP 客户端、CLI 与 SDK。

它同时说明 Broker 本身不能代替隔离：同一宿主上的 cooperative proxy 无法阻止具备任意网络执行能力的 Agent 绕过代理。Ellamaka 因此不把 Agent Vault 的具体实现当成产品安全模型，而是把它作为协议、能力授权和部署模式的研究基线。

## Security Levels

后续实现对安全保证使用显式等级，而不是笼统声明“Agent 看不到 Secret”：

| 等级            | 运行形态                                              | 保证重点                                                               |
| --------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| Brokered        | Agent 不持有长期 Secret，标准客户端经 Broker 使用凭据 | 防止普通 env/file 读取、日志与上下文误泄漏；不承诺阻止主动绕过网络代理 |
| Enforced Egress | Agent sandbox 的网络出口只能到 Broker/允许目标        | 在 Brokered 基础上限制 raw socket / direct egress                      |
| Remote Broker   | Broker/Vault 位于独立安全域                           | Agent 主机不持有长期 Secret，安全边界最强                              |

平台实现可以选择达到的等级；产品 UI 和诊断必须表达实际等级，而不是把 cooperative host 模式描述成强隔离。

## Shell and PTY Integration

Broker 接入沿用已有执行 seam，而不是修改 Host Environment 的事实模型：

```text
Host Environment
      │
      ▼
Native / DSH execution environment
      │
      ├── normal non-secret environment
      └── broker bootstrap overlay
             ├── proxy endpoint
             ├── CA / transport facts
             ├── short-lived capability/session token
             └── dummy credential names when required
```

Ellamaka Native 的 `shell.env` Hook 可以成为 per-execution broker bootstrap 的一个接入点。DSH 使用自身 `shell-env` / subprocess contract；Bridge 只在正式 contract 允许的位置注入 Broker 所需的显式 env，不绕过 DSH 的 child-env owner。

Browser Terminal、Native PTY、Agent shell、MCP、LSP 与 DSH Tools 不强制共享一种 transport。HTTP credential、SSH/signing、cloud identity、database dynamic credential 可以分别采用适合协议的 Broker backend。

## Workspace Secret Representation

目标状态下，WopalSpace 管理的配置只保存非敏感 credential reference 和 capability 描述，例如：

```yaml
credentials:
  github:
    ref: github.default
    service: github
  openai:
    ref: openai.dev
    service: openai
```

Agent 可以读取这些引用；真实值由选定 provider 保存。用户项目自己拥有的 `.env` 仍属于项目文件，Ellamaka 不擅自删除或改写。

## Compatibility Transition

Broker 以并行能力加入，不要求一次切断现有 `.env`：

1. Broker contract 与一个可验证 provider 先落地，现有 `.env` / environment 路径继续可用。
2. Wopal 管理的 credential 可以选择保存为 broker reference；同一能力提供显式导入工具，把已有值写入选定 Secret Store 后只留下 reference。
3. 常见 HTTP/CLI 场景优先使用 Broker；无法无明文运行的程序继续走窄范围 compatibility injection。
4. 当主流凭据类型均有 Broker 路径后，再评估 Wopal 自己是否仍需要以 `.env` 作为默认 Secret storage。

每一步都必须允许用户继续运行尚未适配的工具，不能以安全升级为由破坏现有开发环境。

## Relationship to Issue #263

#263 只建立 Broker 未来需要的干净上游边界：

- Desktop 每次运行只解析一份 Host Environment；
- Host Environment 显式进入 sidecar；
- Native 与 DSH 共享共同父环境，但保留各自 child-env owner；
- 默认完整继承，用户可选 allowlist；
- 完整 Host Environment 不持久化、不进入日志。

#263 不实现 Broker、Secret Store、`.env` 导入工具、网络出口控制或 Secretless Workspace 默认策略。

## Suggested Next-Version Slice

下一版建议先做一个可验证但范围有限的切片：

1. 定义 provider-neutral Credential Broker contract。
2. 选择一个本地/开源 provider 做 PoC；Infisical Agent Vault 是首选研究对象之一。
3. 先覆盖 GitHub 或另一个标准 HTTPS credential 场景。
4. 验证 Agent/PTY 中只能看到 dummy/capability，而 `gh` / HTTP 客户端仍可正常认证。
5. 验证 broker session 生命周期、日志脱敏和失败行为。
6. 在 PoC 证明模型成立后，再决定 native credential store、团队 Vault、强制 egress 和 `.env` transition 的产品范围。

## Decision Gates

进入正式 DESIGN 前需要产品层确认：

- 首个支持的 credential/service 类型；
- 本地 Desktop 对 Brokered / Enforced Egress 两个等级分别承诺什么；
- 本地 Secret Store 首选平台原生凭据库还是随 provider 管理；
- Wopal 管理的 `.env` 何时从“默认方式”转为“兼容方式”；
- Browser Terminal 是否也默认启用 broker bootstrap，还是只对 Agent execution 开启。

这些决策独立于 #263，可以在当前环境修复稳定后进入下一轮正式设计。
