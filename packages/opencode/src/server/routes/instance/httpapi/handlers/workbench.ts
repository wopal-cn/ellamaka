import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi, RootHttpApi } from "../api"
import {
  InvalidSpaceTarget,
  type ProvisionError,
  SessionDirectoryUnavailable,
  SessionProvisioner,
  WorkbenchRequestConflict,
} from "@/workbench/session-provisioner"
import { SessionProjection, WorkbenchSpaceNotFound } from "@/workbench/session-projection"
import { SessionDirectoryHealth } from "@/workbench/session-directory-health"
import { WorkbenchDshUrl } from "@/workbench/dsh-url"
import {
  SpaceFiles,
  SpaceFilesAccessDenied,
  SpaceFilesNotFound,
  SpaceFilesSpaceNotFound,
  type SpaceFilesError,
} from "@/workbench/space-files"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import { CapabilityContractError as CapabilityContractFailure, SpaceControlUnavailable } from "@/wopal/cli-schema"
import {
  CapabilityContractError,
  InvalidSpaceTargetError,
  SessionDirectoryUnavailableError,
  SpaceControlUnavailableError,
  WorkbenchRequestConflictError,
  WorkbenchSpaceFileAccessDeniedError,
  WorkbenchSpaceFileNotFoundError,
  WorkbenchSpaceNotFoundError,
} from "../groups/workbench"

export const workbenchHandlers = HttpApiBuilder.group(RootHttpApi, "workbench", (handlers) =>
  Effect.gen(function* () {
    const projection = yield* SessionProjection.Service
    const dshUrl = yield* WorkbenchDshUrl
    const status = yield* SessionStatus.Service
    const spaceFiles = yield* SpaceFiles.Service
    const sessionGroups = Effect.fn("WorkbenchHttpApi.sessionGroups")(function* () {
      const groups = yield* projection
        .getSessionGroups()
        .pipe(Effect.catch((error) => Effect.fail(controlApiError(error))))
      return {
        groups: groups.map((group) => ({
          id: group.id,
          title: group.title,
          type: group.type,
          sessionCount: group.sessionCount,
          sessions: group.sessions,
        })),
      }
    })
    const dshUrlHandler = Effect.fn("WorkbenchHttpApi.dshUrl")(function* () {
      return { url: dshUrl.get() }
    })
    const sessionStatuses = Effect.fn("WorkbenchHttpApi.sessionStatuses")(function* () {
      return yield* status.snapshot()
    })
    const sessionSummary = Effect.fn("WorkbenchHttpApi.sessionSummary")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      return yield* projection.getSessionSummary(ctx.params)
    })
    const files = Effect.fn("WorkbenchHttpApi.files")(function* (ctx: { query: { spacePath: string; path?: string } }) {
      return yield* spaceFiles.list(ctx.query).pipe(Effect.catch((error) => Effect.fail(spaceFilesApiError(error))))
    })
    const fileContent = Effect.fn("WorkbenchHttpApi.fileContent")(function* (ctx: {
      query: { spacePath: string; path: string }
    }) {
      return yield* spaceFiles.read(ctx.query).pipe(Effect.catch((error) => Effect.fail(spaceFilesApiError(error))))
    })
    return handlers
      .handle("sessionGroups", sessionGroups)
      .handle("dshUrl", dshUrlHandler)
      .handle("sessionStatuses", sessionStatuses)
      .handle("sessionSummary", sessionSummary)
      .handle("files", files)
      .handle("fileContent", fileContent)
  }),
)

export const workbenchInstanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "workbench-instance", (handlers) =>
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
        .pipe(Effect.catch((error) => Effect.fail(controlApiError(error))))
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

function controlApiError(error: SpaceControlUnavailable | CapabilityContractFailure) {
  if (error._tag === "SpaceControlUnavailable") {
    return new SpaceControlUnavailableError({ message: error.message, reason: error.reason })
  }
  return new CapabilityContractError({
    message: error.message,
    capability: error.capability,
    detail: error.detail,
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
  return controlApiError(error)
}

function locationApiError(error: WorkbenchSpaceNotFound | SpaceControlUnavailable | CapabilityContractFailure) {
  if (error._tag === "WorkbenchSpaceNotFound") {
    return new WorkbenchSpaceNotFoundError({ message: error.message, spacePath: error.spacePath })
  }
  return controlApiError(error)
}

function spaceFilesApiError(error: SpaceFilesError) {
  if (error._tag === "SpaceFilesSpaceNotFound") {
    return new WorkbenchSpaceNotFoundError({ message: error.message, spacePath: error.spacePath })
  }
  if (error._tag === "SpaceFilesAccessDenied") {
    return new WorkbenchSpaceFileAccessDeniedError({ message: error.message, path: error.path })
  }
  if (error._tag === "SpaceFilesNotFound") {
    return new WorkbenchSpaceFileNotFoundError({ message: error.message, path: error.path })
  }
  return controlApiError(error)
}
