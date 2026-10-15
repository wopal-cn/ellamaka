import { randomUUID } from "node:crypto"
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { acquireHomeLock, releaseHomeLock, type HomeLockToken } from "./home-lock.js"
import { resolveDshLayout } from "./status.js"

export type DshHomeFailureReason =
  | "DSH_HOME_BUSY"
  | "DSH_HOME_NEWER_THAN_RUNTIME"
  | "DSH_HOME_VERSION_UNKNOWN"
  | "DSH_HOME_BACKUP_FAILED"
  | "DSH_HOME_STATE_WRITE_FAILED"

export type DshHomeState =
  | { kind: "empty"; marker: false; homeExists: false }
  | { kind: "legacy"; marker: false; homeExists: true }
  | { kind: "unknown"; marker: boolean; homeExists: boolean }
  | { kind: "state-only"; closureVersion: number; marker: false; homeExists: boolean }
  | { kind: "managed"; closureVersion: number; marker: true; homeExists: boolean }

export type PrepareDshHomeResult =
  | { ok: true; homeVersion: number; changed: boolean; backupDir?: string }
  | { ok: false; reason: DshHomeFailureReason; homeVersion?: number }

export interface DshHomeRuntimeLease {
  readonly mode: "shared"
  release(): Promise<void>
}

export type DshHomeRuntimeAccessResult =
  | { ok: true; homeVersion: number; lease: DshHomeRuntimeLease }
  | { ok: false; reason: DshHomeFailureReason; homeVersion?: number }

export interface HomeGuardDeps {
  /** Test seam for deterministic backup failures. */
  copyHome?: (source: string, destination: string, defaultCopy: (source: string, destination: string) => void) => void
  /** Test seam around atomic metadata publication. */
  atomicWrite?: (file: string, content: string, defaultWrite: (file: string, content: string) => void) => void
  /** Test seam proving backup completes before current.json changes. */
  beforeStatePublish?: () => void
}

export interface PrepareDshHomeOptions {
  readonly wopalHome: string
  readonly closureVersion: number
  readonly lockTimeoutMs?: number
  /**
   * Explicit operator confirmation for the one-time adoption of a legacy Home.
   * The new lock cannot prove that pre-lock Ellamaka/DSH processes have stopped.
   */
  readonly legacyAdoptionConfirmed?: boolean
  readonly deps?: HomeGuardDeps
}

const DEFAULT_LOCK_TIMEOUT_MS = 1_000
const MANAGED_MARKER = "ellamaka-managed-v1\n"

/** Purely inspect Ellamaka-owned Home metadata; never creates directories. */
export async function readDshHomeState(wopalHome: string): Promise<DshHomeState> {
  const layout = resolveDshLayout(wopalHome)
  const homeExists = existsSync(layout.homeDir)
  const markerExists = existsSync(layout.managedMarkerFile)
  const stateExists = existsSync(layout.homeStateFile)
  let markerValid = false
  if (markerExists) {
    try {
      markerValid = readFileSync(layout.managedMarkerFile, "utf8") === MANAGED_MARKER
    } catch {
      return { kind: "unknown", marker: true, homeExists }
    }
    if (!markerValid) return { kind: "unknown", marker: true, homeExists }
  }

  if (!stateExists) {
    if (markerExists) return { kind: "unknown", marker: true, homeExists }
    return homeExists
      ? { kind: "legacy", marker: false, homeExists: true }
      : { kind: "empty", marker: false, homeExists: false }
  }

  let closureVersion: number
  try {
    const raw: unknown = JSON.parse(readFileSync(layout.homeStateFile, "utf8"))
    if (typeof raw !== "object" || raw === null || !("closureVersion" in raw)) {
      return { kind: "unknown", marker: markerExists, homeExists }
    }
    const value = raw.closureVersion
    if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
      return { kind: "unknown", marker: markerExists, homeExists }
    }
    closureVersion = value
  } catch {
    return { kind: "unknown", marker: markerExists, homeExists }
  }

  return markerValid
    ? { kind: "managed", closureVersion, marker: true, homeExists }
    : { kind: "state-only", closureVersion, marker: false, homeExists }
}

/**
 * Prepare Home metadata under the shared/exclusive Home lock.
 *
 * This operation never returns a runtime lease. Runtime activation must call
 * acquireDshHomeRuntimeAccess separately, closing the prepare→activate race by
 * re-reading current.json while holding the long-lived shared lease.
 */
