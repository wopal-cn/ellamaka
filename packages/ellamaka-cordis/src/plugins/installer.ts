import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { withPluginsLock, writeProfileManifestLocked, readProfileManifest, setDependency, dropPlugin, appendBundle } from "./profile-manifest.js"
import { profileDirOf, healPluginsModuleFallback, removePluginSymlink } from "./compose.js"
import { resolveTree, type ResolveSpec, type ResolvedTree } from "./resolver.js"

/**
 * Plugin installer: the install/remove pipeline of the dsh plugin supply
 * chain, rewritten to the OFFICIAL end state (DESIGN-dsh-poc 「Bun 安装器流水线」).
 *
 * Registry pipeline: resolveTree → per-package extract into a staging dir
 * (pacote in production via the injectable {@link ExtractLike}) → entry +
 * transitive deps moved into `<profile>/node_modules/` (parent-walk
 * resolvable; official `@deepseek-ai/*` packages are skipped — the shared
 * profiles/node_modules heal satisfies them) → the profile `package.json`
 * declares the dependency + appends the bundle row (official CLI
 * reconcilePlugins semantics, atomic write under the plugins lock).
 *
 * `--dir` pipeline: copy the directory tree into place + declare. Local
 * directories carry no registry manifest, so no resolution happens.
 *
 * Failure semantics (DESIGN 验收基线 #5): any failure before the declaration
 * write cleans staging and leaves the profile directory UNTOUCHED; the error
 * propagates with diagnostics. Same-name re-add overwrites (official CLI
 * replace semantics — no AlreadyInstalledError).
 */

/** `pacote.extract`-shaped download boundary (production: dynamic import). */
export type ExtractLike = (spec: string, dest: string, opts?: { registry?: string }) => Promise<unknown>

/** Where a package install comes from. */
export type InstallSpec = ResolveSpec

/** Options accepted by {@link installPackage} / {@link removePackage}. */
export interface InstallOptions {
  /**
   * The Ellamaka territory root (`$WOPAL_HOME/dsh`), NOT the DSH home; the
   * profiles live under `home/profiles/`.
   */
  home: string
  /** Injected extract (production: pacote). Tests inject fakes. */
  extract?: ExtractLike
  /** Injected tree resolver (production: plugins/resolver.ts). */
  resolve?: (spec: InstallSpec) => Promise<ResolvedTree>
  /** Registry for the extract boundary; defaults to npm. */
  registry?: string
  /**
   * The profiles to install into (default: `["web"]`). Each requested
   * profile receives the package entity and the manifest declaration.
   */
  profiles?: string[]
  /**
   * Legacy CLI alias for {@link profiles} (the old store's `enabledIn`
   * semantics: which profiles see the plugin). Kept so the CLI shape is
   * stable across the Task-7 retarget.
   */
  enabledIn?: string[]
}

/** Result of a successful {@link installPackage}. */
export interface InstallResult {
  name: string
  version: string
  source: "registry" | "dir"
  /**
   * Whether the package manifest declares `dsh.bundle.patch` — i.e. whether
   * the package is a mountable dsh bundle. A plain library dependency
   * installs fine but cannot mount.
   */
  isBundle: boolean
  /** Present when the package installed but cannot mount (isBundle false). */
  warning?: string
}

/** Removal requested for a plugin that is not installed. */
export class NotInstalledError extends Error {
  constructor(name: string) {
    super(`dsh plugin installer: ${name} is not installed`)
    this.name = "NotInstalledError"
  }
}

/** The default install profile (official CLI default). */
const DEFAULT_PROFILES = ["web"]

/**
 * npm package-name rule (simplified but strict): scope/name segments of
 * lowercase URL-safe characters, no leading `.|_|-`, no path separators — a
 * name doubles as a directory name under `node_modules/`, so anything else
 * (including `../`) is rejected (rook B-08).
 */
const PACKAGE_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** Exact semver (the installer pins one version per profile manifest entry). */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** Validate an untrusted name+version pair from a package manifest. */
export function assertSafePackageIdentity(name: string, version: string): void {
  if (name.length > 214 || !PACKAGE_NAME_RE.test(name)) {
    throw new Error(`dsh plugin installer: unsafe package name ${JSON.stringify(name)} (npm name rules)`)
  }
  if (!SEMVER_RE.test(version)) {
    throw new Error(`dsh plugin installer: unsafe package version ${JSON.stringify(version)} (exact semver required)`)
  }
}

