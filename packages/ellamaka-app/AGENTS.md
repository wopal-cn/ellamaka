---
name: ellamaka-app agent rules
description: Ellamaka Web UI built with SolidJS, Vite, and Tailwind CSS
---

# Agent Development Rules

## 1. Canonical References

- Project design: `../../docs/DESIGN.md`
- Workbench design: `../../docs/WORKBENCH.md`
- Desktop design: `../../docs/DESKTOP.md` — authoritative for Electron hosting and the shared sidecar/PTY lifecycle.
- Parent rules: `../../AGENTS.md`
- Backend rules: `../opencode/AGENTS.md`
- Desktop package rules: `../ellamaka-desktop/AGENTS.md` — required before a coordinated renderer/shell change.

## 2. Architecture and Directories

Execution chain: Vite dev server → SolidJS SPA → `@opencode-ai/sdk` → backend (`packages/opencode`) HTTP/WS API.

### Desktop Integration Boundary

`ellamaka-app` serves both browser Workbench and the `/workbench` renderer hosted by `ellamaka-desktop`. Electron owns the native window, preload API, and local sidecar lifetime; this package owns the shared Workbench layout, interaction, and PTY client lifecycle. Treat changes to platform integration, desktop startup/routing, macOS window chrome, sidecar readiness, or PTY create/probe/reconnect/release semantics as cross-package work: read `../../docs/DESKTOP.md` and `../ellamaka-desktop/AGENTS.md` before changing either side, and preserve the same PTY ownership contract in Web and Desktop.

| Directory | Responsibility |
|---|---|
| `src/app.tsx` / `src/entry.tsx` | Application root, routing composition, and Vite mount entry |
| `src/pages/` | Route-level page components |
| `src/pages/workbench/` | Workbench-specific implementation; follow the mandatory boundaries in section 5 of this file |
| `src/components/` | Reusable UI components |
| `src/context/` | SolidJS context definitions; `global-sync/` contains SSE event handling and state reconciliation |
| `src/utils/` | Pure utility functions |
| `src/i18n/` | Translations and locale configuration |
| `e2e/` | Playwright e2e tests |
| `script/` | Build, validation, and development scripts; `check-workbench-boundaries.ts` is the Workbench boundary static gate |

## 3. Development Commands

| Scenario | Command | When |
|---|---|---|
| Dev server | `bun run dev` | Local frontend development; requires backend running |
| Build | `bun run build` | Production build |
| Typecheck | `bun run typecheck` | After TypeScript changes |
| Unit tests | `bun run test:unit --force-exit` | After component, hook, or util changes |
| E2E tests | `bun run test:e2e` | After page, route, or user-flow changes |
| Workbench boundary check | `bun run check:workbench-boundaries` | After any `src/pages/workbench/` change |
| Workbench lint | `bun run lint:workbench` | Workbench code quality check |
| CSS lint | `bun run lint:css` | After any `src/**/*.css` change; must stay at 0 errors |

Unit tests must run through `bun run test:unit` (or `test:ci`), never raw `bun test`. The script adds `--conditions=browser --preload ./happydom.ts`; without the browser condition, `solid-js/web` resolves to its server build, which lacks the `use` export that `virtua/solid` imports, and component test files fail at module load.

Frontend-backend dev verification: `./scripts/dev.sh help`

## 4. Implementation Rules

