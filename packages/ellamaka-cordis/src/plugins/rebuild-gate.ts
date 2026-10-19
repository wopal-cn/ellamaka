import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The `dsh:web` external-rebuild gate (DESIGN.md#unified-reload--lifecycle
 * 两级重载: hot replay vs cold reload).
 *
 * The web container runs in a child process that owns its own composition
 * watcher: editing the profile patch layer or the manifest's bundle rows
 * replays IN PLACE inside that child (`reconcileProfilePatches`), which keeps
 * the iframe, its WebSocket and its session alive.
 *
 * The host-side Plugin Runtime Service watches the SAME files, but its only
 * lever on this unit is an external rebuild — spawn a new child, publish a new
 * revision, emit `runtime.reloaded`. Doing that for a config edit costs a full
 * boot (seconds) and every live WebSocket drops, which reads as an endless
 * reconnect in the Web UI. A cold rebuild is therefore reserved for the change
 * that genuinely needs a fresh module graph: a DEPENDENCY change (module
 * resolution already happened at boot and cannot be un-imported).
 *
 * This gate turns "the unit's files changed" into "did the dependency set
 * change?". Everything else is already applied by the child.
 */

/**
 * A stable fingerprint of one profile's `dependencies` block.
 *
 * Deliberately ignores `dsh.profile.bundles` (enable/disable rows), every
 * other manifest field, and the patch layer: those are composition, which the
 * child replays itself. Key order inside `dependencies` is normalized so an
 * idempotent rewrite of the same set does not look like a change.
 */
export function dependencySnapshot(profileDir: string): string {
  // Read the raw document instead of the parsed manifest: a corrupt manifest
  // must throw here (the replay then keeps its last good state) rather than
  // silently answering "unchanged".
  const raw: unknown = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf-8"))
  const dependencies =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as { dependencies?: unknown }).dependencies
      : undefined
  if (dependencies === undefined) return "{}"
  if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
    return JSON.stringify(dependencies)
  }
  const entries = Object.entries(dependencies).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify(entries)
}

export interface DependencyRebuildGateOptions {
  /** The profile directory whose manifest carries the dependency set. */
  profileDir: string
  /** Spawn the replacement unit (the host's cold rebuild). */
  rebuild(): Promise<void>
  /** Snapshot override for tests; defaults to {@link dependencySnapshot}. */
  readSnapshot?: (profileDir: string) => string
}

/**
 * Create the gate for one profile.
 *
 * The constructor captures the boot baseline IMMEDIATELY: the child was built
 * from exactly the dependencies on disk at construction time. Capturing it
 * lazily on the first callback would swallow the first real change (the
 * callback only runs when files changed, so "first observation" is already
 * after the edit).
 *
 * Call the returned function whenever the profile composition changed: it
 * rebuilds only when the dependency set moved, and adopts the observation on
 * success. A failed rebuild keeps the previous snapshot, so the next real
 * change retries instead of silently assuming the new dependencies are live.
 */
export function createDependencyRebuildGate(options: DependencyRebuildGateOptions): () => Promise<void> {
  const read = options.readSnapshot ?? dependencySnapshot
  let adopted = read(options.profileDir)
  return async () => {
    const current = read(options.profileDir)
    if (current === adopted) return
    await options.rebuild()
    adopted = current
  }
}

export * as RebuildGate from "./rebuild-gate.js"
