import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import * as Sse from "effect/unstable/encoding/Sse"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  OntologyServiceError,
  SetupServiceError,
  SpaceServiceError,
  redactSecret,
  type SetupGoal,
} from "@wopal/wopalspace"
import { InstanceHttpApi, RootHttpApi } from "../api"
import { Config } from "@/config/config"
import { WopalSpaceHostService } from "@/wopal/wopal-space-host"
import { SetupHostService } from "@/wopal/setup-host"
import { completeDshSetup } from "@/workbench/dsh-mount-registry"
import {
  WopalSpaceConflictError,
  WopalSpaceForbiddenError,
  WopalSpaceNotFoundError,
  WopalSpaceOperationError,
  WopalSpaceRequestError,
} from "../groups/wopal-space"

type ApiError =
  | WopalSpaceRequestError
  | WopalSpaceNotFoundError
  | WopalSpaceForbiddenError
  | WopalSpaceConflictError
  | WopalSpaceOperationError

const NOT_FOUND = new Set(["SPACE_NOT_FOUND", "SPACE_ONTOLOGY_NOT_FOUND", "ONTOLOGY_NOT_FOUND", "SPACE_META_MISSING"])
const FORBIDDEN = new Set(["SPACE_PATH_ESCAPE", "ONTOLOGY_PATH_ESCAPE", "PATH_TRAVERSAL_DETECTED"])
const CONFLICT = new Set([
  "SPACE_NAME_EXISTS",
  "SPACE_PATH_REGISTERED",
  "SPACE_NESTED",
  "SPACE_INVALID_STATE",
  "SPACE_META_CONCURRENT_MODIFICATION",
  "SPACE_META_LEGACY_PRIVATE",
  "MERGE_IN_PROGRESS",
  "SPACE_SYNC_CONFLICT",
  "SPACE_SYNC_DIRTY",
  "ONTOLOGY_SYNC_DIRTY",
  "ONTOLOGY_SYNC_IN_PROGRESS",
  "ONTOLOGY_TARGET_CONFLICT",
  "ONTOLOGY_HISTORY_CONFLICT",
  "ONTOLOGY_SOURCE_CONFLICT",
  "ONTOLOGY_TOPOLOGY_CONFLICT",
  "ONTOLOGY_REGISTRY_CHANGED",
])
const SETUP_NOT_FOUND = new Set(["SETUP_PLAN_NOT_FOUND", "SETUP_RUN_NOT_FOUND", "SETUP_ACTION_NOT_FOUND"])
const SETUP_CONFLICT = new Set([
  "SETUP_HOME_UNCONFIRMED",
  "SETUP_HOME_LOCKED",
  "SETUP_PLAN_STALE",
  "SETUP_OPERATION_BUSY",
  "SETUP_INCOMPLETE",
  "SETUP_OPERATION_CANCELLED",
  "SETUP_ACTION_DEPENDENCY_PENDING",
])
const SETUP_REQUEST = new Set([
  "SETUP_HOME_INVALID",
  "SETUP_GOAL_INVALID",
  "SETUP_ACTION_INPUT_REQUIRED",
  "SETUP_ACTION_INPUT_INVALID",
  "SETUP_GITHUB_TOKEN_INVALID",
])
const SETUP_HOST_FAILURE = new Set([
  "SETUP_HOME_PERSIST_FAILED",
  "SETUP_STATE_WRITE_FAILED",
  "SETUP_INSPECT_FAILED",
  "SETUP_GITHUB_FAILED",
  "SETUP_PROVIDER_FAILED",
  "SETUP_ONTOLOGY_FAILED",
  "SETUP_SPACE_FAILED",
  "SETUP_PREPARATION_FAILED",
  "SETUP_FOUNDATION_FAILED",
])

const HOST_FAILURE = new Set([
  "SPACE_OPERATION_FAILED",
  "ONTOLOGY_OPERATION_FAILED",
  "ONTOLOGY_UPGRADE_FAILED",
  "ONTOLOGY_REFRESH_FAILED",
  "ONTOLOGY_PR_UNAVAILABLE",
  "ONTOLOGY_REGISTRY_INVALID",
  "SPACE_REGISTRY_INVALID",
  "SPACE_WORKTREE_FAILED",
  "SPACE_SYNC_FAILED",
  "SPACE_ENV_SEED_FAILED",
  "SPACE_META_COMMIT_FAILED",
  "SPACE_PREPARATION_FAILED",
  "SPARSE_APPLY_FAILED",
  "CAPABILITY_FAILED",
  "SPACE_CAPABILITY_PARTIAL_COMMIT",
  "ASSEMBLY_SCHEMA_INVALID",
  "ASSEMBLY_ARCHETYPE_INVALID",
])

