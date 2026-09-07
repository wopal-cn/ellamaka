import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { readProfileManifest } from "./profile-manifest.js"
import { parseDocument } from "yaml"
import { homeProfilesDirOf } from "../runtime/status.js"
import { resolveRowSpecifier } from "./resolve-specifiers.js"

/**
 * Plugin composition on the OFFICIAL bundle semantics (Plan 223 alignment).
 *
 * The profile manifest's `dsh.profile.bundles` is the ONLY composition
 * source, and EVERY bundle — official `@deepseek-ai/*` or a user plugin — is
 * an official `loadProfile` layer: the closure parses each package's
 * `cordis.patch.yml` with the FULL official grammar (disable rows, nested
 * config, `!!js` expressions). There is no Bridge-owned plugin track and no
 * handwritten subset parser; the loader diffs entries by id exactly as the
 * official CLI boot does.
 *
 * The Bridge owns exactly one thing here (B1 拆雷, preserved): bare package
 * names inside official layers are resolved to absolute `file://` URLs at
 * the composition point ({@link resolveUserBundleNames}), because the
 * official `loader.internal` resolution path does not exist under Bun. Boot
 * and hot reload share the same composition ({@link composeFullPatchStack}).
 */

/**
 * The per-container patch-stack context captured at boot: every
 * manifest-independent layer of the container's composition. The Plugin
 * Runtime Service passes this back to {@link composeFullPatchStack} so a hot
 * replay rebuilds the ENTIRE stack (rook B-01) instead of replacing it with
 * plugin rows only.
 */
export interface DshPluginStackContext {
  /**
   * Recomposable official bundle layers (`loadProfile(...).layers` — EVERY
   * bundle, official or user plugin, with bare names already resolved to
   * `file://` URLs). Boot passes a closure over the official loader so a hot
   * replay recomposes FRESH (a plugin installed after boot mounts on the
   * next replay, official `reconcilePlugins` semantics); a static list is
   * accepted for tests. Both shapes carry RESOLVED names — composition is
   * pure transport.
   */
  profileLayers: { patches: unknown[] }[] | (() => { packageName: string; patches: unknown[] }[])
  /** The profile's own user patch layer (`cordis.patch.yml` rows). */
  userPatches: unknown[]
  /** The Bridge's extraPatches for this mount. */
  extraPatches: unknown[]
  /** The home config injection rows (official home semantics). */
  homePatches: unknown[]
}

/**
 * Composition options carrying the resolution anchors (B1 拆雷).
 */
export interface ComposeLayersOptions {
  /**
   * The install anchor the container's profile loads from (the closure's
   * `@deepseek-ai/dsh/package.json`). Passed through to the specifier
   * resolver; when omitted it falls back to this package's own closure.
   */
  installAnchor?: string
}

/** The profile directory of one profile name under a territory root. */
export function profileDirOf(dshRoot: string, profile: string): string {
  return join(homeProfilesDirOf(dshRoot), profile)
}



/**
 * Resolve bare package names inside OFFICIAL bundle layers to absolute
 * `file://` URLs (B1 拆雷, kept): the official `loader.internal` resolution
 * path does not exist under Bun, so the Bridge rewrites every bare `name` —
 * profile entity first, then the shared closure -> profiles anchor order —
 * and hands the Loader final URLs. Layer objects are cloned; the official
 * parse output is never mutated.
 */
