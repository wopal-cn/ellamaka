---
name: ellamaka-app agent rules
description: Long-lived SolidJS UI, state, async, and verification rules for Ellamaka App
---

# Agent Development Rules

## Canonical References

- [Project rules](../../AGENTS.md)
- [Workbench design](../../docs/DESIGN-workbench.md)
- [Desktop design](../../docs/DESIGN-desktop.md); for coordinated renderer/shell changes also read the [Desktop package rules](../ellamaka-desktop/AGENTS.md).
- [opencode package rules](../opencode/AGENTS.md) for backend-facing behavior.
- DESIGN-workbench owns the detailed state and interaction contracts; the rules below are the working constraints to follow without opening it.

## Architecture and Directories

ellamaka-app owns the shared Browser/Desktop renderer and the Official App BFF contract/client used by Onboarding/Workbench product projections. Platform capabilities use the published `@wopal/ellamaka-sdk`; app-specific BFF calls use the package's generated private client. Both reach the same Ellamaka Server. The Electron shell, credentials, and sidecar process belong to ellamaka-desktop.

| Path | Responsibility |
|---|---|
| src/app.tsx and src/entry.tsx | App entry and route composition |
| src/pages/workbench/ | Workbench state, actions, runtime health, Space queries, and renderer PTY client |
| src/pages/session/ | Shared Session and chat presentation |
| src/context/ | Server/SDK providers and server-event synchronization |
| src/components/ | Reusable UI components shared by routes |

Core ownership facts:

- WorkbenchStore owns persisted layout and binding references; view-store provides hydration/persistence context. Neither owns Server resources.
- Session/message data is a Server fact shown through a local projection. Persist only UI layout and references needed to reconnect, not a second copy of Server records.
- WorkbenchActions is the boundary for operations crossing stores, SDK requests, and PTY resources. Stores remain synchronous state owners; components express intent.
- SpaceScope identifies General versus a Space; panel directory selects the working directory for SDK/file/session requests. They are different identities. Never infer General from an empty or falsy path.
- A restored or hidden Space tab is saved UI state, not a request to activate a Runtime. Unknown transport failures are not authoritative resource deletion; ordinary disconnect is distinct from an explicit user close.
- The Server/sidecar owns PTY processes. Renderer PTY IDs are reconnect hints, not proof that a process exists.

## Development Commands

| Scenario | Command | When |
|---|---|---|
| Dev server | bun run dev | Local frontend development; backend must be running |
| Build | bun run build | Production build |
| Typecheck | bun run typecheck | After TypeScript changes |
| Unit tests | bun run test:unit --force-exit | After component, hook, or utility changes |
| E2E tests | bun run test:e2e | After route or user-flow changes |
| Workbench boundary check | bun run check:workbench-boundaries | After Workbench changes |
| Workbench lint | bun run lint:workbench | After Workbench changes |
| CSS lint | bun run lint:css | After CSS changes |
| Frontend/backend dev help | ./scripts/dev.sh help | Integrated development |

Unit tests must use the package script, which sets the browser condition and happy-dom preload; raw bun test resolves the wrong SolidJS renderer for component tests. Typecheck uses `tsgo -b`; never run `tsc` directly.

## Implementation Rules

- Use generated clients for Server communication: the public SDK for Runtime/WopalSpace platform operations and the app-private generated client for Official App BFF operations. Do not create handwritten fetch contracts, and do not put app-only projection DTOs into the public SDK.
- `packages/ui` is never modified for Workbench presentation. Adapt inside `ellamaka-app` through component wrappers, extension points (`FileComponentProvider`, `ThemeProvider.registerTheme`), and scoped CSS overrides.
- Extend shared Session, command, Dialog, and navigation flows through adapters, callbacks, or small injection points; never copy an entire upstream flow into this package.
- Keep canonical, derived, persisted, and transient UI state distinct. Do not persist live Server projections.
- Route cross-owner changes through WorkbenchActions. A component must not coordinate multiple stores, SDK calls, or PTY cleanup itself.
- Keep shared Session/components independent from Workbench internals; extend through adapters or callbacks.
- Bind the SDK provider to the owning directory. Reject stale async results when scope, directory, or Server identity changes.
- Distinguish transport failure from an authoritative not-found result. Preserve reconnect state when the outcome is unknown.
- Resource lifecycle follows user intent: view switches and ordinary disconnects do not mean explicit backend destruction.
- Acquire SolidJS context/hooks under their provider synchronously. Do not call hooks from asynchronous callbacks.
- Only the active visible input may restore prompt focus; preserve hidden-panel drafts and user selection.
- Update only the owner of a high-frequency stream/event; avoid refreshing unrelated trees or panels on reconnect.
- SSE events: `server.connected` only restores transport and does not trigger a global refresh; only `global.disposed` triggers full reconciliation. When changing SSE handling, verify UI state survives reconnect and `global.disposed` still refreshes.
- Canvas rendering must use an integral `devicePixelRatio`. A canvas that computes `width = cssSize * dpr` + `ctx.scale(dpr)` produces grid stripes when the dpr is non-integral (Electron zoom compounds this). The `Terminal` component already rounds it — do not remove that; any new canvas path (direct `<canvas>` or a new terminal renderer) must round the dpr too.
- Use design tokens and accessible semantics. Inspect rendered DOM when styling framework/renderer-generated markup; isolate adapters for private renderer APIs and fail safely on shape drift.
- Route recoverable local errors through the diagnostic channel instead of destroying an otherwise usable Workbench.

### Workbench Chat Styling

These rules apply to `src/index.css` changes that touch `src/pages/session/` chat blocks. Each exists because a regression shipped once — follow them instead of re-deriving the fix.

- **Inspect the rendered DOM before editing CSS.** The transcript is produced by the self-built `WorkbenchMarkdown` and tool blocks at runtime; never write an override from memory or from `packages/ui` CSS alone — read the live `computedStyle`/box structure in the running Workbench first.
- **Reference design tokens** (`var(--background-base)`, `var(--surface-*)`, `var(--border-*)`, `var(--text-*)`); never hardcode colors or spacing. A hardcoded value cannot follow the theme, and a token that resolves equal to the page background renders invisible.
- **`!important` only to override upstream inline styles** (e.g. shiki's `style="background-color:..."`) or third-party card chrome, and always with a comment stating the reason.
- **A hover-reveal scrollbar must reserve gutter space** (`scrollbar-gutter: stable`), so hover never changes layout.
- **Self-verify before handing off**: `bun run lint:css` (0 errors), `bun run typecheck`, the affected component tests, and a screenshot against the running Workbench.

## Testing

- Follow TDD at the Store/Provider/Action/component boundary. Controlled SDK fakes are allowed at the transport boundary.
- Verify stale replies, scope/Server changes, reconnect, hidden panels, explicit close, and resource cleanup when changing lifecycle behavior.
- Run boundary checks, browser-condition unit tests, and typecheck for Workbench changes; CSS changes also require CSS lint. Report GUI observations separately from automated evidence.

## User-Supplied Rules

- Always use parallel tools when applicable.
