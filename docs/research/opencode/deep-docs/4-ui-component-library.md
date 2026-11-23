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

# UI Component Library

Relevant source files

- [packages/app/src/pages/directory-layout.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/pages/directory-layout.tsx)
- [packages/app/src/pages/session/review-tab.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/pages/session/review-tab.tsx)
- [packages/enterprise/src/routes/share/\[shareID\].tsx](https://deepwiki.com/anomalyco/opencode/packages/enterprise/src/routes/share/%5BshareID%5D.tsx)
- [packages/ui/package.json](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/package.json)
- [packages/ui/src/components/basic-tool.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/basic-tool.tsx)
- [packages/ui/src/components/message-part.css](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/message-part.css)
- [packages/ui/src/components/message-part.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/message-part.tsx)
- [packages/ui/src/components/session-review.css](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/session-review.css)
- [packages/ui/src/components/session-review.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/session-review.tsx)
- [packages/ui/src/components/session-turn.css](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/session-turn.css)
- [packages/ui/src/components/session-turn.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/session-turn.tsx)
- [packages/ui/src/components/sticky-accordion-header.css](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/sticky-accordion-header.css)
- [packages/ui/src/context/data.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/context/data.tsx)
- [packages/ui/src/hooks/create-auto-scroll.tsx](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/hooks/create-auto-scroll.tsx)
- [packages/ui/src/pierre/index.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/pierre/index.ts)
- [packages/ui/src/pierre/worker.ts](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/pierre/worker.ts)

## Purpose and Scope

The `@opencode-ai/ui` package provides the foundational UI component library for OpenCode's frontend applications. It contains reusable SolidJS components, theming utilities, styling systems, and assets that are shared across the web application, desktop applications, and console frontend.

This page provides an overview of the package structure, dependencies, and component categories. For detailed information about specific subsystems:

- Component architecture and export patterns: see [Component Architecture & Exports](https://deepwiki.com/anomalyco/opencode/4.1-component-architecture-and-exports)
- Session UI and message rendering: see [Session Turn & Message Rendering](https://deepwiki.com/anomalyco/opencode/4.2-session-turn-and-message-rendering)
- Styling and theming: see [Styling System & Themes](https://deepwiki.com/anomalyco/opencode/4.3-styling-system-and-themes)
- General application components (Terminal, Diffs): see the `@opencode-ai/app` package documentation

---

## Package Structure

The `@opencode-ai/ui` package is organized into several logical subsystems that can be imported independently through well-defined export paths.

### Export Map Structure

**Sources:** [packages/ui/package.json6-25](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/package.json#L6-L25)

### Key Export Patterns

| Export Path         | Source Location                            | Purpose                           |
| ------------------- | ------------------------------------------ | --------------------------------- |
| `./*`               | `./src/components/*.tsx`                   | Individual component imports      |
| `./i18n/*`          | `./src/i18n/*.ts`                          | Internationalization utilities    |
| `./pierre`          | `./src/pierre/index.ts`                    | Pierre diff rendering utilities   |
| `./hooks`           | `./src/hooks/index.ts`                     | Shared SolidJS hooks              |
| `./context`         | `./src/context/index.ts`                   | Context providers                 |
| `./styles`          | `./src/styles/index.css`                   | Base CSS styles                   |
| `./styles/tailwind` | `./src/styles/tailwind/index.css`          | Tailwind-based styles             |
| `./theme`           | `./src/theme/index.ts`                     | Theme utilities and definitions   |
| `./icons/provider`  | `./src/components/provider-icons/types.ts` | Provider icon type definitions    |
| `./icons/file-type` | `./src/components/file-icons/types.ts`     | File icon type definitions        |
| `./icons/app`       | `./src/components/app-icons/types.ts`      | Application icon type definitions |

**Sources:** [packages/ui/package.json6-25](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/package.json#L6-L25)

---

## Core Dependencies

The UI package builds on several foundational libraries that provide core functionality:

### Dependency Architecture

**Sources:** [packages/ui/package.json44-75](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/package.json#L44-L75)

### Primary Dependencies by Category

| Category                  | Package               | Purpose                                                                    |
| ------------------------- | --------------------- | -------------------------------------------------------------------------- |
| **Framework**             | `solid-js`            | Reactive UI framework with fine-grained reactivity                         |
| **Accessible Components** | `@kobalte/core`       | Headless, accessible UI component primitives (dialogs, dropdowns, etc.)    |
| **Syntax Highlighting**   | `shiki`               | Fast, accurate syntax highlighting using TextMate grammars                 |
| **Markdown**              | `marked`              | Markdown to HTML parser with extensibility                                 |
| **Math Rendering**        | `katex`               | Fast, typographically-correct math rendering                               |
| **Diffs**                 | `@pierre/diffs`       | Side-by-side diff rendering with syntax highlighting                       |
| **Animations**            | `motion`              | Declarative animations for SolidJS                                         |
| **Virtualization**        | `virtua`              | Virtual scrolling for large lists (message history)                        |
| **Utilities**             | `@solid-primitives/*` | Collection of SolidJS utilities for bounds, media queries, lifecycle, etc. |

**Sources:** [packages/ui/package.json44-75](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/package.json#L44-L75)

---

## Component Categories

The UI package contains several categories of components, organized by their functional domain:

### Core Component Architecture

**Sources:** [packages/ui/src/components/session-turn.tsx1-542](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/session-turn.tsx#L1-L542)
[packages/ui/src/components/message-part.tsx1-1500](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/message-part.tsx#L1-L1500)
[packages/ui/src/components/session-review.tsx1-500](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/session-review.tsx#L1-L500)
[packages/ui/src/components/basic-tool.tsx1-252](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/basic-tool.tsx#L1-L252)

### Component Directory Structure

The components are organized by functionality:

| Category            | Key Components                                 | Purpose                                     |
| ------------------- | ---------------------------------------------- | ------------------------------------------- |
| **Session/Message** | `SessionTurn`, `MessagePart`, `AssistantParts` | Render conversation turns and message parts |
| **Tool Display**    | `BasicTool`, `GenericTool`, `ContextToolGroup` | Render tool calls (bash, edit, read, etc.)  |
| **Review/Diffs**    | `SessionReview`, `Diff`, `DiffChanges`         | Display file changes and review UI          |
| **Code Display**    | `Code`, `Markdown`                             | Syntax-highlighted code and markdown        |
| **Icons**           | `Icon`, `ProviderIcon`, `FileIcon`             | Icon rendering systems                      |
| **Primitives**      | `Button`, `Dialog`, `Accordion`, etc.          | Accessible base components                  |
| **Layout**          | `ScrollView`, `ResizablePanel`                 | Layout and structure components             |

**Sources:** [packages/ui/package.json8](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/package.json#L8-L8)

---

## Context Providers and State Management

The UI library provides several context providers that manage state and configuration across components:

### Context Provider Architecture

**Sources:** [packages/ui/src/context/data.tsx1-49](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/context/data.tsx#L1-L49)
[packages/app/src/pages/directory-layout.tsx14-29](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/pages/directory-layout.tsx#L14-L29)

### DataProvider Store Schema

The `DataProvider` is the central state management context that provides reactive access to session data:

| Store Key        | Type                               | Purpose                                           |
| ---------------- | ---------------------------------- | ------------------------------------------------- |
| `provider`       | `ProviderListResponse`             | Available LLM providers and models                |
| `session`        | `Session[]`                        | List of conversation sessions                     |
| `session_status` | `Record<sessionID, SessionStatus>` | Real-time status per session (idle/retry/working) |
| `session_diff`   | `Record<sessionID, FileDiff[]>`    | File changes per session                          |
| `message`        | `Record<sessionID, Message[]>`     | Messages grouped by session                       |
| `part`           | `Record<messageID, Part[]>`        | Message parts (text, tool, file, reasoning)       |

The store is consumed via the `useData()` hook and provides reactive updates when the underlying data changes through SSE events.

**Sources:** [packages/ui/src/context/data.tsx5-48](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/context/data.tsx#L5-L48)

## Integration with Frontend Applications

The UI library serves as a foundation for multiple frontend applications in the OpenCode ecosystem:

### Consumer Relationship

**Sources:** [packages/enterprise/src/routes/share/\[shareID\].tsx:1-400](https://deepwiki.com/anomalyco/opencode/4-ui-component-library)
, [packages/app/src/pages/directory-layout.tsx1-94](https://github.com/anomalyco/opencode/blob/7daea69e/packages/app/src/pages/directory-layout.tsx#L1-L94)

### Usage Patterns

Applications import from `@opencode-ai/ui` using the defined export paths:

The UI package provides the primitive components and contexts, while `@opencode-ai/app` builds higher-level features like `SyncProvider` and `LocalProvider` on top of these primitives.

**Sources:** [packages/ui/package.json6-25](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/package.json#L6-L25)
[packages/enterprise/src/routes/share/\[shareID\].tsx:1-10](https://deepwiki.com/anomalyco/opencode/4-ui-component-library)

---

## Build and Development

### Development Scripts

| Script              | Command                      | Purpose                                         |
| ------------------- | ---------------------------- | ----------------------------------------------- |
| `typecheck`         | `tsgo --noEmit`              | Type check without emitting files               |
| `dev`               | `vite`                       | Start Vite dev server for component development |
| `generate:tailwind` | `bun run script/tailwind.ts` | Generate Tailwind CSS utilities                 |

**Sources:** [packages/ui/package.json26-30](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/package.json#L26-L30)

### Build Configuration

The package uses several build tools:

- **Vite**: Development server and build tool
- **TypeScript**: Type checking using the native TypeScript compiler
- **Tailwind CSS**: Utility-first CSS framework via `@tailwindcss/vite`
- **Vite Plugins**:
  - `vite-plugin-solid`: SolidJS support
  - `vite-plugin-icons-spritesheet`: Icon sprite sheet generation

**Sources:** [packages/ui/package.json31-42](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/package.json#L31-L42)

---

## SessionTurn Component Architecture

The `SessionTurn` component is the primary container for rendering a conversation turn (user message + assistant response):

### SessionTurn Structure

**Sources:** [packages/ui/src/components/session-turn.tsx141-541](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/session-turn.tsx#L141-L541)

### SessionTurn Data Loading Pattern

The component uses memoized queries to load related data:

1.  **Find user message**: Binary search in `store.message[sessionID]` for the given `messageID`
2.  **Load message parts**: Read from `store.part[messageID]` (text, tool, file parts)
3.  **Find assistant responses**: Scan messages after the user message until next user message
4.  **Extract file diffs**: Read from `message.summary.diffs` for file change preview
5.  **Track active state**: Check if this turn is currently streaming via `pending()` memo

**Sources:** [packages/ui/src/components/session-turn.tsx169-281](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/session-turn.tsx#L169-L281)

### SessionTurn Rendering Logic

The component conditionally renders sections based on state:

| Section         | Condition                         | Content                                                  |
| --------------- | --------------------------------- | -------------------------------------------------------- |
| User Message    | Always                            | `<Message>` with text, attachments, agent/model metadata |
| Divider         | `compaction()` or `interrupted()` | Horizontal line with label                               |
| Assistant Parts | `assistantMessages().length > 0`  | `<AssistantParts>` with all response parts               |
| Thinking        | `showThinking()`                  | Shimmer animation while streaming, no visible parts yet  |
| Session Retry   | `status().type === 'retry'`       | Retry indicator when agent is retrying                   |
| File Diffs      | `edited() > 0 && !working()`      | Collapsible accordion with file changes                  |
| Error Card      | `error()` present                 | Red error card with unwrapped error message              |

**Sources:** [packages/ui/src/components/session-turn.tsx389-533](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/session-turn.tsx#L389-L533)

---

## MessagePart Component and Part Type System

The `MessagePart` component implements a dynamic part rendering system based on part types:

### Part Type Registry

**Sources:** [packages/ui/src/components/message-part.tsx157](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/message-part.tsx#L157-L157)
[packages/ui/src/components/message-part.tsx1-30](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/message-part.tsx#L1-L30)

### Part Rendering Flow

The `Part` component in `message-part.tsx` dynamically renders parts:

1.  **Check `PART_MAPPING`**: Look up custom component for `part.type`
2.  **Built-in types**: Handle `text`, `tool`, `file`, `reasoning` with specialized rendering
3.  **Tool expansion**: For `tool` parts, check tool name and render appropriate tool component
4.  **Context grouping**: Group consecutive `read`/`grep`/`glob`/`list` tools into `ContextToolGroup`
5.  **Fallback**: Use `GenericTool` for unknown MCP tools

**Sources:** [packages/ui/src/components/message-part.tsx690-786](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/message-part.tsx#L690-L786)

### Tool Info System

The `getToolInfo()` function maps tool names to UI metadata:

| Tool       | Icon                    | Title                      | Subtitle Source           |
| ---------- | ----------------------- | -------------------------- | ------------------------- |
| `read`     | `glasses`               | "Read file"                | `input.filePath` filename |
| `edit`     | `code-lines`            | "Edit file"                | `input.filePath` filename |
| `write`    | `code-lines`            | "Write file"               | `input.filePath` filename |
| `bash`     | `console`               | "Shell command"            | `input.description`       |
| `task`     | `task`                  | "Build/Plan/Explore Agent" | `input.description`       |
| `glob`     | `magnifying-glass-menu` | "Find files"               | `input.pattern`           |
| `grep`     | `magnifying-glass-menu` | "Search files"             | `input.pattern`           |
| `question` | `bubble-5`              | "Question"                 | N/A                       |
| Other MCP  | `mcp`                   | Tool name                  | `input` fields            |

**Sources:** [packages/ui/src/components/message-part.tsx226-334](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/message-part.tsx#L226-L334)

### Context Tool Grouping

The `groupParts()` function collapses consecutive context-gathering tools:

- Groups adjacent `read`, `glob`, `grep`, `list` tools
- Creates `PartGroup` of type `"context"` with refs to all parts
- Rendered as single `ContextToolGroup` with summary: "Gathered Context • 3 reads • 2 searches"
- Expandable to show individual tool calls
- Reduces visual clutter when agent reads many files

**Sources:** [packages/ui/src/components/message-part.tsx415-457](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/message-part.tsx#L415-L457)
[packages/ui/src/components/message-part.tsx788-883](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/src/components/message-part.tsx#L788-L883)

---

## Key Features

### Accessibility

Built on `@kobalte/core`, the UI library provides accessible components that follow WAI-ARIA guidelines. All interactive components include proper keyboard navigation, focus management, and screen reader support.

**Sources:** [packages/ui/package.json45](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/package.json#L45-L45)

### Syntax Highlighting

Uses `shiki` for fast, accurate syntax highlighting with TextMate grammars. Integrated with `marked-shiki` for markdown code blocks and supports custom transformers via `@shikijs/transformers`.

**Sources:** [packages/ui/package.json49-51](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/package.json#L49-L51)
[packages/ui/package.json61](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/package.json#L61-L61)

### Math Rendering

Supports LaTeX math rendering in markdown via `katex` and `marked-katex-extension`, enabling technical documentation and mathematical expressions in messages.

**Sources:** [packages/ui/package.json57-60](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/package.json#L57-L60)

### Internationalization

Includes i18n utilities exported via `./i18n/*` for multi-language support across the application. The `useI18n()` hook provides translation functions used throughout components.

**Sources:** [packages/ui/package.json9](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/package.json#L9-L9)

### Theming

Provides a comprehensive theme system with dark/light mode support, exported via `./theme/*`. Theme context can be imported via `./theme/context`.

**Sources:** [packages/ui/package.json17-19](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/package.json#L17-L19)

---

## Asset Management

The package includes static assets that can be imported by consuming applications:

### Font Assets

Custom fonts exported via `./fonts/*`:

- Monospace fonts for code display (`--font-family-mono`)
- Sans-serif fonts for UI text (`--font-family-sans`)

### Audio Assets

Sound effects exported via `./audio/*`:

- Notification sounds
- UI feedback sounds

**Sources:** [packages/ui/package.json23-24](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/package.json#L23-L24)

---

## Pierre Diff System

The package exports utilities from `./pierre` for rendering code diffs. This is built on the `@pierre/diffs` library and provides components for displaying side-by-side file changes with syntax highlighting.

The pierre system is used throughout OpenCode for:

- Showing file modifications before applying changes
- Review panels for AI-suggested edits
- Version control diff viewing

**Sources:** [packages/ui/package.json10-11](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/package.json#L10-L11)
[packages/ui/package.json48](https://github.com/anomalyco/opencode/blob/7daea69e/packages/ui/package.json#L48-L48)

Dismiss

Refresh this wiki

Enter email to refresh

### On this page

- [UI Component Library](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#ui-component-library)
- [Purpose and Scope](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#purpose-and-scope)
- [Package Structure](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#package-structure)
- [Export Map Structure](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#export-map-structure)
- [Key Export Patterns](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#key-export-patterns)
- [Core Dependencies](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#core-dependencies)
- [Dependency Architecture](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#dependency-architecture)
- [Primary Dependencies by Category](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#primary-dependencies-by-category)
- [Component Categories](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#component-categories)
- [Core Component Architecture](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#core-component-architecture)
- [Component Directory Structure](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#component-directory-structure)
- [Context Providers and State Management](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#context-providers-and-state-management)
- [Context Provider Architecture](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#context-provider-architecture)
- [DataProvider Store Schema](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#dataprovider-store-schema)
- [Integration with Frontend Applications](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#integration-with-frontend-applications)
- [Consumer Relationship](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#consumer-relationship)
- [Usage Patterns](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#usage-patterns)
- [Build and Development](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#build-and-development)
- [Development Scripts](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#development-scripts)
- [Build Configuration](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#build-configuration)
- [SessionTurn Component Architecture](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#sessionturn-component-architecture)
- [SessionTurn Structure](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#sessionturn-structure)
- [SessionTurn Data Loading Pattern](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#sessionturn-data-loading-pattern)
- [SessionTurn Rendering Logic](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#sessionturn-rendering-logic)
- [MessagePart Component and Part Type System](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#messagepart-component-and-part-type-system)
- [Part Type Registry](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#part-type-registry)
- [Part Rendering Flow](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#part-rendering-flow)
- [Tool Info System](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#tool-info-system)
- [Context Tool Grouping](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#context-tool-grouping)
- [Key Features](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#key-features)
- [Accessibility](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#accessibility)
- [Syntax Highlighting](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#syntax-highlighting)
- [Math Rendering](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#math-rendering)
- [Internationalization](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#internationalization)
- [Theming](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#theming)
- [Asset Management](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#asset-management)
- [Font Assets](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#font-assets)
- [Audio Assets](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#audio-assets)
- [Pierre Diff System](https://deepwiki.com/anomalyco/opencode/4-ui-component-library#pierre-diff-system)
