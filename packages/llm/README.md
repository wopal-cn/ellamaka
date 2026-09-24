# @wopal/llm

Schema-first LLM core for opencode. One typed request, response, event, and tool language; provider quirks live in adapters, not in calling code.

```ts
import { Effect } from "effect"
import { LLM, LLMClient } from "@wopal/llm"
import { OpenAI } from "@wopal/llm/providers"

const model = OpenAI.configure({ apiKey: process.env.OPENAI_API_KEY }).responses("gpt-4o-mini")

const request = LLM.request({
  model,
  system: "You are concise.",
  prompt: "Say hello in one short sentence.",
  generation: { maxTokens: 40 },
})

const program = Effect.gen(function* () {
  const response = yield* LLMClient.generate(request)
  console.log(response.text)
})
```

Run `LLMClient.stream(request)` instead of `generate` when you want incremental `LLMEvent`s. The event stream is provider-neutral — same shape across OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini, Bedrock Converse, and any OpenAI-compatible deployment.

## Public API

- **`LLM.request({...})`** — build a provider-neutral `LLMRequest`. Accepts ergonomic inputs (`system: string`, `prompt: string`) that normalize into the canonical Schema classes.
- **`LLM.generate` / `LLM.stream`** — re-exported from `LLMClient` for one-import use.
- **`Message.user(...)` / `Message.assistant(...)` / `Message.tool(...)`** — message constructors from the canonical schema model.
- **`Model.make(...)` / `ToolCallPart.make(...)` / `ToolResultPart.make(...)` / `ToolDefinition.make(...)`** — model and tool-related constructors from the canonical schema model.
- **`LLMClient.prepare(request)`** — compile a request through protocol body construction, validation, and HTTP preparation without sending. Useful for inspection and testing.
- **`LLMEvent.is.*`** — typed guards (`is.textDelta`, `is.toolCall`, `is.finish`, …) for filtering streams.

## Caching

