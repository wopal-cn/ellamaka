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

# User Interfaces

Relevant source files

- [packages/app/src/components/dialog-edit-project.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/components/dialog-edit-project.tsx)
- [packages/app/src/components/dialog-select-file.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/components/dialog-select-file.tsx)
- [packages/app/src/components/prompt-input.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/components/prompt-input.tsx)
- [packages/app/src/components/session-context-usage.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/components/session-context-usage.tsx)
- [packages/app/src/components/session/session-header.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/components/session/session-header.tsx)
- [packages/app/src/components/titlebar.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/components/titlebar.tsx)
- [packages/app/src/context/global-sync.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/context/global-sync.tsx)
- [packages/app/src/context/global-sync/session-prefetch.test.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/context/global-sync/session-prefetch.test.ts)
- [packages/app/src/context/global-sync/session-prefetch.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/context/global-sync/session-prefetch.ts)
- [packages/app/src/context/layout.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/context/layout.tsx)
- [packages/app/src/context/sync.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/context/sync.tsx)
- [packages/app/src/pages/layout.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/pages/layout.tsx)
- [packages/app/src/pages/layout/sidebar-items.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/pages/layout/sidebar-items.tsx)
- [packages/app/src/pages/layout/sidebar-project.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/pages/layout/sidebar-project.tsx)
- [packages/app/src/pages/layout/sidebar-workspace.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/pages/layout/sidebar-workspace.tsx)
- [packages/app/src/pages/session.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/pages/session.tsx)
- [packages/app/src/utils/agent.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/utils/agent.ts)
- [packages/opencode/src/cli/cmd/tui/app.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/app.tsx)
- [packages/opencode/src/cli/cmd/tui/attach.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/attach.ts)
- [packages/opencode/src/cli/cmd/tui/component/dialog-command.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/component/dialog-command.tsx)
- [packages/opencode/src/cli/cmd/tui/component/prompt/autocomplete.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/component/prompt/autocomplete.tsx)
- [packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx)
- [packages/opencode/src/cli/cmd/tui/context/args.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/context/args.tsx)
- [packages/opencode/src/cli/cmd/tui/context/exit.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/context/exit.tsx)
- [packages/opencode/src/cli/cmd/tui/context/local.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/context/local.tsx)
- [packages/opencode/src/cli/cmd/tui/context/sdk.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/context/sdk.tsx)
- [packages/opencode/src/cli/cmd/tui/routes/session/header.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/routes/session/header.tsx)
- [packages/opencode/src/cli/cmd/tui/routes/session/index.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx)
- [packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx)
- [packages/opencode/src/cli/cmd/tui/win32.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/win32.ts)
- [packages/opencode/src/command/index.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/command/index.ts)
- [packages/opencode/src/command/template/review.txt](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/command/template/review.txt)
- [packages/sdk/js/src/v2/client.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/sdk/js/src/v2/client.ts)

This page provides an orientation to the three first-party user interfaces shipped with opencode: the **Terminal UI** (TUI), the **Web Application**, and the **Desktop Application**. All three communicate with the same backend HTTP server over the `@opencode-ai/sdk`. The page describes the purpose, technology, and package location of each interface and how they relate to one another.

For detailed coverage of each interface, see the dedicated sub-pages:

