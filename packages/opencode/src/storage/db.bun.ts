import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate as drizzleMigrate } from "drizzle-orm/bun-sqlite/migrator"

type MigrationEntry = { sql: string; timestamp: number; name: string }

export function init(path: string) {
  const sqlite = new Database(path, { create: true })
  const db = drizzle({ client: sqlite })
  return db
}

export function migrate(db: ReturnType<typeof init>, entries: MigrationEntry[]) {
  drizzleMigrate(db, entries)
}
