# Gateway Responses 客户端与双引擎统一接入

Status: proposed

- **Class**: architecture
- **Created**: 2026-11-27

## Problem

WopalSpace 的模型接入方向已经确定：所有上游渠道、协议转换和能力门禁都放在 Wopal Gateway，Gateway 对外提供标准 OpenAI Responses 接口，并持续跟进最新规范。Ellamaka 的两个引擎（原生 Runtime 与 DSH）只需要连 Gateway。现状离这个目标有两处差距。

**协议实现落后，而且不在自己手里。** 原生 Runtime 的生产路径是 AI SDK `streamText()`（[llm.ts](../../../../packages/opencode/src/session/llm.ts)），Responses 协议由 `@ai-sdk/openai` 3.0.53 实现（[package.json](../../../../packages/opencode/package.json)）。这个版本缺少一批新的请求字段和 Item 类型，例如 `context_management`、`prompt_cache_retention`、`safety_identifier`、`input_file`、`custom_tool_call`、`compaction`、`additional_tools`。v3 尾线 3.0.147 只补了一部分；`additional_tools` 等新类型只在 4.x 里有，而 4.x 要求 `ai` v7，等于整个 Runtime 跟着迁移。DSH 一侧用 pi-ai 的 `openai-responses`，同样要等第三方跟进。Gateway 每支持一个新能力，两个引擎都要等别人的库更新才能用上。

**配置要写两份，而且两份已经不一致。** 原生 Runtime 在 `$WOPAL_HOME/config/settings.jsonc` 手写了 `wopal-gateway` provider 和 15 个模型条目，包括上下文窗口、输入模态、推理档位，还有 `enable_thinking` 这类渠道私有字段。DSH Web profile 在 `cordis.patch.yml` 手写了另一份 `llm-pi-ai` 配置，35 个模型，地址还指着测试端口。Gateway 每加一个模型，两边都要手工跟着改。

## Proposal

整体思路：Gateway 是唯一的模型事实源，Ellamaka 自己维护一个薄的 Responses 协议客户端，两个引擎共用这个客户端和同一份连接配置。

```text
$WOPAL_HOME/config/settings.jsonc
  wopal.gateway.baseURL ──┐        （远程 Gateway 的凭据在 auth.json）
                          ▼
            @wopal/gateway-client（共享协议包）
              ├─ 基于官方 openai SDK 的 Responses 类型
              ├─ 请求组装 / SSE 解析 / 模型目录读取
              ├─ AI SDK 适配：LanguageModelV3 provider ──▶ 原生 Runtime streamText()
              └─ DSH 适配：LlmAdapter 插件 ──────────────▶ DSH Web profile
                          │
                          ▼
            Wopal Gateway  GET /v1/models · POST /v1/responses
```

### 1. 共享协议包 `@wopal/gateway-client`

在 Ellamaka monorepo 新建 `packages/gateway-client`，只负责“跟 Gateway 说 Responses 协议”，不依赖 AI SDK，也不依赖 DSH：

- **类型直接用官方 `openai` SDK 的 Responses 定义。** 请求体、Item、SSE 事件的类型由 OpenAI 自己维护，跟进新规范只需要升级这个依赖。HTTP 发送和 SSE 解析可以用官方 SDK 的客户端，也可以只借用类型、自己发 `fetch`，实施时按包体积和 Bun 兼容性选定。
- **输出统一的内部事件流**：文本、推理、工具调用参数流、usage、结束原因、错误，每个事件带 Responses 的 item ID 和 output index，供两个适配层各自转换。
- **原样保留不认识的内容。** 请求侧允许调用方附带额外的 Responses 字段，原样合并进请求体；响应侧遇到适配层不认识的 Item 或事件时原样保留，不丢弃。Gateway 支持了某个新能力而引擎还没用上时，这部分数据仍能完整往返。
- **模型目录**：读取 Gateway `/v1/models` 的 `wopal` 扩展（由 [Gateway 客户端模型目录提案](../../../../../wopal-gateway/docs/proposals/proposed/feature/2026-11-27-client-model-catalog.md)定义），转换成上下文窗口、最大输出、输入模态和推理档位。
- **推理档位只发标准 `reasoning.effort`**，不再发送 `enable_thinking` 等渠道私有字段；映射由 Gateway 负责。
- **测试用 Gateway 发布的协议样本。** 请求样本检查组装结果，响应样本回放检查事件解析；客户端声明自己对应的样本版本号。

### 2. 原生 Runtime 接入