/**
 * GitHub-source transports are phase 2 (git clone + build); phase 1 gives a
 * clear error with the npm alternative instead of a confusing resolver
 * failure (D-07).
 */
export function assertNotGithubSource(spec: string): void {
  if (/^github:/i.test(spec)) {
    throw new Error(
      `dsh plugin installer: github sources are not supported yet ("${spec}") — install the npm published package instead (e.g. "ellamaka dsh plugin add <npm-package-name>")`,
    )
  }
}

/**
 * Ensure a computed install target stays INSIDE the profile's node_modules —
 * the last line of defence against a crafted manifest escaping the install
 * area with `../` segments (rook B-08).
 */
function assertTargetInsideProfileModules(profileModulesDir: string, target: string): void {
  const area = resolve(profileModulesDir)
  const resolvedTarget = resolve(target)
  if (resolvedTarget !== area && !resolvedTarget.startsWith(area + sep)) {
    throw new Error(
      `dsh plugin installer: install target ${resolvedTarget} escapes the profile node_modules ${area} — refusing`,
    )
  }
}

/** Production extractor: `pacote.extract` (dynamically imported, Bun/Node). */
async function createRealExtract(): Promise<ExtractLike> {
  const { default: pacote } = await import("pacote")
  return (spec, dest, opts) => pacote.extract(spec, dest, { registry: opts?.registry, ignoreScripts: true })
}

/** Read a package manifest from a directory. */
function readManifest(pkgDir: string): Record<string, unknown> {
  const manifestPath = join(pkgDir, "package.json")
  if (!existsSync(manifestPath)) {
    throw new Error(`dsh plugin installer: extracted package has no package.json at ${pkgDir}`)
  }
  return JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>
}

/** Whether the manifest declares a mountable dsh bundle patch. */
export function manifestIsBundle(manifest: Record<string, unknown>): boolean {
  const dsh = manifest.dsh as { bundle?: { patch?: string } } | undefined
  return typeof dsh?.bundle?.patch === "string" && dsh.bundle.patch.length > 0
}

/** Official packages never download into a profile (shared heal covers them). */
function isOfficialPackage(name: string): boolean {
  return name.startsWith("@deepseek-ai/")
}

/** Install a plugin (registry or local dir). Holds the plugins mutex. */
export async function installPackage(spec: InstallSpec, options: InstallOptions): Promise<InstallResult> {
  return withPluginsLock(options.home, () =>
    spec.kind === "dir" ? installFromDir(spec.path, options) : installFromRegistry(spec, options),
  )
}

/** Read name+version from a package directory's manifest. */
function manifestIdentity(dir: string): { name: string; version: string; manifest: Record<string, unknown> } {
  const manifest = readManifest(dir)
  const name = manifest.name as string | undefined
  const version = manifest.version as string | undefined
  if (typeof name !== "string" || name.length === 0 || typeof version !== "string" || version.length === 0) {
    throw new Error(`dsh plugin installer: package.json at ${dir} lacks name/version`)
  }
  // Untrusted manifest fields become directory path segments — validate
  // BEFORE any path math (rook B-08).
  assertSafePackageIdentity(name, version)
  return { name, version, manifest }
}

function noBundleWarning(name: string): string {
  return `${name} declares no "dsh.bundle.patch" in its package.json: installed as a plain dependency, but it provides no dsh bundle to mount`
}

/**
 * Place the staged entry package + its flat transitive tree into ONE
 * profile's node_modules, then declare it in that profile's manifest.
 * Any throw propagates to the staging cleanup (profile untouched).
 */
function placeIntoProfile(
  profile: string,
  entryName: string,
  entryVersion: string,
  source: "registry" | "dir",
  isBundle: boolean,
  options: InstallOptions,
  place: (entityDir: string) => void,
): InstallResult {
  const profileDir = profileDirOf(options.home, profile)
  const modulesDir = join(profileDir, "node_modules")
  const entityDir = join(modulesDir, ...entryName.split("/"))
  assertTargetInsideProfileModules(modulesDir, entityDir)
  mkdirSync(modulesDir, { recursive: true })
  // Replace semantics: an existing entity (same or different version) is
  // overwritten (official CLI reinstall semantics).
  rmSync(entityDir, { recursive: true, force: true })
  place(entityDir)

  writeProfileManifestLocked(profileDir, (manifest) => {
    setDependency(manifest, entryName, entryVersion)
    if (isBundle) appendBundle(manifest, entryName)
    else dropBundleRowIfPresent(manifest, entryName)
  })
  return {
    name: entryName,
    version: entryVersion,
    source,
    isBundle,
    warning: isBundle ? undefined : noBundleWarning(entryName),
  }
}

