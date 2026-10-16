/**
 * Per-unit trigger scoping (DESIGN.md#unified-reload--lifecycle 触发定域).
 *
 * The reload domain is decided by WHICH state source changed, never by a
 * fixed combination:
 *
 * - web profile composition/manifest change → `dsh:web` only
 * - tools profile composition/manifest change → `dsh:tools` only
 * - shared dsh-base change (home-level `cordis.patch.yml`) → web + tools
 *   (the one declared multi-unit dependency edge)
 * - global provider/config change → `global` / `instance:*`, never DSH
 * - a CODE (module-graph) change cold-rebuilds the web unit in a new child
 *   process; the tools unit is in-process by default and reports
 *   restart-required instead of silently skipping
 *
 * The decision is a pure function so every host (CLI serve/web, Desktop
 * sidecar, TUI) scopes its reload identically.
 */

/** A pure trigger decision: which DSH units the change invalidates. */
export interface UnitTriggerDecision {
  /** The DSH units to invalidate (empty = no DSH unit affected). */
  readonly units: ("dsh:web" | "dsh:tools")[]
  /** The change is a code change: `dsh:web` rebuilds in a new child process. */
  readonly coldRebuild?: boolean
  /**
   * The changed unit is in-process and cannot apply the change live: the
   * caller must report restart-required for this unit (Plan Task 9).
   */
  readonly restartRequired?: "dsh:tools"
}

export interface UnitTriggerInput {
  /** The profile whose files changed (`web` / `ellamaka-tools` / absent). */
  profile?: string
  /** The changed file name (informational; the profile decides the unit). */
  file: string
  /** A home-level (shared dsh-base) composition change. */
  sharedBase?: boolean
  /** A global provider/config change (settings, providers). */
  globalConfig?: boolean
  /** The change replaces package code (module graph), not just composition. */
  codeChange?: boolean
}

/**
 * Decide which DSH reload units a state-source change invalidates.
 */
export function restartRequiredForTools(
  profile: string | undefined,
  _file: string,
  input?: Omit<UnitTriggerInput, "profile" | "file">,
): UnitTriggerDecision {
  const options = input ?? {}
  // Global provider/config changes never touch DSH units (触发定域: 全局
  // provider/config 变 → global/instance，不牵动 dsh).
  if (options.globalConfig) return { units: [] }
  // Shared dsh-base change: the one declared multi-unit edge.
  if (options.sharedBase) {
    if (options.codeChange) {
      // A code-level shared-base change cold-rebuilds web; tools reports
      // restart-required (in-process, cannot swap its module graph).
      return { units: ["dsh:web"], coldRebuild: true, restartRequired: "dsh:tools" }
    }
    return { units: ["dsh:web", "dsh:tools"] }
  }
  if (profile === "web") {
    return options.codeChange ? { units: ["dsh:web"], coldRebuild: true } : { units: ["dsh:web"] }
  }
  if (profile === "ellamaka-tools") {
    // Code changes to the in-process tools unit cannot hot-apply: explicit
    // restart-required, never a silent skip (Plan Task 9 Behavior).
    return options.codeChange ? { units: [], restartRequired: "dsh:tools" } : { units: ["dsh:tools"] }
  }
  return { units: [] }
}

export * as UnitTrigger from "./unit-trigger.js"
