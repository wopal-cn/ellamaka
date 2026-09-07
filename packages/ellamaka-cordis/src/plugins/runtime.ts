import { watch, type FSWatcher } from "chokidar"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { composeFullPatchStack, healPluginsModuleFallback, profileDirOf, readUserPatchLayer } from "./compose.js"

/**
 * Plugin Runtime Service: watches the profile composition files and replays
 * include patches into the running containers (DESIGN-dsh-poc A2, D-03).
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
 * {@link composeFullPatchStack}: bundle layers -> plugin layers -> user patch
 * layer -> extra patches -> home patches. The loader diffs entries by
 * explicit id, so mount/unmount of individual plugins is transactional —
 * add/remove/enable/disable all share this one path.
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

/** A running service handle. */
export interface DshPluginServiceHandle {
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
 * The patch stack a hot replay must restore: the FULL boot composition
 * (bundle -> plugin -> user -> extra -> home) with freshly composed plugin
 * rows. `profilePatches` carries the per-profile boot context (bundle layer
 * patches, user patch list, extras, home patches) captured at mount time —
 * these layers are manifest-independent and stay byte-identical across
 * replays.
 */
export interface DshPluginStackContext {
  /** The profile's bundle layers (from `loadProfile(...).layers`). */
  profileLayers: { patches: unknown[] }[]
  /** The profile's user patch layer (`loadProfile(...).patches`). */
  userPatches: unknown[]
  /** The Bridge's extraPatches for this mount. */
  extraPatches: unknown[]
  /** The home patches for this mount. */
  homePatches: unknown[]
}

/**
 * Start watching the profile composition files and hot-replaying include
 * patches. Event driven: no polling interval.
 */
export function startDshPluginService(options: DshPluginServiceOptions): DshPluginServiceHandle {
  const containers = options.containers
  const logger = options.logger ?? defaultLogger()
  let lastHash: string | undefined
  let stopped = false
  /** Serialization: change events spotted mid-replay coalesce into one rerun. */
  let replaying = false
  let pendingReplay = false

  /** The watched composition files, one pair per container profile. */
  const watchedFiles = new Map<string, { manifest: string; patch: string }>()
  for (const container of containers) {
    const dir = profileDirOf(options.home, container.profile)
    watchedFiles.set(container.profile, {
      manifest: join(dir, "package.json"),
      patch: join(dir, "cordis.patch.yml"),
    })
  }
  const allWatched = [...watchedFiles.values()].flatMap((f) => [f.manifest, f.patch])

  /** Read one watched file's content (`undefined` when absent). */
  function readContent(file: string): string | undefined {
    try {
      if (!existsSync(file)) return undefined
      return readFileSync(file, "utf-8")
    } catch {
      return undefined
    }
  }

  /** Hash the CURRENT content of every watched file (content, not mtime). */
  function currentHash(): string {
    return compositionHash(allWatched.map(readContent))
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
    if (!stack) throw new Error(`dsh plugin runtime: container for profile ${JSON.stringify(container.profile)} has no boot stack context`)
    const patches = composeFullPatchStack({
      profileLayers: stack.profileLayers,
      userPatches: readUserPatchLayer(options.home, container.profile),
      extraPatches: stack.extraPatches,
      homePatches: stack.homePatches,
    })
    // Shallow-merge contract (spike 2): spread the previous config, replace
    // only `patches`.
    const previousConfig = (container.includeEntry as unknown as {
      options?: { config?: Record<string, unknown> }
    }).options?.config
    const { patches: _prev, ...rest } = previousConfig ?? {}
    await container.includeEntry.update({
      config: { ...rest, patches },
    })
    options.onReplay?.(container.profile)
  }

  /** One observation: hash -> replay changed containers -> keep old hash on failure. */
  const runReplay = async (): Promise<void> => {
    if (stopped) return
    const hash = currentHash()
    if (hash === lastHash) return // short-circuit: nothing changed
    if (replaying) {
      pendingReplay = true
      return
    }
    replaying = true
    try {
      // Heal BEFORE composing: a newly installed plugin needs its
      // profiles/node_modules symlink to exist for the loader's import.
      healPluginsModuleFallback(options.home)
      let failed = false
      for (const container of containers) {
        try {
          await replayContainer(container)
        } catch (error) {
          // Keep the last good state for this container; the service and
          // the other containers are unaffected (DESIGN §9.6 #5).
          failed = true
          logger.error("plugin include replay failed; keeping last good state", {
            profile: container.profile,
            error: (error as Error).message,
          })
          options.onReplayError?.(container.profile, error)
        }
      }
      // Storm fix (D-03): a failed replay does NOT update the hash — the
      // failure is not a state change, so nothing retries until a real file
      // change arrives. Only a fully successful run adopts the new hash.
      if (!failed) {
        lastHash = hash
      }
    } finally {
      replaying = false
    }
  }

  /** Drain a pending change observed while a replay was in flight. */
  const drainPending = async (): Promise<void> => {
    while (pendingReplay && !stopped) {
      pendingReplay = false
      await runReplay()
    }
  }

  lastHash = currentHash() // adopt the state observed at startup
  const watcher = watch(allWatched, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
  })
  watcher.on("all", () => {
    if (stopped) return
    void runReplay().then(drainPending)
  })

  return {
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
