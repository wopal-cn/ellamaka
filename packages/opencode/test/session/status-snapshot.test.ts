import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { InstanceRef } from "../../src/effect/instance-ref"
import { disposeInstance } from "../../src/effect/instance-registry"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { testEffect } from "../lib/effect"

let observe: (() => Effect.Effect<unknown>) | undefined
let published: unknown

const busLayer = Layer.mock(Bus.Service, {
  publish: () => {
    if (!observe) return Effect.void
    return observe().pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          published = snapshot
        }),
      ),
      Effect.asVoid,
    )
  },
})

const it = testEffect(SessionStatus.layer.pipe(Layer.provide(busLayer)))

const instance = (directory: string) => ({ directory }) as never
const inInstance = <A, E>(directory: string, effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.provideService(InstanceRef, instance(directory)))

describe("session status snapshot", () => {
  it.live("publishes a status only after the canonical snapshot includes it", () =>
    Effect.gen(function* () {
      observe = undefined
      published = undefined
      const status = yield* SessionStatus.Service
      observe = () => status.snapshot()

      yield* inInstance("/already-initialized", status.set(SessionID.make("ses_busy"), { type: "busy" }))

      expect(published).toEqual([
        { directory: "/already-initialized", sessionID: "ses_busy", status: { type: "busy" } },
      ])
    }),
  )

  it.live("returns busy and retry states without booting another instance, and drops disposed snapshots", () =>
    Effect.gen(function* () {
      observe = undefined
      const status = yield* SessionStatus.Service
      const first = "/already-initialized/first"
      const second = "/already-initialized/second"
      const busy = SessionID.make("ses_busy")
      const retry = SessionID.make("ses_retry")

      yield* inInstance(first, status.set(busy, { type: "busy" }))
      yield* inInstance(
        second,
        status.set(retry, {
          type: "retry",
          attempt: 2,
          message: "provider unavailable",
          next: 123,
        }),
      )
      yield* inInstance(second, status.set(SessionID.make("ses_idle"), { type: "idle" }))

      expect(yield* status.snapshot()).toEqual([
        { directory: first, sessionID: busy, status: { type: "busy" } },
        {
          directory: second,
          sessionID: retry,
          status: { type: "retry", attempt: 2, message: "provider unavailable", next: 123 },
        },
      ])

      yield* Effect.promise(() => disposeInstance(first))

      expect(yield* status.snapshot()).toEqual([
        {
          directory: second,
          sessionID: retry,
          status: { type: "retry", attempt: 2, message: "provider unavailable", next: 123 },
        },
      ])
    }),
  )
})
