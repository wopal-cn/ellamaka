import { Context, Effect, Layer, Schema } from "effect"
import { mkdir } from "fs/promises"
import path from "path"
import { Global } from "@wopal/ellamaka-core/global"
import { SpaceRegistry } from "@/wopal/space-registry"
import { CliContract } from "@/wopal/cli-contract"
import { SessionDirectoryHealth } from "./session-directory-health"
import { SpaceControlUnavailable, CapabilityContractError } from "@/wopal/cli-schema"
import { SessionShare } from "@/share/session"
import { InstanceStore } from "@/project/instance-store"
import { Database } from "@/storage/db"
import { SessionTable } from "@/session/session.sql"
import { normalizeWorkbenchPath, resolveSpaceDirectory } from "./session-tree"

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

export class InvalidSpaceTarget extends Schema.TaggedErrorClass<InvalidSpaceTarget>()(
  "InvalidSpaceTarget",
  { message: Schema.String, detail: Schema.optional(Schema.String) },
) {}

export class WorkbenchRequestConflict extends Schema.TaggedErrorClass<WorkbenchRequestConflict>()(
  "WorkbenchRequestConflict",
  { message: Schema.String, requestID: Schema.String },
) {}

export type ProvisionError =
  | SessionDirectoryUnavailable
  | InvalidSpaceTarget
  | WorkbenchRequestConflict
  | SpaceControlUnavailable
  | CapabilityContractError

export interface SessionProvisioner {
  readonly provisionGeneral: (input: ProvisionGeneralInput) => Effect.Effect<ProvisionResult, ProvisionError>
  readonly provisionSpace: (input: ProvisionSpaceInput) => Effect.Effect<ProvisionResult, ProvisionError>
}

export class Service extends Context.Service<Service, SessionProvisioner>()("@opencode/SessionProvisioner") {}

const WOPAL_HOME = Global.Path.wopalHome

const make = Effect.gen(function* () {
  const health = yield* SessionDirectoryHealth.Service
  const registry = yield* SpaceRegistry.Service
  const sharedSessions = yield* SessionShare.Service
  const instances = yield* InstanceStore.Service
  const inFlight = new Map<string, { payload: string; run: Effect.Effect<ProvisionResult, ProvisionError> }>()

  const registeredSpaces = () =>
    Effect.gen(function* () {
      const snapshot = yield* registry.getSpaces()
      if (snapshot.spaces.length > 0) return snapshot.spaces
      return (yield* registry.refreshSpaces(CliContract.executablePath())).spaces
    })

  const ensureHealthyDirectory = (directory: string) =>
    health.check(directory).pipe(
      Effect.flatMap((status) => {
        if (status === "healthy") return Effect.succeed(directory)
        return Effect.fail(new SessionDirectoryUnavailable({
          message: `Directory is ${status}: ${directory}`,
          directory,
        }))
      }),
    )

  const resultFromSession = (session: { id: string; directory: string; title: string; time?: { created?: number; updated?: number } }) => ({
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
            return !!workbench && typeof workbench === "object" && "requestID" in workbench && workbench.requestID === requestID
          }),
      ),
    ).pipe(
      Effect.flatMap((existing) => {
        if (!existing) return Effect.succeed(undefined)
        const workbench = existing.metadata?.workbench as { payload?: unknown }
        if (workbench.payload === payload) {
          return Effect.succeed({
            id: existing.id,
            directory: existing.directory,
            title: existing.title,
            timeCreated: existing.timeCreated ?? Date.now(),
            timeUpdated: existing.timeUpdated ?? Date.now(),
          })
        }
        return Effect.fail(new WorkbenchRequestConflict({
          message: "requestID was already used with a different Workbench creation payload",
          requestID,
        }))
      }),
    )

  const request = (input: { requestID: string; payload: string; create: () => Effect.Effect<ProvisionResult, ProvisionError> }) =>
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
          Effect.flatMap((existing) => existing ? Effect.succeed(existing) : input.create()),
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
    const directory = path.join(WOPAL_HOME, "general_tasks", `${y}-${m}-${d}`)
    const payload = JSON.stringify({ target: { type: "general" }, title: input.title, agent: input.agent })
    return request({
      requestID,
      payload,
      create: () =>
        Effect.tryPromise(() => mkdir(directory, { recursive: true })).pipe(
          Effect.mapError(() => new SessionDirectoryUnavailable({
            message: "Failed to create general task directory",
            directory,
          })),
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
      const matching = input.spacePath
        ? yield* matchSpaceByPath(spaces, input.spacePath)
        : spaces.filter((space) => space.id === input.spaceName)
      if (matching.length === 0) {
        return yield* new InvalidSpaceTarget({
          message: `Registered Space not found: ${input.spacePath ?? input.spaceName}`,
          detail: input.spacePath ?? input.spaceName,
        })
      }
      if (matching.length > 1) {
        return yield* new InvalidSpaceTarget({
          message: "Legacy Space name is ambiguous; use spacePath",
          detail: input.spaceName,
        })
      }
      const selected = matching[0]!
      const spacePath = yield* Effect.tryPromise(() => resolveSpaceDirectory(selected.path)).pipe(
        Effect.mapError((error) => new SessionDirectoryUnavailable({
          message: error instanceof Error ? error.message : "Space directory is unavailable",
          directory: selected.path,
        })),
      )
      const directory = yield* Effect.tryPromise(() => resolveSpaceDirectory(selected.path, input.relativeDirectory)).pipe(
        Effect.mapError((error) => new SessionDirectoryUnavailable({
          message: error instanceof Error ? error.message : "Space directory is unavailable",
          directory: selected.path,
        })),
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
          instances.provide(
            { directory },
            sharedSessions.create({
              title: input.title,
              agent: input.agent,
              metadata: { workbench: { requestID, payload } },
            }),
          ).pipe(Effect.map(resultFromSession)),
      })
    })

  return Service.of({ provisionGeneral, provisionSpace })
})

function matchSpaceByPath(spaces: Array<{ name: string; path: string }>, value: string) {
  const requested = normalizeWorkbenchPath(value)
  return Effect.all(
    spaces.map((space) =>
      Effect.tryPromise(() => resolveSpaceDirectory(space.path)).pipe(
        Effect.map((resolved) => ({ space, resolved })),
        Effect.catch(() => Effect.succeed({ space, resolved: normalizeWorkbenchPath(space.path) })),
      ),
    ),
    { concurrency: 16 },
  ).pipe(
    Effect.map((items) => items.filter((item) => item.resolved === requested || normalizeWorkbenchPath(item.space.path) === requested).map((item) => item.space)),
  )
}

export const layer = Layer.effect(Service, make)

export const defaultLayer = layer.pipe(
  Layer.provide(SpaceRegistry.defaultLayer),
  Layer.provide(SessionDirectoryHealth.defaultLayer),
)

export * as SessionProvisioner from "./session-provisioner"
