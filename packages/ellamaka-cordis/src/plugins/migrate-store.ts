import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { writeProfileManifestLocked, withPluginsLock, setDependency, appendBundle } from "./profile-manifest.js"
import { profileDirOf, healPluginsModuleFallback } from "./compose.js"

/**
 * One-time migration of the retired `installed.json` plugin store into the
 * official profile manifest truth source (DESIGN-dsh-poc 迁移路径 #3/#5).
 *
 * For every store entry and every profile it was enabled in (defaulting to
 * `web` when an entry declares none): the package entity moves from the
 * legacy install area `plugins/<name>/<version>/` into
 * `<profile>/node_modules/<name>/`, and the profile `package.json` gains the
 * dependency + bundle declaration. When done, `installed.json` is renamed to
 * `installed.json.retired-<date>` — NOT deleted, so the migration is
 * reversible by hand.
 *
 * Idempotent: a missing store is a no-op; a retired store is a no-op.
 * Failure semantics: a foreign schema or a corrupted document fails LOUD and
 * writes nothing (a corrupt truth source must never be silently emptied or
 * half-migrated).
 */

/** The legacy store document shape (read-only; never re-serialised). */
interface LegacyStoreV1 {
  schema: string
  plugins: { name: string; version: string; source: string; enabledIn: string[]; installedAt: string }[]
}

/** The store file location under the territory root. */
function storeFile(dshRoot: string): string {
  return join(dshRoot, "plugins", "installed.json")
}

/**
 * Read + validate the legacy store. Returns `undefined` for a missing file
 * (nothing to migrate); throws a named diagnostic for a foreign schema or
 * corrupted document.
 */
function readLegacyStore(dshRoot: string): LegacyStoreV1 | undefined {
  const file = storeFile(dshRoot)
  if (!existsSync(file)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"))
  } catch (error) {
    throw new Error(`dsh plugin migration: failed to parse ${file}: ${(error as Error).message}`, { cause: error })
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`dsh plugin migration: store document ${file} must be an object`)
  }
  const doc = parsed as Record<string, unknown>
  if (doc.schema !== "ellamaka.dsh-plugins/v1") {
    throw new Error(
      `dsh plugin migration: unexpected schema ${JSON.stringify(doc.schema)} in ${file}, expected "ellamaka.dsh-plugins/v1"`,
    )
  }
  if (!Array.isArray(doc.plugins)) {
    throw new Error(`dsh plugin migration: store ${file} field "plugins" must be an array`)
  }
  return parsed as LegacyStoreV1
}

/** The profiles an entry was enabled in (empty enabledIn defaults to web). */
function profilesFor(entry: { enabledIn: string[] }): string[] {
  const profiles = entry.enabledIn.filter((p) => typeof p === "string" && p.length > 0)
  return profiles.length > 0 ? profiles : ["web"]
}

/** Safe profile name guard (the name becomes a path segment). */
function assertSafeProfileName(profile: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(profile) || profile === "node_modules") {
    throw new Error(`dsh plugin migration: unsafe profile name ${JSON.stringify(profile)}`)
  }
}

/** Safe package name guard (the name becomes a path segment). */
function assertSafePackageName(name: string): void {
  if (name.length > 214 || !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new Error(`dsh plugin migration: unsafe package name ${JSON.stringify(name)}`)
  }
}

/**
 * Place one legacy entity into a profile's node_modules: copy (an entry
 * enabled in several profiles needs the SAME source tree more than once);
 * the LAST copy drains the legacy directory with a rename.
 */
function placeEntity(legacyDir: string, entityDir: string, lastUse: boolean): void {
  mkdirSync(dirname(entityDir), { recursive: true })
  rmSync(entityDir, { recursive: true, force: true })
  if (lastUse) {
    renameSync(legacyDir, entityDir)
    // Drain the now-empty legacy parent (e.g. `plugins/<name>/` after
    // `plugins/<name>/<version>/` was renamed out) so a re-install never
    // trips over a stale shell.
    const parent = dirname(legacyDir)
    if (!existsSync(join(parent, "package.json"))) {
      try {
        if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true })
      } catch {
        // A non-empty or unreadable parent stays — never delete user data.
      }
    }
  } else {
    cpSync(legacyDir, entityDir, { recursive: true })
  }
}

/**
 * Migrate the legacy store, if present. Runs under the cross-process plugins
 * mutex, so a CLI migration never races a live installer.
 */
export async function migratePluginStore(dshRoot: string): Promise<void> {
  return withPluginsLock(dshRoot, () => {
    const store = readLegacyStore(dshRoot)
    if (!store) return // no-op: nothing (or nothing left) to migrate

    const migrated = new Set<string>() // `${profile}:${name}` — dedupe re-entries
    for (const entry of store.plugins) {
      assertSafePackageName(entry.name)
      const legacyDir = join(dshRoot, "plugins", entry.name, entry.version)
      const profiles = profilesFor(entry)
      for (const [index, profile] of profiles.entries()) {
        assertSafeProfileName(profile)
        const profileDir = profileDirOf(dshRoot, profile)
        const entityDir = join(profileDir, "node_modules", ...entry.name.split("/"))
        const lastUse = index === profiles.length - 1
        if (!existsSync(entityDir) && existsSync(join(legacyDir, "package.json"))) {
          placeEntity(legacyDir, entityDir, lastUse)
        }
        if (!migrated.has(`${profile}:${entry.name}`)) {
          migrated.add(`${profile}:${entry.name}`)
          writeProfileManifestLocked(profileDir, (manifest) => {
            setDependency(manifest, entry.name, entry.version)
            appendBundle(manifest, entry.name)
          })
        }
      }
      // The legacy version directory (if the entity moved or never existed)
      // is drained below by the retire rename of the whole area's store doc;
      // any leftover empty dirs stay harmless.
    }

    // Retire the store doc: rename (reversible), never delete.
    const file = storeFile(dshRoot)
    const retiredName = `installed.json.retired-${new Date().toISOString().slice(0, 10)}`
    renameSync(file, join(dshRoot, "plugins", retiredName))

    // Final heal so the migrated packages resolve immediately.
    healPluginsModuleFallback(dshRoot)
  })
}
