import { Schema } from "effect"
import { BusEvent } from "@/bus/bus-event"

export const PreparationStateSchema = Schema.Literals(["READY", "NEEDS_PREPARATION", "PREPARING", "BUSY", "DEGRADED"])

export const PreparationTargetSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("host") }),
  Schema.Struct({ kind: Schema.Literal("instance"), directory: Schema.String }),
])

export const CorePreparationRunSchema = Schema.Struct({
  runId: Schema.String,
  sequence: Schema.Number,
  step: Schema.String,
  phase: Schema.String,
  elapsedMs: Schema.Number,
})

export const CorePreparationResultSchema = Schema.Struct({
  target: PreparationTargetSchema,
  state: PreparationStateSchema,
  reason: Schema.optional(Schema.String),
  run: Schema.optional(CorePreparationRunSchema),
  steps: Schema.Array(
    Schema.Struct({
      step: Schema.String,
      state: PreparationStateSchema,
      code: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "CorePreparationResult" })

export const CorePreparationEventSchema = Schema.Struct({
  runId: Schema.String,
  sequence: Schema.Number,
  target: PreparationTargetSchema,
  step: Schema.String,
  phase: Schema.String,
  state: PreparationStateSchema,
  elapsedMs: Schema.Number,
  current: Schema.optional(Schema.Number),
  total: Schema.optional(Schema.Number),
  unit: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
}).annotate({ identifier: "CorePreparationEvent" })

export const CorePreparationBusEvent = BusEvent.define("core.preparation", CorePreparationEventSchema)
