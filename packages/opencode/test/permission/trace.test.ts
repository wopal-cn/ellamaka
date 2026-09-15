import { expect } from "bun:test"
import fs from "fs/promises"
import { Global } from "@wopal/ellamaka-core/global"
import * as Log from "@wopal/ellamaka-core/util/log"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Permission } from "../../src/permission"
import { PermissionID } from "../../src/permission/schema"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const bus = Bus.layer
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = Layer.mergeAll(
  Permission.layer.pipe(Layer.provide(bus)),
  bus,
  CrossSpawnSpawner.defaultLayer,
  InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
)
const it = testEffect(env)

/**
 * Permission decisions were previously logged at INFO, which flooded serve logs
 * with one record per evaluated pattern. They must now be reachable only
 * through the opt-in TRACE level, and the record must never carry the
 * evaluated pattern, command, path, or session id.
 */
async function readLog(marker: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const content = await fs.readFile(Log.file(), "utf8").catch(() => "")
    if (content.includes(marker)) return content
    await Bun.sleep(10)
  }
  await Bun.sleep(20)
  return await fs.readFile(Log.file(), "utf8").catch(() => "")
}

it.instance(
  "permission - traces an allow decision with safe metadata only",
  () =>
    Effect.gen(function* () {
      const previousLog = Global.Path.log
      yield* Effect.addFinalizer(() => Effect.sync(() => (Global.Path.log = previousLog)))
      const dir = yield* tmpdirScoped()
      Global.Path.log = dir
      yield* Effect.promise(() =>
        Log.init({ print: false, dev: false, role: "serve", level: "TRACE", trace: "permission" }),
      )

      const marker = "permission-trace-probe"
      Log.Default.info(marker)

      const permission = yield* Permission.Service
      const sensitive = "sensitive-pattern-must-not-be-logged"
      yield* permission.ask({
        sessionID: SessionID.make("ses_trace"),
        permission: "bash",
        patterns: [sensitive],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      yield* Effect.sleep("20 millis")

      const content = yield* Effect.promise(() => readLog(marker))
      expect(content).toContain(marker)
      expect(content).toContain("TRACE")
      expect(content).toContain("permission")
      expect(content).toContain("allow")
      expect(content).not.toContain(sensitive)
    }),
  { git: true },
)

it.instance(
  "permission - traces an ask decision without the evaluated pattern",
  () =>
    Effect.gen(function* () {
      const previousLog = Global.Path.log
      yield* Effect.addFinalizer(() => Effect.sync(() => (Global.Path.log = previousLog)))
      const dir = yield* tmpdirScoped()
      Global.Path.log = dir
      yield* Effect.promise(() =>
        Log.init({ print: false, dev: false, role: "serve", level: "TRACE", trace: "permission" }),
      )

      const marker = "permission-ask-probe"
      Log.Default.info(marker)

      const permission = yield* Permission.Service
      const sensitive = "ask-pattern-must-not-be-logged"
      const done = yield* Deferred.make<void>()
      const fiber = yield* permission
        .ask({
          sessionID: SessionID.make("ses_ask"),
          permission: "bash",
          patterns: [sensitive],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        })
        .pipe(Effect.ensuring(Effect.sync(() => Deferred.doneUnsafe(done, Effect.void))), Effect.forkScoped)

      // Wait until the ask is pending (the trace record is written first).
      for (let attempt = 0; attempt < 20; attempt++) {
        if ((yield* permission.list()).length === 1) break
        yield* Effect.sleep("10 millis")
      }

      const content = yield* Effect.promise(() => readLog(marker))
      expect(content).toContain(marker)
      expect(content).toContain("TRACE")
      expect(content).toContain("ask")
      expect(content).not.toContain(sensitive)

      // Clean up the pending fiber so the instance finalizer does not block.
      for (const request of yield* permission.list()) {
        yield* permission.reply({ requestID: request.id, reply: "reject" })
      }
      yield* Fiber.await(fiber)
    }),
  { git: true },
)

it.instance(
  "permission - emits no permission records below TRACE",
  () =>
    Effect.gen(function* () {
      const previousLog = Global.Path.log
      yield* Effect.addFinalizer(() => Effect.sync(() => (Global.Path.log = previousLog)))
      const dir = yield* tmpdirScoped()
      Global.Path.log = dir
      yield* Effect.promise(() => Log.init({ print: false, dev: false, role: "serve", level: "DEBUG" }))

      const marker = "permission-debug-probe"
      Log.Default.info(marker)

      const permission = yield* Permission.Service
      yield* permission.ask({
        id: PermissionID.make("per_quiet"),
        sessionID: SessionID.make("ses_quiet"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      yield* Effect.sleep("20 millis")

      const content = yield* Effect.promise(() => readLog(marker))
      expect(content).toContain(marker)
      expect(content).not.toContain("action=allow")
    }),
  { git: true },
)
