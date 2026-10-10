import { AsyncLocalStorage } from "node:async_hooks"
import { readFileSync } from "node:fs"
import { watch, type FSWatcher } from "chokidar"
import { isAbsolute, join, resolve } from "node:path"
import { composeFullPatchStack, profileDirOf, readUserPatchLayer, type DshPluginStackContext } from "./compose.js"
import type { DshPluginContainer, DshPluginServiceLogger } from "./runtime.js"

/**
 * Bun host HMR adapter (DESIGN-dsh-base.md 「Bun 宿主 HMR 适配器」, B3 收窄).
 *
 * Replaces the official `cordis-plugin-hmr` on the Bun serve path, where the
 * official plugin cannot run (it requires the Node internal loader).
 * Implements EXACTLY the surface the official caller consumes
 * (`watchUserPatches` in dsh-app-boot):
 *
 *  1. `registerConfig(filename, refresh)` — watch ONE file; run `refresh`
 *     serially on add/change/unlink; return an async disposer; throw when the
 *     path is already registered. Aligned with the rc.1
 *     `cordis-plugin-hmr/lib/index.js` registerConfig (path dedupe, serial
 *     refresh chain, disposer awaits the in-flight refresh).
 *  2. `includeEntry.update({ config })` replays through the shared
 *     composition logic (the same shallow-merge full-stack rebuild the
 *     Plugin Runtime Service performs).
 *
 * The official INACTIVE_EFFECT error shape is preserved: registering while
 * the service is not mounted throws an error with `code === "INACTIVE_EFFECT"`
 * (the official caller checks exactly this and degrades to a no-op disposer).
 */

/** The structured logger seam (same shape the runtime service logs through). */
export type BunHmrLogger = DshPluginServiceLogger

/** Options for {@link createBunHmr}. */
export interface BunHmrOptions {
  /** The containers whose composition files the service replays into. */
  containers: DshPluginContainer[]
  /** The Ellamaka territory root (`$WOPAL_HOME/dsh`). */
  dshRoot: string
  /**
   * The container context the service mounts on (`ctx.provide("hmr", ...)`).
   * Generation replays reuse the containers' composition logic.
   */
  ctx?: unknown
  /** Install anchor for composition (bare-name resolution). */
  installAnchor?: string
  /** Structured logger; defaults to a console-backed fallback. */
  logger?: BunHmrLogger
  /** Settle and validate the complete profile after a mutation or restoration. */
  afterApply?: () => Promise<void>
  /** A restoration failure invalidates the mount; the owner handles publication. */
  onFailedRestoration?: (error: unknown) => void
}

/** One running registration: its watcher and serial refresh chain state. */
interface Registration {
  watchFilename: string
  watcher: FSWatcher
  /** Serial refresh chain state (dirty flag + in-flight task). */
  state: { dirty: boolean; running?: Promise<void> }
  disposed: boolean
}

/** Console-backed fallback logger. */
function defaultLogger(): BunHmrLogger {
  return {
    info: (message, extra) => console.log(`[dsh-bun-hmr] ${message}`, extra ?? ""),
    warn: (message, extra) => console.warn(`[dsh-bun-hmr] ${message}`, extra ?? ""),
    error: (message, extra) => console.error(`[dsh-bun-hmr] ${message}`, extra ?? ""),
  }
}

/**
 * Create the Bun host HMR service. Mount it on a context with `mount()` to
 * expose `ctx.hmr.registerConfig` (the official consumption shape), and use
 * {@link BunHmr.watchCompositionFiles} for the generation candidate
 * replacement of the plugin composition files.
 */