const CREDENTIALS = /https?:\/\/[^/\s@]+@/gi

/** Remote credentials and tokens must never reach a public error body. */
function sanitize(message: string) {
  return redactSecret(message.replace(CREDENTIALS, (match) => (match.startsWith("https") ? "https://" : "http://")))
}

/** Map one domain failure onto the stable public error contract. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof SetupServiceError) {
    const fields = {
      code: error.code,
      message: sanitize(error.message),
      ...(error.suggestion ? { suggestion: sanitize(error.suggestion) } : {}),
    }
    if (SETUP_NOT_FOUND.has(error.code)) return new WopalSpaceNotFoundError(fields)
    if (SETUP_CONFLICT.has(error.code)) return new WopalSpaceConflictError(fields)
    if (SETUP_HOST_FAILURE.has(error.code)) return new WopalSpaceOperationError(fields)
    return new WopalSpaceRequestError(fields)
  }
  const known = error instanceof OntologyServiceError || error instanceof SpaceServiceError
  const code = known ? error.code : "WOPALSPACE_OPERATION_FAILED"
  const message = sanitize(known ? error.message : error instanceof Error ? error.message : String(error))
  const suggestion = known && error.suggestion ? sanitize(error.suggestion) : undefined
  const fields = { code, message, ...(suggestion ? { suggestion } : {}) }
  if (NOT_FOUND.has(code)) return new WopalSpaceNotFoundError(fields)
  if (FORBIDDEN.has(code)) return new WopalSpaceForbiddenError(fields)
  if (CONFLICT.has(code) || SETUP_CONFLICT.has(code)) return new WopalSpaceConflictError(fields)
  if (SETUP_REQUEST.has(code)) return new WopalSpaceRequestError(fields)
  if (HOST_FAILURE.has(code)) return new WopalSpaceOperationError(fields)
  return new WopalSpaceRequestError(fields)
}

/** Run a synchronous domain operation as an Effect with public error mapping. */
function attempt<A>(run: () => A): Effect.Effect<A, ApiError> {
  return Effect.try({ try: run, catch: toApiError })
}

/** Run an asynchronous domain operation as an Effect with public error mapping. */
function attemptAsync<A>(run: () => Promise<A>): Effect.Effect<A, ApiError> {
  return Effect.tryPromise({ try: run, catch: toApiError })
}

// ---------------------------------------------------------------------------
// Ontology
// ---------------------------------------------------------------------------

