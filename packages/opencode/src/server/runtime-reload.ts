/**
 * The unit-reload revision registry (DESIGN.md#unified-reload--lifecycle).
 *
 * Every reload unit (`global`, `instance:<directory>`, `dsh:web`,
 * `dsh:tools`) owns a monotonically increasing revision counter. A reload
 * that validated and published its new entry/route ATOMICALLY bumps the
 * counter and emits `runtime.reloaded` with `{unit, revision}`; a FAILED
 * reload never bumps — no fake revisions are published. Counters are
 * per-unit, so a `dsh:web` reload does not move `dsh:tools` or any
 * `instance:*` revision (unit independence, Plan Task 9).
 *
 * The registry lives in the server process next to the GlobalBus: emitters
 * are the host seams that own the unit's publish step (global lifecycle,
 * InstanceStore.reload, the DSH ReloadController). The module holds only
 * counters — no unit state, no restart semantics.
 */
import { GlobalBus } from "@/bus/global"

/** The reload units the event contract names (Plan Task 9 Interface). */
export type RuntimeReloadUnit = "global" | `instance:${string}` | "dsh:web" | "dsh:tools"

const revisions = new Map<RuntimeReloadUnit, number>()

/** The current revision of one unit; `0` before the unit's first reload. */
export function revisionOf(unit: RuntimeReloadUnit): number {
  return revisions.get(unit) ?? 0
}

/**
 * Bump one unit's revision and publish `runtime.reloaded` on the GlobalBus.
 * Call only AFTER the unit's new entry/route validated and published.
 */
export function emitRuntimeReloaded(unit: RuntimeReloadUnit): void {
  const next = (revisions.get(unit) ?? 0) + 1
  revisions.set(unit, next)
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: "runtime.reloaded",
      properties: { unit, revision: next },
    },
  })
}

/** Test seam: reset every counter (per-process state, never touched in production). */
export function resetRuntimeRevisions(): void {
  revisions.clear()
}

export * as RuntimeReload from "./runtime-reload"
