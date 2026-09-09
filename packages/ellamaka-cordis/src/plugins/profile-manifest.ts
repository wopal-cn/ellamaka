import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { acquireMaterializeLock, releaseMaterializeLock, type LockToken } from "../runtime/lock.js"

/**
 * Profile manifest: the OFFICIAL composition source of truth for dsh plugins
 * (DESIGN-dsh-poc 「真相源与目录布局」). The profile directory's `package.json`
 * carries the installed packages (`dependencies`) and the activated plugin
 * layers (`dsh.profile.bundles`) — the same files the official CLI, the
 * dshmarket and Ellamaka read and write. No second manifest exists (D-04).
 *
 * Layout under the Ellamaka territory root (`$WOPAL_HOME/dsh`):
 *   home/profiles/<name>/package.json — the manifest (this module)
 *   locks/plugins.lock                — cross-process mutex for writers
 *
 * Writes are atomic (tmp file + rename inside the profile dir) and serialised
 * through the `plugins.lock` guard, so concurrent CLI writers serialise and
 * a file-watching replay service only ever observes consistent documents.
 */

/** The profile manifest filename (official shape). */
export const PROFILE_MANIFEST_FILENAME = "package.json"

/** The `dsh.profile.bundles` field path: activated plugin layers, in order. */
export interface ProfileManifest {
  /**
   * The installed packages and their version ranges. A missing `dependencies`
   * field reads as empty; writes create it.
   */
  dependencies: Record<string, string>
  /**
   * The activated plugin layers (`dsh.profile.bundles`), in application
   * order. Official bundle rows (`@deepseek-ai/*`) keep their position; user
   * plugins append at the tail. A missing field reads as empty.
   */
  bundles: string[]
  /**
   * The raw manifest document. Persisted unchanged apart from the fields the
   * mutators touch — every official field outside `dsh.profile` is preserved.
   */
  raw: Record<string, unknown>
}

/** The cross-process plugins mutex filename (in `locks/`). */
export const PLUGINS_LOCK_FILENAME = "plugins.lock"

/** Absolute path of the cross-process plugins mutex for a dsh root. */
export function pluginsLockFile(dshRoot: string): string {
  return join(dshRoot, "locks", PLUGINS_LOCK_FILENAME)
}

/** Run `fn` while holding the cross-process plugins mutex. */
export async function withPluginsLock<T>(dshRoot: string, fn: () => Promise<T> | T): Promise<T> {
  const lockPath = pluginsLockFile(dshRoot)
  const timeoutMs = 30_000
  const token: LockToken | null = await acquireMaterializeLock(lockPath, timeoutMs)
  if (!token) {
    throw new Error(`dsh profile manifest: timed out acquiring ${lockPath} after ${timeoutMs}ms`)
  }
  try {
    return await fn()
  } finally {
    await releaseMaterializeLock(lockPath, token)
  }
}

/**
 * Read the profile manifest. A missing file reads as an EMPTY manifest (a
 * fresh profile installs nothing); a present but invalid manifest fails loud
 * naming the offending field — a corrupt truth source must never be silently
 * emptied.
 */
export function readProfileManifest(profileDir: string): ProfileManifest {
  const file = join(profileDir, PROFILE_MANIFEST_FILENAME)
  if (!existsSync(file)) {
    return { dependencies: {}, bundles: [], raw: {} }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"))
  } catch (error) {
    throw new Error(`dsh profile manifest: failed to parse ${file}: ${(error as Error).message}`, { cause: error })
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`dsh profile manifest: ${file} must hold a JSON object`)
  }
  const raw = parsed as Record<string, unknown>
  const dependencies = raw.dependencies
  if (dependencies !== undefined && (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies))) {
    throw new Error(`dsh profile manifest: ${file} field "dependencies" must be an object`)
  }
  const dsh = raw.dsh
  const bundles = (dsh as { profile?: { bundles?: unknown } } | undefined)?.profile?.bundles
  if (bundles !== undefined && !Array.isArray(bundles)) {
    throw new Error(`dsh profile manifest: ${file} field "dsh.profile.bundles" must be an array`)
  }
  return {
    dependencies: { ...(dependencies as Record<string, string>) },
    bundles: bundles === undefined ? [] : [...(bundles as string[])],
    raw,
  }
}

/** The profile manifest path (exported for diagnostics and watch setups). */
export function profileManifestFile(profileDir: string): string {
  return join(profileDir, PROFILE_MANIFEST_FILENAME)
}

/**
 * Locked atomic write (caller must already hold the plugins mutex): read,
 * mutate, persist atomically (tmp sibling + rename inside the profile dir).
 * The installer pipelines run inside `withPluginsLock` and use this entry to
 * write per-profile manifests without re-entering the (non-reentrant) lock.
 * When the mutator throws, the file on disk stays untouched.
 */
export function writeProfileManifestLocked(
  profileDir: string,
  mutate: (manifest: Record<string, unknown>) => void,
): void {
  const raw = readProfileManifest(profileDir).raw
  mutate(raw)
  mkdirSync(profileDir, { recursive: true })
  // Write to a tmp sibling in the SAME directory, then rename: rename within
  // one filesystem is atomic, so a reader never observes a torn document.
  const tmp = join(profileDir, `.${PROFILE_MANIFEST_FILENAME}.tmp-${process.pid}`)
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", "utf-8")
  try {
    renameSync(tmp, join(profileDir, PROFILE_MANIFEST_FILENAME))
  } finally {
    rmSync(tmp, { force: true })
  }
}

