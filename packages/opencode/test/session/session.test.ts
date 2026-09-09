import { beforeAll, describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import * as Log from "@wopal/ellamaka-core/util/log"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"
import { Bus } from "@/bus"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"

void Log.init({ print: false })

// The test DB is a single in-memory SQLite shared across all test files in the
// same `bun test` process (OPENCODE_DB=:memory:). MessageTable's primary key is
// the message id, and the projector's onConflictDoUpdate keeps the existing
// row's session_id on a fixed-id collision. This file and revert-compact.test.ts
// both write the same fixed wrap-around ids (msg_fa2c3af72001 / msg_002ceb729001),
// so without a fresh DB the rows land in the wrong session and fork() clones
// nothing. Reset the shared DB before this file's tests run.
beforeAll(() => resetDatabase())

const it = testEffect(
  Layer.mergeAll(
    SessionNs.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(SyncEvent.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
    CrossSpawnSpawner.defaultLayer,
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const remove = (id: SessionID) => SessionNs.use.remove(id)

const subscribeGlobal = (type: string, callback: (event: NonNullable<GlobalEvent["payload"]>) => void) => {
  const listener = (event: GlobalEvent) => {
    if (event.payload?.type === type) callback(event.payload)
  }
  GlobalBus.on("event", listener)
  return () => GlobalBus.off("event", listener)
}

describe("session.created event", () => {
  it.instance("should emit session.created event when session is created", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsub = subscribeGlobal(SessionNs.Event.Created.type, (event) => {
        Deferred.doneUnsafe(received, Effect.succeed(event.properties.info as SessionNs.Info))
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsub))

      const info = yield* session.create({})
      const receivedInfo = yield* awaitDeferred(received, "timed out waiting for session.created")

      expect(receivedInfo.id).toBe(info.id)
      expect(receivedInfo.projectID).toBe(info.projectID)
      expect(receivedInfo.directory).toBe(info.directory)
      expect(receivedInfo.path).toBe(info.path)
      expect(receivedInfo.title).toBe(info.title)

      yield* session.remove(info.id)
    }),
  )

  it.instance("session.created event should be emitted before session.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events: string[] = []
      const received = yield* Deferred.make<string[]>()
      const push = (event: string) => {
        events.push(event)
        if (events.includes("created") && events.includes("updated")) {
          Deferred.doneUnsafe(received, Effect.succeed(events))
        }
      }

      const unsubCreated = subscribeGlobal(SessionNs.Event.Created.type, () => {
        push("created")
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsubCreated))

      const unsubUpdated = subscribeGlobal(SessionNs.Event.Updated.type, () => {
        push("updated")
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsubUpdated))

      const info = yield* session.create({})
      const receivedEvents = yield* awaitDeferred(received, "timed out waiting for session created/updated events")

      expect(receivedEvents).toContain("created")
      expect(receivedEvents).toContain("updated")
      expect(receivedEvents.indexOf("created")).toBeLessThan(receivedEvents.indexOf("updated"))

      yield* session.remove(info.id)
    }),
  )
})

