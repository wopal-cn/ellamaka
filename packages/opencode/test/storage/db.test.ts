import { describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Global } from "@wopal/ellamaka-core/global"
import { InstallationChannel } from "@wopal/ellamaka-core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@/storage/db"
import { it } from "../lib/effect"

describe("Database.getChannelPath", () => {
  it.effect("returns database path for the current channel", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      // beta shares the release database (ellamaka.db) with prod/latest so beta
      // testers operate on the same data as production users.
      const isRelease = ["latest", "prod", "beta"].includes(InstallationChannel)
      const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
      const expected = isRelease
        ? path.join(Global.Path.data, "ellamaka.db")
        : path.join(Global.Path.data, `ellamaka-${safe}.db`)

      expect(Database.getChannelPath(flags)).toBe(expected)
    }).pipe(Effect.provide(RuntimeFlags.layer())),
  )

  it.effect("uses the shared ellamaka.db when channel databases are disabled", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(Database.getChannelPath(flags)).toBe(path.join(Global.Path.data, "ellamaka.db"))
    }).pipe(Effect.provide(RuntimeFlags.layer({ disableChannelDb: true }))),
  )

  it.effect("accepts RuntimeFlags with skipMigrations for database callers", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(flags.skipMigrations).toBe(true)
      expect(Database.getChannelPath(flags)).toBe(Database.getChannelPath({ disableChannelDb: flags.disableChannelDb }))
    }).pipe(Effect.provide(RuntimeFlags.layer({ skipMigrations: true }))),
  )
})
