Loading...

Index your code with Devin

[DeepWiki](https://deepwiki.com/)

[DeepWiki](https://deepwiki.com/)

[anomalyco/opencode](https://github.com/anomalyco/opencode "Open repository")

Index your code with

Devin

Edit WikiShare

Loading...

Last indexed: 17 March 2026 ([7daea6](https://github.com/anomalyco/opencode/commits/7daea69e)
)

- [Overview](https://deepwiki.com/anomalyco/opencode/1-overview)
- [Repository Structure & Packages](https://deepwiki.com/anomalyco/opencode/1.1-repository-structure-and-packages)
- [Architecture Overview](https://deepwiki.com/anomalyco/opencode/1.2-architecture-overview)
- [Core Application](https://deepwiki.com/anomalyco/opencode/2-core-application)
- [CLI Entrypoint & Commands](https://deepwiki.com/anomalyco/opencode/2.1-cli-entrypoint-and-commands)
- [Configuration System](https://deepwiki.com/anomalyco/opencode/2.2-configuration-system)
- [Session & Agent System](https://deepwiki.com/anomalyco/opencode/2.3-session-and-agent-system)
- [AI Provider & Model Management](https://deepwiki.com/anomalyco/opencode/2.4-ai-provider-and-model-management)
- [Tool System & Permissions](https://deepwiki.com/anomalyco/opencode/2.5-tool-system-and-permissions)
- [HTTP Server & REST API](https://deepwiki.com/anomalyco/opencode/2.6-http-server-and-rest-api)
- [Event Bus & Real-time Updates](https://deepwiki.com/anomalyco/opencode/2.7-event-bus-and-real-time-updates)
- [LSP & Code Formatting](https://deepwiki.com/anomalyco/opencode/2.8-lsp-and-code-formatting)
- [Plugin System](https://deepwiki.com/anomalyco/opencode/2.9-plugin-system)
- [MCP Integration](https://deepwiki.com/anomalyco/opencode/2.10-mcp-integration)
- [Skills & Command System](https://deepwiki.com/anomalyco/opencode/2.11-skills-and-command-system)
- [User Interfaces](https://deepwiki.com/anomalyco/opencode/3-user-interfaces)
- [Terminal User Interface (TUI)](<https://deepwiki.com/anomalyco/opencode/3.1-terminal-user-interface-(tui)>)
- [Web Application](https://deepwiki.com/anomalyco/opencode/3.2-web-application)
- [Desktop Applications](https://deepwiki.com/anomalyco/opencode/3.3-desktop-applications)
- [UI Component Library](https://deepwiki.com/anomalyco/opencode/4-ui-component-library)
- [Component Architecture & Exports](https://deepwiki.com/anomalyco/opencode/4.1-component-architecture-and-exports)
- [Session Turn & Message Rendering](https://deepwiki.com/anomalyco/opencode/4.2-session-turn-and-message-rendering)
- [Styling System & Themes](https://deepwiki.com/anomalyco/opencode/4.3-styling-system-and-themes)
- [SDK & API](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api)
- [JavaScript SDK](https://deepwiki.com/anomalyco/opencode/5.1-javascript-sdk)
- [OpenAPI Specification & Code Generation](https://deepwiki.com/anomalyco/opencode/5.2-openapi-specification-and-code-generation)
- [IDE Extensions & Integrations](https://deepwiki.com/anomalyco/opencode/6-ide-extensions-and-integrations)
- [VS Code Extension](https://deepwiki.com/anomalyco/opencode/6.1-vs-code-extension)
- [Zed Extension](https://deepwiki.com/anomalyco/opencode/6.2-zed-extension)
- [Slack Integration](https://deepwiki.com/anomalyco/opencode/6.3-slack-integration)
- [Console Management System](https://deepwiki.com/anomalyco/opencode/7-console-management-system)
- [Console Architecture](https://deepwiki.com/anomalyco/opencode/7.1-console-architecture)
- [Console Backend](https://deepwiki.com/anomalyco/opencode/7.2-console-backend)
- [Console Frontend](https://deepwiki.com/anomalyco/opencode/7.3-console-frontend)
- [Build & Release](https://deepwiki.com/anomalyco/opencode/8-build-and-release)
- [Release Pipeline](https://deepwiki.com/anomalyco/opencode/8.1-release-pipeline)
- [Nix Builds](https://deepwiki.com/anomalyco/opencode/8.2-nix-builds)
- [Reference](https://deepwiki.com/anomalyco/opencode/9-reference)
- [Providers & Models](https://deepwiki.com/anomalyco/opencode/9.1-providers-and-models)
- [TUI Commands & Keybindings](https://deepwiki.com/anomalyco/opencode/9.2-tui-commands-and-keybindings)
- [Configuration Schema Reference](https://deepwiki.com/anomalyco/opencode/9.3-configuration-schema-reference)

Menu

# SDK & API

Relevant source files

- [packages/opencode/src/config/config.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/config/config.ts)
- [packages/opencode/src/env/index.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/env/index.ts)
- [packages/opencode/src/provider/error.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/provider/error.ts)
- [packages/opencode/src/provider/models.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/provider/models.ts)
- [packages/opencode/src/provider/provider.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/provider/provider.ts)
- [packages/opencode/src/provider/transform.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/provider/transform.ts)
- [packages/opencode/src/server/server.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/server/server.ts)
- [packages/opencode/src/session/compaction.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/compaction.ts)
- [packages/opencode/src/session/index.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/index.ts)
- [packages/opencode/src/session/llm.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/llm.ts)
- [packages/opencode/src/session/message-v2.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/message-v2.ts)
- [packages/opencode/src/session/message.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/message.ts)
- [packages/opencode/src/session/prompt.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/prompt.ts)
- [packages/opencode/src/session/revert.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/revert.ts)
- [packages/opencode/src/session/summary.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/summary.ts)
- [packages/opencode/src/tool/task.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/tool/task.ts)
- [packages/opencode/test/config/config.test.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/test/config/config.test.ts)
- [packages/opencode/test/provider/provider.test.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/test/provider/provider.test.ts)
- [packages/opencode/test/provider/transform.test.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/test/provider/transform.test.ts)
- [packages/opencode/test/session/llm.test.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/test/session/llm.test.ts)
- [packages/opencode/test/session/message-v2.test.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/test/session/message-v2.test.ts)
- [packages/opencode/test/session/revert-compact.test.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/test/session/revert-compact.test.ts)
- [packages/sdk/js/src/gen/sdk.gen.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/src/gen/sdk.gen.ts)
- [packages/sdk/js/src/gen/types.gen.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/src/gen/types.gen.ts)
- [packages/sdk/js/src/v2/gen/sdk.gen.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/src/v2/gen/sdk.gen.ts)
- [packages/sdk/js/src/v2/gen/types.gen.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/src/v2/gen/types.gen.ts)
- [packages/sdk/openapi.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/openapi.json)

This page explains how the `@opencode-ai/sdk` JavaScript package and the `packages/sdk/openapi.json` OpenAPI specification work together to give clients typed, programmatic access to the opencode HTTP server. It covers the package layout, code-generation pipeline, and a summary of the API surface.

For the HTTP server implementation that the SDK talks to, see [HTTP Server & REST API](https://deepwiki.com/anomalyco/opencode/2.5-tool-system-and-permissions)
. For the JavaScript SDK module exports and SSE consumption patterns, see [JavaScript SDK](https://deepwiki.com/anomalyco/opencode/5.1-javascript-sdk)
. For the full endpoint reference derived from the OpenAPI spec, see [OpenAPI Specification & Code Generation](https://deepwiki.com/anomalyco/opencode/5.2-openapi-specification-and-code-generation)
.

---

## How the pieces fit together

The SDK provides a typed client for the OpenCode HTTP server. The server (`packages/opencode/src/server/server.ts`) exposes a Hono-based REST API with Server-Sent Events (SSE) for real-time updates. The OpenAPI specification (`packages/sdk/openapi.json`) defines all endpoints, and `@hey-api/openapi-ts` generates TypeScript types and client methods from it.

The SDK supports two transport modes:

- **HTTP transport**: Remote server connections via `fetch()`
- **Internal transport**: In-process function calls when the SDK and server run in the same Node/Bun process

**Diagram: SDK architecture and transport modes**

Sources: [packages/opencode/src/server/server.ts53-277](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/server/server.ts#L53-L277)
[packages/sdk/js/package.json1-43](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/package.json#L1-L43)
[packages/sdk/openapi.json1-43](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/openapi.json#L1-L43)

---

## Package structure

The `@opencode-ai/sdk` package lives at `packages/sdk/js/`. It uses TypeScript with multiple entry points defined via the `exports` field in `package.json`.

| Export path       | Source file                  | Purpose                                                 |
| ----------------- | ---------------------------- | ------------------------------------------------------- |
| `.`               | `src/index.ts`               | Legacy export, re-exports `./v2`                        |
| `./client`        | `src/client.ts`              | Low-level HTTP client primitives                        |
| `./server`        | `src/server.ts`              | Server-side utilities (not for client use)              |
| `./v2`            | `src/v2/index.ts`            | **Main entry point** - exports `createOpencodeClient()` |
| `./v2/client`     | `src/v2/client.ts`           | Client factory with transport selection                 |
| `./v2/gen/client` | `src/v2/gen/client/index.ts` | Generated low-level HTTP/SSE client                     |
| `./v2/gen/types`  | `src/v2/gen/types.gen.ts`    | All generated TypeScript types                          |
| `./v2/gen/sdk`    | `src/v2/gen/sdk.gen.ts`      | Generated SDK methods                                   |
| `./v2/server`     | `src/v2/server.ts`           | Server-side SSE and event utilities                     |

The build output goes to `dist/`, which is published to npm. Monorepo packages import source files directly via workspace references.

**Dependencies:**

- Runtime: None (uses native `fetch` and `EventSource`)
- Dev: `@hey-api/openapi-ts@0.90.10` for code generation

Sources: [packages/sdk/js/package.json11-43](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/package.json#L11-L43)

---

## Code generation pipeline

The OpenAPI specification at `packages/sdk/openapi.json` is the canonical source for all API surface definitions. The build process uses `@hey-api/openapi-ts` to generate three files:

1.  **`src/v2/gen/types.gen.ts`** — All TypeScript type definitions (300+ types including models, events, errors)
2.  **`src/v2/gen/sdk.gen.ts`** — Typed SDK client classes with methods for each endpoint
3.  **`src/v2/gen/client/index.ts`** — Low-level HTTP/SSE client implementation

All generated files include the header `// This file is auto-generated by @hey-api/openapi-ts` and must never be edited manually. Changes must be made to `openapi.json` and regenerated.

**Diagram: Code generation and build flow**

The generation happens during `bun run build` via the `generate` script defined in `package.json`. The OpenAPI spec is maintained manually, with each route defined using `describeRoute()` calls in the server code.

Sources: [packages/sdk/js/src/v2/gen/types.gen.ts1-2](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/src/v2/gen/types.gen.ts#L1-L2)
[packages/sdk/js/src/v2/gen/sdk.gen.ts1-4](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/src/v2/gen/sdk.gen.ts#L1-L4)
[packages/sdk/openapi.json1-10](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/openapi.json#L1-L10)

---

## Client API structure

`createOpencodeClient()` returns an `OpencodeClient` instance that aggregates all resource-specific client classes. Each endpoint group maps to a client class with typed methods.

**Diagram: OpencodeClient structure and method groups**

**Example usage:**

Sources: [packages/sdk/js/src/v2/gen/sdk.gen.ts1-200](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/src/v2/gen/sdk.gen.ts#L1-L200)
[packages/sdk/js/src/v2/client.ts1-50](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/src/v2/client.ts#L1-L50)

---

## API endpoints reference

The OpenAPI specification defines 80+ endpoints organized into 15 resource groups. Each endpoint has an `operationId` that maps to a generated SDK method.

| Group            | Endpoint examples                                                                                                                  | Operation IDs                                                                                     | SDK methods                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Global**       | `GET /global/health` <br>`GET /global/event` <br>`PATCH /global/config`                                                            | `global.health` <br>`global.event` <br>`global.config.update`                                     | `client.global.health()` <br>`client.global.event()` <br>`client.global.config.update()`                                     |
| **Auth**         | `PUT /auth/{providerID}` <br>`DELETE /auth/{providerID}`                                                                           | `auth.set` <br>`auth.remove`                                                                      | `client.auth.set()` <br>`client.auth.remove()`                                                                               |
| **Project**      | `GET /project` <br>`GET /project/current` <br>`PATCH /project/{projectID}`                                                         | `project.list` <br>`project.current` <br>`project.update`                                         | `client.project.list()` <br>`client.project.current()` <br>`client.project.update()`                                         |
| **Session**      | `GET /session` <br>`POST /session` <br>`POST /session/{sessionID}/prompt`                                                          | `session.list` <br>`session.create` <br>`session.prompt`                                          | `client.session.list()` <br>`client.session.create()` <br>`client.session.prompt()`                                          |
| **Message**      | `GET /session/{sessionID}/message/{messageID}` <br>`PATCH /session/{sessionID}/message/{messageID}`                                | `message.get` <br>`message.update`                                                                | `client.session.message.get()` <br>`client.session.message.update()`                                                         |
| **Part**         | `PATCH /session/{sessionID}/message/{messageID}/part/{partID}` <br>`DELETE /session/{sessionID}/message/{messageID}/part/{partID}` | `part.update` <br>`part.delete`                                                                   | `client.session.message.part.update()` <br>`client.session.message.part.delete()`                                            |
| **Permission**   | `GET /session/{sessionID}/permission` <br>`POST /session/{sessionID}/permission/{requestID}`                                       | `permission.list` <br>`permission.respond`                                                        | `client.permission.list()` <br>`client.permission.respond()`                                                                 |
| **Question**     | `GET /session/{sessionID}/question` <br>`POST /session/{sessionID}/question/{requestID}`                                           | `question.list` <br>`question.reply`                                                              | `client.question.list()` <br>`client.question.reply()`                                                                       |
| **Provider**     | `GET /provider` <br>`GET /provider/{providerID}/oauth/authorize`                                                                   | `provider.list` <br>`provider.oauth.authorize`                                                    | `client.provider.list()` <br>`client.provider.oauth.authorize()`                                                             |
| **MCP**          | `GET /mcp` <br>`POST /mcp` <br>`POST /mcp/{name}/connect`                                                                          | `mcp.status` <br>`mcp.add` <br>`mcp.connect`                                                      | `client.mcp.status()` <br>`client.mcp.add()` <br>`client.mcp.connect()`                                                      |
| **PTY**          | `GET /pty` <br>`POST /pty` <br>`GET /pty/{ptyID}/connect`                                                                          | `pty.list` <br>`pty.create` <br>`pty.connect`                                                     | `client.pty.list()` <br>`client.pty.create()` <br>`client.pty.connect()`                                                     |
| **Config**       | `GET /config` <br>`PATCH /config` <br>`GET /config/providers`                                                                      | `config.get` <br>`config.update` <br>`config.providers`                                           | `client.config.get()` <br>`client.config.update()` <br>`client.config.providers()`                                           |
| **File**         | `GET /file` <br>`GET /file/read` <br>`GET /file/status`                                                                            | `file.list` <br>`file.read` <br>`file.status`                                                     | `client.file.list()` <br>`client.file.read()` <br>`client.file.status()`                                                     |
| **LSP/Format**   | `GET /lsp/status` <br>`GET /formatter/status`                                                                                      | `lsp.status` <br>`formatter.status`                                                               | `client.lsp.status()` <br>`client.formatter.status()`                                                                        |
| **Experimental** | `POST /experimental/workspace` <br>`GET /experimental/workspace` <br>`GET /experimental/session`                                   | `experimental.workspace.create` <br>`experimental.workspace.list` <br>`experimental.session.list` | `client.experimental.workspace.create()` <br>`client.experimental.workspace.list()` <br>`client.experimental.session.list()` |

**Query parameters:** Most endpoints accept `directory` and `workspace` query parameters to scope operations to a specific project instance. These are automatically added by the SDK client based on initialization options.

Sources: [packages/sdk/openapi.json8-1800](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/openapi.json#L8-L1800)
[packages/opencode/src/server/server.ts131-277](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/server/server.ts#L131-L277)

---

## Event system (SSE)

OpenCode uses Server-Sent Events (SSE) for real-time updates. Two SSE endpoints exist:

1.  **`GET /global/event`** — Cross-instance events wrapped in `GlobalEvent` (includes `directory` field)
2.  **`GET /event`** — Per-instance events (deprecated in favor of global endpoint)

### GlobalEvent structure

Every event emitted by `/global/event` follows this envelope pattern:

The `directory` field allows clients to filter events by project when monitoring multiple instances.

### Event type hierarchy

The `Event` union type encompasses all possible event payloads. Events are organized by subsystem:

**Diagram: Event type categories and counts**

### Consuming events

The SDK provides an async iterator for SSE consumption:

**Server implementation:** The server publishes events using `Bus.publish()` from various subsystems ([packages/opencode/src/bus/global.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/bus/global.ts)
). The HTTP handler at `/global/event` uses Hono's `streamSSE()` to multiplex events from the global bus to connected SSE clients.

Sources: [packages/sdk/js/src/v2/gen/types.gen.ts959-1009](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/src/v2/gen/types.gen.ts#L959-L1009)
[packages/opencode/src/server/server.ts131-160](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/server/server.ts#L131-L160)
[packages/sdk/openapi.json44-68](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/openapi.json#L44-L68)

---

## Core data types

The generated `types.gen.ts` file exports 300+ TypeScript types. The most important types for building clients are documented below.

### Session and message types

| Type               | Description                      | Key fields                                                                                                                  |
| ------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Session`          | Conversation thread record       | `id`, `projectID`, `workspaceID`, `title`, `permission`, `summary`, `share`, `time.created`, `time.updated`                 |
| `UserMessage`      | User turn in conversation        | `id`, `sessionID`, `role: "user"`, `agent`, `model: {providerID, modelID}`, `format?`, `system?`, `variant?`                |
| `AssistantMessage` | AI response turn                 | `id`, `sessionID`, `role: "assistant"`, `parentID`, `modelID`, `providerID`, `agent`, `cost`, `tokens`, `finish?`, `error?` |
| `Message`          | Union of user/assistant messages | Discriminated by `role` field                                                                                               |

### Part types (message content)

Messages consist of one or more `Part` objects. Each part has a `type` field that determines its structure:

| Part type     | Type name        | Purpose                         | Key fields                                             |
| ------------- | ---------------- | ------------------------------- | ------------------------------------------------------ |
| `text`        | `TextPart`       | Plain text content              | `text`, `synthetic?`, `ignored?`                       |
| `reasoning`   | `ReasoningPart`  | AI reasoning/thinking trace     | `text`, `time`                                         |
| `file`        | `FilePart`       | Attached file reference         | `url`, `filename`, `mime`, `source?`                   |
| `tool`        | `ToolPart`       | Tool execution record           | `callID`, `tool`, `state: ToolState`                   |
| `step-start`  | `StepStartPart`  | Marks beginning of agentic step | `snapshot?`                                            |
| `step-finish` | `StepFinishPart` | Marks end of agentic step       | `reason`, `snapshot?`, `cost`, `tokens`                |
| `snapshot`    | `SnapshotPart`   | File system snapshot reference  | `snapshot` (hash)                                      |
| `patch`       | `PatchPart`      | Git patch reference             | `hash`, `files[]`                                      |
| `agent`       | `AgentPart`      | Agent/mode switch directive     | `name`, `source?`                                      |
| `retry`       | `RetryPart`      | Retry attempt after error       | `attempt`, `error`                                     |
| `compaction`  | `CompactionPart` | Context compaction marker       | `auto`, `overflow?`                                    |
| `subtask`     | `SubtaskPart`    | Delegated subtask request       | `prompt`, `description`, `agent`, `model?`, `command?` |

**Diagram: Part type hierarchy**

### Tool execution state

`ToolState` is a discriminated union representing the lifecycle of a tool call:

### Other key types

| Type                | Description                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `Project`           | Project metadata: `id`, `worktree`, `vcs`, `name`, `icon`, `commands`, `sandboxes[]`          |
| `Pty`               | Pseudo-terminal session: `id`, `command`, `args[]`, `cwd`, `env`, `status`, `pid`, `title`    |
| `PermissionRequest` | Runtime permission prompt: `id`, `sessionID`, `permission`, `patterns[]`, `metadata`, `tool?` |
| `QuestionRequest`   | Interactive question to user: `id`, `sessionID`, `questions[]`, `tool?`                       |
| `Provider`          | LLM provider config: `id`, `name`, `models[]`, `default`                                      |
| `Config`            | OpenCode configuration object (mirrors `Config.Info` from server)                             |
| `FileDiff`          | File change record: `file`, `before`, `after`, `additions`, `deletions`, `status?`            |
| `OutputFormat`      | Structured output spec: `text` or `json_schema` with schema                                   |

**Error types:** All API errors are typed. Common error types include `UnknownError`, `ProviderAuthError`, `APIError`, `ContextOverflowError`, `StructuredOutputError`, `MessageOutputLengthError`, and `MessageAbortedError`. Each error has a `name` and `data` field with error-specific details.

Sources: [packages/sdk/js/src/v2/gen/types.gen.ts21-1014](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/src/v2/gen/types.gen.ts#L21-L1014)
[packages/opencode/src/session/message-v2.ts20-212](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/message-v2.ts#L20-L212)

---

## SDK consumers in the monorepo

| Package               | Import path used                  | Role                                             |
| --------------------- | --------------------------------- | ------------------------------------------------ |
| `@opencode-ai/app`    | `@opencode-ai/sdk`                | Web frontend data fetching and SSE subscriptions |
| `@opencode-ai/ui`     | `@opencode-ai/sdk`                | Types for session/message rendering components   |
| `@opencode-ai/plugin` | `@opencode-ai/sdk`                | Plugin API types and client access               |
| `@opencode-ai/slack`  | `@opencode-ai/sdk`                | Slack bot interaction with opencode sessions     |
| `sdks/vscode`         | `@opencode-ai/sdk`                | VS Code extension communication                  |
| `opencode` (CLI)      | `@opencode-ai/sdk` (workspace:\*) | Internal use within the opencode process         |

Sources: [bun.lock26-33](https://github.com/anomalyco/opencode/blob/7daea69e/bun.lock#L26-L33)
[bun.lock377-390](https://github.com/anomalyco/opencode/blob/7daea69e/bun.lock#L377-L390)
[bun.lock408-420](https://github.com/anomalyco/opencode/blob/7daea69e/bun.lock#L408-L420)
[packages/plugin/package.json18-20](https://github.com/anomalyco/opencode/blob/7daea69e/packages/plugin/package.json#L18-L20)

Dismiss

Refresh this wiki

Enter email to refresh

### On this page

- [SDK & API](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api#sdk-api)
- [How the pieces fit together](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api#how-the-pieces-fit-together)
- [Package structure](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api#package-structure)
- [Code generation pipeline](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api#code-generation-pipeline)
- [Client API structure](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api#client-api-structure)
- [API endpoints reference](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api#api-endpoints-reference)
- [Event system (SSE)](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api#event-system-sse)
- [GlobalEvent structure](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api#globalevent-structure)
- [Event type hierarchy](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api#event-type-hierarchy)
- [Consuming events](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api#consuming-events)
- [Core data types](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api#core-data-types)
- [Session and message types](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api#session-and-message-types)
- [Part types (message content)](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api#part-types-message-content)
- [Tool execution state](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api#tool-execution-state)
- [Other key types](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api#other-key-types)
- [SDK consumers in the monorepo](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api#sdk-consumers-in-the-monorepo)
