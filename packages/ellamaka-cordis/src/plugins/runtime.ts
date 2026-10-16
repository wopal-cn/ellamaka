import { watch, type FSWatcher } from "chokidar"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { composeFullPatchStack, profileDirOf, readUserPatchLayer, type DshPluginStackContext } from "./compose.js"

/**
 * Plugin Runtime Service: watches the profile composition files and replays
 * include patches into the running containers (DESIGN-dsh-base.md A2, D-03).
 *
 * Trigger contract (event driven, Plan Task 5): the watched set is each
 * container's profile composition files — `package.json` (the manifest
 * truth source) and `cordis.patch.yml` (the user patch layer). chokidar
 * events fire a replay; the CONTENT of the watched files is hashed
 * (mtime is unreliable: an idempotent write must not replay, P9 lesson) and
 * only a hash change replays.
 *
 * Failure semantics (D-03 storm fix): a failed replay KEEPS the last hash —
 * a failure does not count as a state change, so no retry loop ever forms.
 * The containers stay on their last good state; the next REAL file change
 * triggers a fresh replay.
 *
 * Replay contract (D-03, spike 2 path B): the include `entry.update` is a
 * SHALLOW merge, so each replay spreads the previous config back and REPLACES
 * `patches` with the FULL composition rebuilt by
 * {@link composeFullPatchStack}: official bundle layers -> user patch layer ->
 * extra patches -> home patches. The loader diffs entries by explicit id, so
 * mount/unmount of individual plugins is transactional — add/remove/enable/
 * disable all share this one path.
 */