内置一个 `wopal` provider，用 `@wopal/gateway-client` 实现 AI SDK 的 `LanguageModelV3` 接口（当前 `ai` 6.0.168 使用的 provider 规范）。`streamText()`、工具循环、telemetry 和 Session 处理都不动，变化只在 provider 这一层。provider 实现放在新文件里，对上游的 [provider.ts](../../../../packages/opencode/src/provider/provider.ts) 只加最少的注册和调用入口。

- **请求**：把 AI SDK 的 prompt 转成 Responses input items，工具定义转成 function tools。System prompt 的放法（`instructions` 还是 developer message）以 Gateway 协议样本为准，并与 [Prompt 缓存稳定性提案](./2026-11-25-prompt-cache-stability.md)的分层前缀兼容。
- **响应**：把内部事件转成 AI SDK 流事件（text / reasoning / tool-input / tool-call / finish）。加密 reasoning 和 item ID 放进 provider metadata，下一轮请求时原样回放。
- **模型目录**：provider 启动时调用 `/v1/models` 生成模型列表。`provider.ts` 的 `discoverModels` 钩子目前只对 `gitlab` 生效，这次改成对 `wopal` 也生效。Gateway 不可达时，provider 显示为不可用并给出明确原因，不回退到旧配置。
- **用户覆盖**：`provider.wopal` 下手写的模型条目仍按现有合并规则覆盖目录值，只用于个别调整，不再需要整份清单。
- **其他 provider 不受影响**：从上游继承的 provider 和 `@ai-sdk/*` 依赖保持原样；用户手写的 `wopal-gateway` 旧配置继续可用，由用户决定何时删掉。原生 `packages/llm` 路径不在本提案范围内。

### 3. 统一配置

全局 `settings.jsonc` 只需要一项：

```jsonc
{
  "wopal": {
    "gateway": { "baseURL": "http://127.0.0.1:11435/v1" }
  }
}
```

- `baseURL` 是两个引擎共用的唯一连接配置，归 `@wopal/wopalspace` 的产品设置模块所有，跟 `wopal.dsh.web.enabled` 走同一套读写和保护规则。
- 本机回环的 Gateway 不需要凭据。远程 Gateway 需要的 key 按现有规则存进 `$WOPAL_HOME/ellamaka/data/auth.json`（provider ID 为 `wopal`），不写进 `settings.jsonc`。
- 改 `baseURL` 后两个引擎都要重新加载才生效，标为 `restart-required`。

### 4. DSH 接入

**DSH 的 Gateway 配置由 Ellamaka 注入，用户不再手写。** 加载 Web profile 时，Ellamaka 把 Gateway provider 作为内置配置层注入内存，复用 `ellamaka-tools` 现有的 `builtinLayers` 机制（[dsh-web.ts](../../../../packages/ellamaka-cordis/src/dsh-web.ts)）。用户的 `cordis.patch.yml` 不会被改写，引擎运行时也不会有外部进程写 profile 目录。凭据不出现在任何 DSH 配置文件里，包括 loader 回写的 `cordis.yml`；插件运行时从 Ellamaka 宿主拿凭据。

**DSH 插件 `@wopal/dsh-llm-gateway`** 放在同一 monorepo，基于 `@wopal/gateway-client` 实现 DSH 的 `LlmAdapter`，随 Ellamaka 产品闭包一起分发，不单独发布：

- `listModels()` 和 `resolveModel()` 读 Gateway 模型目录，提供模型、输入模态、上下文窗口和推理档位；
- `stream()` 把共享事件流转成 DSH 的 `StreamChunk`，保持工具、reasoning 回放、取消和错误语义；
- 使用独立的 provider route 和 settings 命名空间，不跟用户自己配的其他 DSH provider 冲突。

过渡期：插件交付之前，内置配置层先生成 `llm-pi-ai` 的 `openai-responses` provider 指向 Gateway，模型列表由 pi-ai 读 `/models` 自动发现。用户手写的 `gw-test` 等旧配置保持原样，由用户决定是否删除。

[Gateway 侧的 DSH 插件提案](../../../../../wopal-gateway/docs/proposals/proposed/architecture/2026-11-11-dsh-provider-plugin.md)中「DSH 插件」一节由本提案接管：Ellamaka 负责装配 DSH profile，插件和装配放在同一处维护。该提案的 Devin Proxy 部分不受影响。

### 交付顺序

四部分有依赖关系，可以分段验收：

1. 共享协议包，加上原生 Runtime 的 `wopal` provider（依赖 Gateway 模型目录提案的 `/v1/models` 扩展和协议样本）；
2. 统一配置，以及 DSH 内置配置层的过渡版本（先用 pi-ai）；
3. DSH 插件替换过渡版本。

