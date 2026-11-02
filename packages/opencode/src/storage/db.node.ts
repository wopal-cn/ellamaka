import { DatabaseSync } from "node:sqlite"
import { drizzle } from "drizzle-orm/node-sqlite"

type MigrationEntry = { sql: string; timestamp: number; name: string }

export function init(path: string) {
  const sqlite = new DatabaseSync(path)
  const db = drizzle({ client: sqlite })
  return db
}

export function migrate(db: ReturnType<typeof init>, entries: MigrationEntry[]) {
  const migrations = entries.map((entry) => ({
    sql: entry.sql.split("--> statement-breakpoint"),
    folderMillis: entry.timestamp,
    hash: "",
    bps: true,
    name: entry.name,
  }))
  // Drizzle's Node SQLite database carries the same synchronous dialect and
  // session fields used by its migrator at runtime, but does not expose them
  // on the public NodeSQLiteDatabase type. The journal is embedded at build
  // time, so using the dialect directly is the Node equivalent of the Bun
  // migrator's journal overload without importing any Bun-only runtime.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- upstream hides these runtime fields from the public type
  const migrationDb = db as unknown as {
    dialect: { migrate: (items: typeof migrations, session: unknown, config: object) => unknown }
    session: unknown
  }
  migrationDb.dialect.migrate(migrations, migrationDb.session, {})
}