- TUI internals → [Terminal User Interface (TUI)](<https://deepwiki.com/anomalyco/opencode/3.1-terminal-user-interface-(tui)>)
- Web app internals → [Web Application](https://deepwiki.com/anomalyco/opencode/3.2-web-application)
- Desktop app internals → [Desktop Application](https://deepwiki.com/anomalyco/opencode/3.3-desktop-applications)
- Shared component library used by the web and desktop apps → [UI Component Library](https://deepwiki.com/anomalyco/opencode/4-ui-component-library)
- The SDK used by all interfaces → [JavaScript SDK](https://deepwiki.com/anomalyco/opencode/5.1-javascript-sdk)
- The backend HTTP server all interfaces connect to → [HTTP Server & REST API](https://deepwiki.com/anomalyco/opencode/2.5-tool-system-and-permissions)

---

## At a Glance

| Interface           | Package path                         | Technology                                    | Connects to backend via                                            |
| ------------------- | ------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------ |
| Terminal UI (TUI)   | `packages/opencode/src/cli/cmd/tui/` | `@opentui/solid` (terminal renderer, SolidJS) | In-process (same binary) or HTTP/SSE                               |
| Web Application     | `packages/app/`                      | SolidJS + `@solidjs/router`                   | HTTP/SSE via `@opencode-ai/sdk`                                    |
| Desktop Application | `packages/desktop/`                  | Tauri v2 + embedded web app                   | Sidecar spawns `opencode` process; web layer connects via HTTP/SSE |

---

## Architecture Overview

The following diagram shows how each UI package relates to the backend and to shared libraries. All three UIs use the same `@opencode-ai/sdk` client to communicate with the opencode server, though the TUI can run the server in-process when invoked as a standalone CLI.

**Diagram: UI packages and their connections**

Sources: [packages/opencode/src/cli/cmd/tui/app.tsx115-199](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/app.tsx#L115-L199)
[packages/app/src/pages/layout.tsx94-107](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/pages/layout.tsx#L94-L107)
[packages/app/src/pages/session.tsx300-316](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/pages/session.tsx#L300-L316)
[packages/desktop/src/index.tsx1-50](https://github.com/anomalyco/opencode/blob/7daea69e/packages/desktop/src/index.tsx#L1-L50)

---

## Shared Architecture Patterns

All three UIs share common architectural patterns for state management and real-time updates, though the TUI implements them with terminal-specific primitives while the web/desktop apps use DOM-based libraries.

### Context-Based State Management

Both the web/desktop app and the TUI organize state into nested SolidJS contexts. Each context provides reactive stores and derived signals that components consume via `use*()` hooks.

**Diagram: Core context providers shared across UIs**

Sources: [packages/app/src/context/global-sync.tsx54-80](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/context/global-sync.tsx#L54-L80)
[packages/opencode/src/cli/cmd/tui/context/local.tsx17-48](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/context/local.tsx#L17-L48)
[packages/opencode/src/cli/cmd/tui/context/sdk.tsx1-50](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/context/sdk.tsx#L1-L50)

### Event-Driven Updates via SSE

All UIs subscribe to Server-Sent Events from the opencode HTTP server. The `GlobalBus` emits events for message updates, tool executions, permission requests, and file changes. Each UI processes these events to update its reactive stores.

| Event type             | Purpose                               | Handled by                                              |
| ---------------------- | ------------------------------------- | ------------------------------------------------------- |
| `message.created`      | New message added to session          | `GlobalSyncProvider`, `SyncProvider`                    |
| `message.part.updated` | Tool execution progress or completion | `SyncProvider`                                          |
| `permission.asked`     | Tool requires user approval           | `PermissionProvider` (web/desktop), inline prompt (TUI) |
| `worktree.ready`       | Project initialization complete       | `GlobalSyncProvider`                                    |

Sources: [packages/app/src/context/global-sync.tsx428-518](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/context/global-sync.tsx#L428-L518)
[packages/opencode/src/cli/cmd/tui/routes/session/index.tsx217-232](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx#L217-L232)

### Component Composition Patterns

Both UIs use a similar component hierarchy: a root layout component that manages global navigation and sidebar state, and a session component that renders the message timeline and prompt input.

**Diagram: Component hierarchy (web/desktop)**

Sources: [packages/app/src/pages/layout.tsx94-599](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/pages/layout.tsx#L94-L599)
[packages/app/src/pages/session.tsx300-900](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/pages/session.tsx#L300-L900)

---

## Terminal UI (TUI)

The TUI is built directly into the `opencode` CLI binary (the `packages/opencode` package). It is launched by the `opencode` command and renders directly to the terminal using the `@opentui/solid` renderer, which maps a SolidJS reactive tree to terminal cells at up to 60 FPS.

The TUI entry point is the `tui()` function in [packages/opencode/src/cli/cmd/tui/app.tsx115-199](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/app.tsx#L115-L199)
It wraps the application in a stack of SolidJS context providers and calls `render()` from `@opentui/solid`. The top-level `App` component switches between two routes: `Home` (session list) and `Session` (active session view).

**Diagram: TUI component hierarchy**

Sources: [packages/opencode/src/cli/cmd/tui/app.tsx115-199](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/app.tsx#L115-L199)
[packages/opencode/src/cli/cmd/tui/routes/session/index.tsx116-260](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx#L116-L260)

**Key modules:**

| Module         | Path                                                | Role                                                           |
| -------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| `tui()`        | `src/cli/cmd/tui/app.tsx`                           | Entry point, provider tree, `render()` call with 60 FPS target |
| `App`          | `src/cli/cmd/tui/app.tsx`                           | Top-level component; route switching, terminal title updates   |
| `Home`         | `src/cli/cmd/tui/routes/home`                       | Session list screen with fuzzy search                          |
| `Session`      | `src/cli/cmd/tui/routes/session/index.tsx`          | Active session screen with scrollable message timeline         |
| `Prompt`       | `src/cli/cmd/tui/component/prompt/index.tsx`        | Multi-line `TextareaRenderable` with file/agent autocomplete   |
| `Autocomplete` | `src/cli/cmd/tui/component/prompt/autocomplete.tsx` | `@` file/agent and `/` slash-command popover with fuzzy search |
| `Sidebar`      | `src/cli/cmd/tui/routes/session/sidebar.tsx`        | Diffs, todos, MCP server status, cost/token metrics            |
| `Header`       | `src/cli/cmd/tui/routes/session/header.tsx`         | Session title, model indicator, agent color bar                |
| `Footer`       | `src/cli/cmd/tui/routes/session/footer.tsx`         | Status messages, interrupt prompt                              |

**Context providers in the TUI provider tree** (outermost → innermost):

    ArgsProvider → ExitProvider → KVProvider → ToastProvider →
    RouteProvider → TuiConfigProvider → SDKProvider → SyncProvider →
    ThemeProvider → LocalProvider → KeybindProvider → PromptStashProvider →
    DialogProvider → CommandProvider → FrecencyProvider →
    PromptHistoryProvider → PromptRefProvider → App

### TUI-Specific Implementation Details

The TUI uses `@opentui/core` primitives for rendering:

- `BoxRenderable` for layout containers
- `ScrollBoxRenderable` for scrollable message timelines with custom scroll acceleration
- `TextareaRenderable` for the prompt input with extmark support (virtual text overlays for `@mentions`)
- `TextAttributes` and `RGBA` for styling (colors, bold, dim, underline)

The prompt component tracks file attachments and agent mentions as "extmarks" (virtual text ranges) that overlay the actual buffer content. When the user types `@` followed by a filename, the autocomplete creates an extmark with a styled background, and the underlying buffer stores a reference to the file URL.

Sources: [packages/opencode/src/cli/cmd/tui/routes/session/index.tsx1-240](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx#L1-L240)
[packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx61-388](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx#L61-L388)
[packages/opencode/src/cli/cmd/tui/component/prompt/autocomplete.tsx1-400](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/component/prompt/autocomplete.tsx#L1-L400)
[packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx15-200](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx#L15-L200)

---

## Web Application

The web app lives in `packages/app/` and is a SolidJS single-page application that connects to an opencode server via `@opencode-ai/sdk`. It is the UI embedded inside the desktop app, and it is also usable standalone in a browser when pointed at a running server.

The root component is `app.tsx`, which sets up routing and global providers. Navigation is handled by `@solidjs/router` with URL structure `/:dir/session/:id` where `:dir` is a base64-encoded project directory path and `:id` is the session ID.

**Diagram: Web/Desktop routing and page structure**

Sources: [packages/app/src/pages/layout.tsx94-599](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/pages/layout.tsx#L94-L599)
[packages/app/src/pages/session.tsx300-900](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/pages/session.tsx#L300-L900)

**Key modules:**

| Module             | Path                                                     | Role                                                                                            |
| ------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `app.tsx`          | `packages/app/src/app.tsx`                               | Root component, routing, all global providers                                                   |
| `Layout`           | `packages/app/src/pages/layout.tsx`                      | Persistent shell: sidebar, project list, workspace management, drag-and-drop reordering         |
| `Session` (page)   | `packages/app/src/pages/session.tsx`                     | Session view: message timeline, review panel, terminal, prompt input                            |
| `PromptInput`      | `packages/app/src/components/prompt-input.tsx`           | Rich text `contenteditable` with file/agent `@` mentions, `/` slash commands, image attachments |
| `SessionHeader`    | `packages/app/src/components/session/session-header.tsx` | Top bar with project name, file search, share button, open-in-editor menu                       |
| `Titlebar`         | `packages/app/src/components/titlebar.tsx`               | Platform-aware title bar with back/forward navigation, traffic lights (macOS)                   |
| `GlobalSync`       | `packages/app/src/context/global-sync.tsx`               | Global SSE event stream, multi-project state management, session prefetching                    |
| `Layout` (context) | `packages/app/src/context/layout.tsx`                    | Sidebar/panel open state, tab management, panel widths, review diff style, workspace order      |

**Global context providers in the web app:**

    PlatformProvider → ServerProvider → GlobalSDKProvider → GlobalSyncProvider →
    LanguageProvider → ThemeProvider → SettingsProvider → LayoutProvider →
    NotificationProvider → PermissionProvider → CommandProvider →
    HighlightsProvider → ModelsProvider → Router → Layout → Session

### State Management Architecture

The web app uses a hierarchical state management system:

**Diagram: State management layers**

Sources: [packages/app/src/context/global-sync.tsx54-270](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/context/global-sync.tsx#L54-L270)
[packages/app/src/context/sync.tsx1-400](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/context/sync.tsx#L1-L400)
[packages/app/src/context/layout.tsx133-500](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/context/layout.tsx#L133-L500)

#### GlobalSyncProvider

`GlobalSyncProvider` manages state across all open projects simultaneously. It:

- Subscribes to the global SSE event stream from the server
- Maintains a `Map` of child stores, one per project directory
- Implements session prefetching: preloads messages for nearby sessions in the sidebar
- Enforces cache limits (max 10 sessions per directory with full message history)
- Applies event reducers that update child stores when SSE events arrive

Key functions:

- `child(directory, { bootstrap?: boolean })` — returns or creates the store for a directory
- `bootstrapInstance(directory)` — fetches initial state (config, project metadata, sessions)
- `loadSessions(directory)` — fetches recent sessions for the project

Sources: [packages/app/src/context/global-sync.tsx54-400](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/context/global-sync.tsx#L54-L400)
[packages/app/src/context/global-sync/bootstrap.ts1-200](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/context/global-sync/bootstrap.ts#L1-L200)
[packages/app/src/context/global-sync/session-prefetch.ts1-100](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/context/global-sync/session-prefetch.ts#L1-L100)

#### SyncProvider

`SyncProvider` wraps a single child store from `GlobalSyncProvider` and provides session-scoped state. It:

- Exposes `sync.data.*` accessors for messages, parts, diffs, todos, permissions
- Implements optimistic updates: adds messages/parts to the store before server confirmation
- Manages message pagination with cursors
- Provides `sync.session.sync(id)` to refresh a specific session
- Handles permission dialogs and question prompts

Sources: [packages/app/src/context/sync.tsx1-400](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/context/sync.tsx#L1-L400)

#### LayoutProvider

`LayoutProvider` manages UI state that persists across page reloads:

- Sidebar open/closed state
- Panel widths (review panel, file tree, session panel, terminal)
- Tab state per session (open file tabs, active tab)
- Workspace order and expansion state
- Review diff style preference (unified vs. split)

All state is persisted to `localStorage` using the `persisted()` utility and keyed by directory or session ID.

Sources: [packages/app/src/context/layout.tsx133-500](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/context/layout.tsx#L133-L500)
[packages/app/src/utils/persist.ts1-100](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/utils/persist.ts#L1-L100)

### Prompt Input System

The `PromptInput` component implements a rich text editor using a `contenteditable` div with custom handling for:

- **File mentions**: Typing `@` opens an autocomplete popover filtered by fuzzy search. Selecting a file inserts a styled span with `data-type="file"` and `data-path="..."`.
- **Agent mentions**: Typing `@agent-name` creates a span with `data-type="agent"` and `data-name="..."`.
- **Slash commands**: Typing `/` opens a command palette with builtin commands (e.g., `/share`, `/rename`) and custom skill commands.
- **Image attachments**: Drag-and-drop or paste images to attach them as base64-encoded data URLs.
- **History navigation**: Arrow up/down cycles through previous prompts stored in `localStorage`.

The component reconciles the DOM with a `Prompt` data structure (array of `ContentPart | FileAttachmentPart | AgentPart | ImageAttachmentPart`) on every input event, ensuring the internal state matches the visible DOM.

Sources: [packages/app/src/components/prompt-input.tsx103-1000](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/components/prompt-input.tsx#L103-L1000)
[packages/app/src/components/prompt-input/slash-popover.tsx1-300](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/components/prompt-input/slash-popover.tsx#L1-L300)
[packages/app/src/components/prompt-input/attachments.ts1-200](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/components/prompt-input/attachments.ts#L1-L200)

---

## Desktop Application

The desktop app is a Tauri v2 application in `packages/desktop/`. It embeds the web application (`packages/app/`) in a Tauri WebView and manages the lifecycle of an `opencode` sidecar process that provides the backend server.

**Diagram: Desktop app architecture and sidecar lifecycle**

Sources: [packages/desktop/src/index.tsx1-500](https://github.com/anomalyco/opencode/blob/7daea69e/packages/desktop/src/index.tsx#L1-L500)
[packages/desktop/src-tauri/src/lib.rs1-400](https://github.com/anomalyco/opencode/blob/7daea69e/packages/desktop/src-tauri/src/lib.rs#L1-L400)
[packages/desktop/src-tauri/src/cli.rs1-150](https://github.com/anomalyco/opencode/blob/7daea69e/packages/desktop/src-tauri/src/cli.rs#L1-L150)

The Rust backend (`src-tauri/src/lib.rs`) spawns the CLI binary via `src-tauri/src/cli.rs`, waits for the server to become ready, and then exposes Tauri commands that the TypeScript frontend calls via `invoke()`.

The TypeScript entry point (`src/index.tsx`) implements the `Platform` interface from `packages/app/src/context/platform.tsx`. This interface abstracts platform-specific capabilities (file pickers, update checking, notifications, OS-native path opening) so the shared web app can use them without knowing whether it is running in Tauri or a plain browser.

**Tauri command surface (Rust → TypeScript bridge):**

| Rust command           | Purpose                                                                    | Invoked by                           |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------------------ |
| `await_initialization` | Blocks until sidecar server is ready; streams `InitStep` progress          | App bootstrap in `src/index.tsx`     |
| `kill_sidecar`         | Kills the managed opencode sidecar process                                 | Window close handler                 |
| `open_path`            | Opens a directory or file in the named application (VS Code, Finder, etc.) | `SessionHeader` "Open in..." menu    |
| `check_app_exists`     | Checks whether an app (VS Code, Zed, etc.) is installed                    | `SessionHeader` menu item visibility |
| `resolve_app_path`     | Resolves app name to executable path (Windows)                             | `open_path` pre-check                |
| `install_cli`          | Installs the opencode CLI to `~/.opencode/bin` and updates `$PATH`         | Settings dialog                      |
| `wsl_path`             | Converts Windows↔Linux paths in WSL mode                                  | File path resolution                 |
| `get_display_backend`  | Returns the Linux display backend (Wayland/auto)                           | Window decoration setup              |
| `show_in_folder`       | Opens the system file manager at the given path                            | Context menu action                  |
| `check_update`         | Checks for app updates via Tauri's updater                                 | Update polling timer                 |
| `install_update`       | Downloads and installs an app update                                       | Update notification action           |
| `restart_app`          | Restarts the desktop app                                                   | Post-update flow                     |
| `send_notification`    | Displays an OS-native notification                                         | Permission/question alerts           |

### Platform Interface Implementation

The `Platform` interface defines methods that the web app calls to access platform-specific features. The desktop implementation uses Tauri's `invoke()` API to bridge from TypeScript to Rust:

The browser implementation provides no-op or limited fallbacks for these methods.

Sources: [packages/desktop/src/index.tsx61-500](https://github.com/anomalyco/opencode/blob/7daea69e/packages/desktop/src/index.tsx#L61-L500)
[packages/desktop/src-tauri/src/lib.rs90-400](https://github.com/anomalyco/opencode/blob/7daea69e/packages/desktop/src-tauri/src/lib.rs#L90-L400)
[packages/desktop/src-tauri/src/cli.rs1-100](https://github.com/anomalyco/opencode/blob/7daea69e/packages/desktop/src-tauri/src/cli.rs#L1-L100)
[packages/app/src/context/platform.tsx1-150](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/context/platform.tsx#L1-L150)

---

## How the Three UIs Share Code

The diagram below maps the shared packages to the consuming UIs.

**Diagram: Shared code dependencies across UIs**

Key shared modules and what each UI uses:

| Shared module                                       | TUI                   | Web App                     | Desktop                      |
| --------------------------------------------------- | --------------------- | --------------------------- | ---------------------------- |
| `@opencode-ai/sdk` — typed HTTP client + SSE events | ✓ (via `SDKProvider`) | ✓ (via `GlobalSDKProvider`) | ✓ (through embedded web app) |
| `@opencode-ai/ui` — SolidJS component library       | —                     | ✓                           | ✓ (through embedded web app) |
| `@opencode-ai/util` — path, encoding, binary utils  | ✓                     | ✓                           | ✓                            |

The TUI has its own component system (built on `@opentui/core` primitives) and does not use `@opencode-ai/ui`, which is designed for DOM environments.

Sources: [packages/opencode/src/cli/cmd/tui/app.tsx1-45](https://github.com/anomalyco/opencode/blob/7daea69e/packages/opencode/src/cli/cmd/tui/app.tsx#L1-L45)
[packages/app/src/app.tsx1-35](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/app.tsx#L1-L35)
[packages/desktop/src/index.tsx1-35](https://github.com/anomalyco/opencode/blob/7daea69e/packages/desktop/src/index.tsx#L1-L35)

Dismiss

Refresh this wiki

Enter email to refresh

### On this page

- [User Interfaces](https://deepwiki.com/anomalyco/opencode/3-user-interfaces#user-interfaces)
- [At a Glance](https://deepwiki.com/anomalyco/opencode/3-user-interfaces#at-a-glance)
- [Architecture Overview](https://deepwiki.com/anomalyco/opencode/3-user-interfaces#architecture-overview)
- [Shared Architecture Patterns](https://deepwiki.com/anomalyco/opencode/3-user-interfaces#shared-architecture-patterns)
- [Context-Based State Management](https://deepwiki.com/anomalyco/opencode/3-user-interfaces#context-based-state-management)
- [Event-Driven Updates via SSE](https://deepwiki.com/anomalyco/opencode/3-user-interfaces#event-driven-updates-via-sse)
- [Component Composition Patterns](https://deepwiki.com/anomalyco/opencode/3-user-interfaces#component-composition-patterns)
- [Terminal UI (TUI)](https://deepwiki.com/anomalyco/opencode/3-user-interfaces#terminal-ui-tui)
- [TUI-Specific Implementation Details](https://deepwiki.com/anomalyco/opencode/3-user-interfaces#tui-specific-implementation-details)
- [Web Application](https://deepwiki.com/anomalyco/opencode/3-user-interfaces#web-application)
- [State Management Architecture](https://deepwiki.com/anomalyco/opencode/3-user-interfaces#state-management-architecture)
- [GlobalSyncProvider](https://deepwiki.com/anomalyco/opencode/3-user-interfaces#globalsyncprovider)
- [SyncProvider](https://deepwiki.com/anomalyco/opencode/3-user-interfaces#syncprovider)
- [LayoutProvider](https://deepwiki.com/anomalyco/opencode/3-user-interfaces#layoutprovider)
- [Prompt Input System](https://deepwiki.com/anomalyco/opencode/3-user-interfaces#prompt-input-system)
- [Desktop Application](https://deepwiki.com/anomalyco/opencode/3-user-interfaces#desktop-application)
- [Platform Interface Implementation](https://deepwiki.com/anomalyco/opencode/3-user-interfaces#platform-interface-implementation)
- [How the Three UIs Share Code](https://deepwiki.com/anomalyco/opencode/3-user-interfaces#how-the-three-uis-share-code)
