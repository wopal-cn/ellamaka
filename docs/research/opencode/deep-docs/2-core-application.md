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

# Core Application

Relevant source files

- [packages/opencode/src/cli/bootstrap.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/bootstrap.ts)
- [packages/opencode/src/cli/cmd/acp.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/acp.ts)
- [packages/opencode/src/cli/cmd/run.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/run.ts)
- [packages/opencode/src/cli/cmd/serve.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/serve.ts)
- [packages/opencode/src/cli/cmd/tui/context/sync.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/context/sync.tsx)
- [packages/opencode/src/cli/cmd/tui/thread.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/thread.ts)
- [packages/opencode/src/cli/cmd/tui/worker.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/worker.ts)
- [packages/opencode/src/cli/cmd/web.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/web.ts)
- [packages/opencode/src/cli/network.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/network.ts)
- [packages/opencode/src/config/config.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/config/config.ts)
- [packages/opencode/src/env/index.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/env/index.ts)
- [packages/opencode/src/index.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/index.ts)
- [packages/opencode/src/provider/error.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/provider/error.ts)
- [packages/opencode/src/provider/models.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/provider/models.ts)
- [packages/opencode/src/provider/provider.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/provider/provider.ts)
- [packages/opencode/src/provider/transform.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/provider/transform.ts)
- [packages/opencode/src/server/mdns.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/server/mdns.ts)
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
- [packages/sdk/js/src/index.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/src/index.ts)
- [packages/sdk/js/src/v2/gen/sdk.gen.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/src/v2/gen/sdk.gen.ts)
- [packages/sdk/js/src/v2/gen/types.gen.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/src/v2/gen/types.gen.ts)
- [packages/sdk/openapi.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/openapi.json)
- [packages/web/src/content/docs/cli.mdx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/cli.mdx?plain=1)
- [packages/web/src/content/docs/config.mdx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/config.mdx?plain=1)
- [packages/web/src/content/docs/ide.mdx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/ide.mdx?plain=1)
- [packages/web/src/content/docs/plugins.mdx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/plugins.mdx?plain=1)
- [packages/web/src/content/docs/sdk.mdx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/sdk.mdx?plain=1)
- [packages/web/src/content/docs/server.mdx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/server.mdx?plain=1)
- [packages/web/src/content/docs/tui.mdx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/tui.mdx?plain=1)

The Core Application is the main OpenCode server package ([packages/opencode](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode)
) that provides the foundational AI agent capabilities. It implements a Hono-based HTTP server with an embedded CLI interface, managing AI conversations (sessions), tool execution, provider integrations, and real-time event streaming. The server can run in-process (local mode) or as a networked service (remote mode), exposing an OpenAPI-compliant REST API.