export function resolveUserBundleNames(
  layers: { packageName?: string; patches: unknown[] }[],
  options?: ComposeLayersOptions & { dshRoot?: string; profile?: string },
): { packageName?: string; patches: unknown[] }[] {
  const dshRoot = options?.dshRoot
  return layers.map((layer) => {
    const patches = structuredClone(layer.patches)
    const packageName = layer.packageName ?? ""
    // Official closure bundles stay UNTOUCHED: their bare names resolve
    // natively inside the closure under both runtimes. Only USER plugin
    // layers need the file:// rewrite (Bun's native import cannot reach
    // home/profiles packages).
    if (!dshRoot || !options?.profile || packageName.startsWith("@deepseek-ai/")) {
      return { packageName: layer.packageName, patches }
    }
    // Anchor the parent-walk at the plugin's own directory (its siblings and
    // own subtree resolve natively).
    const packageDir = join(profileDirOf(dshRoot, options.profile), "node_modules", ...packageName.split("/"))
    const visit = (row: unknown) => {
      if (row === null || typeof row !== "object") return
      const record = row as Record<string, unknown>
      const name = record.name
      if (typeof name === "string" && !name.startsWith("file://") && !name.startsWith(".") && !name.startsWith("cordis:") && !name.startsWith("@deepseek-ai/")) {
        // Best effort: rewrite to the entity's entry URL; on failure KEEP the
        // bare name — the Loader falls back to native import() (official
        // embedder semantics) and the standing patch warning surfaces it.
        try {
          record.name = pathToFileURL(createRequire(join(packageDir, "package.json")).resolve(name)).href
        } catch {
          try {
            record.name = resolveRowSpecifier(name, { dshRoot, installAnchor: options?.installAnchor })
          } catch {
            // keep the bare name
          }
        }
      }
      if (Array.isArray(record.config)) record.config.forEach(visit)
      if (Array.isArray(record.insert)) record.insert.forEach(visit)
    }
    patches.forEach(visit)
    return { packageName: layer.packageName, patches }
  })
}

/**
 * The full patch stack of one container (D-01/D-03): official bundle layers
 * (EVERY bundle, official or user) -> user patch layer -> extra patches ->
 * home patches. Boot AND hot reload call this ONE function — a hot replay
 * must rebuild the entire stack, because the include re-applies
 * `config.patches` over the raw config on every update and replacing the
 * list would drop the official bundle/user/home rows.
 */
export function composeFullPatchStack(layers: {
  profileLayers: { patches: unknown[] }[] | (() => { packageName: string; patches: unknown[] }[])
  userPatches: unknown[]
  extraPatches: unknown[]
  homePatches: unknown[]
}): unknown[] {
  // Pure transport: the official layers arrive with bare names ALREADY
  // resolved (the boot closure owns the anchors — {@link resolveUserBundleNames}).
  const official = typeof layers.profileLayers === "function" ? layers.profileLayers() : layers.profileLayers
  return [
    ...official.flatMap((layer) => layer.patches),
    ...layers.userPatches,
    ...layers.extraPatches,
    ...layers.homePatches,
  ]
}

/**
 * Read the profile's CURRENT user patch layer (`cordis.patch.yml`) for a hot
 * replay. Official `loadOptionalPatches` semantics: a missing file is an
 * empty layer; a present file must parse as a top-level YAML sequence or the
 * error propagates (fail loud — the composition layer keeps the last good
 * state on a replay failure).
 *
 * The replay path MUST call this per replay instead of reusing the boot-time
 * snapshot: the user patch layer is the enable/disable surface, and a stale
 * snapshot races the official `watchUserPatches` (which reads fresh bytes)
 * and re-applies rows the user just removed.
 */
export function readUserPatchLayer(dshRoot: string, profile: string): unknown[] {
  const file = join(profileDirOf(dshRoot, profile), "cordis.patch.yml")
  let content: string
  try {
    content = readFileSync(file, "utf8")
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return []
    throw error
  }
  const document = parseDocument(content)
  if (document.errors.length > 0) {
    throw new Error(`dsh plugin compose: failed to parse user patch layer ${file}: ${document.errors.map((error) => error.message).join("; ")}`)
  }
  const body = document.contents
  if (body === null || body === undefined) return []
  const rows = (body as { items?: unknown }).items
  if (!Array.isArray(rows)) {
    throw new Error(`dsh plugin compose: user patch layer ${file} is not a top-level YAML sequence`)
  }
  return rows.map((row) => (row as { toJSON?: () => unknown }).toJSON?.() ?? row)
}