- Backend communication goes through `@opencode-ai/sdk`; components must not call fetch against the backend directly.
- Typecheck uses `tsgo -b`; never run `tsc` directly.
- Extend upstream shared code through adapters, callbacks, or small injection points; never copy entire Session, command, Dialog, or navigation flows.
- `packages/ui` is never modified for Workbench presentation. All adaptation happens inside `ellamaka-app` through component wrappers, extension points (`FileComponentProvider`, `ThemeProvider.registerTheme`), and scoped CSS overrides. Whether a chat block is self-built or reuses an official renderer is a pragmatic per-block decision recorded in `docs/WORKBENCH.md` §4.6.6.
- SSE event handling: `server.connected` only restores transport and **does not trigger global refresh**; only `global.disposed` triggers full reconciliation. When changing SSE event handling, verify: UI state is preserved after reconnect, and `global.disposed` still triggers full refresh.
- SSE events are tiered by type: high-frequency property changes (title, message stream) are handled locally by the corresponding component; structural events (`session.created` / `session.deleted` / `session.updated` with `timeArchived`) trigger SessionTree refresh. SSE events must not trigger unrelated Panel or tree-level reloads.
- Canvas rendering must use an integral `devicePixelRatio`. Any canvas renderer that computes `canvas.width = cssSize * dpr` + `ctx.scale(dpr)` suffers from subpixel resampling when dpr is non-integral: the browser truncates the backing store to an integer while the context scale stays fractional, causing the compositor to resample the canvas texture and produce grid stripes aligned to character cells. Electron window zoom (e.g. 110%) compounds this by making `window.devicePixelRatio = nativeDpr × zoomFactor` non-integral (e.g. 2.2). The `Terminal` component already rounds `renderer.devicePixelRatio` to an integer; that fix must not be removed. Any new canvas rendering path (direct `<canvas>` usage or a new terminal renderer library) must also round the dpr before passing it to the renderer.

### 4.1 Workbench Chat Styling Discipline

These rules exist because chat transcript styling regressions (background disappearing, hover scrollbar jitter, theme-breaking code blocks) were caused by editing CSS against an imagined DOM instead of the rendered one. Follow them for every change under `src/index.css` that touches `src/pages/session/` chat blocks.

