import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import { AppBffInstanceApi, AppBffRootApi } from "../api"
import { type ProvisionError, SessionProvisioner } from "@/workbench/session-provisioner"
import { SessionProjection, WorkbenchSpaceNotFound, WorkbenchSpaceQueryFailed } from "@/workbench/session-projection"
import { SessionDirectoryHealth } from "@/workbench/session-directory-health"
import { WorkbenchDshUrl } from "@/workbench/dsh-url"
import { ensureDshMounted } from "@/workbench/dsh-mount-registry"
import {
  InvalidSpaceTargetError,
  SessionDirectoryUnavailableError,
  WorkbenchRequestConflictError,
  WorkbenchSpaceNotFoundError,
  WorkbenchSpaceQueryError,
} from "../groups/workbench"

export const workbenchHandlers = HttpApiBuilder.group(AppBffRootApi, "workbench", (handlers) =>
  Effect.gen(function* () {
    const dshUrl = yield* WorkbenchDshUrl
    const dshUrlHandler = Effect.fn("WorkbenchHttpApi.dshUrl")(function* () {
      // The entry composes on the origin the browser is actually talking to
      // (its Host header) — a wildcard bind (`0.0.0.0` / mdns) must not leak
      // a non-routable authority into the launch-token URL, or the minted
      // cookie can never match and the Workbench Basic auth dialog loops.
      const request = yield* HttpServerRequest.HttpServerRequest
      // Prepare on use (DESIGN-onboarding.md `## Core Preparation Timing`).
      // A serve process that skipped the eager mount — because application
      // Setup was unfinished — mounts here the first time the Workbench asks
      // for its DSH entry. This is the same idempotent prepare the eager path
      // calls, merely later; when the runtime is already mounted it is a no-op.
      yield* Effect.promise(() => ensureDshMounted())
      return { url: dshUrl.get(request.headers.host) }
    })
    return handlers.handle("dshUrl", dshUrlHandler)
  }),
)

export const workbenchInstanceHandlers = HttpApiBuilder.group(AppBffInstanceApi, "workbench-instance", (handlers) =>
  Effect.gen(function* () {
    const provisioner = yield* SessionProvisioner.Service
    const projection = yield* SessionProjection.Service
    const health = yield* SessionDirectoryHealth.Service

    const createSession = Effect.fn("WorkbenchHttpApi.createSession")(function* (ctx: {
      payload: {
        requestID: string
        target:
          | { type: "general" }
          | { type: "space"; spacePath: string; directory?: string }
          | { type: "space"; space: string; directory?: string }
        title?: string
        agent?: string
      }
    }) {
      const create =
        ctx.payload.target.type === "general"
          ? provisioner.provisionGeneral({
              requestID: ctx.payload.requestID,
              title: ctx.payload.title,
              agent: ctx.payload.agent,
            })
          : provisioner.provisionSpace({
              requestID: ctx.payload.requestID,
              spacePath: "spacePath" in ctx.payload.target ? ctx.payload.target.spacePath : undefined,
              spaceName: "space" in ctx.payload.target ? ctx.payload.target.space : undefined,
              relativeDirectory: ctx.payload.target.directory,
              title: ctx.payload.title,
              agent: ctx.payload.agent,
            })
      const result = yield* create.pipe(Effect.catch((error) => Effect.fail(provisionApiError(error))))
      return {
        id: result.id,
        title: result.title,
        directory: result.directory,
        directoryHealth: yield* health.check(result.directory),
        agent: ctx.payload.agent,
        timeCreated: result.timeCreated,
        timeUpdated: result.timeUpdated,
      }
    })

    const sessionTree = Effect.fn("WorkbenchHttpApi.sessionTree")(function* (ctx: {
      query: { limitPerScope?: number }
    }) {
      return yield* projection
        .getSessionTree(ctx.query)
        .pipe(Effect.catch((error) => Effect.fail(spaceApiError(error))))
    })

    const locations = Effect.fn("WorkbenchHttpApi.locations")(function* (ctx: {
      query: { spacePath: string; query?: string }
    }) {
      return yield* projection
        .getLocations(ctx.query)
        .pipe(Effect.catch((error) => Effect.fail(locationApiError(error))))
    })

    return handlers
      .handle("createSession", createSession)
      .handle("sessionTree", sessionTree)
      .handle("locations", locations)
  }),
)

function spaceApiError(error: WorkbenchSpaceQueryFailed) {
  return new WorkbenchSpaceQueryError({
    code: error.code,
    message: error.message,
    ...(error.suggestion ? { suggestion: error.suggestion } : {}),
  })
}

function provisionApiError(error: ProvisionError) {
  if (error._tag === "InvalidSpaceTarget") {
    return new InvalidSpaceTargetError({ message: error.message, detail: error.detail })
  }
  if (error._tag === "SessionDirectoryUnavailable") {
    return new SessionDirectoryUnavailableError({ message: error.message, directory: error.directory })
  }
  if (error._tag === "WorkbenchRequestConflict") {
    return new WorkbenchRequestConflictError({ message: error.message, requestID: error.requestID })
  }
  return spaceApiError(error)
}

function locationApiError(error: WorkbenchSpaceNotFound | WorkbenchSpaceQueryFailed) {
  if (error._tag === "WorkbenchSpaceNotFound") {
    return new WorkbenchSpaceNotFoundError({ message: error.message, spacePath: error.spacePath })
  }
  return spaceApiError(error)
}
