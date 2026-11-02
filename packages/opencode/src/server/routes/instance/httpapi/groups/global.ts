import { Config } from "@/config/config"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import "@/server/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"
import { ApiNotFoundError } from "../errors"
import { CorePreparationResultSchema } from "@/core/preparation-event"

const GlobalHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
  managedInstanceId: Schema.optional(Schema.String),
  dsh: Schema.Struct({
    web: Schema.Literals(["disabled", "preparing", "ready", "degraded"]),
    tools: Schema.Literals(["disabled", "preparing", "ready", "degraded"]),
  }),
  dshRuntime: Schema.optional(
    Schema.Struct({
      closureVersion: Schema.Number,
      homeVersion: Schema.optional(Schema.Number),
      reasonCode: Schema.optional(Schema.String),
    }),
  ),
  preparation: Schema.optional(CorePreparationResultSchema),
})

const RuntimePreparationResult = Schema.Struct({
  status: Schema.Literals(["ready", "degraded", "disabled"]),
  diagnostic: Schema.optional(Schema.String),
})

const GlobalEventSchema = Schema.Struct({
  directory: Schema.String,
  project: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  payload: Schema.Union([...BusEvent.effectPayloads(), ...SyncEvent.effectPayloads()]),
}).annotate({ identifier: "GlobalEvent" })

export const GlobalUpgradeInput = Schema.Struct({
  target: Schema.optional(Schema.String),
})

const GlobalUpgradeResult = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    version: Schema.String,
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.String,
  }),
])

export const GlobalPaths = {
  health: "/global/health",
  runtimePrepare: "/global/runtime/prepare",
  sessionStatus: "/global/session/status",
  sessionGet: "/global/session/:sessionID",
  event: "/global/event",
  config: "/global/config",
  dispose: "/global/dispose",
  upgrade: "/global/upgrade",
} as const

export const GlobalApi = HttpApi.make("global").add(
  HttpApiGroup.make("global")
    .add(
      HttpApiEndpoint.get("health", GlobalPaths.health, {
        success: described(GlobalHealth, "Health information"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.health",
          summary: "Get health",
          description: "Get health information about the OpenCode server.",
        }),
      ),
      HttpApiEndpoint.post("runtimePrepare", GlobalPaths.runtimePrepare, {
        success: described(RuntimePreparationResult, "Host runtime preparation result"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.runtime.prepare",
          summary: "Prepare host runtime resources",
          description: "Prepare enabled runtime profiles without activating them.",
        }),
      ),
      HttpApiEndpoint.get("sessionStatus", GlobalPaths.sessionStatus, {
        success: described(
          Schema.Array(Schema.Struct({ directory: Schema.String, sessionID: SessionID, status: SessionStatus.Info })),
          "Active session statuses",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.session.status",
          summary: "Get active session statuses",
          description: "Read the in-memory status of active sessions without loading a directory instance.",
        }),
      ),
      HttpApiEndpoint.get("sessionGet", GlobalPaths.sessionGet, {
        params: { sessionID: SessionID },
        success: described(Session.Info, "Session information"),
        error: ApiNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.session.get",
          summary: "Get session without loading a directory",
          description: "Read session metadata directly from storage without loading a directory instance.",
        }),
      ),
      HttpApiEndpoint.get("event", GlobalPaths.event, {
        success: GlobalEventSchema,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.event",
          summary: "Get global events",
          description: "Subscribe to global events from the OpenCode system using server-sent events.",
        }),
      ),
      HttpApiEndpoint.get("configGet", GlobalPaths.config, {
        success: described(Config.Info, "Get global config info"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.get",
          summary: "Get global configuration",
          description: "Retrieve the current global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.patch("configUpdate", GlobalPaths.config, {
        payload: Config.Info,
        success: described(Config.Info, "Successfully updated global config"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.update",
          summary: "Update global configuration",
          description: "Update global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.post("dispose", GlobalPaths.dispose, {
        success: described(Schema.Boolean, "Global disposed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.dispose",
          summary: "Dispose instance",
          description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        }),
      ),
      HttpApiEndpoint.post("upgrade", GlobalPaths.upgrade, {
        payload: [HttpApiSchema.NoContent, GlobalUpgradeInput],
        success: described(GlobalUpgradeResult, "Upgrade result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.upgrade",
          summary: "Upgrade opencode",
          description: "Upgrade opencode to the specified version or latest if not specified.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "global", description: "Global server routes." })),
)
