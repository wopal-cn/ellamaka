# @wopal/ellamaka-cordis

Ellamaka's single cordis boundary package ([ellamaka design](../../docs/DESIGN.md) current
convention 1): every `@deepseek-ai/cordis` import in this repository
converges here.

## What this package provides

- `CordisHub` — a thin lifecycle wrapper around a cordis `Context`: mount
  plugins, dispose the container. The process-level dsh engine (serve/TUI)
  mounts on a hub's context.
- `dsh-web` subpath — `mountDshWeb` / `bootDshWeb` (web profile, native
  webserver) and `mountDshTools` / `bootDshTools` (ellamaka-tools profile,
  no webserver, agent-loop plugins disabled). These replay the dsh boot
  sequence on the host context — one process, one container ([dsh fusion foundation](../../docs/DESIGN-dsh-base.md)).
- `createCordisLogExporter` — routes every dsh plugin's `ctx.logger` output
  to its profile's dedicated log file (`dsh-plugins-<profile>.log`),
  independent of the ellamaka main log
  ([tool container design](../../docs/DESIGN-ellamaka-tools.md)).

## Mountable plugin list (Q3, rolling)

Conformance-verified dsh plugins ([tool container design](../../docs/DESIGN-ellamaka-tools.md)). Each entry records the
verified version and the gate that proves it.

| Plugin | Version | Gates |
|---|---|---|
| (none currently mounted) | — | — |

## Dependency notes

- The six deeply-coupled dsh packages (agent-loop/session/session-query/
  compaction/subagent/schedule) must never be runtime-loaded. This is gated
  by `test/forbidden-load.test.ts` ([ellamaka design](../../docs/DESIGN.md), runtime semantics).
