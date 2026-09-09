# @wopal/ellamaka-cordis

Ellamaka's single cordis boundary package (DESIGN-dsh-poc §7 current
convention 1): every `@deepseek-ai/cordis` import in this repository
converges here.

## What this package provides

- `CordisHub` — a thin lifecycle wrapper around a cordis `Context`: mount
  plugins, dispose the container. The process-level dsh engine (serve/TUI)
  mounts on a hub's context.
- `dsh-web` subpath — `mountDshWeb` / `bootDshWeb` (web profile, native
  webserver) and `mountDshTools` / `bootDshTools` (ellamaka-tools profile,
  no webserver, agent-loop plugins disabled). These replay the dsh boot
  sequence on the host context — one process, one container (DESIGN-dsh-poc
  §3).
- `createCordisLogExporter` — routes every dsh plugin's `ctx.logger` output
  to a dedicated log file (`dsh-plugins.log`), independent of the ellamaka
  main log (DESIGN-dsh-poc §6.4).

## Mountable plugin list (Q3, rolling)

Conformance-verified dsh plugins (DSH POC DESIGN §4.1). Each entry records the
verified version and the gate that proves it.

| Plugin | Version | Gates |
|---|---|---|
| (none currently mounted) | — | — |

## Dependency notes

- The six deeply-coupled dsh packages (agent-loop/session/session-query/
  compaction/subagent/schedule) must never be runtime-loaded. This is gated
  by `test/forbidden-load.test.ts` (§7 current convention, runtime semantics).