export async function prepareDshHome(options: PrepareDshHomeOptions): Promise<PrepareDshHomeResult> {
  assertClosureVersion(options.closureVersion)
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS

  // Same-version/no-write and older-runtime refusal use a shared lock, so a
  // second same-version product can start while another runtime is active.
  const initial = await readDshHomeState(options.wopalHome)
  if (initial.kind === "managed" && initial.closureVersion >= options.closureVersion) {
    const shared = await acquireHomeLock(resolveDshLayout(options.wopalHome).homeLockPath, "shared", timeoutMs)
    if (!shared) return { ok: false, reason: "DSH_HOME_BUSY", homeVersion: initial.closureVersion }
    try {
      const stable = await readDshHomeState(options.wopalHome)
      if (stable.kind === "managed") {
        if (stable.closureVersion > options.closureVersion) {
          return { ok: false, reason: "DSH_HOME_NEWER_THAN_RUNTIME", homeVersion: stable.closureVersion }
        }
        if (stable.closureVersion === options.closureVersion) {
          return { ok: true, homeVersion: stable.closureVersion, changed: false }
        }
      }
      // Metadata changed while waiting. Release shared and fall through to the
      // exclusive path, which re-reads authoritative state before writing.
    } finally {
      await releaseHomeLock(resolveDshLayout(options.wopalHome).homeLockPath, shared)
    }
  }

  const layout = resolveDshLayout(options.wopalHome)
  const exclusive = await acquireHomeLock(layout.homeLockPath, "exclusive", timeoutMs)
  if (!exclusive) {
    const state = await readDshHomeState(options.wopalHome)
    return {
      ok: false,
      reason: "DSH_HOME_BUSY",
      ...(versionOf(state) === undefined ? {} : { homeVersion: versionOf(state) }),
    }
  }

  try {
    return prepareUnderExclusive(options, exclusive)
  } finally {
    await releaseHomeLock(layout.homeLockPath, exclusive)
  }
}

async function prepareUnderExclusive(
  options: PrepareDshHomeOptions,
  _exclusive: HomeLockToken,
): Promise<PrepareDshHomeResult> {
  const state = await readDshHomeState(options.wopalHome)
  const current = versionOf(state)

  if (state.kind === "unknown") return { ok: false, reason: "DSH_HOME_VERSION_UNKNOWN" }
  if (current !== undefined && current > options.closureVersion) {
    return { ok: false, reason: "DSH_HOME_NEWER_THAN_RUNTIME", homeVersion: current }
  }

  if (state.kind === "managed" && current === options.closureVersion) {
    return { ok: true, homeVersion: options.closureVersion, changed: false }
  }

  if (state.kind === "legacy" && !options.legacyAdoptionConfirmed) {
    return { ok: false, reason: "DSH_HOME_VERSION_UNKNOWN" }
  }

  // A valid state without its marker is not legacy. Repair the marker under
  // exclusive qualification, preserving the recorded generation.
  if (state.kind === "state-only") {
    if (!publishMarker(options)) {
      return { ok: false, reason: "DSH_HOME_STATE_WRITE_FAILED", homeVersion: state.closureVersion }
    }
    if (state.closureVersion === options.closureVersion) {
      return { ok: true, homeVersion: options.closureVersion, changed: true }
    }
  }

  let backupDir: string | undefined
  const needsBackup = state.kind === "legacy" || (current !== undefined && current < options.closureVersion)
  if (needsBackup) {
    try {
      backupDir = createBackup(options, state)
    } catch {
      return {
        ok: false,
        reason: "DSH_HOME_BACKUP_FAILED",
        ...(current === undefined ? {} : { homeVersion: current }),
      }
    }
  }

  if (!publishState(options)) {
    return {
      ok: false,
      reason: "DSH_HOME_STATE_WRITE_FAILED",
      ...(current === undefined ? {} : { homeVersion: current }),
    }
  }
  if (!publishMarker(options)) {
    // current.json may now be valid with a missing marker. That partial state is
    // intentionally fail-closed and repairable by a later exclusive prepare.
    return { ok: false, reason: "DSH_HOME_STATE_WRITE_FAILED", homeVersion: options.closureVersion }
  }

  return {
    ok: true,
    homeVersion: options.closureVersion,
    changed: true,
    ...(backupDir ? { backupDir } : {}),
  }
}

