import { BusEvent } from "@/bus/bus-event"
import { Schema } from "effect"

export const Event = {
  Connected: BusEvent.define("server.connected", Schema.Struct({})),
  Disposed: BusEvent.define("global.disposed", Schema.Struct({})),
}

/**
 * The unit-reload notification (DESIGN.md#unified-reload--lifecycle). `unit`
 * is the reload boundary (`global`, `instance:<directory>`, `dsh:web`,
 * `dsh:tools`); `revision` is that unit's monotonic counter. Emitted only
 * after the unit's new entry/route validated and published atomically — a
 * failed reload publishes no revision. `global.disposed` keeps its original
 * semantics; DSH notifications only reconnect the corresponding iframe.
 */
export const RuntimeReloaded = BusEvent.define(
  "runtime.reloaded",
  Schema.Struct({
    unit: Schema.String,
    revision: Schema.Number,
  }),
)
