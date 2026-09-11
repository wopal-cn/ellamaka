import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "./schema"
import { NonNegativeInt } from "@wopal/ellamaka-core/schema"
import { Effect, Layer, Context, Schema } from "effect"

export const Info = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("idle"),
  }),
  Schema.Struct({
    type: Schema.Literal("retry"),
    attempt: NonNegativeInt,
    message: Schema.String,
    action: Schema.optional(
      Schema.Struct({
        reason: Schema.String,
        provider: Schema.String,
        title: Schema.String,
        message: Schema.String,
        label: Schema.String,
        link: Schema.optional(Schema.String),
      }),
    ),
    next: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("busy"),
  }),
]).annotate({ identifier: "SessionStatus" })
export type Info = Schema.Schema.Type<typeof Info>

export const Event = {
  Status: BusEvent.define(
    "session.status",
    Schema.Struct({
      sessionID: SessionID,
      status: Info,
    }),
  ),
  // deprecated
  Idle: BusEvent.define(
    "session.idle",
    Schema.Struct({
      sessionID: SessionID,
    }),
  ),
}

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly snapshot: () => Effect.Effect<Snapshot[]>
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
}

export interface Snapshot {
  readonly directory: string
  readonly sessionID: SessionID
  readonly status: Info
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const snapshots = new Map<string, Map<SessionID, Info>>()

    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(function* (ctx) {
        const data = new Map<SessionID, Info>()
        snapshots.set(ctx.directory, data)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (snapshots.get(ctx.directory) === data) snapshots.delete(ctx.directory)
          }),
        )
        return data
      }),
    )

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.get(sessionID) ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map(yield* InstanceState.get(state))
    })

    const snapshot = Effect.fn("SessionStatus.snapshot")(() =>
      Effect.sync(() =>
        [...snapshots].flatMap(([directory, statuses]) =>
          [...statuses].flatMap(([sessionID, status]) =>
            status.type === "idle" ? [] : [{ directory, sessionID, status }],
          ),
        ),
      ),
    )

    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
      const data = yield* InstanceState.get(state)
      if (status.type === "idle") {
        data.delete(sessionID)
      } else {
        data.set(sessionID, status)
      }
      yield* bus.publish(Event.Status, { sessionID, status })
      if (status.type === "idle") yield* bus.publish(Event.Idle, { sessionID })
    })

    return Service.of({ get, list, snapshot, set })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as SessionStatus from "./status"
