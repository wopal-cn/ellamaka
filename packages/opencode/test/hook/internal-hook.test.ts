import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Scope } from "effect"
import { InternalHook } from "@/hook/internal-hook"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(InternalHook.defaultLayer))

const event = (over: Partial<InternalHook.FileOpEvent> = {}): InternalHook.FileOpEvent => ({
  toolId: "read",
  args: {},
  filePaths: ["/tmp/foo.ts"],
  result: { title: "foo", metadata: {}, output: "ok" },
  sessionID: "ses_test",
  ...over,
})

describe("internal-hook", () => {
  it.instance("emit with no registered observer is a no-op", () =>
    Effect.gen(function* () {
      const hook = yield* InternalHook.Service
      yield* hook.emit(event())
    }),
  )

  it.instance("register then emit invokes the observer with the event", () =>
    Effect.gen(function* () {
      const hook = yield* InternalHook.Service
      const seen: InternalHook.FileOpEvent[] = []
      yield* hook.register({
        id: "probe",
        onFileOp: (e) =>
          Effect.sync(() => {
            seen.push(e)
          }),
      })

      yield* hook.emit(event())

      expect(seen).toHaveLength(1)
      expect(seen[0].toolId).toBe("read")
      expect(seen[0].filePaths).toEqual(["/tmp/foo.ts"])
      expect(seen[0].sessionID).toBe("ses_test")
    }),
  )

  it.instance("duplicate observer id registers only once", () =>
    Effect.gen(function* () {
      const hook = yield* InternalHook.Service
      let calls = 0
      const observer = (): InternalHook.InternalHookObserver => ({
        id: "same",
        onFileOp: () =>
          Effect.sync(() => {
            calls += 1
          }),
      })
      yield* hook.register(observer())
      yield* hook.register(observer())

      yield* hook.emit(event())

      expect(calls).toBe(1)
    }),
  )

  it.instance("emit awaits blocking observers before returning", () =>
    Effect.gen(function* () {
      const hook = yield* InternalHook.Service
      const order: string[] = []
      yield* hook.register({
        id: "blocking",
        onFileOp: () =>
          Effect.gen(function* () {
            yield* Effect.yieldNow
            order.push("observer")
          }),
      })

      yield* hook.emit(event())
      order.push("after-emit")

      expect(order).toEqual(["observer", "after-emit"])
    }),
  )

  it.instance("observers can fork fire-and-forget work that survives emit", () =>
    Effect.gen(function* () {
      const hook = yield* InternalHook.Service
      const gate = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      yield* hook.register({
        id: "forker",
        onFileOp: () =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope
            yield* Deferred.await(gate).pipe(
              Effect.tap(() => Deferred.succeed(done, undefined)),
              Effect.forkIn(scope),
            )
          }),
      })

      yield* hook.emit(event())
      yield* Deferred.succeed(gate, undefined)

      yield* awaitWithTimeout(Deferred.await(done), "forked observer work was interrupted with the emit call")
    }),
  )
})