/**
 * Atomically persist the manifest (tmp sibling + rename inside the profile
 * dir) while holding the cross-process plugins mutex. The mutator receives
 * the freshly read manifest document; when it throws, the file on disk stays
 * untouched. The return value passes through.
 */
export async function withProfileManifestWrite<T>(
  profileDir: string,
  mutate: (manifest: Record<string, unknown>) => Promise<T> | T,
): Promise<T> {
  return withPluginsLock(dirnameOfProfileRoot(profileDir), async () => {
    const raw = readProfileManifest(profileDir).raw
    const result = await mutate(raw)
    mkdirSync(profileDir, { recursive: true })
    // Write to a tmp sibling in the SAME directory, then rename: rename within
    // one filesystem is atomic, so a reader never observes a torn document.
    const tmp = join(profileDir, `.${PROFILE_MANIFEST_FILENAME}.tmp-${process.pid}`)
    writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", "utf-8")
    try {
      renameSync(tmp, join(profileDir, PROFILE_MANIFEST_FILENAME))
    } finally {
      rmSync(tmp, { force: true })
    }
    return result
  })
}

/**
 * Derive the plugins-lock root from a profile directory. The layout is
 * `<dshRoot>/home/profiles/<name>/`, so the territory root is three levels
 * up. Exported for tests; production callers pass the real dsh root through
 * the installer, which always knows it.
 */
function dirnameOfProfileRoot(profileDir: string): string {
  const profileName = basenameOf(profileDir)
  const profilesDir = dirnameOf(profileDir)
  const homeDir = dirnameOf(profilesDir)
  const root = dirnameOf(homeDir)
  // Defensive layout check: only trust the derivation when the directory
  // names line up with the official layout; otherwise fall back to locking on
  // the profile dir's own ancestor chain (still correct, just less shared).
  if (
    basenameOf(profilesDir) === "profiles" &&
    basenameOf(homeDir) === "home" &&
    profileName.length > 0
  ) {
    return root
  }
  return root
}

/** `path.basename` without importing the whole path module twice. */
function basenameOf(p: string): string {
  const index = p.lastIndexOf("/")
  return index === -1 ? p : p.slice(index + 1)
}

/** `path.dirname` local helper. */
function dirnameOf(p: string): string {
  const index = p.lastIndexOf("/")
  if (index === -1) return "."
  return p.slice(0, index)
}

/**
 * Add or update one dependency range (pure mutator, no I/O).
 */
export function setDependency(manifest: Record<string, unknown>, name: string, range: string): void {
  assertSafeManifestName(name)
  const dependencies = ensureDependencies(manifest)
  dependencies[name] = range
}

/**
 * Append one package to `dsh.profile.bundles` (pure mutator, no I/O).
 * Idempotent: an existing bundle keeps its position. Appends only at the
 * tail, so official bundles keep their order in front.
 */
export function appendBundle(manifest: Record<string, unknown>, name: string): void {
  assertSafeManifestName(name)
  const dsh = ensureRecord(manifest, "dsh")
  const profile = ensureRecord(dsh, "profile")
  if (!Array.isArray(profile.bundles)) {
    profile.bundles = Array.isArray(profile.bundles) ? profile.bundles : []
  }
  const bundles = profile.bundles as string[]
  if (!bundles.includes(name)) bundles.push(name)
}

/**
 * Remove one plugin from BOTH `dependencies` and `dsh.profile.bundles`
 * (pure mutator, no I/O). Returns whether anything changed.
 */
export function dropPlugin(manifest: Record<string, unknown>, name: string): boolean {
  assertSafeManifestName(name)
  let changed = false
  const dependencies = manifest.dependencies
  if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)) {
    if (name in (dependencies as Record<string, unknown>)) {
      delete (dependencies as Record<string, unknown>)[name]
      changed = true
    }
  }
  const bundles = (manifest.dsh as { profile?: { bundles?: unknown } } | undefined)?.profile?.bundles
  if (Array.isArray(bundles)) {
    const list = bundles as unknown[]
    const index = list.indexOf(name)
    if (index !== -1) {
      list.splice(index, 1)
      changed = true
    }
  }
  return changed
}

/** Ensure `manifest.dependencies` exists as a record and return it. */
function ensureDependencies(manifest: Record<string, unknown>): Record<string, string> {
  const existing = manifest.dependencies
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, string>
  }
  if (existing !== undefined) {
    throw new Error(`dsh profile manifest: field "dependencies" must be an object`)
  }
  const created: Record<string, string> = {}
  manifest.dependencies = created
  return created
}

/** Ensure `parent[key]` exists as a record and return it. */
function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key]
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>
  }
  if (existing !== undefined) {
    throw new Error(`dsh profile manifest: field "${key}" must be an object`)
  }
  const created: Record<string, unknown> = {}
  parent[key] = created
  return created
}

/**
 * The manifest's dependency keys and bundle rows become path segments (the
 * installer places packages under `node_modules/<name>`), so anything
 * outside the npm name rule is rejected before any path math (rook B-08).
 */
function assertSafeManifestName(name: string): void {
  const PACKAGE_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
  if (name.length === 0 || name.length > 214 || !PACKAGE_NAME_RE.test(name)) {
    throw new Error(`dsh profile manifest: unsafe package name ${JSON.stringify(name)} (npm name rules)`)
  }
}