describe("step-finish token propagation via Bus event", () => {
  it.instance(
    "non-zero tokens propagate through PartUpdated event",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const info = yield* session.create({})

        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as MessageV2.Info)

        // Bus subscribers receive readonly Schema.Type payloads; `MessageV2.Part`
        // is the mutable domain type. Cast bridges the two — safe because the
        // test only reads the value afterwards.
        const received = yield* Deferred.make<MessageV2.Part>()
        const unsub = subscribeGlobal(MessageV2.Event.PartUpdated.type, (event) => {
          Deferred.doneUnsafe(received, Effect.succeed(event.properties.part as MessageV2.Part))
        })
        yield* Effect.addFinalizer(() => Effect.sync(unsub))

        const tokens = {
          total: 1500,
          input: 500,
          output: 800,
          reasoning: 200,
          cache: { read: 100, write: 50 },
        }

        const partInput = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "step-finish" as const,
          reason: "stop",
          cost: 0.005,
          tokens,
        }

        yield* session.updatePart(partInput)
        const receivedPart = yield* awaitDeferred(received, "timed out waiting for message.part.updated")

        expect(receivedPart.type).toBe("step-finish")
        const finish = receivedPart as MessageV2.StepFinishPart
        expect(finish.tokens.input).toBe(500)
        expect(finish.tokens.output).toBe(800)
        expect(finish.tokens.reasoning).toBe(200)
        expect(finish.tokens.total).toBe(1500)
        expect(finish.tokens.cache.read).toBe(100)
        expect(finish.tokens.cache.write).toBe(50)
        expect(finish.cost).toBe(0.005)
        expect(receivedPart).not.toBe(partInput)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("Session", () => {
  it.live("remove works without an instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(dir)(session.create({ title: "remove-without-instance" }))

      const removeExit = yield* remove(info.id).pipe(Effect.exit)
      expect(Exit.isSuccess(removeExit)).toBe(true)

      const getExit = yield* session.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(getExit)).toBe(true)
    }),
  )

  it.instance("persists metadata and copies it on fork by default", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const meta = { source: "sdk", trace: { id: "abc" } }
      const created = yield* Effect.acquireRelease(session.create({ title: "with-meta", metadata: meta }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(saved.metadata).toEqual(meta)
      expect(fork.metadata).toEqual(meta)
      expect(fork.metadata).not.toBe(meta)
    }),
  )

  it.instance("omits metadata when not provided", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "empty-meta" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)

      expect(created.metadata).toBeUndefined()
      expect(saved.metadata).toBeUndefined()
    }),
  )

  it.instance("fork does not publish message.updated or message.part.updated for cloned records", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service

      // Create a session with messages and parts
      const parent = yield* Effect.acquireRelease(
        session.create({ title: "fork-storm-test" }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )

      const msgID = MessageID.ascending()
      yield* session.updateMessage({
        id: msgID,
        sessionID: parent.id,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as MessageV2.Info)

      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msgID,
        sessionID: parent.id,
        type: "step-finish",
        reason: "stop",
        cost: 0,
        tokens: { total: 100, input: 50, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      // Set up trap: if any message.updated or message.part.updated arrives
      // for the forked session, the deferred resolves and the test fails.
      const stormCaught = yield* Deferred.make<string>()
      const trap = (eventType: string) => (event: NonNullable<GlobalEvent["payload"]>) => {
        const sid = (event.properties as { sessionID?: string } | undefined)?.sessionID
        if (sid && sid !== parent.id) {
          Deferred.doneUnsafe(stormCaught, Effect.succeed(eventType))
        }
      }
      const unsubMsg = subscribeGlobal(MessageV2.Event.Updated.type, trap("message.updated"))
      const unsubPart = subscribeGlobal(MessageV2.Event.PartUpdated.type, trap("message.part.updated"))
      yield* Effect.addFinalizer(() => Effect.sync(unsubMsg))
      yield* Effect.addFinalizer(() => Effect.sync(unsubPart))

      // Fork — this is the operation that must NOT publish per-message/part events
      const forked = yield* Effect.acquireRelease(
        session.fork({ sessionID: parent.id }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )

      // Allow a brief window for any async publish to arrive
      const stormResult = yield* Effect.race(
        Deferred.await(stormCaught),
        Effect.sleep("200 millis").pipe(Effect.as(undefined)),
      )

      expect(stormResult).toBeUndefined()

      // Verify cloned data was actually persisted (fork still works correctly)
      const forkedMsgs = yield* session.messages({ sessionID: forked.id })
      expect(forkedMsgs.length).toBe(1)
      expect(forkedMsgs[0]!.parts.length).toBe(1)
      expect(forkedMsgs[0]!.parts[0]!.type).toBe("step-finish")
    }),
    { timeout: 30000 },
  )

  // W-02 regression for #208. A post-wrap message id (`msg_00...`) is lexically
  // smaller than pre-wrap ids (`msg_fa...`) even though it is newer. fork() must
  // locate the fork point by id over the time-ordered list (not by lexical id
  // comparison) so it clones only the messages before the fork point.
  it.instance("fork across message-id wrap-around clones only messages before the fork point", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service

      const parent = yield* Effect.acquireRelease(
        session.create({ title: "fork-wrap-test" }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )

      // Pre-wrap message (created before the 26th wrap on 2026-08-14).
      const preID = MessageID.make("msg_fa2c3af72001")
      yield* session.updateMessage({
        id: preID,
        sessionID: parent.id,
        role: "user",
        time: { created: 1784448447887 },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as MessageV2.Info)
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: preID,
        sessionID: parent.id,
        type: "step-finish",
        reason: "stop",
        cost: 0,
        tokens: { total: 100, input: 50, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      // Post-wrap fork point (chronologically after the pre-wrap message).
      const forkID = MessageID.make("msg_002ceb729001")
      yield* session.updateMessage({
        id: forkID,
        sessionID: parent.id,
        role: "user",
        time: { created: 1786753496981 },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as MessageV2.Info)

      const forked = yield* Effect.acquireRelease(
        session.fork({ sessionID: parent.id, messageID: forkID }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )

      const forkedMsgs = yield* session.messages({ sessionID: forked.id })
      // fork() regenerates ids, so verify by count + content. Only the
      // pre-wrap message (with its part) is before the fork point and should
      // be cloned; the post-wrap fork point message must be excluded.
      expect(forkedMsgs).toHaveLength(1)
      expect(forkedMsgs[0]!.parts).toHaveLength(1)
      expect(forkedMsgs[0]!.parts[0]!.type).toBe("step-finish")
    }),
    { timeout: 30000 },
  )
})
