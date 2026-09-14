---
name: ellamaka-cordis rules
description: DSH fusion bridge package — cordis container boundary, runtime closure materialization, plugin supply chain, and dual-profile assembly
---

# Agent Development Rules

## Canonical References

- Parent Rules: `../../AGENTS.md`
- Fusion foundation: `../../docs/DESIGN-dsh-base.md`
- Tool container: `../../docs/DESIGN-ellamaka-tools.md`
- Web profile: `../../docs/DESIGN-dsh-web.md`
- Main design: `../../docs/DESIGN.md`

## Architecture and Directories

This package is the bridge between ellamaka and the dsh runtime, compiled into the CLI binary and the Desktop sidecar. It owns three responsibilities at once: the single in-process cordis container entry, the materialization and dynamic loading of the dsh runtime closure, and the plugin supply chain.

| Directory | Responsibility |
|------|---------------|
| `src/hub.ts` | `CordisHub` — the repository's single cordis boundary, holding `Context` lifecycle |
| `src/dsh-web.ts` | Replays the dsh boot sequence per profile: `mountDshWeb` / `bootDshWeb` (web), `mountDshTools` / `bootDshTools` (ellamaka-tools) |
| `src/dsh-virtual-webserver.ts` | `VirtualWebServer` — implements the official WebServer contract, holding route and upgrade dispatch |
| `src/runtime/` | Runtime Manager: runtime manifest, embedded lock, closure materialization, installAnchor resolution and state machine |
| `src/plugins/` | Plugin supply chain: profile declaration, resolver, installer, composition, patch layer, HMR adapter, market install worker |
| `src/log-bridge.ts` | `createCordisLogExporter` — bridges plugin `ctx.logger` into the ellamaka `Log` system |
| `script/` | Build-time manifest and lock generators, with a `--check` drift gate |
| `generated/` | Committed build products: `dsh-runtime-manifest.json`, `dsh-runtime-lock.json` |
| `test/` | Package-level tests; `probe-*.ts` are manual mount probes, not unit tests |

## Development Commands

All commands run from `packages/ellamaka-cordis/`.

| Scenario | Command |
|----------|---------|
| Full test suite | `bun test` |
| Unit tests | `bun run test:unit` |
| Integration tests | `bun run test:integration` |
| Typecheck | `bun run typecheck` |
| Regenerate runtime manifest | `bun script/generate-dsh-runtime-manifest.ts` |
| Regenerate runtime lock | `bun script/generate-dsh-runtime-lock.ts` |
| Check generated-artifact drift | `bun script/generate-dsh-runtime-manifest.ts --check` |

## Implementation Rules

- **Single cordis boundary**: every `@deepseek-ai/cordis` import converges inside this package. Value imports are erased at build time and resolved at runtime via installAnchor. Production mount points always inject a closure-resolved context; the in-package fallback in `hub.ts` serves source-dev mode only.
- **Contracts are self-owned**: contract shapes are borrowed from dsh, but this package imports no dsh contract package and does not track its rc release surface. External plugins mount only after passing contract conformance smoke tests.
- **The Bridge stays out of the closure**: this package ships as part of the ellamaka release. It is never published as a standalone registry package, nor declared as a `$WOPAL_HOME/dsh/package.json` dependency.
- **Generated artifacts are never hand-edited**: the manifest and lock under `generated/` come from `script/`; `package.json` dependencies are the only edit source for dsh direct dependency versions. The upgrade flow is change versions, `bun install`, regenerate.
- **Test isolation**: any test, dump, or diagnostic that would touch `$WOPAL_HOME/dsh/home/profiles/` runs against a temp home by injecting `dshHome` / `installAnchor`.
- **No listening socket**: `VirtualWebServer` provides route registration and upgrade dispatch only; the listening port belongs to the ellamaka main server.
- **Bridges stay additive**: new bridges arrive as new files or wrappers, so deleting one is a complete rollback; upstream files are never restructured to make room.

## Testing

- Code changes follow TDD: write a failing test first, then implement to make it pass.
- Automated coverage is required for: the closure materialization state machine, manifest and lock generation and drift checks, plugin resolution and installation, profile declaration read/write, patch layer composition, and VirtualWebServer route dispatch.
- Integration tests cover paths that need a real cordis container assembly (`plugins-runtime.test.ts`, `dsh-web.test.ts`). They are grouped into `test:integration` and stay out of the default unit set.
- Cross-package behavior is carried by the opencode-side tests: `packages/opencode/test/cli/serve/dsh-mount.test.ts`, `packages/opencode/test/cli/cmd/tui/dsh-mount.test.ts`, `packages/opencode/test/server/dsh-single-port.test.ts`, and the `test/cli/cmd/dsh-*.test.ts` group. These must stay green after any change to this package.
- Real host boundaries (installAnchor resolution inside the packaged binary, Desktop utilityProcess mounting) rely on manual smoke runs via `test/probe-*.ts` against a real closure.

## User-Supplied Rules

(None)