/** The structured logger seam the service logs through (W-02). */
export interface DshPluginServiceLogger {
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

/** One watched container: its profile and the boot include entry handle. */
export interface DshPluginContainer {
  /** The profile name the container mounted ("web" | "ellamaka-tools"). */
  profile: string
  /** The container context (service probes / logging). */
  ctx?: unknown
  /** The root include entry from the mount handle (DshHost.includeEntry). */
  includeEntry: {
    id: string
    update(options: unknown): Promise<void>
  }
  /**
   * The container's boot patch-stack context (DshHost.stackContext): passed
   * to `composeFullPatchStack` so a replay rebuilds the ENTIRE stack
   * (bundle -> plugin -> user -> extra -> home), never dropping the
   * official layers (rook B-01).
   */
  stackContext?: unknown
}

/** Options for {@link startDshPluginService}. */
export interface DshPluginServiceOptions {
  /**
   * The Ellamaka territory root (`$WOPAL_HOME/dsh`), NOT the DSH home; the
   * watched composition files live under `home/profiles/<name>/`.
   */
  home: string
  /** The containers to replay plugin layers into. */
  containers: DshPluginContainer[]
  /**
   * The install anchor the container's profile was loaded from (binds the
   * full-stack recomposition to the same bundle layers boot used).
   */
  installAnchor?: string
  /** Structured logger; defaults to a console-backed fallback. */
  logger?: DshPluginServiceLogger
  /** Diagnostic hook invoked after each successful replay (tests). */
  onReplay?: (profile: string) => void
  /** Diagnostic hook invoked on a failed replay (tests). */
  onReplayError?: (profile: string, error: unknown) => void
}

/** The result of one host-owned composition replay. */
export type DshPluginReplayResult = { ok: true } | { ok: false; error: string }

/**
 * Per-unit observation state (DESIGN.md#unified-reload--lifecycle): each
 * container is its own reload unit with its own content hash, last
 * observation and failure record. A unit's files changing invalidates ONLY
 * that unit; a failed unit keeps its last hash (no retry storm) while its
 * siblings keep replaying on their own changes.
 */
interface UnitState {
  container: DshPluginContainer
  files: [string, string]
  lastHash: string | undefined
  lastObservation: { hash: string; result: DshPluginReplayResult } | undefined
}

/** A running service handle. */
export interface DshPluginServiceHandle {
  /**
   * Replay the current profile composition and wait for its result. Market
   * installs use this acknowledgement instead of mounting the package a
   * second time through their own temporary loader tree.
   */
  replay(): Promise<DshPluginReplayResult>
  /**
   * Close the watcher and settle in-flight replays. Idempotent: further
   * calls are no-ops.
   */
  stop(): Promise<void>
}

/** Stable hash of the watched composition contents: JSON serialization digest. */
function compositionHash(contents: (string | undefined)[]): string {
  return JSON.stringify(contents)
}

/** Console-backed fallback logger (never silent in production, W-02). */
function defaultLogger(): DshPluginServiceLogger {
  return {
    info: (message, extra) => console.log(`[dsh-plugins] ${message}`, extra ?? ""),
    warn: (message, extra) => console.warn(`[dsh-plugins] ${message}`, extra ?? ""),
    error: (message, extra) => console.error(`[dsh-plugins] ${message}`, extra ?? ""),
  }
}

/**
 * Start watching the profile composition files and hot-replaying include
 * patches. Event driven: no polling interval.
 *
 * Unit scoping (DESIGN.md#unified-reload--lifecycle): every container is an
 * independent reload unit. The watched files are hashed PER PROFILE, and a
 * replay recomposes only the units whose content actually changed — a web
 * profile write never replays the tools container and vice versa. A failed
 * unit keeps its last good hash (D-03 storm fix, per unit now); the other
 * units' successes still adopt their new hashes in the same run.
 */
export function startDshPluginService(options: DshPluginServiceOptions): DshPluginServiceHandle {
  const logger = options.logger ?? defaultLogger()
  let stopped = false
  /** Serialization: change events spotted mid-replay coalesce into one rerun. */
  let replaying = false
  let pendingReplay = false
  let activeReplay: Promise<DshPluginReplayResult> | undefined

  /** One independent unit per container, observed through its own files. */
  const units: UnitState[] = options.containers.map((container) => {
    const dir = profileDirOf(options.home, container.profile)
    return {
      container,
      files: [join(dir, "package.json"), join(dir, "cordis.patch.yml")],
      lastHash: undefined,
      lastObservation: undefined,
    }
  })
  const allWatched = units.flatMap((unit) => unit.files)

  /** Read one watched file's content (`undefined` when absent). */
  function readContent(file: string): string | undefined {
    try {
      if (!existsSync(file)) return undefined
      return readFileSync(file, "utf-8")
    } catch {
      return undefined
    }
  }

  /** Hash the CURRENT content of one unit's watched files (content, not mtime). */
  function currentHash(unit: UnitState): string {
    return compositionHash(unit.files.map(readContent))
  }

  const replayContainer = async (container: DshPluginContainer): Promise<void> => {
    // Rebuild the FULL patch stack (B-01): the include re-applies
    // config.patches over the raw config on every update, so replacing the
    // list would drop the bundle/user/home layers. Boot captured this
    // container's stack context on its handle; the USER patch layer is
    // re-read FRESH here — it is the enable/disable surface, and a boot-time
    // snapshot would race the official watchUserPatches (fresh bytes) and
    // re-apply rows the user just removed.
    const stack = (container as { stackContext?: DshPluginStackContext }).stackContext
    if (!stack)
      throw new Error(
        `dsh plugin runtime: container for profile ${JSON.stringify(container.profile)} has no boot stack context`,
      )
    const mutate = async () => {
      const patches = composeFullPatchStack({
        profileLayers: stack.profileLayers,
        userPatches: readUserPatchLayer(options.home, container.profile),
        extraPatches: stack.extraPatches,
        homePatches: stack.homePatches,
        hostPatches: stack.hostPatches,
      })
      // Shallow-merge contract (spike 2): spread the previous config, replace
      // only `patches`.
      const previousConfig = (
        container.includeEntry as unknown as {
          options?: { config?: Record<string, unknown> }
        }
      ).options?.config
      const { patches: _prev, ...rest } = previousConfig ?? {}
      await container.includeEntry.update({
        config: { ...rest, patches },
      })
    }
    // SettingsForms, loader reconciliation, and CLI acknowledgement use
    // the profile's one transaction queue and activation/rollback checks.
    const hmr = (
      container.ctx as
        | {
            get?(
              name: string,
              strict?: boolean,
            ): { runExclusive<T>(operation: () => Promise<T>): Promise<T> } | undefined
          }
        | undefined
    )?.get?.("hmr", false)
    if (hmr) await hmr.runExclusive(mutate)
    else await mutate()
    options.onReplay?.(container.profile)
  }

  /**
   * Replay ONE unit into its container. Returns the unit's outcome; the
   * caller decides hash adoption per unit (failure keeps the old hash).
   */
  const replayUnit = async (unit: UnitState, hash: string): Promise<DshPluginReplayResult> => {
    if (unit.lastObservation?.hash === hash) return unit.lastObservation.result
    try {
      await replayContainer(unit.container)
      unit.lastHash = hash
      unit.lastObservation = { hash, result: { ok: true } }
      return unit.lastObservation.result
    } catch (error) {
      // Keep the last good state for this unit; its siblings are unaffected
      // (unit isolation, DESIGN.md#unified-reload--lifecycle). The failed
      // hash is NOT adopted — a failure is not a state change (D-03). The
      // failure IS cached on lastObservation so an unchanged re-observation
      // answers the same verdict instead of re-running into the same wall.
      const message = (error as Error).message
      const failure: DshPluginReplayResult = { ok: false, error: message }
      unit.lastObservation = { hash, result: failure }
      logger.error("plugin include replay failed; keeping last good state", {
        profile: unit.container.profile,
        error: message,
      })
      options.onReplayError?.(unit.container.profile, error)
      return failure
    }
  }

  /**
   * One observation: hash every unit independently, replay only the units
   * whose composition changed, adopt successes per unit. A run with any
   * failed unit answers `{ ok: false }` for that unit's error — but the
   * OTHER units' successes are already published (they adopted their new
   * hashes above), so a failed web unit never blocks a tools replay.
   */
  const runReplay = (queueWhenBusy = false): Promise<DshPluginReplayResult> => {
    if (stopped) return Promise.resolve({ ok: false, error: "dsh plugin runtime is stopped" })
    const observations = units.map((unit) => ({ unit, hash: currentHash(unit) }))
    const changed = observations.filter(({ unit, hash }) => hash !== unit.lastHash)
    if (changed.length === 0) return Promise.resolve({ ok: true })
    if (replaying) {
      if (queueWhenBusy) pendingReplay = true
      return activeReplay ?? Promise.resolve({ ok: false, error: "dsh plugin replay lost its active task" })
    }
    replaying = true
    activeReplay = (async (): Promise<DshPluginReplayResult> => {
      let firstError: string | undefined
      for (const { unit, hash } of changed) {
        const result = await replayUnit(unit, hash)
        if (!result.ok) firstError ??= result.error
      }
      return firstError === undefined ? { ok: true } : { ok: false, error: firstError }
    })()
    return activeReplay.finally(() => {
      replaying = false
      activeReplay = undefined
    })
  }

  /** Drain a pending change observed while a replay was in flight. */
  const drainPending = async (): Promise<void> => {
    while (pendingReplay && !stopped) {
      pendingReplay = false
      await runReplay()
    }
  }

  /**
   * The host acknowledgement: observe the CURRENT composition and answer for
   * that observation, never for someone else's in-flight run.
   *
   * The service must not answer `{ ok: true }` from `activeReplay` alone. That
   * run may have adopted its hash BEFORE the caller's change landed, so its
   * `{ ok: true }` says nothing about the bytes the caller just wrote. When a
   * replay is in flight, this waits for it to settle and then observes the
   * composition once more — the observation the caller's verdict describes.
   *
   * A caller is never told "your change is live" on the strength of a run that
   * could not have seen it.
   */
  const acknowledge = async (): Promise<DshPluginReplayResult> => {
    // Observe the busy state BEFORE awaiting anything: awaiting the in-flight
    // run clears `replaying`, so a check afterwards can no longer tell whether
    // this caller's change was ever looked at.
    if (!replaying) return runReplay()
    // Settle the run that was already going, then observe the composition
    // again. The second observation is the one the caller's verdict describes:
    // the in-flight run read the hash before this caller's change landed.
    //
    // `pendingReplay` is deliberately NOT set here. That flag belongs to the
    // watcher's coalescing contract (`runReplay(true).then(drainPending)`), and
    // claiming it would make this call's outcome depend on whether a watcher
    // event happened to arrive.
    await activeReplay
    if (stopped) return { ok: false, error: "dsh plugin runtime is stopped" }
    return runReplay()
  }

  // Adopt each unit's startup state so an idempotent boot never replays.
  for (const unit of units) unit.lastHash = currentHash(unit)
  const watcher = watch(allWatched, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
  })
  watcher.on("error", (error) => {
    logger.error("plugin composition watcher failed", { error: error instanceof Error ? error.message : String(error) })
  })
  watcher.on("all", () => {
    if (stopped) return
    void runReplay(true).then(drainPending)
  })

  return {
    replay: acknowledge,
    stop: async () => {
      if (stopped) return
      stopped = true
      await watcher.close()
      // Await at most one in-flight replay so callers observe settled state.
      while (replaying) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
  }
}
