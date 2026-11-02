import { Context, Effect, Layer, Schema } from "effect"
import { mkdir } from "fs/promises"
import path from "path"
import { Global } from "@wopal/ellamaka-core/global"
import { WopalSpaceHostService } from "@/wopal/wopal-space-host"
import { SessionDirectoryHealth } from "./session-directory-health"
import { spaceQueryFailed, WorkbenchSpaceQueryFailed } from "./session-projection"
import { SessionShare } from "@/share/session"
import { InstanceStore } from "@/project/instance-store"
import { Database } from "@/storage/db"
import { SessionTable } from "@/session/session.sql"
import { resolveSpaceDirectory } from "./session-tree"
import { spaceByPath } from "./space-paths"

export interface ProvisionGeneralInput {
  requestID?: string
  title?: string
  agent?: string
}

export interface ProvisionSpaceInput {
  requestID?: string
  spacePath?: string
  spaceName?: string
  relativeDirectory?: string
  title?: string
  agent?: string
}

export interface ProvisionResult {
  id: string
  directory: string
  title: string
  timeCreated: number
  timeUpdated: number
}

export class SessionDirectoryUnavailable extends Schema.TaggedErrorClass<SessionDirectoryUnavailable>()(
  "SessionDirectoryUnavailable",
  { message: Schema.String, directory: Schema.String },
) {}

export class InvalidSpaceTarget extends Schema.TaggedErrorClass<InvalidSpaceTarget>()("InvalidSpaceTarget", {
  message: Schema.String,
  detail: Schema.optional(Schema.String),
}) {}

export class WorkbenchRequestConflict extends Schema.TaggedErrorClass<WorkbenchRequestConflict>()(
  "WorkbenchRequestConflict",
  { message: Schema.String, requestID: Schema.String },
) {}

export type ProvisionError =
  | SessionDirectoryUnavailable
  | InvalidSpaceTarget
  | WorkbenchRequestConflict
  | WorkbenchSpaceQueryFailed

export interface SessionProvisioner {
  readonly provisionGeneral: (input: ProvisionGeneralInput) => Effect.Effect<ProvisionResult, ProvisionError>
  readonly provisionSpace: (input: ProvisionSpaceInput) => Effect.Effect<ProvisionResult, ProvisionError>
}

export class Service extends Context.Service<Service, SessionProvisioner>()("@opencode/SessionProvisioner") {}