/**
 * Maintain the user half of the flat module fallback
 * `$DSH_HOME/profiles/node_modules` (the territory's `home/profiles/node_modules`):
 * one symlink per user-declared plugin package, so a bare package name in a
 * plugin layer resolves through the ordinary Node parent-walk from the
 * profile directory (spike 2: the profiles-anchor require finds
 * `node_modules/<pkg>` beside it).
 *
 * This is self-owned (it does not touch the official
 * `healProfilesModuleFallback`): the official function links the closure's
 * dependency BFS; this one links the profile's declared user packages.
 * Idempotent — correct links are kept, stale links are re-pointed, entries
 * not declared by the manifest are left alone.
 */
export function healPluginsModuleFallback(dshRoot: string): void {
  const modulesDir = join(homeProfilesDirOf(dshRoot), "node_modules")
  mkdirSync(modulesDir, { recursive: true })
  const profilesDir = homeProfilesDirOf(dshRoot)
  const profileNames = existsSync(profilesDir)
    ? readdirSync(profilesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
        .map((entry) => entry.name)
    : []
  for (const profile of profileNames) {
    const profileDir = join(profilesDir, profile)
    const manifest = readProfileManifest(profileDir)
    for (const packageName of manifest.bundles) {
      // Official bundles are linked by the closure's own fallback healer;
      // this one links the profile's user-declared packages only.
      if (packageName.startsWith("@deepseek-ai/")) continue
      const target = join(profileDir, "node_modules", ...packageName.split("/"))
      const link = join(modulesDir, packageName)
      if (!existsSync(join(target, "package.json"))) continue // damaged install: skip, compose will fail loud
      mkdirSync(join(modulesDir, ...packageName.split("/").slice(0, -1)), { recursive: true })
      rePointSymlink(link, target)
    }
  }
}

/** Ensure `link` is a symlink resolving to `target`; re-point when stale. */
function rePointSymlink(link: string, target: string): void {
  let current: string | undefined
  let isLink = false
  try {
    current = realpathSync(link)
    isLink = lstatSync(link).isSymbolicLink()
  } catch {
    current = undefined
  }
  if (current !== undefined) {
    if (isLink && current === target) return // already correct
    if (isLink) {
      // A stale link owned by us (same basename semantics): re-point it.
      rmSync(link, { force: true })
    } else {
      // A real directory/file occupies the name — never delete user data.
      return
    }
  } else {
    // realpath failed: either the link does not exist, or it DANGLES (rook
    // B-06: a remove left a link whose target is gone). A dangling entry we
    // own (a symlink whose lstat succeeds but realpath fails) must be
    // replaced, or symlinkSync below would fail EEXIST forever.
    try {
      const stale = lstatSync(link)
      if (stale.isSymbolicLink()) {
        rmSync(link, { force: true })
      } else {
        return // a real file/directory — never delete user data
      }
    } catch {
      // Nothing at the path: fall through to create the link fresh.
    }
  }
  try {
    symlinkSync(target, link, "dir")
  } catch {
    // Lost a race with another healer that just created the same link.
    if (!existsSync(link)) throw new Error(`dsh plugin compose: failed to link ${link} -> ${target}`)
  }
}

/**
 * Remove this module's `profiles/node_modules/<name>` link for one plugin.
 * Called by the installer on remove so a later reinstall (any version) never
 * trips over a dangling link (rook B-06). A foreign entry at the path is
 * left alone.
 */
export function removePluginSymlink(dshRoot: string, name: string): void {
  const link = join(homeProfilesDirOf(dshRoot), "node_modules", ...name.split("/"))
  try {
    if (lstatSync(link).isSymbolicLink()) {
      rmSync(link, { force: true })
    }
  } catch {
    // Nothing there (or unreadable): nothing to clean.
  }
}