## Alternatives considered

- **把 `@ai-sdk/openai` 升到 3.0.147** — 只改一行版本号，但只补了一部分字段，`additional_tools` 等新类型仍然缺失。协议节奏还是跟着 AI SDK v3 尾线走，配置重复的问题也没解决。可以作为本提案交付前的临时维护，不能当作方向。
- **升级到 `ai` v7 加 `@ai-sdk/openai` 4.x** — 能拿到最新字段，但要迁移整个原生 Runtime 的 AI SDK 调用面，改动远超 provider 层。之后跟进规范仍然要等 AI SDK 发版。
- **原生 Runtime 改用 pi-ai** — 两个引擎能用同一个库，但仍要等第三方跟进新规范。pi-ai 自带 Anthropic、Bedrock、Google 等多个 SDK，约 55MB，要求 Node ≥ 22.19；事件模型需要再适配一层，system prompt 和工具的部分字段会丢失。
- **把 provider 放进 `ellamaka-tools` 容器，由 DSH 统一提供** — 要拉入 settings、credentials、authorization 等七个以上的服务，破坏[工具容器](../../../DESIGN-ellamaka-tools.md)无持久 Session 的契约；agent loop 在容器外，每次模型调用都要跨 Cordis 边界。
- **基于原生 `packages/llm` 的 Responses 实现继续开发** — 954 行单文件，落后上游 9822 个提交，且没有可行的合并路径。它只服务未开启的原生路径，要接到生产路径上，就得同时替换 `streamText()`。
- **DSH 继续由用户手写 `cordis.patch.yml`** — 不需要任何开发，但两份配置的重复和漂移一直存在，跟“只配一次”的目标冲突。

## Acceptance criteria

1. 只配置 `wopal.gateway.baseURL`（回环、无凭据）且没有任何手写模型条目时，原生 Runtime 能列出 Gateway 的全部模型，上下文窗口、输入模态和推理档位与 `/v1/models` 一致。
2. 经 `wopal` provider 的对话完成以下回归：纯文本、多轮回放、并行工具调用、读写文件工具、子 agent、图片输入、切换推理档位、跨轮加密 reasoning 回放、中途取消；发给 Gateway 的请求里没有渠道私有字段。
3. `@wopal/gateway-client` 通过 Gateway 当前版本的全部请求样本和响应样本测试；Gateway 样本版本号变化而客户端未更新时，测试明确失败。
4. 请求附带一个适配层不认识的 Responses 字段时，该字段原样出现在发给 Gateway 的请求体里；响应包含不认识的 Item 时，Item 被保留、不报错。
5. DSH Web profile 在没有手写 provider 配置时能看到并使用 Gateway 模型；用户的 `cordis.patch.yml` 没有被改写；DSH 的任何配置文件和 `cordis.yml` 里都没有凭据。
6. 修改 `wopal.gateway.baseURL` 并重新加载后，两个引擎都连到新地址。
7. 其他 provider（含用户手写的 `wopal-gateway` 旧配置）行为不变，现有 provider 测试全部通过。
8. 交付时同步更新 `DESIGN.md` 的 Provider 章节，以及 DSH Web 相关的现状 DESIGN。

## Risks

- **AI SDK 适配层需要自己维护。** `LanguageModelV3` 的流事件、usage 和 provider metadata 有不少细节，例如工具输入流和 reasoning 的分段规则。写错会直接影响 Agent 稳定性。缓解办法：用 Gateway 协议样本加真实 Session 回放做回归，切换前保留旧的 `wopal-gateway` 配置作为退路。
- **引擎内部还用不上部分新能力。** 协议客户端能让新字段和新 Item 完整往返，但 custom tool、compaction 这类引擎没有对应概念的能力，要让 Agent 真正用起来，需要另外做引擎层设计。本提案只保证“传得过去、拿得回来”。
- **完全依赖 Gateway 可用。** Gateway 不可达时，`wopal` provider 没有任何模型可用。这是“Gateway 唯一入口”的直接代价；本机回环部署下风险较低，远程部署需要用户自己保证 Gateway 可用。
- **DSH 插件跟随 DSH 版本。** `LlmAdapter`、`StreamChunk` 的契约以 Ellamaka 锁定的 `@deepseek-ai/dsh` 版本为准，升级 DSH 时插件要一起验证。
- **官方 `openai` SDK 的大版本升级。** 类型来自官方 SDK，大版本升级可能带来类型的破坏性变化。升级节奏由 Gateway 协议样本的版本号驱动，不追着官方每个版本走。
