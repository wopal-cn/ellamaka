import { Schema } from "effect"
import "./contract-events"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import { ConfigApi } from "./groups/config"
import { ControlApi } from "./groups/control"
import { EventApi } from "./groups/event"
import { ExperimentalApi } from "./groups/experimental"
import { FileApi } from "./groups/file"
import { GlobalApi } from "./groups/global"
import { InstanceApi } from "./groups/instance"
import { McpApi } from "./groups/mcp"
import { PermissionApi } from "./groups/permission"
import { ProjectApi } from "./groups/project"
import { ProviderApi } from "./groups/provider"
import { PtyApi, PtyConnectApi } from "./groups/pty"
import { QuestionApi } from "./groups/question"
import { SessionApi } from "./groups/session"
import { SyncApi } from "./groups/sync"
import { TuiApi } from "./groups/tui"
import { WorkspaceApi } from "./groups/workspace"
import { WopalSpaceApi, WopalSpaceInstanceApi } from "./groups/wopal-space"
import { WorkbenchApi, WorkbenchInstanceApi } from "./groups/workbench"
import { V2Api } from "./groups/v2"
import { Authorization } from "./middleware/authorization"
import { SchemaErrorMiddleware } from "./middleware/schema-error"

// SSE event schemas built from the BusEvent/SyncEvent registries.
const EventSchema = Schema.Union(BusEvent.effectPayloads()).annotate({ identifier: "Event" })
const SyncEventSchemas = SyncEvent.effectPayloads()

export const RootHttpApi = HttpApi.make("opencode-root")
  .addHttpApi(ControlApi)
  .addHttpApi(GlobalApi)
  .addHttpApi(WopalSpaceApi)
  .middleware(SchemaErrorMiddleware)
  .middleware(Authorization)

export const InstanceHttpApi = HttpApi.make("opencode-instance")
  .addHttpApi(ConfigApi)
  .addHttpApi(ExperimentalApi)
  .addHttpApi(FileApi)
  .addHttpApi(InstanceApi)
  .addHttpApi(McpApi)
  .addHttpApi(ProjectApi)
  .addHttpApi(PtyApi)
  .addHttpApi(QuestionApi)
  .addHttpApi(PermissionApi)
  .addHttpApi(ProviderApi)
  .addHttpApi(SessionApi)
  .addHttpApi(SyncApi)
  .addHttpApi(V2Api)
  .addHttpApi(TuiApi)
  .addHttpApi(WorkspaceApi)
  .addHttpApi(WopalSpaceInstanceApi)
  .middleware(SchemaErrorMiddleware)

// Official App BFF: private composition served by the same Server with the same
// auth. It is absent from the public SDK contract and included in Server /doc.
export const AppBffRootApi = HttpApi.make("ellamaka-app-bff-root")
  .addHttpApi(WorkbenchApi)
  .middleware(SchemaErrorMiddleware)
  .middleware(Authorization)

export const AppBffInstanceApi = HttpApi.make("ellamaka-app-bff-instance")
  .addHttpApi(WorkbenchInstanceApi)
  .middleware(SchemaErrorMiddleware)

// The raw /doc route serves the full document; declare its public discovery
// contract here so it is also visible in the SDK's public OpenAPI subset.
const DiscoveryApi = HttpApi.make("discovery").add(
  HttpApiGroup.make("discovery").add(
    HttpApiEndpoint.get("document", "/doc", {
      success: Schema.Struct({
        openapi: Schema.Literal("3.1.0"),
        info: Schema.Struct({
          title: Schema.String,
          version: Schema.String,
          description: Schema.optional(Schema.String),
        }),
        paths: Schema.Record(Schema.String, Schema.Unknown),
        components: Schema.optional(Schema.Unknown),
        security: Schema.optional(Schema.Unknown),
        tags: Schema.optional(Schema.Unknown),
      }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "discovery.document",
        summary: "Discover server HTTP APIs",
        description:
          "Returns the complete Server OpenAPI document, including public platform and official App endpoints.",
      }),
    ),
  ),
)

export const OpenCodeHttpApi = HttpApi.make("opencode")
  .addHttpApi(RootHttpApi)
  .addHttpApi(EventApi)
  .addHttpApi(InstanceHttpApi)
  .addHttpApi(PtyConnectApi)
  .addHttpApi(DiscoveryApi)
  .annotate(HttpApi.AdditionalSchemas, [EventSchema, ...SyncEventSchemas])

export type AppBffRootApiType = typeof AppBffRootApi
export type AppBffInstanceApiType = typeof AppBffInstanceApi
export type RootHttpApiType = typeof RootHttpApi
export type InstanceHttpApiType = typeof InstanceHttpApi
