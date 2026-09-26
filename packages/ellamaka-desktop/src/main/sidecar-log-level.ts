/**
 * The sidecar's single log-level hub.
 *
 * The sidecar speaks one level at a time: the parent process sends
 * `setLogLevel`, the level is written back to `ELLAMAKA_LOG_LEVEL` for the
 * process tree, the engine log is re-targeted live, and every DSH host reads
 * the hub through `dshLogLevel()` (mapped to DSH's four-level vocabulary at
 * the `toDshLogLevel` boundary). One mutable value, one accessor — a future
 * reader that bypasses the hub cannot stay in sync.
 *
 * The level set is the unified engine vocabulary: TRACE stays legal here
 * (env/explicit only), DSH's four-level mapping happens at the boundary.
 */
export type SidecarLogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR"

let sidecarLogLevel: SidecarLogLevel = "INFO"

/** The current sidecar level (unified engine vocabulary; may be TRACE). */
export function currentSidecarLogLevel(): SidecarLogLevel {
  return sidecarLogLevel
}

/** Set the sidecar level; callers re-target the engine log and propagate. */
export function setSidecarLogLevel(level: SidecarLogLevel): void {
  sidecarLogLevel = level
}

/** Reset to the module default (INFO); test isolation helper. */
export function resetSidecarLogLevelForTest(): void {
  sidecarLogLevel = "INFO"
}
