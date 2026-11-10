import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"
import { WopalSpaceOperations } from "./wopal-space-operations"

export {
  WopalSpaceConflictError,
  WopalSpaceForbiddenError,
  WopalSpaceNotFoundError,
  WopalSpaceOperationError,
  WopalSpaceRequestError,
} from "../wopal-space-errors"

export { WopalSpaceOperations } from "./wopal-space-operations"

export const WopalSpaceApi = HttpApi.make("wopal-space").add(WopalSpaceOperations.middleware(Authorization))

// ===========================================================================
// Instance mode (Runtime view of the current directory)
// ===========================================================================

export const WopalSpaceInstanceApi = HttpApi.make("wopal-space-mode")
  .add(
    HttpApiGroup.make("wopal-space-mode")
      .add(
        HttpApiEndpoint.get("mode", "/wopal-space/mode", {
          query: Schema.Struct({
            directory: Schema.optional(Schema.String),
            workspace: Schema.optional(Schema.String),
          }),
          success: described(
            Schema.Struct({ isWopalSpace: Schema.Boolean }),
            "WopalSpace mode for the current directory instance",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wopalSpace.mode",
            summary: "Get WopalSpace mode",
            description: "Check if the current directory instance is running in WopalSpace mode.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "wopal-space",
          description: "WopalSpace instance routes (ellamaka customization).",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "wopalspace instance api",
      version: "0.0.1",
      description: "Instance-scoped WopalSpace API.",
    }),
  )

export type PublicErrorBody = { readonly code: string; readonly message: string; readonly suggestion?: string }