const make = Effect.gen(function* () {
  const health = yield* SessionDirectoryHealth.Service
  const host = yield* WopalSpaceHostService.Service
  const sharedSessions = yield* SessionShare.Service
  const instances = yield* InstanceStore.Service
  const inFlight = new Map<string, { payload: string; run: Effect.Effect<ProvisionResult, ProvisionError> }>()

  // Registered Spaces are read-only WopalSpace facts; no CLI cache warm-up.
  const registeredSpaces = () => Effect.try({ try: () => host.space.list().items, catch: spaceQueryFailed })

  const ensureHealthyDirectory = (directory: string) =>
    health.check(directory).pipe(
      Effect.flatMap((status) => {
        if (status === "healthy") return Effect.succeed(directory)
        return Effect.fail(
          new SessionDirectoryUnavailable({
            message: `Directory is ${status}: ${directory}`,
            directory,
          }),
        )
      }),
    )

  const resultFromSession = (session: {
    id: string
    directory: string
    title: string
    time?: { created?: number; updated?: number }
  }) => ({
    id: session.id,
    directory: session.directory,
    title: session.title,
    timeCreated: session.time?.created ?? Date.now(),
    timeUpdated: session.time?.updated ?? Date.now(),
  })

  const existingRequest = (requestID: string, payload: string) =>
    Effect.sync(() =>
      Database.use((db) =>
        db
          .select({
            id: SessionTable.id,
            directory: SessionTable.directory,
            title: SessionTable.title,
            timeCreated: SessionTable.time_created,
            timeUpdated: SessionTable.time_updated,
            metadata: SessionTable.metadata,
          })
          .from(SessionTable)
          .all()
          .find((session) => {
            const workbench = session.metadata?.workbench
            return (
              !!workbench &&
              typeof workbench === "object" &&
              "requestID" in workbench &&
              workbench.requestID === requestID
            )
          }),
      ),
    ).pipe(
      Effect.flatMap((existing) => {
        if (!existing) return Effect.succeed(undefined)
        const workbench = existing.metadata?.workbench
        if (workbench && typeof workbench === "object" && "payload" in workbench && workbench.payload === payload) {
          return Effect.succeed({
            id: existing.id,
            directory: existing.directory,
            title: existing.title,
            timeCreated: existing.timeCreated ?? Date.now(),
            timeUpdated: existing.timeUpdated ?? Date.now(),
          })
        }
        return Effect.fail(
          new WorkbenchRequestConflict({
            message: "requestID was already used with a different Workbench creation payload",
            requestID,
          }),
        )
      }),
    )

  const request = (input: {
    requestID: string
    payload: string
    create: () => Effect.Effect<ProvisionResult, ProvisionError>
  }) =>
    Effect.gen(function* () {
      const active = inFlight.get(input.requestID)
      if (active) {
        if (active.payload !== input.payload) {
          return yield* new WorkbenchRequestConflict({
            message: "requestID is already creating a Session with a different payload",
            requestID: input.requestID,
          })
        }
        return yield* active.run
      }
      const cached = yield* Effect.cached(
        existingRequest(input.requestID, input.payload).pipe(
          Effect.flatMap((existing) => (existing ? Effect.succeed(existing) : input.create())),
          Effect.ensuring(Effect.sync(() => inFlight.delete(input.requestID))),
        ),
      )
      inFlight.set(input.requestID, { payload: input.payload, run: cached })
      return yield* cached
    })

  const provisionGeneral = (input: ProvisionGeneralInput) => {
    const requestID = input.requestID ?? crypto.randomUUID()
    // Group all General sessions created on the same local-calendar day into
    // one shared date directory. The directory is reused if it already exists
    // (mkdir recursive is idempotent); the grouping shown in the tree is
    // derived from timeCreated anyway, so this only affects the on-disk layout.
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, "0")
    const d = String(now.getDate()).padStart(2, "0")
    const directory = path.join(Global.Path.wopalHome, "general_tasks", `${y}-${m}-${d}`)
    const payload = JSON.stringify({ target: { type: "general" }, title: input.title, agent: input.agent })
    return request({
      requestID,
      payload,
      create: () =>
        Effect.tryPromise(() => mkdir(directory, { recursive: true })).pipe(
          Effect.mapError(
            () =>
              new SessionDirectoryUnavailable({
                message: "Failed to create general task directory",
                directory,
              }),
          ),
          Effect.flatMap(() =>
            instances.provide(
              { directory },
              sharedSessions.create({
                title: input.title,
                agent: input.agent,
                metadata: { workbench: { requestID, payload } },
              }),
            ),
          ),
          Effect.map(resultFromSession),
        ),
    })
  }

  const provisionSpace = (input: ProvisionSpaceInput) =>
    Effect.gen(function* () {
      if (!!input.spacePath === !!input.spaceName) {
        return yield* new InvalidSpaceTarget({
          message: "Space target requires exactly one of spacePath or legacy space name",
          detail: input.spacePath ?? input.spaceName,
        })
      }
      const spaces = yield* registeredSpaces()
      const requestedPath = input.spacePath
      const matching = requestedPath
        ? yield* Effect.tryPromise(() => spaceByPath(spaces, requestedPath)).pipe(Effect.mapError(spaceQueryFailed))
        : spaces.filter((space) => space.name === input.spaceName)
      if (matching.length === 0) {
        return yield* new InvalidSpaceTarget({
          message: `Registered Space not found: ${input.spacePath ?? input.spaceName}`,
          detail: input.spacePath ?? input.spaceName,
        })
      }
      if (matching.length > 1) {
        return yield* new InvalidSpaceTarget({
          message: requestedPath
            ? "Multiple registered Spaces resolve to the requested path"
            : "Legacy Space name is ambiguous; use spacePath",
          detail: input.spacePath ?? input.spaceName,
        })
      }
      const selected = matching[0]
      const spacePath = yield* Effect.tryPromise(() => resolveSpaceDirectory(selected.path)).pipe(
        Effect.mapError(
          (error) =>
            new SessionDirectoryUnavailable({
              message: error instanceof Error ? error.message : "Space directory is unavailable",
              directory: selected.path,
            }),
        ),
      )
      const directory = yield* Effect.tryPromise(() =>
        input.relativeDirectory
          ? resolveSpaceDirectory(spacePath, input.relativeDirectory)
          : Promise.resolve(spacePath),
      ).pipe(
        Effect.mapError(
          (error) =>
            new SessionDirectoryUnavailable({
              message: error instanceof Error ? error.message : "Space directory is unavailable",
              directory: selected.path,
            }),
        ),
      )
      yield* ensureHealthyDirectory(directory)
      const requestID = input.requestID ?? crypto.randomUUID()
      const payload = JSON.stringify({
        target: { type: "space", spacePath, directory: input.relativeDirectory },
        title: input.title,
        agent: input.agent,
      })
      return yield* request({
        requestID,
        payload,
        create: () =>
          instances
            .provide(
              { directory },
              sharedSessions.create({
                title: input.title,
                agent: input.agent,
                metadata: { workbench: { requestID, payload } },
              }),
            )
            .pipe(Effect.map(resultFromSession)),
      })
    })

  return Service.of({ provisionGeneral, provisionSpace })
})

export const layer = Layer.effect(Service, make)

export const defaultLayer = layer.pipe(
  Layer.provide(WopalSpaceHostService.layer),
  Layer.provide(SessionDirectoryHealth.defaultLayer),
)

export * as SessionProvisioner from "./session-provisioner"