export const wopalSpaceHandlers = HttpApiBuilder.group(RootHttpApi, "wopal-space", (handlers) =>
  Effect.gen(function* () {
    const host = yield* WopalSpaceHostService.Service
    const setup = yield* SetupHostService.Service

    const listOntologies = Effect.fn("WopalSpaceHttpApi.ontology.list")(function* () {
      return yield* attemptAsync(() => host.ontology.list())
    })

    const installOntology = Effect.fn("WopalSpaceHttpApi.ontology.install")(function* (ctx: {
      payload: { name: string; source?: string; mode?: "fork" | "clone"; fork?: boolean }
    }) {
      return yield* attemptAsync(() => host.ontology.install(ctx.payload))
    })

    const inspectOntology = Effect.fn("WopalSpaceHttpApi.ontology.inspect")(function* (ctx: {
      params: { name: string }
    }) {
      return yield* attemptAsync(() => host.ontology.inspect(ctx.params.name))
    })

    const refreshOntology = Effect.fn("WopalSpaceHttpApi.ontology.refresh")(function* (ctx: {
      params: { name: string }
    }) {
      return yield* attemptAsync(() => host.ontology.refresh(ctx.params.name))
    })

    const syncOntology = Effect.fn("WopalSpaceHttpApi.ontology.sync")(function* (ctx: {
      params: { name: string }
      payload: { confirm: boolean }
    }) {
      return yield* attemptAsync(() => host.ontology.sync(ctx.params.name, { confirm: ctx.payload.confirm }))
    })

    const ontologyCapabilities = Effect.fn("WopalSpaceHttpApi.ontology.capabilities")(function* (ctx: {
      params: { name: string }
      query: { kind?: string }
    }) {
      return yield* attemptAsync(() =>
        host.ontology.capabilityList(ctx.params.name, ctx.query.kind ? { kind: ctx.query.kind } : undefined),
      )
    })

    // --- Space -------------------------------------------------------------

    const resolveSpace = Effect.fn("WopalSpaceHttpApi.space.resolve")(function* (ctx: {
      payload: { name?: string; directory?: string }
    }) {
      return yield* attempt(() => host.space.resolve(ctx.payload))
    })

    const listSpaces = Effect.fn("WopalSpaceHttpApi.space.list")(function* () {
      return yield* attempt(() => host.space.list())
    })

    const initSpace = Effect.fn("WopalSpaceHttpApi.space.init")(function* (ctx: {
      payload: { name: string; root?: string; ontology?: string; type?: string; displayName?: string }
    }) {
      return yield* attemptAsync(() => host.space.init(ctx.payload))
    })

    const spaceProjects = Effect.fn("WopalSpaceHttpApi.space.projects")(function* (ctx: { params: { name: string } }) {
      return yield* attempt(() => host.space.projectsList(ctx.params.name))
    })

    const spaceFiles = Effect.fn("WopalSpaceHttpApi.space.files")(function* (ctx: {
      params: { name: string }
      query: { path?: string }
    }) {
      return yield* attempt(() => host.space.filesList(ctx.params.name, ctx.query.path))
    })

    const spaceFileContent = Effect.fn("WopalSpaceHttpApi.space.fileContent")(function* (ctx: {
      params: { name: string }
      query: { path: string }
    }) {
      return yield* attempt(() => host.space.filesRead(ctx.params.name, ctx.query.path))
    })

    const searchSpace = Effect.fn("WopalSpaceHttpApi.space.search")(function* (ctx: {
      params: { name: string }
      query: { query?: string; type?: "dir" | "repo" | "file"; limit?: number; offset?: number }
    }) {
      return yield* attempt(() =>
        host.space.search(ctx.params.name, {
          ...(ctx.query.query !== undefined ? { query: ctx.query.query } : {}),
          ...(ctx.query.type !== undefined ? { type: ctx.query.type } : {}),
          ...(ctx.query.limit !== undefined ? { limit: ctx.query.limit } : {}),
          ...(ctx.query.offset !== undefined ? { offset: ctx.query.offset } : {}),
        }),
      )
    })

    const scanSpace = Effect.fn("WopalSpaceHttpApi.space.scan")(function* (ctx: { params: { name: string } }) {
      return yield* attempt(() => host.space.scan(ctx.params.name))
    })

    const spaceStatus = Effect.fn("WopalSpaceHttpApi.space.status")(function* (ctx: { params: { name: string } }) {
      return yield* attemptAsync(() => host.space.status(ctx.params.name))
    })

    const syncSpace = Effect.fn("WopalSpaceHttpApi.space.sync")(function* (ctx: {
      params: { name: string }
      payload: { confirm: boolean }
    }) {
      return yield* attemptAsync(() => host.space.sync(ctx.params.name, { confirm: ctx.payload.confirm }))
    })

    const capabilityPayload = (ctx: {
      payload: { readonly references: readonly string[]; local?: boolean; section?: string; confirm: boolean }
    }) => ({
      references: ctx.payload.references,
      ...(ctx.payload.local !== undefined ? { local: ctx.payload.local } : {}),
      ...(ctx.payload.section !== undefined ? { section: ctx.payload.section } : {}),
      confirm: ctx.payload.confirm,
    })

    const addSpaceCapabilities = Effect.fn("WopalSpaceHttpApi.space.capabilityAdd")(function* (ctx: {
      params: { name: string }
      payload: { readonly references: readonly string[]; local?: boolean; section?: string; confirm: boolean }
    }) {
      return yield* attemptAsync(() => host.space.capabilityAdd(ctx.params.name, capabilityPayload(ctx)))
    })

    const removeSpaceCapabilities = Effect.fn("WopalSpaceHttpApi.space.capabilityRemove")(function* (ctx: {
      params: { name: string }
      payload: { readonly references: readonly string[]; local?: boolean; section?: string; confirm: boolean }
    }) {
      return yield* attemptAsync(() => host.space.capabilityRemove(ctx.params.name, capabilityPayload(ctx)))
    })

    // --- Setup -------------------------------------------------------------

    const setupInspect = Effect.fn("WopalSpaceHttpApi.setup.inspect")(function* () {
      return yield* attemptAsync(() => setup.inspect())
    })

    const setupHomeSelect = Effect.fn("WopalSpaceHttpApi.setup.home.select")(function* (ctx: {
      payload: { readonly path: string }
    }) {
      return yield* attemptAsync(() => setup.homeSelect({ path: ctx.payload.path }))
    })

    const setupPlan = Effect.fn("WopalSpaceHttpApi.setup.plan")(function* (ctx: {
      payload: { readonly goals: readonly SetupGoal[] }
    }) {
      return yield* attemptAsync(() => setup.plan({ goals: ctx.payload.goals }))
    })

    const setupExecute = Effect.fn("WopalSpaceHttpApi.setup.execute")(function* (ctx: {
      payload: {
        readonly planId: string
        readonly actionId: SetupGoal
        readonly input?: Readonly<Record<string, unknown>>
      }
    }) {
      return yield* attemptAsync(() =>
        setup.execute({
          planId: ctx.payload.planId,
          actionId: ctx.payload.actionId,
          ...(ctx.payload.input ? { input: ctx.payload.input } : {}),
        }),
      )
    })

    const setupProgress = Effect.fn("WopalSpaceHttpApi.setup.progress")(function* (ctx: {
      params: { readonly runId: string }
    }) {
      return yield* attemptAsync(() => setup.progress(ctx.params.runId))
    })

    const setupCancel = Effect.fn("WopalSpaceHttpApi.setup.cancel")(function* (ctx: {
      params: { readonly runId: string }
    }) {
      return yield* attemptAsync(() => setup.cancel(ctx.params.runId))
    })

    const setupComplete = Effect.fn("WopalSpaceHttpApi.setup.complete")(function* (ctx: {
      payload: { readonly planId: string }
    }) {
      const result = yield* attemptAsync(() => setup.complete({ planId: ctx.payload.planId }))
      completeDshSetup()
      return result
    })

    /**
     * SSE progress.
     *
     * The run is resolved before the stream opens, so an unknown run is a typed
     * 404 instead of an empty stream. Events carry a monotonic sequence and the
     * after query replays only newer ones; a client that missed events still
     * reads the terminal snapshot through GET progress.
     */
    const setupProgressEvents = Effect.fn("WopalSpaceHttpApi.setup.progressEvents")(function* (ctx: {
      params: { readonly runId: string }
      query: { readonly after?: number }
    }) {
      const { runId } = ctx.params
      yield* attemptAsync(() => setup.progress(runId))
      const events = setup.progressEvents({ runId, after: ctx.query.after ?? 0 })
      return HttpServerResponse.stream(
        Stream.fromAsyncIterable(events, (error) => toApiError(error)).pipe(
          Stream.map(
            (event): Sse.Event => ({
              _tag: "Event",
              event: "message",
              id: String(event.sequence),
              data: JSON.stringify(event),
            }),
          ),
          Stream.pipeThroughChannel(Sse.encode()),
          Stream.encodeText,
        ),
        {
          contentType: "text/event-stream",
          headers: {
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "X-Content-Type-Options": "nosniff",
          },
        },
      )
    })

    return handlers
      .handle("listOntologies", listOntologies)
      .handle("installOntology", installOntology)
      .handle("inspectOntology", inspectOntology)
      .handle("refreshOntology", refreshOntology)
      .handle("syncOntology", syncOntology)
      .handle("ontologyCapabilities", ontologyCapabilities)
      .handle("resolveSpace", resolveSpace)
      .handle("listSpaces", listSpaces)
      .handle("initSpace", initSpace)
      .handle("spaceProjects", spaceProjects)
      .handle("spaceFiles", spaceFiles)
      .handle("spaceFileContent", spaceFileContent)
      .handle("searchSpace", searchSpace)
      .handle("scanSpace", scanSpace)
      .handle("spaceStatus", spaceStatus)
      .handle("syncSpace", syncSpace)
      .handle("addSpaceCapabilities", addSpaceCapabilities)
      .handle("removeSpaceCapabilities", removeSpaceCapabilities)
      .handle("setupInspect", setupInspect)
      .handle("setupHomeSelect", setupHomeSelect)
      .handle("setupPlan", setupPlan)
      .handle("setupExecute", setupExecute)
      .handle("setupProgress", setupProgress)
      .handleRaw("setupProgressEvents", setupProgressEvents)
      .handle("setupCancel", setupCancel)
      .handle("setupComplete", setupComplete)
  }),
)

// ---------------------------------------------------------------------------
// Instance mode
// ---------------------------------------------------------------------------

export const wopalSpaceInstanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "wopal-space-mode", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service

    const mode = Effect.fn("WopalSpaceHttpApi.mode")(function* () {
      const isWopal = yield* config.isWopalSpace()
      return { isWopalSpace: isWopal }
    })

    return handlers.handle("mode", mode)
  }),
)
