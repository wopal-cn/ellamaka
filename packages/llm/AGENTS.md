---
name: llm package rules
description: LLM package development rules for Effect-based HTTP clients, streams, and codecs
---

# LLM Package Guide

## Effect

- Prefer `HttpClient.HttpClient` / `HttpClientResponse.HttpClientResponse` over web `fetch` / `Response` at package boundaries.
- Use `Stream.Stream` for streaming data flow. Avoid ad hoc async generators or manual web reader loops unless an Effect `Stream` API cannot model the behavior.
- Use Effect Schema codecs for JSON encode/decode (`Schema.fromJsonString(...)`) instead of direct `JSON.parse` / `JSON.stringify` in implementation code.
- In `Effect.gen`, yield yieldable errors directly (`return yield* new MyError(...)`) instead of `Effect.fail(new MyError(...))`.
- Use `Effect.void` instead of `Effect.succeed(undefined)` when the successful value is intentionally void.

## Conventions

Per-type constructors live on the type, not as top-level re-exports. Use `Message.user(...)`, `Message.assistant(...)`, `Message.tool(...)`, `Model.make(...)`, `ToolDefinition.make(...)`, `ToolCallPart.make(...)`, `ToolResultPart.make(...)`, `ToolChoice.make(...)`, `ToolChoice.named(...)`, `SystemPart.make(...)`, and `GenerationOptions.make(...)` directly. The top-level `LLM` namespace is reserved for request-shaped call APIs: `LLM.request`, `LLM.generate`, `LLM.stream`, `LLM.updateRequest`, and `LLM.generateObject`. Two ways to construct the same thing is one too many.

## Tests

- Use `testEffect(...)` from `test/lib/effect.ts` for tests requiring Effect layers.
- Keep provider tests fixture-first. Live provider calls must stay behind `RECORD=true` and required API-key checks.

## Architecture

This package is an Effect Schema-first LLM core. The Schema classes in `src/schema/` are the canonical runtime data model. Convenience functions in `src/llm.ts` are thin constructors that return those same Schema class instances; they should improve callsites without creating a second model.

Primary in-repo integration point:

- `packages/opencode/src/session/llm.ts` is the session-owned orchestration layer that decides whether a request uses AI SDK or this package's native route runtime.
- `packages/opencode/src/session/llm/native-request.ts` is the lowering adapter from opencode's session/AI SDK-shaped data into this package's `LLMRequest` model.
- `packages/opencode/src/session/llm/native-runtime.ts` is the execution adapter that calls `LLMClient.stream(...)` and bridges opencode tools into this package's tool runtime.
- `packages/opencode/src/session/llm/ai-sdk.ts` keeps the default AI SDK path compatible by converting AI SDK stream parts into this package's shared `LLMEvent`s.

Keep this package independent of session concerns. Session auth, permissions, plugins, telemetry headers, and runtime selection belong in `packages/opencode/src/session/llm.ts` and its local adapters.

Request flow, route composition, URL construction, provider facades, folder layout, shared protocol helpers, and the tool runtime are documented in `README.md`.

## Protocol File Style

Protocol files should look self-similar. Provider quirks belong behind named helpers so a new route can be reviewed by comparing the same sections across files.

### Section order

Use this order for every protocol module:

1. Public model input
2. Request body schema
3. Streaming event schema
4. Parser state
5. Request body construction (`fromRequest`)
6. Stream parsing (`step` and per-event handlers)
7. Protocol and route
8. Protocol route export

### Rules