/**
 * Drop a bundle row when the package is present but no longer declares a
 * bundle patch (a later update that loses the declaration deactivates the
 * layer, official reconcilePlugins symmetric).
 */
function dropBundleRowIfPresent(manifest: Record<string, unknown>, name: string): void {
  const bundles = (manifest.dsh as { profile?: { bundles?: unknown } } | undefined)?.profile?.bundles
  if (Array.isArray(bundles)) {
    const list = bundles as unknown[]
    const index = list.indexOf(name)
    if (index !== -1) list.splice(index, 1)
  }
}

/**
 * Copy a staged registry tree into place: the staged entry package becomes
 * the entity; EVERY non-official package of the tree lands under the entry
 * package's `node_modules/` (parent-walk resolvable, rook B-03).
 *
 * One staged tree serves EVERY target profile: `copy` places a duplicate
 * (cpSync) so the staging source survives; only the LAST profile `rename`s
 * and drains the staging (same source-multiple-place pattern as the
 * migrate-store `placeEntity` lastUse rule).
 */
function placeStagedTree(staging: string, entryName: string, tree: ResolvedTree, entityDir: string, copy: boolean): void {
  mkdirSync(dirname(entityDir), { recursive: true })
  const place = (source: string, target: string) => {
    if (copy) cpSync(source, target, { recursive: true })
    else renameSync(source, target)
  }
  place(join(staging, "node_modules", ...entryName.split("/")), entityDir)
  for (const dep of tree.packages.values()) {
    if (dep.name === entryName || isOfficialPackage(dep.name)) continue
    const stagedDep = join(staging, "node_modules", ...dep.name.split("/"))
    if (!existsSync(stagedDep)) continue
    const depTarget = join(entityDir, "node_modules", ...dep.name.split("/"))
    rmSync(depTarget, { recursive: true, force: true })
    mkdirSync(dirname(depTarget), { recursive: true })
    place(stagedDep, depTarget)
  }
}

/** The registry pipeline: resolve → stage → place per profile → declare. */
async function installFromRegistry(
  spec: { name: string; version?: string },
  options: InstallOptions,
): Promise<InstallResult> {
  assertNotGithubSource(spec.version ?? spec.name)
  const resolve = options.resolve ?? ((s: InstallSpec) => resolveTree(s, { registry: options.registry }))
  const tree = await resolve({ kind: "registry", name: spec.name, version: spec.version })

  const rootId = `${tree.root.name}@${tree.root.version}`
  const rootPkg = tree.packages.get(rootId)
  if (!rootPkg) {
    throw new Error(`dsh plugin installer: resolved tree for ${rootId} is missing its root package`)
  }
  assertSafePackageIdentity(rootPkg.name, rootPkg.version)

  const profiles = options.profiles ?? options.enabledIn ?? DEFAULT_PROFILES
  // PRE-FLIGHT: validate every target profile BEFORE staging so a bad
  // profile name never leaves a half state anywhere.
  for (const profile of profiles) {
    assertSafeProfileName(profile)
  }

  const extract = options.extract ?? (await createRealExtract())
  // Staging scene: a temp dir OUTSIDE the profile; a failed staging is never
  // resolvable as an install (DESIGN 失败语义).
  const staging = mkdtempSync(join(tmpdir(), "dsh-plugins-stage-"))
  try {
    // Every tree name becomes a directory path segment (staging + profile
    // node_modules) — validate the UNTRUSTED registry data before any path
    // math, same standard as the root identity check (rook W-01, B-08).
    for (const pkg of tree.packages.values()) {
      assertSafePackageIdentity(pkg.name, pkg.version)
    }
    for (const pkg of tree.packages.values()) {
      if (isOfficialPackage(pkg.name)) continue // shared heal resolves them
      const spec2 = `${pkg.name}@${pkg.version}`
      // pacote.extract strips the tarball's `package/` root into dest — pass
      // each package's FINAL slot so the staged tree matches the layout
      // placeStagedTree reads (staging/node_modules/<name>).
      await extract(
        spec2,
        join(staging, "node_modules", ...pkg.name.split("/")),
        options.registry ? { registry: options.registry } : undefined,
      )
    }
    const stagedRoot = join(staging, "node_modules", ...rootPkg.name.split("/"))
    if (!existsSync(join(stagedRoot, "package.json"))) {
      throw new Error(`dsh plugin installer: staged tree missing the entry package at ${stagedRoot}`)
    }
    const stagedManifest = readManifest(stagedRoot)
    const isBundle = manifestIsBundle(stagedManifest)

    let result: InstallResult | undefined
    for (const [index, profile] of profiles.entries()) {
      // The staging source is only drained (rename) by the LAST profile;
      // earlier placements copy so the next profile can read it (rook B-01).
      const last = index === profiles.length - 1
      result = placeIntoProfile(
        profile,
        rootPkg.name,
        rootPkg.version,
        "registry",
        isBundle,
        options,
        (entityDir) => placeStagedTree(staging, rootPkg.name, tree, entityDir, !last),
      )
    }
    if (!result) throw new Error("dsh plugin installer: no target profiles")
    healPluginsModuleFallback(options.home)
    return result
  } finally {
    // Staging is always drained: on success the packages were renamed out of
    // it; on failure this removes the partial scene.
    rmSync(staging, { recursive: true, force: true })
  }
}

