---
name: ellamaka-cordis rules
description: Long-lived DSH bridge ownership, runtime closure, profile, and verification rules
---

# Agent Development Rules

## Canonical References

- [Project rules](../../AGENTS.md)
- [DSH foundation](../../docs/DESIGN-dsh-base.md)
- [DSH Web profile](../../docs/DESIGN-dsh-web.md)
- [Ellamaka tools profile](../../docs/DESIGN-ellamaka-tools.md)

## Architecture and Directories

ellamaka-cordis is the product's DSH bridge, embedded in Ellamaka CLI and Desktop. It owns the DSH import boundary and adapts DSH to the host Server/runtime.

| Path | Responsibility |
|---|---|
| src/hub.ts | Cordis context boundary and lifecycle |
| src/dsh-web.ts | Assemble the web and ellamaka-tools profiles |
| src/dsh-virtual-webserver.ts | Register DSH routes/upgrades on the Ellamaka Server listener |
| src/runtime/ | Resolve and materialize the product runtime closure |
| src/plugins/ | Profile declaration, plugin composition, installation, and runtime updates |
| src/log-bridge.ts | Route Cordis plugin logs through Ellamaka logging |
| generated/ and script/ | Generated runtime manifest/lock and their generators |

Keep these ownership facts:

- All runtime imports of @deepseek-ai/cordis stay inside this package. The product closure supplies the runtime instance; an unrelated host copy is not a substitute.
- web is the DSH UI/session profile. ellamaka-tools is a session-free tool profile; do not move DSH Session/agent-loop providers into native Ellamaka tools.
- The Ellamaka Server owns the listening socket. VirtualWebServer registers and dispatches routes; it does not start a second listener.
- package.json dependencies are the direct version inputs. Never hand-edit generated runtime manifest/lock files; regenerate and check them through script/.
- Plugin/profile changes share the package's serialized update path. On failure report the effective runtime outcome rather than assuming the previous profile stayed active.
- Tests and diagnostics that touch DSH Home use an injected temporary Home and install anchor.

## Development Commands

Run from packages/ellamaka-cordis/.

| Scenario | Command | When |
|---|---|---|
| Full tests | bun test | All Cordis tests |
| Unit tests | bun run test:unit | Pure/module tests |
| Integration tests | bun run test:integration | Real Cordis composition |
| Typecheck | bun run typecheck | After TypeScript changes |
| Regenerate manifest | bun script/generate-dsh-runtime-manifest.ts | After closure input changes |
| Regenerate lock | bun script/generate-dsh-runtime-lock.ts | After closure input changes |
| Check manifest drift | bun script/generate-dsh-runtime-manifest.ts --check | Before delivery |

## Implementation Rules

- Keep the DSH bridge boundary in this package. Adapt demonstrated host differences without copying upstream subsystems or predicting private APIs.
- Keep the Server as listener owner and inject the selected product runtime/profile explicitly.
- Serialize persistent profile mutations and collect owned worker/child processes on cancellation or shutdown.
- Use ctx.logger with stable structured messages; redact user/config/credential values and bound upstream diagnostics.
- Validate runtime resolution and package-host behavior through the real product closure, not only source resolution.
- Keep bridges additive: introduce a new bridge as a new file or wrapper so deleting it is a complete rollback; do not restructure upstream files to make room.
- The Bridge stays out of the closure: it ships only with the Ellamaka product, is never published as a standalone registry package, and is never declared as a `$WOPAL_HOME/dsh` dependency.

## Testing

- Follow TDD at the real metadata, installer, profile, or container boundary being changed.
- Keep pure contract tests deterministic and put real container/host integration in the integration suite.
- Validate packaged closure resolution and Electron utility-process behavior through their host paths; source tests alone do not prove them.

## User-Supplied Rules

(None)