export function createBunHmr(options: BunHmrOptions): BunHmr {
  const containers = options.containers
  const logger = options.logger ?? defaultLogger()
  const registrations = new Map<string, Registration>()
  let stopped = false
  let active = false
  const transaction = new AsyncLocalStorage<boolean>()
  let operations: Promise<void> = Promise.resolve()

  const service: BunHmr = {
    runExclusive<T>(operation: () => Promise<T>): Promise<T> {
      if (!active || stopped) {
        const error = new Error("dsh configuration HMR is inactive or stopped")
        Object.assign(error, { code: "INACTIVE_EFFECT" })
        return Promise.reject(error)
      }
      if (transaction.getStore()) return Promise.reject(new Error("nested profile configuration transaction"))
      const result = operations.then(() =>
        transaction.run(true, async () => {
          if (stopped) throw new Error("dsh configuration HMR is stopped")
          const snapshots = containers.map((container) => ({
            entry: container.includeEntry,
            config: (container.includeEntry as { options?: { config?: Record<string, unknown> } }).options?.config,
          }))
          try {
            const value = await operation()
            await options.afterApply?.()
            return value
          } catch (failure) {
            try {
              for (const snapshot of snapshots) {
                if (snapshot.config !== undefined) await snapshot.entry.update({ config: snapshot.config })
              }
              await options.afterApply?.()
            } catch (restoration) {
              const error = new AggregateError([failure, restoration], "profile configuration restoration failed")
              logger.error("profile configuration restoration failed", {
                error: error instanceof Error ? error.message : String(error),
              })
              options.onFailedRestoration?.(error)
              throw error
            }
            throw failure
          }
        }),
      )
      operations = result.then(
        () => {},
        () => {},
      )
      return result
    },
    watchConfig(filename, refresh) {
      return service.registerConfig(filename, refresh)
    },
    /** Whether the service is mounted (registerConfig requires this). */
    isActive(): boolean {
      return active && !stopped
    },

    /**
     * Mount the service onto the context: exposes the official `hmr`
     * service (`registerConfig`) exactly as `watchUserPatches` consumes it.
     */
    async mount(): Promise<void> {
      if (stopped) throw new Error("dsh bun-hmr: service already stopped")
      active = true
      const ctx = options.ctx as
        | {
            provide(name: string, value: unknown): unknown
            effect?(dispose: () => () => Promise<void>): unknown
          }
        | undefined
      ctx?.effect?.(() => () => service.stop())
      ctx?.provide?.("hmr", {
        runExclusive: service.runExclusive,
        watchConfig: service.watchConfig,
        registerConfig: (filename: string, refresh: () => Promise<void> | void) =>
          service.registerConfig(filename, refresh),
      })
    },

    /**
     * Watch ONE exact file and run `refresh` serially on add/change/unlink.
     * Returns an async disposer once the watch is ready. Throws
     * INACTIVE_EFFECT-shaped errors when unmounted, and a named duplicate
     * error when the path is already registered.
     */
    async registerConfig(filename, refresh): Promise<() => Promise<void>> {
      if (stopped || !active) {
        const error = new Error("dsh bun-hmr: HMR is not active (registerConfig before mount or after stop)")
        ;(error as Error & { code?: string }).code = "INACTIVE_EFFECT"
        throw error
      }
      const target = isAbsolute(filename) ? filename : resolve(process.cwd(), filename)
      if (registrations.has(target)) {
        throw new Error(`dsh bun-hmr: config path already registered: ${filename}`)
      }

      const watcher = transaction.exit(() => watch(target, { ignoreInitial: true }))
      const registration: Registration = { watchFilename: target, watcher, state: { dirty: false }, disposed: false }
      registrations.set(target, registration)
      const content = () => {
        try {
          return readFileSync(target, "utf8")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
          throw error
        }
      }
      let observed = content()

      /** Serial refresh chain (official refreshConfig semantics). */
      const runRefresh = (): void => {
        const state = registration.state
        // Record observed bytes even on failure: an identical bad file must
        // not repeatedly activate plugins. A changed file can recover.
        let current: string | undefined
        try {
          current = content()
        } catch (error) {
          logger.warn("config read failed", { file: target, error: String(error) })
          return
        }
        if (current === observed) return
        observed = current
        state.dirty = true
        if (state.running) return
        const task = (async () => {
          do {
            state.dirty = false
            try {
              await service.runExclusive(async () => {
                if (!registration.disposed) await refresh()
              })
            } catch (reason) {
              const error = reason instanceof Error ? reason : new Error(String(reason), { cause: reason })
              logger.warn("config reload failed", {
                file: target,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          } while (state.dirty && !registration.disposed)
        })().finally(() => {
          state.running = undefined
        })
        state.running = task
      }

      watcher.on("error", (error) => {
        logger.error("config watcher failed", {
          file: target,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      watcher.on("all", (_event, path) => {
        const observed = resolve(path)
        if (observed !== target && observed !== registration.watchFilename) return
        runRefresh()
      })

      // Watcher readiness: chokidar resolves on the first scan; a missing
      // file still "watches" for its creation, so readiness is immediate.
      await new Promise<void>((resolveReady, reject) => {
        watcher.once("ready", resolveReady)
        watcher.once("error", reject)
      }).catch(async (error) => {
        registrations.delete(target)
        registration.disposed = true
        await watcher.close()
        throw error
      })

      return async () => {
        if (registration.disposed) return
        registration.disposed = true
        if (registrations.get(target) === registration) registrations.delete(target)
        await watcher.close()
        // Await the in-flight refresh (official disposer contract).
        if (!transaction.getStore()) await registration.state.running
      }
    },

    /**
     * Watch one container's composition files (manifest + user patch layer)
     * and REPLAY the full patch stack through the include entry whenever
     * they change — the generation candidate replacement (D-05): the
     * recomposed stack IS the candidate; a failed update keeps the last good
     * state (the include update is transactional by id diff).
     */
    async watchCompositionFiles(profile: string): Promise<void> {
      if (stopped) throw new Error("dsh configuration HMR is stopped")
      // Legacy standalone composition watchers can run without context injection.
      active = true
      const container = containers.find((c) => c.profile === profile)
      if (!container) {
        return Promise.reject(new Error(`dsh bun-hmr: no container for profile ${JSON.stringify(profile)}`))
      }
      const dir = profileDirOf(options.dshRoot, profile)
      const files = [join(dir, "package.json"), join(dir, "cordis.patch.yml")]
      const replay = async (): Promise<void> => {
        // Heal BEFORE composing (fresh installs need their links).
        const stack = (container as { stackContext?: DshPluginStackContext }).stackContext
        if (!stack)
          return Promise.reject(
            new Error(`dsh bun-hmr: no boot stack context for profile ${JSON.stringify(container.profile)}`),
          )
        // The user patch layer is the enable/disable surface: re-read FRESH so
        // a replay never re-applies rows the user just removed (same contract
        // as the Plugin Runtime Service, runtime.ts).
        const patches = composeFullPatchStack({
          profileLayers: stack.profileLayers,
          userPatches: readUserPatchLayer(options.dshRoot, profile),
          extraPatches: stack.extraPatches,
          homePatches: stack.homePatches,
          hostPatches: stack.hostPatches,
        })
        const previousConfig = (
          container.includeEntry as unknown as {
            options?: { config?: Record<string, unknown> }
          }
        ).options?.config
        const { patches: _prev, ...rest } = previousConfig ?? {}
        await container.includeEntry.update({ config: { ...rest, patches } })
      }
      const watcher = transaction.exit(() =>
        watch(files, {
          ignoreInitial: true,
          awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
        }),
      )
      const registration: Registration = { watchFilename: dir, watcher, state: { dirty: false }, disposed: false }
      for (const file of files) registrations.set(file, registration)
      watcher.on("all", () => {
        // Serial chain per registration group.
        const state = registration.state
        state.dirty = true
        if (state.running) return
        const task = (async () => {
          do {
            state.dirty = false
            try {
              const owner = (
                container.ctx as
                  | { get?(name: string): { runExclusive?<T>(operation: () => Promise<T>): Promise<T> } }
                  | undefined
              )?.get?.("hmr")
              await (owner?.runExclusive ? owner.runExclusive(replay) : service.runExclusive(replay))
            } catch (error) {
              logger.error("composition replay failed; keeping last good state", {
                profile,
                error: (error as Error).message,
              })
            }
          } while (state.dirty)
        })().finally(() => {
          state.running = undefined
        })
        state.running = task
      })
      await new Promise<void>((resolveReady, reject) => {
        watcher.once("ready", resolveReady)
        watcher.once("error", reject)
      })
    },

    /** Stop everything. Idempotent; in-flight refreshes are awaited. */
    async stop(): Promise<void> {
      if (transaction.getStore()) throw new Error("cannot stop HMR inside its configuration transaction")
      if (stopped) return
      stopped = true
      active = false
      const watchers = [...registrations.values()]
      registrations.clear()
      await Promise.all(
        watchers.map(async (registration) => {
          if (registration.disposed) return
          registration.disposed = true
          await registration.watcher.close()
        }),
      )
      // Await any in-flight refresh chains.
      await Promise.all(watchers.map((r) => r.state.running ?? Promise.resolve()))
      await operations
    },
  }

  return service
}

export interface BunHmr {
  isActive(): boolean
  mount(): Promise<void>
  runExclusive<T>(operation: () => Promise<T>): Promise<T>
  watchConfig(filename: string, refresh: () => Promise<void>): Promise<() => Promise<void>>
  registerConfig(filename: string, refresh: () => Promise<void> | void): Promise<() => Promise<void>>
  watchCompositionFiles(profile: string): Promise<void>
  stop(): Promise<void>
}