- Keep protocol files focused on the protocol. Move provider-specific projection, signing, media normalization, or other bulky transformations into `src/protocols/utils/*`.
- Use `Effect.fn("Provider.fromRequest")` for request body construction entrypoints. Use `Effect.fn(...)` for event handlers that yield effects; keep purely synchronous handlers as plain functions returning a `StepResult` that the dispatcher lifts via `Effect.succeed(...)`.
- Parser state owns terminal information. The state machine records finish reason, usage, and pending tool calls; emit one terminal `finish` event (or `provider-error`) for each completed response. If a provider splits reason and usage across events, merge them in parser state before flushing.
- Emit exactly one terminal `finish` event for a completed response, normally after a matching `step-finish`. Use `stream.terminal` to stop reading when the provider has a completion sentinel; use `stream.onHalt` when the final event must be flushed after the framed stream ends.
- Use shared helpers for repeated protocol policy such as text joining, usage totals, JSON parsing, and tool-call accumulation. `ToolStream` (`protocols/utils/tool-stream.ts`) accumulates streamed tool-call arguments uniformly.
- Make intentional provider differences explicit in helper names or comments. If two protocol files differ visually, the reason should be obvious from the names.
- Prefer dispatched per-event handlers (`onMessageStart`, `onContentBlockDelta`, ...) called from a small top-level `step` switch over a long if-chain. The dispatcher keeps the event surface visible at a glance.
- Keep tests in the same conceptual order as the protocol: basic prepare, tools prepare, unsupported lowering, text/usage parsing, tool streaming, finish reasons, provider errors.

### Review checklist

- Can the file be skimmed side-by-side with `openai-chat.ts` without hunting for equivalent sections?
- Are provider quirks named, isolated, and covered by focused tests?
- Does request body construction validate unsupported common content at the protocol boundary?
- Does stream parsing emit stable common events without leaking provider event order to callers?
- Does `toolChoice: "none"` behavior read as intentional?

## Recording Tests

Recorded tests use one cassette file per scenario. A cassette holds an ordered array of `{ request, response }` interactions, so multi-step flows (tool loops, retries, polling) record into a single file. Use `recordedTests({ prefix, requires })` and let the helper derive cassette names from test names:

```ts
const recorded = recordedTests({ prefix: "openai-chat", requires: ["OPENAI_API_KEY"] })

recorded.effect("streams text", () =>
  Effect.gen(function* () {
    // test body
  }),
)
```

Replay is the default. `RECORD=true` records fresh cassettes and requires the listed env vars. Cassettes are written as pretty-printed JSON so multi-interaction diffs stay reviewable.

Pass `provider`, `protocol`, and optional `tags` to `recordedTests(...)` / `recorded.effect.with(...)` so cassettes carry searchable metadata. Use recorded-test filters to replay or record a narrow subset without rewriting a whole file:

- `RECORDED_PROVIDER=openai` matches tests tagged with `provider:openai`; comma-separated values are allowed.
- `RECORDED_PREFIX=openai-chat` matches cassette groups by `recordedTests({ prefix })`; comma-separated values are allowed.
- `RECORDED_TAGS=tool` requires all listed tags to be present, e.g. `RECORDED_TAGS=provider:togetherai,tool`.
- `RECORDED_TEST="streams text"` matches by test name, kebab-case test id, or cassette path.

Filters apply in replay and record mode. Combine them with `RECORD=true` when refreshing only one provider or scenario.

**Binary response bodies.** Most providers stream text (SSE, JSON). AWS Bedrock streams binary AWS event-stream frames whose CRC32 fields would be mangled by a UTF-8 round-trip — those bodies are stored as base64 with `bodyEncoding: "base64"` on the response snapshot. Detection is by `Content-Type` in `@wopal/http-recorder` (currently `application/vnd.amazon.eventstream` and `application/octet-stream`); cassettes for SSE/JSON routes omit the field and decode as text.

**Matching strategy.** Replay walks the cassette in record order via an internal cursor: the Nth runtime request is served by the Nth recorded interaction, and each one is validated by comparing method, URL, allow-listed headers, and the canonical JSON body. This handles tool loops (each round's request differs as history grows) and retry/polling scenarios (successive byte-identical requests with different responses) uniformly. If a test reorders its requests, re-record the cassette. `scriptedResponses` (in `test/lib/http.ts`) is the deterministic counterpart for tests that don't need a live provider; it scripts response bodies in order without reading from disk.

Do not blanket re-record an entire test file when adding one cassette. `RECORD=true` rewrites every recorded case that runs, and provider streams contain volatile IDs, timestamps, fingerprints, and obfuscation fields. Prefer deleting the one cassette you intend to refresh, or run a focused test pattern that only registers the scenario you want to record. Keep stable existing cassettes unchanged unless their request shape or expected behavior changed.
