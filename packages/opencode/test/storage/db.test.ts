import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Global } from "@wopal/ellamaka-core/global"
import { InstallationChannel } from "@wopal/ellamaka-core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@/storage/db"
import { it } from "../lib/effect"

describe("Database.getChannelDbName", () => {
  test("stable and beta share the release database (ellamaka.db)", () => {
    expect(Database.getChannelDbName("stable")).toBe("ellamaka.db")
    expect(Database.getChannelDbName("beta")).toBe("ellamaka.db")
  })

  test("main and local get channel-qualified database files", () => {
    expect(Database.getChannelDbName("main")).toBe("ellamaka-main.db")
    expect(Database.getChannelDbName("local")).toBe("ellamaka-local.db")
  })

  test("safe-character filtering still applies to channel-qualified names", () => {
    expect(Database.getChannelDbName("weird/channel")).toBe("ellamaka-weird-channel.db")
  })
})

describe("Database.getChannelPath", () => {
  it.effect("returns database path for the current channel", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const expected = path.join(Global.Path.data, Database.getChannelDbName(InstallationChannel))

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