- **Inspect the rendered DOM before editing CSS.** The chat transcript is rendered by the self-built `WorkbenchMarkdown` (`workbench-markdown-renderer.tsx`) and tool block components, not the upstream `Markdown`. Code block wrappers (`markdown-code`), copy buttons, and shiki classes are produced at runtime. Never write an override from memory or from reading `packages/ui` CSS alone — first read the live `computedStyle`/box structure in the running Workbench, then target the real selectors.
- **Reference design tokens, never hardcode colors or spacing.** Use `var(--background-base)`, `var(--surface-*)`, `var(--border-*)`, `var(--text-*)`, etc. A hardcoded value cannot follow the theme. Verify the token's resolved value against the actual chat background — a token that equals the page background renders invisible (this is exactly how the code block lost its background).
- **`!important` is allowed only to override upstream inline styles** (e.g. shiki's `style="background-color:..."`) or third-party card chrome, and every use must carry a comment stating the reason. Keep them counted — stylelint surfaces each as a warning.
- **Hover-reveal scrollbars must reserve gutter space.** A scrollbar that appears on hover without `scrollbar-gutter: stable` shifts the content box and makes the block jump. Any `overflow: auto` content region that hides its scrollbar until hover must also set `scrollbar-gutter: stable` (or an equivalent layout reservation) so hover never changes layout.
- **Self-verify before handing off.** After editing chat CSS, run `bun run lint:css` (0 errors) and `bun run typecheck`, run the affected component tests, and confirm the visual result against the running Workbench (screenshot) before asking the user to review. Do not hand over an unverified styling change.

## 5. Mandatory Workbench Boundaries

This section applies to all code under `src/pages/workbench/` and to Workbench adaptations made in `src/components/`, `src/context/`, or `src/pages/session/`.

The implementation priority is fixed:

1. Preserve server resource and data truth.
2. Prevent General, Space, Panel, and Session identity from crossing scopes.
3. Preserve a single state owner and a single transaction entry point.
4. Address presentation, interaction, and styling last.

### 5.1 State Ownership

Every state category has exactly one canonical owner. Caches, projections, and persisted copies must not override canonical data.

| State | Canonical Owner | Allowed Workbench Representation | Forbidden |
|---|---|---|---|
| Session title, directory, timestamps, status | Server Session Projection | In-memory read-only projection, `boundSessionId` references | Persisting complete Sessions; fabricating Sessions in UI; overriding server fields with stale local data |
| Space, Tab, Panel layout | `WorkbenchStore` | Tabs, Panels, activePanel, viewMode, slotState, required reconnect hints | SDK calls, PTY disposal, navigation, or Toasts inside the Store |
| Whether a PTY process exists | Backend PTY registry | `PtyManager` runtime handle; PTY ID in layout is a reconnect hint only | Treating a UI boolean as process truth; hiding a clearly closed PTY without releasing it |
| Plugin, MCP, LSP, config load results | Directory-bound SDK/sync layer | In-memory projection for the current directory | Persisting lists; reusing results across directories; validating counts without source paths |
| Transient messages and dialogs | Workbench UI state | Short-lived, non-persisted state | Writing them into domain Stores or using them as domain truth |

`sessionStore` is read-only to UI consumers. Only the Session Projection adapter and SSE reconciliation may write to it; components, Dialogs, command handlers, and Workbench Actions must not fabricate or directly edit server-owned fields.

### 5.2 Identity and Directory Scope

General is not an alias for an empty path. Domain boundaries must use an explicit discriminated type:

```ts
type SpaceScope =
  | { kind: "general" }
  | { kind: "space"; name: string; path: string }
```

- Do not use `if (spacePath)`, `if (!spacePath)`, or `path || fallback` to distinguish General from a Space.
- Do not evaluate falsy string fallback expressions (e.g. `path || fallback` or `sessionDirectory || spacePath`) when constructing session or panel payloads for General scope. General path is canonically `""`, but scope recognition must always check `scope.kind === "general"`.
- Do not use `spaceName`, `panel.directory`, or a falsy string as the Space key.
- `SpaceScope` determines Session ownership and plugin composition; `panel.directory` determines the working directory for Panel SDK, file, terminal, and Session requests. They are not interchangeable.
- General loads only global plugins, global MCP servers, and global configuration; it must not inherit the most recently visited Space context.
- A Space loads the union of global capabilities and capabilities defined by that Space. Validation must compare complete source paths, not just counts.
- Convert strings from routes, localStorage, or the server into `SpaceScope` at the boundary. Internal code must not propagate the implicit contract that an empty string means General.

### 5.3 Dependency Direction and Shared Boundaries

The only allowed primary dependency direction is:

```text
UI components -> WorkbenchActions -> Store / PtyManager / directory-bound SDK / Projection adapter
```

- UI components render, collect user intent, and call Actions. They do not compose multi-step domain transactions.
- A component must not write two Stores in one operation, nor write a Store and then call the SDK or `PtyManager` directly.
- `WorkbenchStore` performs synchronous, pure state mutations only. It must not import the SDK, `PtyManager`, router, Toast, or Dialog.
- All operations that cross state owners go through `WorkbenchActions`, including load, replace, fork, bind, unbind, closePanel, closeSpace, and createSession.
- Dependency direction is one-way: shared code under `src/components/` and `src/pages/session/` must not reverse-depend on Workbench internals. When Workbench needs to extend a shared component, inject capabilities via adapter or callback; do not expose Workbench-specific parameters like `panelID`, `spacePath`, or `spaceName` on shared components.
- Shared components return generic results via callbacks such as `onCompleted` or `onForked`. A Workbench adapter then calls the Action.
- Migration adapters must live under Workbench, state their owner, deletion condition, and corresponding Plan Task. New callers must not adopt the legacy entry point.

### 5.4 Directory SDK and Context

- Each Panel subtree consumes one canonical `SDKProvider` bound to that Panel's `directory`.
- Workbench global surfaces such as StatusPopover and TopBar obtain directory context from the active `SpaceScope` and active Panel selector. They must not read the Context of the last mounted Panel.
- Directory clients are injected only by an explicit Provider or Action; components must not create them directly.
- Provider creation, ownership, and disposal must be fixed. Do not use nested Providers to hide scope bugs.
- When the directory changes, asynchronous results for the old directory must not update the new projection.
- Plugin, MCP, and configuration state must be keyed by normalized directory. Mount order and visibility are not scope.

### 5.5 Command Scope

- Workbench global commands are registered exactly once in the Workbench Shell.
- At execution time, read the active `SpaceScope`, Panel, and Session from the canonical selector. Do not capture a Panel's mount-time props in the command closure.
- Hidden, keep-alive, or inactive Panels must not register same-name global commands or replace the active Panel's registration.
- Unsupported commands are not registered. Do not use no-op handlers to make a command appear available.
- Shared Session commands accept only generic action adapters. Do not add Workbench-specific parameters to shared interfaces.

### 5.6 Transactions, Async Races, and PTY Lifecycle

Operations spanning Stores, SDK, and PTYs are not database transactions. `WorkbenchActions` must implement an explicit consistency boundary:

1. Validate `SpaceScope`, Panel, Session, and directory preconditions.
2. Assign a generation or cancellation token to the Panel operation.
3. Perform resource disposal and SDK side effects.
4. Confirm the operation is still the latest generation, then commit Store state once.
5. On failure, clean up resources created by this operation and preserve or restore an explainable previous state.

- close, unbind, and dispose operations must be idempotent. Repeated calls must not destroy newer resources.
- Late PTY, Session, plugin, or MCP results after a Panel closes or its directory changes must be discarded. A late PTY must still be released.
- Context, Store, and router hooks must be acquired during synchronous component initialization. Do not call hooks from Promises, timers, or event callbacks.
- Action behavior must not depend on component visibility. Hidden and visible Panels follow the same lifecycle contract.
- Each Action test must cover success, failure, repeated calls, and stale async results.

**PTY lifecycle and effect race protection** (high-frequency regression point; must be strictly observed):

- The `createEffect` guard for the TUI view in `view-registry` must depend only on `ctx.panel.viewMode`. AND-ing multiple state fields is forbidden. Return immediately when `viewMode !== "tui"`.
- Modifications to `viewMode` and `tuiPtyId` must be in the same SolidJS `batch`, and **viewMode must be switched to `chat` before clearing `tuiPtyId`**. The reverse triggers the effect to create a new PTY in the intermediate state (viewMode=tui + tuiPtyId=undefined).
- TUI process normal exit scenario: the backend `proc.onExit` has already cleaned up the session, so the frontend `exitTui` **must not send a DELETE request**. It only clears local state (viewMode + tuiPtyId + ptyManager memory), avoiding 404 PtyNotFoundError.
- User-initiated close scenario (`closePanel` / `unbindPanel`): synchronously clear PTY state first (switch to chat + clear tui/term/split ptyIds + close split terminal), then `await disposePanel`, then `removePanel` / `commitSessionUnbinding`. Clearing state first makes the effect guard return early, preventing PTY respawn during the await.
- PTY dispose treats 404 PtyNotFoundError as idempotent success (backend already cleaned up). Local state is still cleared; no error is reported.
- **PTY State Real-time Invariant**: `panel.tuiPtyId` must stay strictly synchronized with the backend PTY lifetime. Whenever a PTY destruction event occurs (`pty.deleted` / SSE event / offline grace reap / terminal exit), the frontend global event listener and Store must immediately clear the matching `tuiPtyId`, even when the panel is in the background (`viewMode !== "tui"`), preventing stale blue active highlights from lingering in the header.
- **TUI Background Keepalive & User Control Invariant**: When switching to background views (such as `viewMode === "chat"`), changing tabs, or backgrounding the browser, as long as `panel.tuiPtyId` exists, `view-registry` must maintain the `<Terminal>` component mounted in a hidden DOM node (`display: none`) with an active WebSocket connection to keep the PTY alive. Unmounting `<Terminal>` or clearing `tuiPtyId` on view mode switches is strictly forbidden. Disconnection and cleanup are allowed ONLY when the user explicitly closes TUI/panel/tab or the shell process exits.
- Every PTY lifecycle action test must cover: success path + **effect does not rebuild PTY** + stale generation + idempotency when backend already cleaned up.

### 5.7 Persistence Rules

Allowed to persist:

- Space, Tab, and Panel layout.
- activePanel, viewMode, slotState, and other state required to restore the UI.
- PTY ID reconnect hints, which are not proof that a process exists.

Forbidden to persist:

- Complete Sessions, server titles, or message copies.
- Plugin, MCP, LSP, or directory configuration results.
- Transient messages, pending request state, or error Toasts.
- Data that can be projected again from the server or directory SDK.

The persistence schema must have a version and explicit migrations. Legacy reads may migrate layout fields only. Historical projections must never be injected back into server-owned domain state.

Workbench Chat model selection is isolated by Session. An explicit user selection is the authoritative model for that Session and must not be overwritten by an Agent default, a hidden Panel mount, or a same-value callback from a controlled selector. Without an explicit selection, resolve the model in this fixed order: the last visible user message's model, the Agent default, then an available-model fallback. Same-value Agent updates must be idempotent and must not write model persistence.

### 5.8 Core Design Constraints

The following constraints are derived from the Workbench design document (`../../docs/WORKBENCH.md`). They are cornerstones of architectural stability and must be observed during development. For full design intent and interaction flows, see the design document.

- **Derived state has no duplicate copy**: TUI liveness marker, Split Terminal process highlight, Session binding state, and directory health indication are all derived from canonical fields (e.g. `panel.tuiPtyId`, `panel.splitPtyId`, `boundSessionId`). Do not store duplicate markers in the UI layer.
- **View switching does not release PTY**: TUI ↔ Chat ↔ Context switching and Split Terminal collapse/expand only toggle visibility. PTY processes and WebSocket subscribers are not destroyed. PTY release only happens on Panel close, Space Tab close, or Session unbinding.
- **Hydration gate**: `wb.ready()` is the only Workbench Bootstrap Gate. Before hydration completes, do not render Workspace, create PTYs, or process side-effect events. After hydration, mount the current Space and probe its persisted PTY IDs. Other restored Spaces follow demand-driven mounting on first visit.
- **Demand-driven Space Keep-Alive**: restored Tabs do not imply runtime demand. Initially mount only the current Space; mount another Space on its first visit, then keep its Panels mounted until explicit close. Non-current mounted Spaces use `position: absolute; visibility: hidden; inert`, never `display: none` (Ghostty sizes zero out). Backgrounding an activated Panel must preserve its draft, scroll position, and terminal connections.
- **Runtime demand**: only opened/created Panel Sessions acquire directory capabilities. Empty Panels, tab layout, session-tree rows, activity/unread indicators, and notification metadata are passive reads. They must not create directory stores with active queries or load plugins. Space file browsing and file previews use root-scoped file readers, not Session instances. Active directory status is absent for an empty Panel; server health remains available independently.
- **Reconnect demand boundary**: restoring `localStorage` mounts and restores only the current Space. After backend/sidecar restart while the page stays open, reconcile sessions and restore PTY connections only for the visible Space (all Panels currently shown there). Hidden keep-alive Spaces retain DOM, drafts, and reconnect hints but must not recreate a directory instance, load plugins, or reconnect a PTY until the user returns to that Space.
- **SSE event tiering**: high-frequency property changes (title, message stream) are handled locally by the corresponding component; structural events (`session.created` / `session.deleted` / `session.updated` with `timeArchived`) trigger SessionTree refresh. `message.part.*` only updates the corresponding PanelChat.
- **CLI unavailable degradation**: when CLI is missing, broken, or version-incompatible, General Session, Chat, TUI, and PTY remain available; Space Control is suspended. The repair action is triggered by user confirmation in the diagnostics center. After recovery, the system re-probes automatically without restarting the sidecar.
- **Offline input isolation**: when `runtime.status === "offline"`, the Shell displays a connection protection overlay at the top level and sets the workbench surface to `inert`, blocking all user input. After connection restores, isolation is automatically lifted and the current scene is preserved.
- **Errors must not throw to ErrorBoundary**: local non-blocking errors (e.g. `locations` API fetch failure) must not throw to the Panel ErrorBoundary and cause unmount. Errors enter the diagnostics queue uniformly, displayed at the status bar center with retry/dismiss entry points.
- **PTY resource key**: a PTY is uniquely identified by `spacePath + panelId + resourceKind` (`tui` / `term` / `split`). PTY IDs are persisted as reconnect hints, but process liveness truth belongs to the sidecar PTY Session Registry. The frontend must probe before use.
- **Single-tab mutual exclusion**: `WorkbenchSingletonGuard` acquires an exclusive lock via the Web Locks API. A second tab opening the workbench sees a notice page and does not initialize. The lock is released automatically by the browser when the tab closes.
- **Chat focus ownership**: only the active Chat Panel in the current Space Tab may programmatically focus or restore the Prompt. Hidden, keep-alive, or inactive Panels must relinquish shared-input focus restoration through a generic callback. Panel activation must not clear a user's message-text selection, terminal focus, or an already placed editor caret.

### 5.9 Tests and Acceptance Evidence

Workbench behavior changes follow RED, GREEN, REFACTOR:

- Before fixing a bug, add a failing test that reproduces it and names the user-visible behavior.
- Prefer real Store, Provider, Action, and component composition. Use a controlled fake only at the SDK transport boundary. Do not mock the ownership boundary under test.
- Typecheck, static `rg` output, and plugin counts are supporting evidence only. They do not replace behavior tests or source-path validation.
- Directory-state validation asserts normalized complete plugin and MCP paths and their sources, not only counts.
- Tests must cover the `General -> Space A -> Space B -> General` round trip. General contains global capabilities only; each Space contains global plus its own capabilities.
- Tests must cover multiple Panels, hidden Spaces, fork behavior, command targets, Session Projection reconnects, PTY close behavior, and late asynchronous results.
- PTY lifecycle action tests: see §5.6.
- Regression tests must confirm the real failure reason before the fix and rerun after the fix. Do not treat a harness error as a business RED.

Minimum verification chain (mandatory for all Workbench changes):

```bash
bun run check:workbench-boundaries
bun run test:unit --force-exit
bun run typecheck
```

### 5.10 Change Discipline and Blocking Patterns

- Before editing, state the behavior's owner, input scope, and single transaction entry point. Do not begin if these are unknown.
- One patch solves one verifiable behavior. Router reconstruction, command registration, fork binding, and Store refactoring require separate verification.
- Existing violations may migrate through compatibility adapters and an explicit technical-debt manifest. Do not add or expand debt.
- Do not rewrite, revert, or format unrelated uncommitted changes.

The following patterns are blocking issues:

- Using string truthiness or falsy fallback expressions (`path || fallback`, `if (spacePath)`) to distinguish General from a Space.
- Composing multi-step session tree loading or panel replacement in UI components or detached helpers instead of delegating to a single `WorkbenchActions` transaction entry point.
- A shared Workbench operation writing multiple Stores.
- A component composing `Store + SDK + PtyManager` directly.
- Network, PTY, router, Dialog, or Toast side effects inside a Store.
- A shared component importing a Workbench Store or Context.
- Calling Context or Store hooks from an asynchronous callback.
- Registering the same global command from every Panel.
- Letting hidden Panel mount order determine command or directory ownership.
- Persisting complete Sessions or directory capability lists.
- Claiming correctness from static matching, typecheck, or equal counts alone.

## 6. User-Supplied Rules

- Always use parallel tools when applicable.