/** Acquire the long-lived shared qualification used by an actual Home consumer. */
export async function acquireDshHomeRuntimeAccess(options: {
  wopalHome: string
  closureVersion: number
  lockTimeoutMs?: number
}): Promise<DshHomeRuntimeAccessResult> {
  assertClosureVersion(options.closureVersion)
  const layout = resolveDshLayout(options.wopalHome)
  const token = await acquireHomeLock(layout.homeLockPath, "shared", options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS)
  if (!token) return { ok: false, reason: "DSH_HOME_BUSY" }

  const state = await readDshHomeState(options.wopalHome)
  if (state.kind !== "managed") {
    await releaseHomeLock(layout.homeLockPath, token)
    return {
      ok: false,
      reason: "DSH_HOME_VERSION_UNKNOWN",
      ...(versionOf(state) ? { homeVersion: versionOf(state) } : {}),
    }
  }
  if (state.closureVersion > options.closureVersion) {
    await releaseHomeLock(layout.homeLockPath, token)
    return { ok: false, reason: "DSH_HOME_NEWER_THAN_RUNTIME", homeVersion: state.closureVersion }
  }
  if (state.closureVersion !== options.closureVersion) {
    await releaseHomeLock(layout.homeLockPath, token)
    return { ok: false, reason: "DSH_HOME_VERSION_UNKNOWN", homeVersion: state.closureVersion }
  }

  let released = false
  return {
    ok: true,
    homeVersion: state.closureVersion,
    lease: {
      mode: "shared",
      release: async () => {
        if (released) return
        released = true
        await releaseHomeLock(layout.homeLockPath, token)
      },
    },
  }
}

function publishState(options: PrepareDshHomeOptions): boolean {
  const layout = resolveDshLayout(options.wopalHome)
  try {
    options.deps?.beforeStatePublish?.()
    const content = `${JSON.stringify({ closureVersion: options.closureVersion })}\n`
    writeAtomically(options, layout.homeStateFile, content)
    return true
  } catch {
    return false
  }
}

function publishMarker(options: PrepareDshHomeOptions): boolean {
  try {
    writeAtomically(options, resolveDshLayout(options.wopalHome).managedMarkerFile, MANAGED_MARKER)
    return true
  } catch {
    return false
  }
}

function writeAtomically(options: PrepareDshHomeOptions, file: string, content: string): void {
  const writer = options.deps?.atomicWrite
  if (writer) writer(file, content, atomicWriteFile)
  else atomicWriteFile(file, content)
}

function atomicWriteFile(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temp, content)
    renameSync(temp, file)
  } finally {
    rmSync(temp, { force: true })
  }
}

function createBackup(options: PrepareDshHomeOptions, state: DshHomeState): string {
  const layout = resolveDshLayout(options.wopalHome)
  mkdirSync(layout.backupsDir, { recursive: true })
  const backupDir = join(
    layout.backupsDir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomUUID().slice(0, 8)}`,
  )
  mkdirSync(backupDir)
  try {
    if (existsSync(layout.homeDir)) {
      const copy =
        options.deps?.copyHome ?? ((_source, _destination, defaultCopy) => defaultCopy(_source, _destination))
      copy(layout.homeDir, join(backupDir, "home"), (source, destination) => {
        cpSync(source, destination, { recursive: true, errorOnExist: true })
      })
    }

    const stateBackupDir = join(backupDir, "state")
    mkdirSync(stateBackupDir, { recursive: true })
    if (existsSync(layout.homeStateFile)) copyFileSync(layout.homeStateFile, join(stateBackupDir, "current.json"))
    if (existsSync(layout.managedMarkerFile)) copyFileSync(layout.managedMarkerFile, join(stateBackupDir, "managed"))

    const knownVersion = versionOf(state) ?? null
    writeFileSync(
      join(backupDir, "metadata.json"),
      `${JSON.stringify({ closureVersion: knownVersion, managed: state.kind === "managed" || state.kind === "state-only" })}\n`,
    )
    return backupDir
  } catch (error) {
    rmSync(backupDir, { recursive: true, force: true })
    throw error
  }
}

function versionOf(state: DshHomeState): number | undefined {
  return state.kind === "managed" || state.kind === "state-only" ? state.closureVersion : undefined
}

function assertClosureVersion(value: number): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error("closureVersion must be a positive integer")
}
