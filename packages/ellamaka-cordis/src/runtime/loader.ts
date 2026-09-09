import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import type * as Cordis from "@deepseek-ai/cordis"
import type CordisPluginLoader from "@deepseek-ai/cordis-plugin-loader"
import type * as DshAppBoot from "@deepseek-ai/dsh-app-boot"
import type * as DshCmdline from "@deepseek-ai/dsh-cmdline"
import type * as DshLaunchEnvironment from "@deepseek-ai/dsh-launch-environment"
import type * as DshHostWebserver from "@deepseek-ai/dsh-host-webserver"

/**
 * The six official DSH runtime modules the Bridge resolves dynamically from a
 * materialised closure via `installAnchor`. The value side is never statically
 * imported by the Bridge source — only build-time `import type` types survive.
 */
export type DshModuleName =
  | "cordis"
  | "pluginLoader"
  | "appBoot"
  | "cmdline"
  | "launchEnv"
  | "hostWebserver"

/**
 * Runtime handle to the six official DSH modules, resolved from the closure
 * the installation anchor points into. Values are loaded on demand so the
 * Bridge keeps no runtime top-level `@deepseek-ai/*` import.
 */
export interface DshRuntimeApi {
  cordis: typeof Cordis
  pluginLoader: typeof CordisPluginLoader
  appBoot: typeof DshAppBoot
  cmdline: typeof DshCmdline
  launchEnv: typeof DshLaunchEnvironment
  hostWebserver: typeof DshHostWebserver
}

/**
 * Map of every DshModuleName key to the bare specifier it resolves through a
 * `createRequire(installAnchor)` from the closure's shared `node_modules`.
 */
const MODULE_SPECIFIERS: Record<DshModuleName, string> = {
  cordis: "@deepseek-ai/cordis",
  pluginLoader: "@deepseek-ai/cordis-plugin-loader",
  appBoot: "@deepseek-ai/dsh-app-boot",
  cmdline: "@deepseek-ai/dsh-cmdline",
  launchEnv: "@deepseek-ai/dsh-launch-environment",
  hostWebserver: "@deepseek-ai/dsh-host-webserver",
}

// The module keys whose runtime value is the whole module namespace (`*`).
// `pluginLoader` is deliberately excluded: its default export is the Loader
// class the boot sequence plugs directly into `ctx.registry.plugin(...)`.
const NAMESPACE_KEYS: ReadonlySet<DshModuleName> = new Set([
  "cordis",
  "appBoot",
  "cmdline",
  "launchEnv",
  "hostWebserver",
])

/**
 * Resolve the DSH runtime API from this package's own `node_modules` closure
 * (the source/dev path, and the pre-materialised packaged layout). Used as the
 * fallback when a caller does not inject a runtime — equivalent to the old
 * module-top static imports. Memoised so repeated calls share one handle.
 */
let packageRuntime: DshRuntimeApi | undefined
export function createPackageDshRuntimeApi(): DshRuntimeApi {
  if (!packageRuntime) {
    const requireModule = createRequire(import.meta.url)
    packageRuntime = loadFromRequire(requireModule)
  }
  return packageRuntime
}

/**
 * Resolve the six official DSH runtime modules from a materialised closure.
 *
 * `installAnchor` is the absolute path to `@deepseek-ai/dsh/package.json`
 * inside the closure (DESIGN §3.4.6). A `createRequire(anchor)` is rooted at
 * that file so every `@deepseek-ai/*` specifier resolves through the closure's
 * own `node_modules` — independent of cwd, workspace, global node_modules, or
 * any application bundle.
 *
 * @param installAnchor - absolute path to the closure's `@deepseek-ai/dsh/package.json`.
 * @returns a {@link DshRuntimeApi} of the six resolved module namespaces.
 * @throws naming the module and anchor when any module cannot be resolved.
 */
export function createDshRuntimeApi(installAnchor: string): DshRuntimeApi {
  // Resolve to the real path before rooting `createRequire`: module resolution
  // walks up the *given* path, so a symlinked anchor (pnpm/arborist layout,
  // test fixtures) would miss the closure's own node_modules. The realpath is
  // where the closure's packages actually live.
  const requireModule = createRequire(realpathSync(installAnchor))
  return loadFromRequire(requireModule, installAnchor)
}

/**
 * Create a closure-scoped `require` rooted at the given install anchor.
 * Useful for resolving bare specifiers against the materialised closure.
 */
export function createClosureRequire(installAnchor: string): NodeRequire {
  return createRequire(realpathSync(installAnchor))
}

function loadFromRequire(
  requireModule: ReturnType<typeof createRequire>,
  installAnchor?: string,
): DshRuntimeApi {
  const api = {} as DshRuntimeApi
  for (const key of Object.keys(MODULE_SPECIFIERS) as DshModuleName[]) {
    const spec = MODULE_SPECIFIERS[key]
    try {
      const resolved = requireModule(spec)
      api[key] = NAMESPACE_KEYS.has(key) ? resolved : unwrapDefault(resolved)
    } catch (error) {
      const at = installAnchor ? ` from installAnchor "${installAnchor}"` : ""
      throw new Error(`ellamaka-cordis: failed to resolve DSH runtime module "${spec}"${at}`, {
        cause: error,
      })
    }
  }
  return api
}

/**
 * Return a module's `default` export when it carries one (ESM default-interop
 * through a CJS `createRequire`), else the module value itself. `pluginLoader`
 * is consumed as the Loader class value, so its namespace `.default` is
 * unwrapped here.
 */
function unwrapDefault<T>(value: T): T {
  if (
    typeof value === "object" &&
    value !== null &&
    "default" in value &&
    typeof (value as Record<string, unknown>).default !== "undefined"
  ) {
    return (value as { default: T }).default
  }
  return value
}
