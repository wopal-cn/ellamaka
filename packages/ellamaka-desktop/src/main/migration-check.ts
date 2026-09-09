import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Decides whether the sidecar must run the one-time JSON → SQLite migration.
 *
 * The migration is only meaningful when legacy JSON storage trees exist under
 * `$WOPAL_HOME/ellamaka/data/storage/{project,session,message,part,todo,
 * permission,session_share}`. JsonMigration scans these seven subdirectories
 * for `*.json` files; when all of them are empty the migration is a no-op,
 * so we should neither show the loading overlay nor ask the sidecar to run it.
 *
 * Note: `storage/` itself existing is NOT a signal — the Storage service
 * actively writes to `storage/session_diff/*.json` and `storage/migration`,
 * so that directory will exist for any ellamaka install that has been used
 * at least once. Probing only `storage/` causes the loading overlay to appear
 * on every launch, even though the migration already succeeded.
 *
 * WOPAL_HOME resolution mirrors `@wopal/ellamaka-core/global.ts`:
 * `process.env.WOPAL_HOME || ~/.wopal`.
 */
const LEGACY_SUBDIRS = [
  "project",
  "session",
  "message",
  "part",
  "todo",
  "permission",
  "session_share",
] as const

export function needsJsonMigration(
  env: { OPENCODE_DB?: string; WOPAL_HOME?: string } = process.env,
  wopalHome?: string,
): boolean {
  if (env.OPENCODE_DB === ":memory:") return false

  const home = wopalHome ?? env.WOPAL_HOME ?? join(homedir(), ".wopal")
  const storageDir = join(home, "ellamaka", "data", "storage")
  if (!existsSync(storageDir)) return false

  // Any non-empty legacy subdir signals data that JsonMigration may need to
  // ingest. A subdir containing only nested empty dirs (e.g. an aborted
  // earlier migration) still counts, because JsonMigration's glob will
  // simply find zero files and the run is a no-op — the cost of a redundant
  // migration is far lower than missing real legacy data.
  for (const sub of LEGACY_SUBDIRS) {
    const dir = join(storageDir, sub)
    if (!existsSync(dir)) continue
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      if (entries.length > 0) return true
    } catch {
      // Read failure (permissions, IO error): treat as no migration needed
      // so a transient filesystem issue does not block app launch. The
      // sidecar's JsonMigration.run is independently idempotent.
    }
  }
  return false
}
