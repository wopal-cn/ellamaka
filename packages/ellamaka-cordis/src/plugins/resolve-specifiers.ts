/**
 * B1 (拆雷) explicit specifier resolution: rewrite a Bridge-composed row's
 * `name` to an absolute `file://` URL BEFORE the row reaches the Loader
 * (DESIGN-dsh-poc 「Bun 下不伪造 loader.internal（拆雷）」, Path 1 per the
 * spike record `.wopal-space/.tmp/spike-result.md`).
 *
 * After the fake `loader.internal` injection is removed, the official
 * `EntryTree.import` consults `ctx.loader.internal` dynamically and falls
 * back to native `import()` when absent. Bun's native resolution reaches
 * everything inside the closure (spike probes 1/3) but NOT packages that
 * exist only under `home/profiles/node_modules` — i.e. exactly the rows the
 * Bridge composes itself. Official bundle rows (bare `@deepseek-ai/*`
 * names) are NOT Bridge-owned and stay untouched: their bare names keep
 * resolving through `bareModuleBaseUrl` under Node's internal loader and
 * natively under bun.
 *
 * Resolution order per the supply-chain contract (D-05): closure
 * `node_modules` first (via the install anchor), then the profiles anchor
 * (`<dshRoot>/home/profiles/`), where the healed user-plugin symlinks live.
 * An unresolvable name rethrows the resolver's own error, preserving the
 * original error semantics.
 */
import { createRequire } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createClosureRequire } from "../runtime/loader.js"
import { homeProfilesDirOf } from "../runtime/status.js"

/** Options for {@link resolveRowSpecifier}. */
export interface ResolveRowOptions {
  /**
   * The Ellamaka territory root (`$WOPAL_HOME/dsh`) whose profiles anchor
   * (`<dshRoot>/home/profiles/`) is consulted second.
   */
  dshRoot: string
  /**
   * Absolute path to the closure's `@deepseek-ai/dsh/package.json` install
   * anchor (the mount's closure). Optional: resolution then falls back to
   * this module's own package closure (source/dev mode only — every
   * production mount passes the anchor, see `DshHostOptions.installAnchor`).
   */
  installAnchor?: string
}

/** One composed patch row whose `name` may carry a bare package specifier. */
export interface ResolvableRow {
  name: string
  [key: string]: unknown
}

/**
 * Resolve ONE row `name` to an absolute `file://` URL.
 *
 * Non-bare specifiers pass through: absolute `file://` URLs, relative
 * specifiers, and `cordis:` builtins are consumed by the Loader directly.
 * Bare names resolve closure-first, then profiles, preserving the exact
 * order of the removed fake `internal.import` (closureRequire ->
 * profilesRequire).
 *
 * The Loader normalises ESM/CJS/default shapes before applying a plugin, so
 * resolving the package's entry file (package.json main/exports via
 * `require.resolve`) and converting it with `pathToFileURL` yields a module
 * the Loader consumes identically.
 *
 * @throws the underlying resolution error (e.g. `Cannot find module '<name>'`)
 *   when the name is bare and resolvable in neither area.
 */
export function resolveRowSpecifier(name: string, options: ResolveRowOptions): string {
  // Pass-through: the Loader handles these natively (its relative-URL branch
  // and `cordis:` builtin map). An absolute file URL is already final.
  if (!name || name.startsWith(".") || name.startsWith("cordis:") || name.startsWith("file://")) {
    return name
  }
  const errors: unknown[] = []
  // Closure first: the same anchor-driven require the fake internal used.
  // `createClosureRequire` realpaths the anchor so the node_modules walk
  // reaches the materialised closure regardless of a symlinked layout.
  try {
    const closureRequire = options.installAnchor
      ? createClosureRequire(options.installAnchor)
      : createRequire(import.meta.url)
    return pathToFileURL(closureRequire.resolve(name)).href
  } catch (error) {
    errors.push(error)
  }
  // Then the profiles anchor: parent-walk from `home/profiles/` reaches
  // `home/profiles/node_modules/<pkg>` (the healed plugin symlinks).
  try {
    const profilesRequire = createRequire(join(homeProfilesDirOf(options.dshRoot), "anchor.js"))
    return pathToFileURL(profilesRequire.resolve(name)).href
  } catch (error) {
    errors.push(error)
  }
  throw errors[0] ?? new Error(`dsh plugin compose: cannot resolve plugin specifier "${name}"`)
}

/** The minimal internal-loader surface the Bridge may wrap (Node sidecar). */
export interface InternalImporter {
  import(name: string, ...rest: unknown[]): Promise<unknown>
}

/**
 * Wrap an EXISTING internal loader's `import` with the profiles fallback
 * (rook W-01): the internal loader (Node sidecar) resolves official closure
 * packages but not user plugins under `home/profiles/node_modules`, so every
 * import path must end with a profiles-anchored require. The internal
 * resolution stays first; an unresolved name rethrows the internal's
 * original error. Mutates `internal.import` in place, as the bridge always
 * did for real internals.
 */
export function wrapInternalWithProfilesFallback(internal: InternalImporter, dshRoot: string): void {
  const profilesRequire = createRequire(join(homeProfilesDirOf(dshRoot), "anchor.js"))
  const internalImport = internal.import.bind(internal)
  internal.import = async (name: string, ...rest: unknown[]) => {
    try {
      return await internalImport(name, ...rest)
    } catch (error) {
      try {
        return profilesRequire(name)
      } catch {
        throw error
      }
    }
  }
}
