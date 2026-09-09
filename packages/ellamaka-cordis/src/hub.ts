import type { Context } from "@deepseek-ai/cordis"
import type { HubRuntime, CordisHubOptions } from "./types.js"
import { createPackageDshRuntimeApi } from "./runtime/loader.js"

/** A lazily-resolved cordis module namespace value (never statically imported). */
let cordisContextValue: typeof import("@deepseek-ai/cordis")["Context"] | undefined

/**
 * Resolve the cordis `Context` value from the package closure (source/dev mode
 * ONLY — B-01). Packaged hosts (CLI bundle, Desktop sidecar) ship WITHOUT
 * `@deepseek-ai/*` in their own closure, so this fallback is a dev-time
 * convenience and MUST NOT be reached by any production mount call site. Every
 * production call site injects a closure-resolved context via
 * `CordisHubOptions.context`; this fallback is a narrowly-scoped, documented
 * dev-only seam.
 */
function resolveCordisContext(): typeof import("@deepseek-ai/cordis")["Context"] {
  if (!cordisContextValue) {
    const api = createPackageDshRuntimeApi()
    cordisContextValue = api.cordis.Context
  }
  return cordisContextValue
}

/**
 * Per-instance Cordis container.
 *
 * Each hub owns a fresh cordis `Context` and provides a mount point for
 * bridging work into the Effect world when needed (DESIGN-dsh-poc §6.2).
 *
 * Lifecycle:
 * - `mount(plugin, options)` loads a cordis plugin into the hub's context.
 * - `dispose()` tears the container down via `ctx.fiber.dispose()`.
 *
 * The hub is the single cordis boundary in the repository: every cordis value
 * import is erased at build time and resolved at runtime via
 * `@wopal/ellamaka-cordis/runtime` (DESIGN-dsh-poc §3.4.6).
 */
export class CordisHub {
  /** The cordis context backing this hub. */
  readonly ctx: Context
  /** Effect runtime mount point for bridge services; `null` when unprovided. */
  readonly runtime: HubRuntime
  private disposed = false

  constructor(runtime: HubRuntime, options: CordisHubOptions = {}) {
    this.runtime = runtime
    // Prefer an injected context; else resolve the cordis `Context` value.
    if (options.context !== undefined) {
      this.ctx = options.context
    } else {
      const resolved = resolveCordisContext()
      this.ctx = new resolved()
    }
    // `name` is reserved for future multi-instance diagnostics; the cordis
    // context currently has no stable naming hook beyond the fiber tree.
    void options.name
  }

  /**
   * Load a cordis plugin into this hub's context.
   *
   * Returns a promise that settles once the plugin's services are active and
   * rejected on config or startup errors (e.g. duplicate-service registration).
   */
  mount<T extends object = object>(
    plugin: Parameters<Context["plugin"]>[0],
    config?: unknown,
  ): Promise<void> {
    const fiber = this.ctx.plugin(plugin as never, config as never)
    return fiber as unknown as Promise<void>
  }

  /**
   * Tear the container down, calling `ctx.fiber.dispose()`.
   *
   * Idempotent: subsequent calls are no-ops.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.ctx.fiber.dispose()
  }
}