Prompt caching is **on by default**. Every `LLMRequest` resolves to `cache: "auto"` unless the caller opts out with `cache: "none"`. Each protocol translates `CacheHint`s to its wire format (`cache_control` on Anthropic, `cachePoint` on Bedrock; OpenAI and Gemini do implicit caching server-side and don't need inline markers — auto is a no-op there).

### Auto placement

`"auto"` places three breakpoints — last tool definition, last system part, latest user message. The last-user-message boundary is the load-bearing detail: in a tool-use loop, a single user turn expands into many assistant/tool round-trips, all sharing that prefix. Caching at that boundary lets every intra-turn API call hit.

The math justifies the default: Anthropic's 5-minute cache write is 1.25× base, read is 0.1×, so a single reuse within 5 minutes already wins. One-shot completions below the per-model minimum-cacheable-token threshold silently no-op on the wire, so the worst case is harmless.

### Opting out

```ts
LLM.request({
  model,
  system,
  prompt: "one-off question",
  cache: "none",
})
```

### Granular policy

```ts
cache: {
  tools?: boolean,
  system?: boolean,
  messages?: "latest-user-message" | "latest-assistant" | { tail: number },
  ttlSeconds?: number,         // ≥ 3600 → 1h on Anthropic/Bedrock; else 5m
}
```

### Manual hints

Inline `CacheHint` on any text / system / tool / tool-result part overrides automatic placement. The auto policy preserves manual hints; it only fills gaps.

```ts
LLM.request({
  model,
  system: [
    { type: "text", text: "stable system prompt", cache: { type: "ephemeral" } },
  ],
  ...
})
```

### Provider behavior table

| Protocol                | `cache: "auto"`                                                           |
| ----------------------- | ------------------------------------------------------------------------- |
| Anthropic Messages      | emits up to 3 `cache_control` markers (4-breakpoint cap enforced)         |
| Bedrock Converse        | emits up to 3 `cachePoint` blocks (4-breakpoint cap enforced)             |
| OpenAI Chat / Responses | no-op (implicit caching above 1024 tokens)                                |
| Gemini                  | no-op (implicit caching on 2.5+; explicit `CachedContent` is out-of-band) |

Normalized cache usage is read back into `response.usage.cacheReadInputTokens` and `cacheWriteInputTokens` across every provider.

## Providers

Provider facades configure endpoint/auth/deployment details first, then expose model selectors that take only a model or deployment id. The selected model carries the executable route value used at runtime.

```ts
import { OpenAI, CloudflareAIGateway } from "@wopal/llm/providers"

const openai = OpenAI.configure({ apiKey: process.env.OPENAI_API_KEY }).responses("gpt-4o-mini")
const gateway = CloudflareAIGateway.configure({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  gatewayApiKey: process.env.CLOUDFLARE_API_TOKEN,
}).model("workers-ai/@cf/meta/llama-3.1-8b-instruct")
```

Included providers: OpenAI, Anthropic, Google (Gemini), Amazon Bedrock, Azure OpenAI, Cloudflare AI Gateway, Cloudflare Workers AI, GitHub Copilot, OpenRouter, xAI, plus generic OpenAI-compatible helpers for DeepSeek, Cerebras, Groq, Fireworks, Together, etc.

## Provider options & HTTP overlays

Three escape hatches in order of stability:

1. **`generation`** — portable knobs (`maxTokens`, `temperature`, `topP`, `topK`, penalties, seed, stop).
2. **`providerOptions: { <provider>: {...} }`** — typed-at-the-facade provider-specific knobs (OpenAI `promptCacheKey`, Anthropic `thinking`, Gemini `thinkingConfig`, OpenRouter routing).
3. **`http: { body, headers, query }`** — last-resort serializable overlays merged into the final HTTP request. Reach for this only when a stable typed path doesn't yet exist.

Route/provider defaults are overridden by request-level values for each axis.

## Routes

Adding a new model or deployment is usually 5-15 lines using `Route.make({ protocol, endpoint, auth, framing, ... })`. The route owns endpoint/auth/framing and the protocol owns body construction plus stream parsing. Transports are reusable IO templates that receive route endpoint/auth at compile time. Capability/catalog metadata lives outside this low-level package; unsupported request shapes fail during protocol lowering.

### Request Flow

The intended callsite is:

```ts
const request = LLM.request({
  model: OpenAI.configure({ apiKey }).responses("gpt-4o-mini"),
  system: "You are concise.",
  prompt: "Say hello.",
})

const response = yield * LLMClient.generate(request)
```

`LLM.request(...)` builds an `LLMRequest`. `LLMClient.generate(...)` reads the executable route carried by `request.model.route`, builds the provider-native body, asks the route's transport for a real `HttpClientRequest.HttpClientRequest`, sends it through `RequestExecutor.Service`, parses the provider stream into common `LLMEvent`s, and finally returns an `LLMResponse`.

Use `LLMClient.stream(request)` when callers want incremental `LLMEvent`s. Use `LLMClient.generate(request)` when callers want those same events collected into an `LLMResponse`. Use `LLMClient.prepare<Body>(request)` to compile a request through the route pipeline without sending it — the optional `Body` type argument narrows `.body` to the route's native shape (e.g. `prepare<OpenAIChatBody>(...)` returns a `PreparedRequestOf<OpenAIChatBody>`). The runtime body is identical; the generic is a type-level assertion.

Filter or narrow `LLMEvent` streams with `LLMEvent.is.*` (camelCase guards, e.g. `events.filter(LLMEvent.is.toolCall)`). The kebab-case `LLMEvent.guards["tool-call"]` form also works but prefer `is.*` in new code.

### Routes

A route is the registered, runnable composition of four orthogonal pieces:

- **`Protocol`** (`src/route/protocol.ts`) — semantic API contract. Owns request body construction (`body.from`), the body schema (`body.schema`), the streaming-event schema (`stream.event`), and the event-to-`LLMEvent` state machine (`stream.step`). `Route.make(...)` validates and JSON-encodes the body from `body.schema` and decodes frames with `stream.event`. Examples: `OpenAIChat.protocol`, `OpenAIResponses.protocol`, `AnthropicMessages.protocol`, `Gemini.protocol`, `BedrockConverse.protocol`.
- **`Endpoint`** (`src/route/endpoint.ts`) — URL construction. The host, path, and route query live on the endpoint. `Endpoint.path("/chat/completions", { baseURL })` is the common case; pass a function for paths that embed the model id or a body field (e.g. `Endpoint.path(({ body }) => `/model/${body.modelId}/converse-stream`)`).
- **`Auth`** (`src/route/auth.ts`) — per-request transport authentication. Provider facades configure credentials onto the route before model selection, usually via `Auth.bearer(apiKey)` or `Auth.header(name, apiKey)`. Routes that need per-request signing (Bedrock SigV4, future Vertex IAM, Azure AAD) implement `Auth` as a function that signs the body and merges signed headers into the result.
- **`Framing`** (`src/route/framing.ts`) — bytes → frames. SSE (`Framing.sse`) is shared; Bedrock keeps its AWS event-stream framing as a typed `Framing<object>` value alongside its protocol.

Compose them via `Route.make(...)`:

```ts
export const route = Route.make({
  id: "openai-chat",
  provider: "openai",
  protocol: OpenAIChat.protocol,
  endpoint: Endpoint.path("/chat/completions", {
    baseURL: "https://api.openai.com/v1",
  }),
  auth: Auth.bearer(),
  framing: Framing.sse,
})
```

Route defaults are request-shaping defaults such as `headers`, `limits`, `generation`, `providerOptions`, and `http`. Endpoint host/query belongs on the route endpoint. Selected `Model` values carry only model id, provider id, and the configured route value. Model capability/catalog metadata lives outside this package; protocol support is enforced by request lowering and typed `LLMError`s.

The four-axis decomposition is the reason DeepSeek, TogetherAI, Cerebras, Baseten, Fireworks, and DeepInfra all reuse `OpenAIChat.protocol` verbatim — each provider deployment is a 5-15 line `Route.make(...)` call instead of a 300-400 line route clone. Bug fixes in one protocol propagate to every consumer of that protocol in a single commit.

When a provider ships a non-HTTP transport (OpenAI's WebSocket Responses backend, hypothetical bidirectional streaming APIs), the seam is `Transport` — `WebSocketTransport.jsonTransport.with(...)` constructs an IO template whose `prepare` receives the route endpoint/auth at compile time, builds a WebSocket URL and message, and whose `frames` yields decoded text from the socket. Same protocol and endpoint source, different transport.

### URL Construction

`Endpoint` owns `{ baseURL, path, query }`. Each protocol route includes a canonical endpoint when the provider has one (e.g. `https://api.openai.com/v1`); provider helpers override endpoint fields by configuring the route before selecting a model. Routes that have no canonical URL (OpenAI-compatible Chat, GitHub Copilot) require configuration before execution.

For providers where the URL is derived from typed inputs (Azure resource name, Bedrock region), the provider helper configures the route endpoint before calling `.model(...)`. Use `AtLeastOne<T>` from `route/auth-options.ts` for inputs that accept either of two derivation paths (Azure: `resourceName` or `baseURL`).

### Provider Facades

Provider-facing APIs are configured facades over route values. Endpoint/auth/resource/API-version setup happens before model selection, and model selectors accept only a model or deployment id:

```ts
const openai = OpenAI.configure({ apiKey, baseURL })
const model = openai.responses("gpt-4o-mini")

const azure = Azure.configure({ resourceName, apiKey, apiVersion: "v1" })
const deployment = azure.responses("my-deployment")

const gateway = CloudflareAIGateway.configure({ accountId, gatewayId, gatewayApiKey, apiKey })
const proxied = gateway.model("openai/gpt-4o-mini")
```

Keep provider facades small and explicit:

- Use branded `ProviderID.make(...)` and `ModelID.make(...)` where ids are constructed directly.
- Use `model` for the default API path and named methods for provider-native alternatives such as OpenAI `responses`, `responsesWebSocket`, and `chat`.
- Put provider-specific setup on `.configure(...)`; do not add `model(id, overrides)` as a duplicate construction path.
- Export lower-level `routes` arrays separately only when advanced internal wiring needs them.
- Prefer `apiKey` as provider-specific sugar and `auth` as the explicit override; keep them mutually exclusive in provider option types with `ProviderAuthOption`.
- Resolve `apiKey` → `Auth` with `AuthOptions.bearer(options, "<PROVIDER>_API_KEY")` (it honors an explicit `auth` override and falls back to `Auth.config(envVar)` so missing keys surface a typed `Authentication` error rather than a runtime crash).
- Use separate top-level facades for products with different required setup, such as `CloudflareAIGateway` and `CloudflareWorkersAI`.

`Provider.make(...)` remains available for simple static provider definitions, but new built-in providers should prefer plain configured facades unless a helper removes real duplication without adding runtime behavior.

### Folder layout

```
packages/llm/src/
  schema/                   canonical Schema model, split by concern
    ids.ts                  branded IDs, literal types, ProviderMetadata
    options.ts              Generation/Provider/Http options, Limits, Model, cache policy
    messages.ts             content parts, Message, ToolDefinition, LLMRequest
    events.ts               Usage, individual events, LLMEvent, PreparedRequest, LLMResponse
    errors.ts               error reasons, LLMError, ToolFailure
    index.ts                barrel
  llm.ts                    request constructors and convenience helpers
  route/
    index.ts                @wopal/llm/route advanced barrel
    client.ts               Route.make + LLMClient.prepare/stream/generate
    executor.ts             RequestExecutor service + transport error mapping
    protocol.ts             Protocol type + Protocol.make
    endpoint.ts             Endpoint type + Endpoint.path
    auth.ts                 Auth type + Auth.bearer / Auth.apiKeyHeader / Auth.passthrough
    auth-options.ts         ProviderAuthOption shape, AuthOptions.bearer, AtLeastOne helper
    framing.ts              Framing type + Framing.sse
    transport/              transport implementations
      index.ts              Transport type + HttpTransport / WebSocketTransport namespaces
      http.ts               HttpTransport.httpJson — POST + framing
      websocket.ts          WebSocketTransport.json + WebSocketExecutor service
  protocols/
    shared.ts               ProviderShared toolkit used inside protocol impls
    openai-chat.ts          protocol + route (compose OpenAIChat.protocol)
    openai-responses.ts
    anthropic-messages.ts
    gemini.ts
    bedrock-converse.ts
    bedrock-event-stream.ts framing for AWS event-stream binary frames
    openai-compatible-chat.ts route that reuses OpenAIChat.protocol, no canonical URL
    utils/                  per-protocol helpers (auth, cache, media, tool-stream, ...)
  providers/
    openai-compatible.ts    generic compatible helper + family model helpers
    openai-compatible-profile.ts family defaults (deepseek, togetherai, ...)
    azure.ts / amazon-bedrock.ts / cloudflare.ts / github-copilot.ts / google.ts / xai.ts / openai.ts / anthropic.ts / openrouter.ts
  tool.ts                   typed tool() helper
  tool-runtime.ts           implementation helpers for LLMClient tool execution
```

The dependency arrow points down: `providers/*.ts` files import protocol routes and auth-option utilities; protocol modules import `endpoint`, `auth`, `framing`, and transport pieces. Protocols do not import provider facades. Lower-level modules know nothing about provider catalog metadata.

### Shared protocol helpers

`ProviderShared` exports a small toolkit used inside protocol implementations to keep them focused on provider-native shapes:

- `joinText(parts)` — joins an array of `TextPart` (or anything with a `.text`) with newlines. Use this anywhere a protocol flattens text content into a single string for a provider field.
- `parseToolInput(route, name, raw)` — Schema-decodes a tool-call argument string with the canonical "Invalid JSON input for `<route>` tool call `<name>`" error message. Treats empty input as `{}`.
- `parseJson(route, raw, message)` — generic JSON-via-Schema decode for non-tool bodies.
- `eventError(route, message, ...)` — typed `InvalidProviderOutput` constructor for stream-time decode failures.
- `validateWith(decoder)` — maps Schema decode errors to `InvalidRequest`. `Route.make(...)` uses this for body validation; lower-level routes can reuse it.
- `matchToolChoice(provider, choice, branches)` — branches over `LLMRequest["toolChoice"]` for provider-specific lowering.

If you find yourself copying a 3-to-5-line snippet between two protocols, lift it into `ProviderShared` next to these helpers rather than duplicating.

### Tools

Tool loops are represented in common messages and events:

```ts
const call = ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } })
const result = Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } })

const followUp = LLM.request({
  model,
  messages: [Message.user("Weather?"), Message.assistant([call]), result],
})
```

Routes lower these into provider-native assistant tool-call messages and tool-result messages. Streaming providers should emit `tool-input-delta` events while arguments arrive, then a final `tool-call` event with parsed input.

### Tool runtime

`LLM.stream({ request, tools })` executes model-requested tools with full type safety. Plain `LLM.stream(request)` only streams the model; if `request.tools` contains schemas, tool calls are returned for the caller to handle. Use `toolExecution: "none"` to pass executable tool definitions as schemas without invoking handlers. Add `stopWhen` to opt into follow-up model rounds after tool results.

```ts
const get_weather = tool({
  description: "Get current weather for a city",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ temperature: Schema.Number, condition: Schema.String }),
  execute: ({ city }) =>
    Effect.gen(function* () {
      // city: string  — typed from parameters Schema
      const data = yield* WeatherApi.fetch(city)
      return { temperature: data.temp, condition: data.cond }
      // return type checked against success Schema
    }),
})

const events = yield* LLM.stream({
  request,
  tools: { get_weather, get_time, ... },
  stopWhen: LLM.stepCountIs(10),
}).pipe(Stream.runCollect)
```

The runtime:

- Adds tool definitions (derived from each tool's `parameters` Schema via `Schema.toJsonSchemaDocument`) onto `request.tools`.
- Streams the model.
- On `tool-call`: looks up the named tool, decodes input against `parameters` Schema, dispatches to the typed `execute`, encodes the result against `success` Schema, emits `tool-result`.
- Emits local `tool-result` events in the same step by default.
- Loops only when `stopWhen` is provided and the step finishes with `tool-calls`, appending the assistant + tool messages.

Handler dependencies (services, permissions, plugin hooks, abort handling) are closed over by the consumer at tool-construction time. The runtime's only environment requirement is `RequestExecutor.Service`. Build the tools record inside an `Effect.gen` once and reuse it across many runs.

Errors must be expressed as `ToolFailure`. The runtime catches it and emits a `tool-error` event, then a `tool-result` of `type: "error"`, so the model can self-correct on the next step. Anything that is not a `ToolFailure` is treated as a defect and fails the stream. Three recoverable error paths produce `tool-error` events:

- The model called an unknown tool name.
- Input failed the `parameters` Schema.
- The handler returned a `ToolFailure`.

Provider-defined / hosted tools (Anthropic `web_search` / `code_execution` / `web_fetch`, OpenAI Responses `web_search_call` / `file_search_call` / `code_interpreter_call` / `mcp_call` / `local_shell_call` / `image_generation_call` / `computer_use_call`) pass through the runtime untouched:

- Routes surface the model's call as a `tool-call` event with `providerExecuted: true`, and the provider's result as a matching `tool-result` event with `providerExecuted: true`.
- The runtime detects `providerExecuted` on `tool-call` and **skips client dispatch** — no handler is invoked and no `tool-error` is raised for "unknown tool". The provider already executed it.
- Both events are appended to the assistant message in `assistantContent` so the next round's history carries the call + result for context. Anthropic encodes them back as `server_tool_use` + `web_search_tool_result` (or `code_execution_tool_result` / `web_fetch_tool_result`) blocks; OpenAI Responses callers typically use `previous_response_id` instead of resending hosted-tool items.

Add provider-defined tools to `request.tools` (no runtime entry needed). The matching route must know how to lower the tool definition into the provider-native shape; right now Anthropic accepts `web_search` / `code_execution` / `web_fetch` and OpenAI Responses accepts the hosted tool names listed above.

## Effect

This package is built on Effect. Public methods return `Effect` or `Stream`; provide `LLMClient.layer` for runtime dispatch and import the provider/protocol modules for the routes you use. The example at `example/tutorial.ts` is a runnable walkthrough.

## See also

- `AGENTS.md` — contributor rules (Effect, conventions, tests, protocol file style, recording tests); architecture lives in this file
- `example/tutorial.ts` — runnable end-to-end walkthrough
- `test/provider/*.test.ts` — fixture-first protocol tests; `*.recorded.test.ts` files cover live cassettes
