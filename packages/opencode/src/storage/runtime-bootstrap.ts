import { Global } from "@wopal/ellamaka-core/global"
import { Flag } from "@wopal/ellamaka-core/flag/flag"
import { Database } from "./db"
import { JsonMigration, type Progress } from "./json-migration"
import { Filesystem } from "@/util/filesystem"

export interface RuntimeStorageBootstrapOptions {
  readonly progress?: (event: Progress) => void
}

let injectedBootstrapDatabase = false

/** Keep pre-Onboarding Instance reads process-local without materializing Runtime storage. */
export function useBootstrapDatabase(): boolean {
  if (Flag.OPENCODE_DB) return false
  process.env.OPENCODE_DB = ":memory:"
  injectedBootstrapDatabase = true
  return true
}

function releaseBootstrapDatabase(): void {
  if (!injectedBootstrapDatabase) return
  Database.close()
  delete process.env.OPENCODE_DB
  injectedBootstrapDatabase = false
}

/**
 * Materialize Ellamaka-owned Runtime storage at the explicit Runtime boundary.
 * Server bootstrap and Setup inspection stay read-only until this is called.
 */
export async function ensureRuntimeStorage(options: RuntimeStorageBootstrapOptions = {}) {
  releaseBootstrapDatabase()
  await Global.ensure()
  const marker = Database.getPath()
  if (marker === ":memory:" || (await Filesystem.exists(marker))) return { databaseCreated: false as const }

  await JsonMigration.run(Database.Client(), options.progress ? { progress: options.progress } : {})
  return { databaseCreated: true as const }
}
