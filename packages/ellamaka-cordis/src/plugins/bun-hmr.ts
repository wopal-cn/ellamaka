import { watch, type FSWatcher } from "chokidar"
import { isAbsolute, join, resolve } from "node:path"
import { composeFullPatchStack, profileDirOf, type DshPluginStackContext } from "./compose.js"
import type { DshPluginContainer, DshPluginServiceLogger } from "./runtime.js"

/**
 * Bun host HMR adapter (DESIGN-dsh-poc 「Bun 宿主 HMR 适配器」, B3 收窄).
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

  const service: BunHmr = {
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
      const ctx = options.ctx as { provide(name: string, value: unknown): unknown } | undefined
      ctx?.provide?.("hmr", {
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

      const watcher = watch(target, { ignoreInitial: true })
      const registration: Registration = { watchFilename: target, watcher, state: { dirty: false }, disposed: false }
      registrations.set(target, registration)

      /** Serial refresh chain (official refreshConfig semantics). */
      const runRefresh = (): void => {
        const state = registration.state
        state.dirty = true
        if (state.running) return
        const task = (async () => {
          do {
            state.dirty = false
            try {
              await refresh()
            } catch (reason) {
              const error = reason instanceof Error ? reason : new Error(String(reason), { cause: reason })
              logger.warn("config reload failed", { file: target, error: error.message })
            }
          } while (state.dirty)
        })().finally(() => {
          state.running = undefined
        })
        state.running = task
      }

      watcher.on("all", (_event, path) => {
        const observed = resolve(path)
        if (observed !== target && observed !== registration.watchFilename) return
        runRefresh()
      })

      // Watcher readiness: chokidar resolves on the first scan; a missing
      // file still "watches" for its creation, so readiness is immediate.
      await new Promise((r) => setTimeout(r, 0))

      return async () => {
        if (registration.disposed) return
        registration.disposed = true
        if (registrations.get(target) === registration) registrations.delete(target)
        await watcher.close()
        // Await the in-flight refresh (official disposer contract).
        await registration.state.running
      }
    },

    /**
     * Watch one container's composition files (manifest + user patch layer)
     * and REPLAY the full patch stack through the include entry whenever
     * they change — the generation candidate replacement (D-05): the
     * recomposed stack IS the candidate; a failed update keeps the last good
     * state (the include update is transactional by id diff).
     */
    watchCompositionFiles(profile: string): Promise<void> {
      const container = containers.find((c) => c.profile === profile)
      if (!container) {
        return Promise.reject(new Error(`dsh bun-hmr: no container for profile ${JSON.stringify(profile)}`))
      }
      const dir = profileDirOf(options.dshRoot, profile)
      const files = [join(dir, "package.json"), join(dir, "cordis.patch.yml")]
      const replay = async (): Promise<void> => {
        // Heal BEFORE composing (fresh installs need their links).
        const { healPluginsModuleFallback } = await import("./compose.js")
        healPluginsModuleFallback(options.dshRoot)
        const stack = (container as { stackContext?: DshPluginStackContext }).stackContext
        if (!stack) return Promise.reject(new Error(`dsh bun-hmr: no boot stack context for profile ${JSON.stringify(container.profile)}`))
        const patches = composeFullPatchStack({
          profileLayers: stack.profileLayers,
          userPatches: stack.userPatches,
          extraPatches: stack.extraPatches,
          homePatches: stack.homePatches,
        })
        const previousConfig = (container.includeEntry as unknown as {
          options?: { config?: Record<string, unknown> }
        }).options?.config
        const { patches: _prev, ...rest } = previousConfig ?? {}
        await container.includeEntry.update({ config: { ...rest, patches } })
      }
      const watcher = watch(files, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 } })
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
              await replay()
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
      return Promise.resolve()
    },

    /** Stop everything. Idempotent; in-flight refreshes are awaited. */
    async stop(): Promise<void> {
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
    },
  }

  return service
}

export interface BunHmr {
  isActive(): boolean
  mount(): Promise<void>
  registerConfig(filename: string, refresh: () => Promise<void> | void): Promise<() => Promise<void>>
  watchCompositionFiles(profile: string): Promise<void>
  stop(): Promise<void>
}
