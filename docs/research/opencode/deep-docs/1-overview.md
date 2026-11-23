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

# Overview

Relevant source files

- [README.md](https://github.com/anomalyco/opencode/blob/7daea69e/README.md?plain=1)
- [bun.lock](https://github.com/anomalyco/opencode/blob/7daea69e/bun.lock)
- [packages/console/app/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/app/package.json)
- [packages/console/core/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/core/package.json)
- [packages/console/function/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/function/package.json)
- [packages/console/mail/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/mail/package.json)
- [packages/desktop/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/desktop/package.json)
- [packages/function/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/function/package.json)
- [packages/opencode/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/package.json)
- [packages/opencode/script/schema.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/schema.ts)
- [packages/opencode/src/auth/index.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/auth/index.ts)
- [packages/opencode/src/auth/service.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/auth/service.ts)
- [packages/opencode/src/cli/ui.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/ui.ts)
- [packages/opencode/test/provider/amazon-bedrock.test.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/test/provider/amazon-bedrock.test.ts)
- [packages/opencode/test/provider/gitlab-duo.test.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/test/provider/gitlab-duo.test.ts)
- [packages/plugin/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/plugin/package.json)
- [packages/sdk/js/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/package.json)
- [packages/web/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/package.json)
- [packages/web/src/components/Lander.astro](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/components/Lander.astro)
- [packages/web/src/content/docs/go.mdx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/go.mdx?plain=1)
- [packages/web/src/content/docs/index.mdx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/index.mdx?plain=1)
- [packages/web/src/content/docs/providers.mdx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/providers.mdx?plain=1)
- [packages/web/src/content/docs/zen.mdx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/zen.mdx?plain=1)
- [sdks/vscode/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/sdks/vscode/package.json)

## Purpose and Scope

This document provides a high-level overview of the OpenCode codebase, describing its purpose as an open source AI coding agent, the monorepo structure, core architecture patterns, and key capabilities. For detailed information about specific subsystems, see:

- Repository structure and package dependencies: [1.1](https://deepwiki.com/anomalyco/opencode/1.1-repository-structure-and-packages)
- Detailed architecture diagrams: [1.2](https://deepwiki.com/anomalyco/opencode/1.2-architecture-overview)
- Core application components: [2](https://deepwiki.com/anomalyco/opencode/2-core-application)
- User interface implementations: [3](https://deepwiki.com/anomalyco/opencode/3-user-interfaces)
- SDK and API details: [5](https://deepwiki.com/anomalyco/opencode/5-sdk-and-api)

---

## What is OpenCode

OpenCode is an open source AI coding agent that provides an alternative to proprietary solutions like Claude Code and GitHub Copilot. It is designed to be provider-agnostic, supporting 75+ LLM providers including OpenAI, Anthropic, Google, local models (Ollama, llama.cpp, LM Studio), and specialized services. The project emphasizes flexibility, extensibility, and user control.

**Key characteristics:**

- **Open source**: 100% open source under MIT license
- **Provider-agnostic**: Not coupled to any single LLM provider
- **Multiple interfaces**: Terminal UI (TUI), desktop apps, IDE extensions, web documentation
- **LSP integration**: Out-of-the-box Language Server Protocol support for 20+ languages
- **Client-server architecture**: Server can run locally or remotely

The codebase is organized as a monorepo containing the core server, multiple client implementations, SDK packages, and supporting infrastructure.

**Sources:** [README.md1-142](https://github.com/anomalyco/opencode/blob/7daea69e/README.md?plain=1#L1-L142)
[packages/web/src/content/docs/index.mdx1-361](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/index.mdx?plain=1#L1-L361)

---

## Repository Structure

The OpenCode repository is organized as a monorepo with three major subsystems and specialized services:

### Package Organization Diagram

### Core Platform

The core platform consists of five primary packages:

| Package             | Name                  | Purpose                                                                                                                  |
| ------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/opencode` | `opencode`            | Main application containing CLI, HTTP server, TUI, session management, provider integration, tool system, LSP management |
| `packages/sdk/js`   | `@opencode-ai/sdk`    | TypeScript client SDK exposing OpenAPI-based methods for interacting with the server                                     |
| `packages/plugin`   | `@opencode-ai/plugin` | Plugin system API and base types for extending OpenCode functionality                                                    |
| `packages/util`     | `@opencode-ai/util`   | Shared utilities used across packages (error handling, data structures)                                                  |
| `packages/script`   | `@opencode-ai/script` | Build scripts and tooling for compilation and release                                                                    |

**Sources:** [bun.lock1-638](https://github.com/anomalyco/opencode/blob/7daea69e/bun.lock#L1-L638)
[packages/opencode/package.json1-147](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/package.json#L1-L147)
[packages/sdk/js/package.json1-32](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/package.json#L1-L32)
[packages/plugin/package.json1-29](https://github.com/anomalyco/opencode/blob/7daea69e/packages/plugin/package.json#L1-L29)

### User Interfaces

OpenCode provides multiple interface options:

| Package                     | Name                            | Technology              | Purpose                                                               |
| --------------------------- | ------------------------------- | ----------------------- | --------------------------------------------------------------------- |
| `packages/app`              | `@opencode-ai/app`              | SolidJS                 | Shared UI business logic consumed by desktop apps                     |
| `packages/ui`               | `@opencode-ai/ui`               | SolidJS + Kobalte       | Component library with SessionTurn, MessagePart, Diff viewer (Pierre) |
| `packages/desktop`          | `@opencode-ai/desktop`          | Tauri + Rust            | Native desktop application (macOS, Windows, Linux)                    |
| `packages/desktop-electron` | `@opencode-ai/desktop-electron` | Electron                | Alternative desktop application                                       |
| `packages/web`              | `@opencode-ai/web`              | Astro                   | Static documentation site at opencode.ai/docs                         |
| `sdks/vscode`               | `opencode`                      | VS Code Extension API   | VS Code integration with command palette and terminal                 |
| Built-in TUI                | N/A                             | @opentui/core + SolidJS | Terminal user interface inside `opencode` package                     |

**Sources:** [bun.lock27-77](https://github.com/anomalyco/opencode/blob/7daea69e/bun.lock#L27-L77)
[bun.lock187-219](https://github.com/anomalyco/opencode/blob/7daea69e/bun.lock#L187-L219)
[bun.lock220-250](https://github.com/anomalyco/opencode/blob/7daea69e/bun.lock#L220-L250)
[bun.lock545-577](https://github.com/anomalyco/opencode/blob/7daea69e/bun.lock#L545-L577)
[sdks/vscode/package.json1-109](https://github.com/anomalyco/opencode/blob/7daea69e/sdks/vscode/package.json#L1-L109)

### Console Platform

The Console is a managed SaaS offering providing OpenCode Zen and OpenCode Go services:

| Package                     | Name                            | Purpose                                                               |
| --------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| `packages/console/core`     | `@opencode-ai/console-core`     | Business logic, database operations (Drizzle ORM), Stripe integration |
| `packages/console/app`      | `@opencode-ai/console-app`      | SolidStart frontend deployed to Cloudflare Pages                      |
| `packages/console/function` | `@opencode-ai/console-function` | Cloudflare Workers handling LLM requests with AI SDK                  |
| `packages/console/mail`     | `@opencode-ai/console-mail`     | Email templates using JSX Email                                       |
| `packages/console/resource` | `@opencode-ai/console-resource` | Shared TypeScript types for Cloudflare resources                      |

**Sources:** [bun.lock78-111](https://github.com/anomalyco/opencode/blob/7daea69e/bun.lock#L78-L111)
[bun.lock112-138](https://github.com/anomalyco/opencode/blob/7daea69e/bun.lock#L112-L138)
[bun.lock139-162](https://github.com/anomalyco/opencode/blob/7daea69e/bun.lock#L139-L162)
[bun.lock163-174](https://github.com/anomalyco/opencode/blob/7daea69e/bun.lock#L163-L174)
[packages/console/core/package.json1-52](https://github.com/anomalyco/opencode/blob/7daea69e/packages/console/core/package.json#L1-L52)

### Specialized Services

| Package               | Name                      | Purpose                                                     |
| --------------------- | ------------------------- | ----------------------------------------------------------- |
| `packages/function`   | `@opencode-ai/function`   | GitHub integration via Cloudflare Workers (Octokit, JWT)    |
| `packages/enterprise` | `@opencode-ai/enterprise` | Enterprise features including session sharing functionality |
| `packages/slack`      | `@opencode-ai/slack`      | Slack bot integration using @slack/bolt framework           |

**Sources:** [bun.lock280-295](https://github.com/anomalyco/opencode/blob/7daea69e/bun.lock#L280-L295)
[bun.lock251-279](https://github.com/anomalyco/opencode/blob/7daea69e/bun.lock#L251-L279)
[bun.lock453-465](https://github.com/anomalyco/opencode/blob/7daea69e/bun.lock#L453-L465)

---

## Core Architecture

### Client-Server Communication

OpenCode uses a flexible client-server architecture that supports both local (same-process) and remote (HTTP) operation modes. All clients communicate through the unified SDK layer.

**Key architectural components:**

| Component              | Location                                                                                                                 | Purpose                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| **Hono Server**        | [packages/opencode/src/server](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/server)         | HTTP server exposing REST + SSE endpoints                                |
| **SDK Transport**      | [packages/sdk/js/src/client.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/src/client.ts)       | Abstracts local vs. remote server communication                          |
| **Session Management** | [packages/opencode/src/session](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/session)       | Manages conversation state, messages, context compaction                 |
| **Provider Proxy**     | [packages/opencode/src/provider](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/provider)     | Normalizes requests across 20+ LLM providers                             |
| **Tool Registry**      | [packages/opencode/src/tool](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/tool)             | Executes tools (bash, edit, read, write, grep, glob, task, lsp-_, mcp-_) |
| **Permission System**  | [packages/opencode/src/permission](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/permission) | Enforces allow/deny/ask rules for tool execution                         |

The server can run in two modes:

1.  **Local mode**: Server runs in-process with the client (CLI/TUI default)
2.  **Remote mode**: Server runs separately, clients connect via HTTP

**Sources:** [packages/opencode/package.json1-147](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/package.json#L1-L147)
[packages/sdk/js/package.json1-32](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/package.json#L1-L32)

---

### Runtime Data Flow

The following diagram shows how user prompts flow through the system to generate AI responses with tool execution:

**Key runtime components:**

- **Agent types** (build, plan, explore): Different permission profiles and behavior patterns
- **AI SDK integration**: Uses Vercel AI SDK `streamText()` for streaming LLM responses with tool calling
- **Event Bus** (`GlobalBus`): Publishes events for file changes, tool execution, LLM streaming
- **SSE (Server-Sent Events)**: Streams real-time updates to connected clients
- **Context management**: Automatically compacts conversation history when approaching token limits

**Sources:** [packages/opencode/package.json58-142](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/package.json#L58-L142)

---

## Key Capabilities

### Multi-Provider LLM Support

OpenCode integrates with 75+ LLM providers through a unified abstraction layer:

**Provider categories:**

- **OpenCode services**: OpenCode Zen (pay-as-you-go), OpenCode Go ($10/month subscription)
- **Major providers**: OpenAI, Anthropic, Google (Gemini, Vertex AI), AWS Bedrock
- **Specialized providers**: Groq, Together AI, Cerebras, DeepSeek, Mistral, Cohere, Perplexity, xAI, Fireworks
- **Local models**: Ollama, llama.cpp, LM Studio
- **Enterprise**: GitLab Duo, Azure OpenAI, Cloudflare AI Gateway

Authentication methods include OAuth, API keys, environment variables, and bearer tokens. Provider configuration is managed through [packages/opencode/src/provider/provider.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/provider/provider.ts)
with authentication storage in [packages/opencode/src/auth](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/auth)

For details, see [Provider & Model Management](https://deepwiki.com/anomalyco/opencode/2.4-ai-provider-and-model-management)
and [Providers reference](https://deepwiki.com/anomalyco/opencode/9.1-providers-and-models)
.

**Sources:** [packages/web/src/content/docs/zen.mdx1-278](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/zen.mdx?plain=1#L1-L278)
[packages/web/src/content/docs/providers.mdx1-1000](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/providers.mdx?plain=1#L1-L1000)
[packages/opencode/package.json58-95](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/package.json#L58-L95)

### Tool System

OpenCode provides an extensible tool system for AI agents to interact with code and resources:

**Built-in tool categories:**

| Tool              | Purpose                     | Key features                                  |
| ----------------- | --------------------------- | --------------------------------------------- |
| `bash`            | Execute shell commands      | Tree-sitter parsing for security analysis     |
| `edit`            | Modify files                | 9 fallback strategies for fuzzy text matching |
| `read`            | Read files                  | LSP integration for symbol information        |
| `write`           | Create/overwrite files      | LSP diagnostics validation                    |
| `grep`            | Search file contents        | Uses ripgrep for performance                  |
| `glob`            | Pattern-based file matching | Uses ripgrep for performance                  |
| `task`            | Parallel agent execution    | Subtask management for complex operations     |
| `lsp-hover`       | Symbol information          | LSP hover provider                            |
| `lsp-diagnostics` | Code errors                 | LSP diagnostics                               |
| `lsp-definition`  | Go to definition            | LSP definition provider                       |
| `lsp-references`  | Find references             | LSP references provider                       |
| `mcp-read`        | Read MCP resources          | Database, API access                          |
| `mcp-prompt`      | Execute MCP prompts         | Templated queries                             |
| `web-fetch`       | Fetch URL content           | Markdown, HTML, text extraction               |

The tool system includes file integrity checks (timestamp validation), concurrency control (semaphores), and permission enforcement. Custom tools can be added via plugins.

For details, see [Tool System & Permissions](https://deepwiki.com/anomalyco/opencode/2.5-tool-system-and-permissions)
and [Plugin System](https://deepwiki.com/anomalyco/opencode/2.9-plugin-system)
.

**Sources:** [packages/opencode/package.json58-142](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/package.json#L58-L142)

### LSP Integration

OpenCode automatically manages Language Server Protocol servers for 20+ programming languages:

- **Auto-download**: LSP servers are downloaded on-demand
- **Root detection**: Automatically detects project roots (e.g., `tsconfig.json`, `Cargo.toml`)
- **Diagnostics**: Real-time error checking during file operations
- **Navigation**: Hover, definition, references available to AI agents

This enables AI agents to understand code semantics, navigate projects intelligently, and validate changes.

For details, see [LSP & Code Formatting](https://deepwiki.com/anomalyco/opencode/2.8-lsp-and-code-formatting)
.

**Sources:** [packages/opencode/package.json58-142](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/package.json#L58-L142)

### Session Management

OpenCode supports multiple concurrent sessions with shareable links:

- **Multi-session**: Work on multiple features simultaneously in separate sessions
- **Persistent state**: Sessions stored locally with conversation history
- **Context compaction**: Automatically summarizes history when approaching token limits
- **Shareable links**: Export sessions to [https://opencode.ai/s/{id}](https://opencode.ai/s/%7Bid%7D)
  for team collaboration

Sessions are disabled by default for privacy but can be enabled via configuration.

For details, see [Session & Agent System](https://deepwiki.com/anomalyco/opencode/2.3-session-and-agent-system)
.

**Sources:** [packages/web/src/content/docs/index.mdx338-353](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/content/docs/index.mdx?plain=1#L338-L353)

### Plugin System

OpenCode supports npm-based plugins for extending functionality:

- **Plugin types**: Tools, event handlers, shell environment modifications
- **Loading sources**: npm packages, local paths, global installations
- **Hook system**: `tool.execute.before/after`, `event`, `shell.env`
- **Configuration**: Specified in `opencode.json` `plugin` array

Example plugins include `@gitlab/opencode-gitlab-plugin` for GitLab API integration.

For details, see [Plugin System](https://deepwiki.com/anomalyco/opencode/2.9-plugin-system)
.

**Sources:** [packages/plugin/package.json1-29](https://github.com/anomalyco/opencode/blob/7daea69e/packages/plugin/package.json#L1-L29)

### MCP Integration

OpenCode integrates with Model Context Protocol (MCP) servers for external resource access:

- **Resource types**: Databases, APIs, file systems, custom data sources
- **MCP tools**: `mcp-read`, `mcp-prompt` for interacting with configured servers
- **User configuration**: MCP servers defined in `opencode.json` `mcp` section

This enables AI agents to query databases, access APIs, and retrieve context from external systems.

For details, see [MCP Integration](https://deepwiki.com/anomalyco/opencode/2.10-mcp-integration)
.

**Sources:** [packages/opencode/package.json87](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/package.json#L87-L87)

---

## Distribution

OpenCode is distributed through 8+ package managers and 3 application formats:

### Installation Methods

| Method             | Command                                          | Platform     |
| ------------------ | ------------------------------------------------ | ------------ |
| **Install script** | `curl -fsSL https://opencode.ai/install \| bash` | All          |
| **npm**            | `npm install -g opencode-ai`                     | All          |
| **Homebrew**       | `brew install anomalyco/tap/opencode`            | macOS, Linux |
| **Pacman**         | `sudo pacman -S opencode`                        | Arch Linux   |
| **AUR**            | `paru -S opencode-bin`                           | Arch Linux   |
| **Chocolatey**     | `choco install opencode`                         | Windows      |
| **Scoop**          | `scoop install opencode`                         | Windows      |
| **Nix**            | `nix run nixpkgs#opencode`                       | All          |
| **Docker**         | `docker run ghcr.io/anomalyco/opencode`          | All          |

**Desktop applications:**

- Tauri-based native apps: `.dmg` (macOS), `.exe` (Windows), `.deb`/`.rpm`/AppImage (Linux)
- Electron-based apps: Alternative desktop implementation
- Auto-update support via `latest.json` (Tauri) and `latest.yml` (Electron)

**Binary formats:**

- CLI binaries: 12+ platform variants (darwin-arm64, darwin-x64, linux-x64-glibc, linux-x64-musl, etc.)
- Compiled with Bun's native compiler for fast startup and small size

For details, see [Build & Release](https://deepwiki.com/anomalyco/opencode/8-build-and-release)
and [Release Pipeline](https://deepwiki.com/anomalyco/opencode/8.1-release-pipeline)
.

**Sources:** [README.md46-142](https://github.com/anomalyco/opencode/blob/7daea69e/README.md?plain=1#L46-L142)
[packages/web/src/components/Lander.astro1-598](https://github.com/anomalyco/opencode/blob/7daea69e/packages/web/src/components/Lander.astro#L1-L598)

---

## Configuration and Authentication

OpenCode uses a hierarchical configuration system with multiple sources:

### Configuration Files

| File            | Location                            | Purpose                                         |
| --------------- | ----------------------------------- | ----------------------------------------------- |
| `opencode.json` | Project root, `~/.config/opencode/` | Provider settings, agent config, plugins, tools |
| `auth.json`     | `~/.local/share/opencode/`          | API keys, OAuth tokens (mode 0600)              |
| `.env`          | Project root                        | Environment variables for credentials           |

**Configuration precedence** (highest to lowest):

1.  Remote configuration (OpenCode Console)
2.  Project-local `opencode.json`
3.  Global `~/.config/opencode/opencode.json`
4.  Environment variables
5.  Inline CLI arguments

**Authentication types:**

- **OAuth**: Refresh token, access token, expiry (e.g., Anthropic, GitLab)
- **API keys**: Simple bearer tokens
- **Well-known**: Pre-shared credentials for specific services
- **Environment variables**: Fallback for AWS, Azure, GitLab, etc.

Configuration schema is generated from Zod definitions via [packages/opencode/script/schema.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/schema.ts)
and published to [https://opencode.ai/config.json](https://opencode.ai/config.json)
for IDE autocomplete.

For details, see [Configuration System](https://deepwiki.com/anomalyco/opencode/2.2-configuration-system)
and [AI Provider & Model Management](https://deepwiki.com/anomalyco/opencode/2.4-ai-provider-and-model-management)
.

**Sources:** [packages/opencode/script/schema.ts1-64](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/script/schema.ts#L1-L64)
[packages/opencode/src/auth/index.ts1-58](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/auth/index.ts#L1-L58)
[packages/opencode/src/auth/service.ts1-102](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/auth/service.ts#L1-L102)

---

## Summary

OpenCode is a flexible, provider-agnostic AI coding agent with multiple interface options (CLI/TUI, desktop, IDE extensions) and comprehensive integration capabilities (LSP, MCP, Git, 75+ LLM providers). The codebase is organized as a monorepo with clear separation between core platform, user interfaces, console services, and specialized integrations. The client-server architecture with SDK abstraction enables both local and remote operation modes, supporting diverse deployment scenarios from individual developers to enterprise teams.

**Next steps:**

- For package-level details, see [Repository Structure & Packages](https://deepwiki.com/anomalyco/opencode/1.1-repository-structure-and-packages)
- For architectural deep-dives, see [Architecture Overview](https://deepwiki.com/anomalyco/opencode/1.2-architecture-overview)
- For server implementation details, see [Core Application](https://deepwiki.com/anomalyco/opencode/2-core-application)
- For UI implementation details, see [User Interfaces](https://deepwiki.com/anomalyco/opencode/3-user-interfaces)

Dismiss

Refresh this wiki

Enter email to refresh

### On this page

- [Overview](https://deepwiki.com/anomalyco/opencode/1-overview#overview)
- [Purpose and Scope](https://deepwiki.com/anomalyco/opencode/1-overview#purpose-and-scope)
- [What is OpenCode](https://deepwiki.com/anomalyco/opencode/1-overview#what-is-opencode)
- [Repository Structure](https://deepwiki.com/anomalyco/opencode/1-overview#repository-structure)
- [Package Organization Diagram](https://deepwiki.com/anomalyco/opencode/1-overview#package-organization-diagram)
- [Core Platform](https://deepwiki.com/anomalyco/opencode/1-overview#core-platform)
- [User Interfaces](https://deepwiki.com/anomalyco/opencode/1-overview#user-interfaces)
- [Console Platform](https://deepwiki.com/anomalyco/opencode/1-overview#console-platform)
- [Specialized Services](https://deepwiki.com/anomalyco/opencode/1-overview#specialized-services)
- [Core Architecture](https://deepwiki.com/anomalyco/opencode/1-overview#core-architecture)
- [Client-Server Communication](https://deepwiki.com/anomalyco/opencode/1-overview#client-server-communication)
- [Runtime Data Flow](https://deepwiki.com/anomalyco/opencode/1-overview#runtime-data-flow)
- [Key Capabilities](https://deepwiki.com/anomalyco/opencode/1-overview#key-capabilities)
- [Multi-Provider LLM Support](https://deepwiki.com/anomalyco/opencode/1-overview#multi-provider-llm-support)
- [Tool System](https://deepwiki.com/anomalyco/opencode/1-overview#tool-system)
- [LSP Integration](https://deepwiki.com/anomalyco/opencode/1-overview#lsp-integration)
- [Session Management](https://deepwiki.com/anomalyco/opencode/1-overview#session-management)
- [Plugin System](https://deepwiki.com/anomalyco/opencode/1-overview#plugin-system)
- [MCP Integration](https://deepwiki.com/anomalyco/opencode/1-overview#mcp-integration)
- [Distribution](https://deepwiki.com/anomalyco/opencode/1-overview#distribution)
- [Installation Methods](https://deepwiki.com/anomalyco/opencode/1-overview#installation-methods)
- [Configuration and Authentication](https://deepwiki.com/anomalyco/opencode/1-overview#configuration-and-authentication)
- [Configuration Files](https://deepwiki.com/anomalyco/opencode/1-overview#configuration-files)
- [Summary](https://deepwiki.com/anomalyco/opencode/1-overview#summary)