/** Valid profile name: no separators, no traversal (it is a path segment). */
function assertSafeProfileName(profile: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(profile) || profile === "node_modules") {
    throw new Error(`dsh plugin installer: unsafe profile name ${JSON.stringify(profile)}`)
  }
}

/** The `--dir` pipeline: copy + validate + declare per profile. */
function installFromDir(path: string, options: InstallOptions): InstallResult {
  if (!existsSync(join(path, "package.json"))) {
    throw new Error(`dsh plugin installer: ${path} has no package.json`)
  }
  const { name, version, manifest } = manifestIdentity(path)
  const profiles = options.profiles ?? options.enabledIn ?? DEFAULT_PROFILES
  for (const profile of profiles) {
    assertSafeProfileName(profile)
  }
  const isBundle = manifestIsBundle(manifest)

  let result: InstallResult | undefined
  for (const profile of profiles) {
    result = placeIntoProfile(profile, name, version, "dir", isBundle, options, (entityDir) => {
      cpSync(path, entityDir, { recursive: true })
    })
  }
  if (!result) throw new Error("dsh plugin installer: no target profiles")
  healPluginsModuleFallback(options.home)
  return result
}

/**
 * Remove an installed plugin from every profile that declares it: delete
 * `<profile>/node_modules/<name>/` and drop the dependency + bundle
 * declaration. Holding the plugins mutex for the whole operation keeps
 * CLI-side writers serialised.
 */
export async function removePackage(name: string, options: { home: string }): Promise<void> {
  assertSafePackageIdentity(name, "0.0.0")
  return withPluginsLock(options.home, async () => {
    const profilesDir = join(options.home, "home", "profiles")
    let removed = false
    for (const profile of listProfileNames(options.home)) {
      const manifest = readProfileManifest(join(profilesDir, profile))
      const hasDependency = name in manifest.dependencies
      const hasBundle = manifest.bundles.includes(name)
      if (!hasDependency && !hasBundle) continue
      removed = true
      const entityDir = join(profileDirOf(options.home, profile), "node_modules", ...name.split("/"))
      rmSync(entityDir, { recursive: true, force: true })
      writeProfileManifestLocked(join(profilesDir, profile), (manifest2) => {
        dropPlugin(manifest2, name)
      })
      removePluginSymlink(options.home, name)
    }
    if (!removed) {
      // Nothing declared the package anywhere: not installed.
      throw new NotInstalledError(name)
    }
    healPluginsModuleFallback(options.home)
  })
}

/**
 * List installed plugins from the profile manifest user bundles (the truth
 * source; thin re-export for CLI use).
 */
export function listInstalled(home: string, profile = "web"): { name: string; version: string }[] {
  const manifest = readProfileManifest(profileDirOf(home, profile))
  return manifest.bundles
    .filter((name) => !isOfficialPackage(name))
    .map((name) => ({ name, version: manifest.dependencies[name] ?? "unknown" }))
}

/** The profile names currently present under the home (safe subset). */
function listProfileNames(home: string): string[] {
  const profilesDir = join(home, "home", "profiles")
  if (!existsSync(profilesDir)) return []
  return readdirSync(profilesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
    .map((entry) => entry.name)
}
