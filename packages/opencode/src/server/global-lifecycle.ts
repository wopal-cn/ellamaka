import { GlobalBus } from "@/bus/global"
import { InstanceStore } from "@/project/instance-store"
import * as Log from "@wopal/ellamaka-core/util/log"
import { Effect } from "effect"
import { Event } from "./event"
import { emitRuntimeReloaded } from "./runtime-reload"

const log = Log.create({ service: "server" })

export const emitGlobalDisposed = Effect.sync(() =>
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.Disposed.type,
      properties: {},
    },
  }),
)

/**
 * A full global reload (dispose all instances + re-bootstrap) bumps the
 * `global` unit's revision. `global.disposed` keeps its original semantics —
 * this event is ADDITIONAL (DESIGN.md#unified-reload--lifecycle), consumed by
 * clients that track unit revisions instead of tearing down everything.
 */
export const emitGlobalReloaded = Effect.sync(() => emitRuntimeReloaded("global"))

export const disposeAllInstancesAndEmitGlobalDisposed = Effect.fn("Server.disposeAllInstancesAndEmitGlobalDisposed")(
  function* (options?: { swallowErrors?: boolean }) {
    const store = yield* InstanceStore.Service
    yield* Effect.gen(function* () {
      yield* options?.swallowErrors
        ? store.disposeAll().pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                log.warn("global disposal failed", { cause })
              }),
            ),
          )
        : store.disposeAll()
      yield* emitGlobalDisposed
      yield* emitGlobalReloaded
    }).pipe(Effect.uninterruptible)
  },
)

export * as GlobalLifecycle from "./global-lifecycle"