For specific subsystems, see: CLI commands ([2.1](https://deepwiki.com/anomalyco/opencode/2.1-cli-entrypoint-and-commands)
), configuration loading ([2.2](https://deepwiki.com/anomalyco/opencode/2.2-configuration-system)
), session lifecycle ([2.3](https://deepwiki.com/anomalyco/opencode/2.3-session-and-agent-system)
), provider integration ([2.4](https://deepwiki.com/anomalyco/opencode/2.4-ai-provider-and-model-management)
), tool execution ([2.5](https://deepwiki.com/anomalyco/opencode/2.5-tool-system-and-permissions)
), HTTP routes ([2.6](https://deepwiki.com/anomalyco/opencode/2.6-http-server-and-rest-api)
), event streaming ([2.7](https://deepwiki.com/anomalyco/opencode/2.7-event-bus-and-real-time-updates)
), LSP integration ([2.8](https://deepwiki.com/anomalyco/opencode/2.8-lsp-and-code-formatting)
), plugin system ([2.9](https://deepwiki.com/anomalyco/opencode/2.9-plugin-system)
), MCP servers ([2.10](https://deepwiki.com/anomalyco/opencode/2.10-mcp-integration)
), and skills ([2.11](https://deepwiki.com/anomalyco/opencode/2.11-skills-and-command-system)
).

---

## Architecture Overview

The Core Application follows a layered architecture with clear separation between transport (HTTP/internal), business logic (sessions, agents, tools), and external integrations (LLMs, LSP, MCP).

**Core Application Architecture**

Sources: [packages/opencode/src/index.ts1-197](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/index.ts#L1-L197)
[packages/opencode/src/server/server.ts1-558](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/server/server.ts#L1-L558)
[packages/opencode/src/session/index.ts1-753](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/index.ts#L1-L753)
[packages/opencode/src/config/config.ts1-1010](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/config/config.ts#L1-L1010)

---

## Application Lifecycle

The application initializes through a multi-stage bootstrap process that sets up logging, performs database migrations, loads configuration, and starts the server.

**Application Initialization Flow**

Sources: [packages/opencode/src/index.ts50-123](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/index.ts#L50-L123)
[packages/opencode/src/server/server.ts58-219](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/server/server.ts#L58-L219)
[packages/opencode/src/config/config.ts78-266](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/config/config.ts#L78-L266)

The initialization sequence includes:

1.  **Logging Setup**: [packages/opencode/src/index.ts68-76](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/index.ts#L68-L76)
    configures the logging system with level based on environment
2.  **Database Migration**: [packages/opencode/src/index.ts87-121](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/index.ts#L87-L121)
    performs one-time migration from JSON storage to SQLite
3.  **Configuration Loading**: [packages/opencode/src/config/config.ts78-266](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/config/config.ts#L78-L266)
    loads and merges config from 6 sources in precedence order
4.  **Instance Initialization**: [packages/opencode/src/project/instance.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/project/instance.ts)
    sets up project context with directory and workspace ID
5.  **Server Start**: [packages/opencode/src/server/server.ts56-558](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/server/server.ts#L56-L558)
    creates Hono app with middleware and routes

---

## Core Subsystems

### Session Management

The `Session` namespace ([packages/opencode/src/session/index.ts36-753](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/index.ts#L36-L753)
) manages conversation threads, messages, and parts. Each session tracks:

| Property      | Type                      | Description                   |
| ------------- | ------------------------- | ----------------------------- |
| `id`          | `SessionID`               | Descending ULID identifier    |
| `projectID`   | `ProjectID`               | Associated project            |
| `workspaceID` | `WorkspaceID?`            | Optional workspace (worktree) |
| `title`       | `string`                  | Session title                 |
| `permission`  | `PermissionNext.Ruleset?` | Permission overrides          |
| `summary`     | `SessionSummary?`         | File diff statistics          |
| `share`       | `{url: string}?`          | Share link if published       |
| `revert`      | `RevertInfo?`             | Revert point information      |

Sessions contain `Message` entities (user/assistant) which contain `Part` entities (text, tool, file, reasoning, etc). See [2.3](https://deepwiki.com/anomalyco/opencode/2.3-session-and-agent-system)
for detailed session lifecycle.

Sources: [packages/opencode/src/session/index.ts36-753](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/index.ts#L36-L753)
[packages/opencode/src/session/session.sql.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/session.sql.ts)

### Message and Part Structure

The `MessageV2` namespace ([packages/opencode/src/session/message-v2.ts20-758](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/message-v2.ts#L20-L758)
) defines the message data model:

Sources: [packages/opencode/src/session/message-v2.ts20-758](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/message-v2.ts#L20-L758)
[packages/opencode/src/session/session.sql.ts14-68](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/session.sql.ts#L14-L68)

### Configuration System

The `Config` namespace ([packages/opencode/src/config/config.ts42-1010](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/config/config.ts#L42-L1010)
) implements hierarchical configuration loading with 6 precedence levels (lowest to highest):

1.  Remote `.well-known/opencode` (organization defaults)
2.  Global config (`~/.config/opencode/opencode.json`)
3.  Custom config (`OPENCODE_CONFIG` env var)
4.  Project config (`<project>/opencode.json`)
5.  `.opencode` directories (agents, commands, plugins)
6.  Inline config (`OPENCODE_CONFIG_CONTENT` env var)

Configuration includes agent definitions, provider settings, tool permissions, plugin paths, and TUI keybindings. See [2.2](https://deepwiki.com/anomalyco/opencode/2.2-configuration-system)
for detailed configuration schema.

Sources: [packages/opencode/src/config/config.ts42-1010](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/config/config.ts#L42-L1010)
[packages/opencode/src/config/paths.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/config/paths.ts)

### Agent System

The `Agent` namespace ([packages/opencode/src/agent/agent.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/agent/agent.ts)
) manages agent configurations (modes) which define:

- Model selection (providerID/modelID)
- System prompts and instructions
- Temperature/top_p overrides
- Permission rulesets
- Tool availability
- Maximum iteration steps

Agents can be primary (selected by user) or subagents (invoked via `@` mentions or task tool). The system supports three agent modes: `primary`, `subagent`, and `all`.

Sources: [packages/opencode/src/agent/agent.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/agent/agent.ts)
[packages/opencode/src/config/config.ts712-799](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/config/config.ts#L712-L799)

### Provider Integration

The `Provider` namespace ([packages/opencode/src/provider/provider.ts52-1260](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/provider/provider.ts#L52-L1260)
) provides unified access to 20+ LLM providers:

Each provider has a custom loader ([packages/opencode/src/provider/provider.ts147-661](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/provider/provider.ts#L147-L661)
) that handles authentication, regional endpoints, and model-specific options. See [2.4](https://deepwiki.com/anomalyco/opencode/2.4-ai-provider-and-model-management)
for provider configuration details.

Sources: [packages/opencode/src/provider/provider.ts52-1260](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/provider/provider.ts#L52-L1260)
[packages/opencode/src/provider/models.ts14-191](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/provider/models.ts#L14-L191)

### Tool Execution

The `ToolRegistry` ([packages/opencode/src/tool/registry.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/tool/registry.ts)
) manages tool registration and execution. Core tools include:

| Tool ID | Purpose                                          | Source                                                                                     |
| ------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `bash`  | Execute shell commands                           | [src/tool/bash.ts](https://github.com/anomalyco/opencode/blob/7daea69e/src/tool/bash.ts)   |
| `edit`  | Edit file contents with 9 replacement strategies | [src/tool/edit.ts](https://github.com/anomalyco/opencode/blob/7daea69e/src/tool/edit.ts)   |
| `read`  | Read file contents with LSP integration          | [src/tool/read.ts](https://github.com/anomalyco/opencode/blob/7daea69e/src/tool/read.ts)   |
| `write` | Write file contents                              | [src/tool/write.ts](https://github.com/anomalyco/opencode/blob/7daea69e/src/tool/write.ts) |
| `grep`  | Search file contents using ripgrep               | [src/tool/grep.ts](https://github.com/anomalyco/opencode/blob/7daea69e/src/tool/grep.ts)   |
| `glob`  | Find files matching patterns                     | [src/tool/glob.ts](https://github.com/anomalyco/opencode/blob/7daea69e/src/tool/glob.ts)   |
| `task`  | Spawn parallel subagent tasks                    | [src/tool/task.ts](https://github.com/anomalyco/opencode/blob/7daea69e/src/tool/task.ts)   |
| `lsp-*` | LSP operations (hover, definition, diagnostics)  | [src/lsp/](https://github.com/anomalyco/opencode/blob/7daea69e/src/lsp/)                   |
| `mcp-*` | MCP resource access                              | [src/mcp/](https://github.com/anomalyco/opencode/blob/7daea69e/src/mcp/)                   |

Tool execution is protected by the `PermissionNext` system ([packages/opencode/src/permission/next.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/permission/next.ts)
) which enforces per-tool permissions with pattern matching. See [2.5](https://deepwiki.com/anomalyco/opencode/2.5-tool-system-and-permissions)
for tool system details.

Sources: [packages/opencode/src/tool/registry.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/tool/registry.ts)
[packages/opencode/src/tool/tool.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/tool/tool.ts)
[packages/opencode/src/permission/next.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/permission/next.ts)

### HTTP Server

The `Server` namespace ([packages/opencode/src/server/server.ts53-558](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/server/server.ts#L53-L558)
) implements a Hono HTTP server with:

- OpenAPI route definitions ([packages/sdk/openapi.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/openapi.json)
  )
- CORS middleware for trusted origins ([packages/opencode/src/server/server.ts105-130](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/server/server.ts#L105-L130)
  )
- Basic auth (optional, via `OPENCODE_SERVER_PASSWORD`)
- Directory/workspace context middleware ([packages/opencode/src/server/server.ts194-220](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/server/server.ts#L194-L220)
  )
- Error handling with NamedError serialization ([packages/opencode/src/server/server.ts61-78](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/server/server.ts#L61-L78)
  )

Routes are organized by resource:

- `/global/*` - Global operations (health, config, events)
- `/project/*` - Project management
- `/session/*` - Session CRUD and prompting
- `/pty/*` - Pseudo-terminal management
- `/config/*` - Configuration access
- `/mcp/*` - MCP server management
- `/experimental/*` - Experimental APIs (workspaces, tools)

See [2.6](https://deepwiki.com/anomalyco/opencode/2.6-http-server-and-rest-api)
for API documentation.

Sources: [packages/opencode/src/server/server.ts53-558](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/server/server.ts#L53-L558)
[packages/opencode/src/server/routes/](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/server/routes/)

### Event Bus

The `Bus` ([packages/opencode/src/bus/index.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/bus/index.ts)
) and `GlobalBus` ([packages/opencode/src/bus/global.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/bus/global.ts)
) provide typed event streaming:

Events include: `session.created`, `session.updated`, `message.updated`, `message.part.updated`, `permission.asked`, `question.asked`, `file.edited`, `vcs.branch.updated`, and more. See [2.7](https://deepwiki.com/anomalyco/opencode/2.7-event-bus-and-real-time-updates)
for event system details.

Sources: [packages/opencode/src/bus/index.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/bus/index.ts)
[packages/opencode/src/bus/global.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/bus/global.ts)
[packages/opencode/src/server/routes/global.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/server/routes/global.ts)

### Plugin System

The `Plugin` namespace ([packages/opencode/src/plugin/index.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/plugin/index.ts)
) supports extensibility via npm packages or local files. Plugins can register hooks for:

- `tool.execute.before` / `tool.execute.after` - Intercept tool execution
- `event` - Subscribe to bus events
- `shell.env` - Modify shell environment variables
- `provider.options` - Modify provider request options

Plugins are loaded from three sources:

1.  Global `~/.opencode/plugins/*.{js,ts}` directory
2.  Global `opencode.json` `plugin` array
3.  Project `.opencode/plugins/*.{js,ts}` directory
4.  Project `opencode.json` `plugin` array

See [2.9](https://deepwiki.com/anomalyco/opencode/2.9-plugin-system)
for plugin development.

Sources: [packages/opencode/src/plugin/index.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/plugin/index.ts)
[packages/opencode/src/config/config.ts497-509](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/config/config.ts#L497-L509)

---

## Session Prompt Flow

The core conversation loop ([packages/opencode/src/session/prompt.ts161-188](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/prompt.ts#L161-L188)
) orchestrates a multi-step process from user input to assistant response:

**User Prompt to Response Flow**

Sources: [packages/opencode/src/session/prompt.ts161-758](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/prompt.ts#L161-L758)
[packages/opencode/src/session/llm.ts27-313](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/llm.ts#L27-L313)
[packages/opencode/src/tool/registry.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/tool/registry.ts)

Key stages:

1.  **User Message Creation**: [packages/opencode/src/session/prompt.ts165-166](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/prompt.ts#L165-L166)
    creates user message with parts (text, files, agent mentions)
2.  **Loop Initialization**: [packages/opencode/src/session/prompt.ts187](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/prompt.ts#L187-L187)
    starts the agentic loop with abort signal
3.  **Message History Retrieval**: [packages/opencode/src/session/prompt.ts301](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/prompt.ts#L301-L301)
    fetches non-compacted messages
4.  **LLM Streaming**: [packages/opencode/src/session/llm.ts106-280](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/llm.ts#L106-L280)
    streams text/reasoning/tool-call chunks
5.  **Tool Execution**: [packages/opencode/src/session/prompt.ts544-758](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/prompt.ts#L544-L758)
    executes tools with permission checks
6.  **Compaction**: [packages/opencode/src/session/compaction.ts19-159](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/compaction.ts#L19-L159)
    summarizes old messages when context limit approached
7.  **Iteration**: Loop continues until assistant returns non-tool-calls finish reason

---

## Key Data Structures

### Session Table Schema

Sources: [packages/opencode/src/session/session.sql.ts6-33](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/session.sql.ts#L6-L33)

### Message and Part Tables

Messages are stored in `message` table with JSON `data` column containing the full message structure. Parts are stored separately in `part` table with JSON `data` column. This hybrid approach allows efficient querying while preserving full message/part information.

Sources: [packages/opencode/src/session/session.sql.ts35-68](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session/session.sql.ts#L35-L68)

### Config Schema

The configuration schema ([packages/opencode/src/config/config.ts42-1010](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/config/config.ts#L42-L1010)
) includes:

| Field        | Type                             | Description               |
| ------------ | -------------------------------- | ------------------------- |
| `agent`      | `Record<string, Agent>`          | Agent configurations      |
| `provider`   | `Record<string, ProviderConfig>` | Provider settings         |
| `permission` | `Permission`                     | Global permission rules   |
| `plugin`     | `string[]`                       | Plugin specifiers         |
| `mcp`        | `Record<string, Mcp>`            | MCP server configurations |
| `command`    | `Record<string, Command>`        | Slash command templates   |
| `keybinds`   | `Keybinds`                       | TUI keybindings           |
| `compaction` | `CompactionConfig`               | Compaction settings       |

See [2.2](https://deepwiki.com/anomalyco/opencode/2.2-configuration-system)
for full schema documentation.

Sources: [packages/opencode/src/config/config.ts42-1010](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/config/config.ts#L42-L1010)

---

## Database and Storage

The application uses two storage systems:

1.  **SQLite Database** ([packages/opencode/src/storage/db.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/storage/db.ts)
    ): Stores sessions, messages, parts, projects, and stash entries using Drizzle ORM with better-sqlite3 driver. Database path: `~/.local/state/opencode/opencode.db`
2.  **File Storage** ([packages/opencode/src/storage/storage.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/storage/storage.ts)
    ): Stores large binary data (snapshots, diffs, patches) using JSON files. Storage path: `~/.local/state/opencode/storage/`

The system performs a one-time migration from legacy JSON storage to SQLite on first run ([packages/opencode/src/index.ts87-121](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/index.ts#L87-L121)
).

Sources: [packages/opencode/src/storage/db.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/storage/db.ts)
[packages/opencode/src/storage/storage.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/storage/storage.ts)
[packages/opencode/src/storage/json-migration.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/storage/json-migration.ts)

---

## Transport Modes

The SDK ([packages/sdk/js](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js)
) supports two transport modes:

1.  **Internal Transport**: Server runs in-process via `Server.Default`. The SDK client directly invokes server functions. Used by CLI commands and desktop apps.
2.  **HTTP Transport**: Server runs as separate process listening on a port. The SDK client makes HTTP requests. Used by VS Code extension, browser clients, and remote connections.

Sources: [packages/sdk/js/src/v2/create.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/src/v2/create.ts)
[packages/opencode/src/server/server.ts56-58](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/server/server.ts#L56-L58)

Dismiss

Refresh this wiki

Enter email to refresh

### On this page

- [Core Application](https://deepwiki.com/anomalyco/opencode/2-core-application#core-application)
- [Architecture Overview](https://deepwiki.com/anomalyco/opencode/2-core-application#architecture-overview)
- [Application Lifecycle](https://deepwiki.com/anomalyco/opencode/2-core-application#application-lifecycle)
- [Core Subsystems](https://deepwiki.com/anomalyco/opencode/2-core-application#core-subsystems)
- [Session Management](https://deepwiki.com/anomalyco/opencode/2-core-application#session-management)
- [Message and Part Structure](https://deepwiki.com/anomalyco/opencode/2-core-application#message-and-part-structure)
- [Configuration System](https://deepwiki.com/anomalyco/opencode/2-core-application#configuration-system)
- [Agent System](https://deepwiki.com/anomalyco/opencode/2-core-application#agent-system)
- [Provider Integration](https://deepwiki.com/anomalyco/opencode/2-core-application#provider-integration)
- [Tool Execution](https://deepwiki.com/anomalyco/opencode/2-core-application#tool-execution)
- [HTTP Server](https://deepwiki.com/anomalyco/opencode/2-core-application#http-server)
- [Event Bus](https://deepwiki.com/anomalyco/opencode/2-core-application#event-bus)
- [Plugin System](https://deepwiki.com/anomalyco/opencode/2-core-application#plugin-system)
- [Session Prompt Flow](https://deepwiki.com/anomalyco/opencode/2-core-application#session-prompt-flow)
- [Key Data Structures](https://deepwiki.com/anomalyco/opencode/2-core-application#key-data-structures)
- [Session Table Schema](https://deepwiki.com/anomalyco/opencode/2-core-application#session-table-schema)
- [Message and Part Tables](https://deepwiki.com/anomalyco/opencode/2-core-application#message-and-part-tables)
- [Config Schema](https://deepwiki.com/anomalyco/opencode/2-core-application#config-schema)
- [Database and Storage](https://deepwiki.com/anomalyco/opencode/2-core-application#database-and-storage)
- [Transport Modes](https://deepwiki.com/anomalyco/opencode/2-core-application#transport-modes)
