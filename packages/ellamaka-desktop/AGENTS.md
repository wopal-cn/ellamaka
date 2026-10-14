---
name: ellamaka-desktop rules
description: Long-lived Electron shell, IPC, sidecar ownership, and verification rules
---

# Agent Development Rules

## Canonical References

- [Project rules](../../AGENTS.md)
- [Desktop design](../../docs/DESIGN-desktop.md)
- [App rules](../ellamaka-app/AGENTS.md) for renderer/shell changes

## Architecture and Directories

ellamaka-desktop is the Electron host for the shared ellamaka-app renderer. Main owns the native application/window and sidecar process lifecycle; the Server sidecar owns Runtime APIs and PTY processes.

| Path | Responsibility |
|---|---|
| src/main/ | App/window lifecycle, sidecar supervision, IPC registration, native credentials, and updates |
| src/preload/ | Small allowlisted API exposed to the renderer |
| src/renderer/ | Desktop entry, routing, platform adapters, and shared app loading |
| packages/ellamaka-app/ | Shared Browser/Desktop UI and renderer-owned layout state |
| packages/opencode/ | Server sidecar implementation, Session and PTY resource ownership |

Keep these ownership facts:

- Renderer calls the same authenticated Server/SDK surface used by Browser. Native OS abilities cross the typed preload bridge.
- Sidecar credentials remain in the Main process; never store or log them in renderer state, localStorage, URLs, or crash data.
- Renderer refresh/socket loss, explicit Panel/Space close, and application quit are different lifecycle events. Ordinary disconnect allows reconnect; explicit resource close is handled by the Server; application quit stops the sidecar and its owned children.
- Workbench layout and PTY reconnect references belong to the shared App. PTY IDs are hints; the sidecar is process truth.
- OpenCode upstream is a selective fix reference. Ellamaka release identity and packaged host behavior must be validated from Ellamaka artifacts.
- Brand/identity constants: productName `Ellamaka`; bundle id `ai.ellamaka.desktop.dev` (dev) / `ai.ellamaka.desktop` (prod); protocol `ellamaka://`; settings store `ellamaka.settings`; service name `ellamaka server`.
- Upstream baseline: the Electron shell uses OpenCode `packages/desktop` (v1.15.13 baseline) as a selective-backport reference — security/lifecycle fixes only, no whole-version upgrade; changes are tracked by git diff against that baseline.

## Development Commands

Run from packages/ellamaka-desktop/.

| Scenario | Command | When |
|---|---|---|
| Tests | bun test --preload ./electron-mock.ts --force-exit src | Main/preload/renderer logic |
| Typecheck | bun run typecheck | After TypeScript changes |
| Build | bun run build | After Desktop changes |
| Package macOS dev build | bun run package:mac | Packaging/resource checks |
| Dev server help | ./scripts/dev.sh help | Cross-package GUI validation |

Build the opencode sidecar with bun script/build-node.ts before the Desktop build when sidecar code changes.

## Implementation Rules

- Validate IPC inputs and keep preload methods allowlisted. Renderer never receives arbitrary Node, filesystem, or process access.
- Keep process exit, transport loss, and renderer reload distinct. Do not destroy backend resources from ordinary UI cleanup.
- Await sidecar and child-process cleanup before app quit; make lifecycle operations idempotent.
- Keep credentials inside their trusted process boundary and out of logs and persistent renderer storage.
- Check packaged resource paths and update metadata in the built app; development paths alone are insufficient.

## Testing

- Follow TDD with the Electron mock for unit-level lifecycle behavior.
- Test platform-specific lifecycle and packaging on the target OS. A build on another OS does not verify target quit/install behavior.
- Use real CDP/native runs for GUI behavior that unit tests cannot observe.

## User-Supplied Rules

(None)
