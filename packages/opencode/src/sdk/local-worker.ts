import { parentPort, workerData } from "node:worker_threads"
import { Context, Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { WopalSpaceOperations } from "@/server/routes/instance/httpapi/groups/wopal-space-operations"
import { WopalSpaceRequestError, toApiError } from "@/server/routes/instance/httpapi/wopal-space-errors"
import { WopalSpaceHostService } from "@/wopal/wopal-space-host"
import { SchemaErrorMiddleware, schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"

const input: unknown = workerData
if (!input || typeof input !== "object") throw new Error("local Worker requires execution options")
const options = Object.fromEntries(Object.entries(input))
if (typeof options.wopalHome !== "string" || typeof options.directory !== "string")
  throw new Error("local Worker requires wopalHome and directory strings")
const data = { wopalHome: options.wopalHome, directory: options.directory }
process.env.WOPAL_HOME = data.wopalHome

const LocalApi = HttpApi.make("ellamaka-local").add(WopalSpaceOperations.middleware(SchemaErrorMiddleware))
const unsupported = (operation: string) =>
  new WopalSpaceRequestError({
    code: "LOCAL_OPERATION_UNSUPPORTED",
    message: `${operation} is not available through the trusted-local SDK transport`,
    suggestion: "Use an authenticated Ellamaka Server for Setup and Runtime operations.",
  })
const attempt = <A>(run: () => A) => Effect.try({ try: run, catch: toApiError })
const attemptAsync = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toApiError })

const handlers = HttpApiBuilder.group(LocalApi, "wopal-space", (api) =>
  Effect.gen(function* () {
    const host = yield* WopalSpaceHostService.Service
    const setup = (name: string) => Effect.fail(unsupported(name))
    const capability = (input: {
      references: readonly string[]
      local?: boolean
      section?: string
      confirm: boolean
    }) => ({
      references: input.references,
      ...(input.local !== undefined ? { local: input.local } : {}),
      ...(input.section !== undefined ? { section: input.section } : {}),
      confirm: input.confirm,
    })
    return api
      .handle("listOntologies", () => attemptAsync(() => host.ontology.list()))
      .handle("installOntology", (ctx) => attemptAsync(() => host.ontology.install(ctx.payload)))
      .handle("inspectOntology", (ctx) => attemptAsync(() => host.ontology.inspect(ctx.params.name)))
      .handle("refreshOntology", (ctx) => attemptAsync(() => host.ontology.refresh(ctx.params.name)))
      .handle("syncOntology", (ctx) =>
        attemptAsync(() => host.ontology.sync(ctx.params.name, { confirm: ctx.payload.confirm })),
      )
      .handle("ontologyCapabilities", (ctx) =>
        attemptAsync(() =>
          host.ontology.capabilityList(ctx.params.name, ctx.query.kind ? { kind: ctx.query.kind } : undefined),
        ),
      )
      .handle("resolveSpace", (ctx) => attempt(() => host.space.resolve(ctx.payload)))
      .handle("listSpaces", () => attempt(() => host.space.list()))
      .handle("initSpace", (ctx) => attemptAsync(() => host.space.init(ctx.payload)))
      .handle("spaceProjects", (ctx) => attempt(() => host.space.projectsList(ctx.params.name)))
      .handle("spaceFiles", (ctx) => attempt(() => host.space.filesList(ctx.params.name, ctx.query.path)))
      .handle("spaceFileContent", (ctx) => attempt(() => host.space.filesRead(ctx.params.name, ctx.query.path)))
      .handle("searchSpace", (ctx) =>
        attempt(() =>
          host.space.search(ctx.params.name, {
            ...(ctx.query.query !== undefined ? { query: ctx.query.query } : {}),
            ...(ctx.query.type !== undefined ? { type: ctx.query.type } : {}),
            ...(ctx.query.limit !== undefined ? { limit: ctx.query.limit } : {}),
            ...(ctx.query.offset !== undefined ? { offset: ctx.query.offset } : {}),
          }),
        ),
      )
      .handle("scanSpace", (ctx) => attempt(() => host.space.scan(ctx.params.name)))
      .handle("spaceStatus", (ctx) => attemptAsync(() => host.space.status(ctx.params.name)))
      .handle("syncSpace", (ctx) =>
        attemptAsync(() => host.space.sync(ctx.params.name, { confirm: ctx.payload.confirm })),
      )
      .handle("addSpaceCapabilities", (ctx) =>
        attemptAsync(() => host.space.capabilityAdd(ctx.params.name, capability(ctx.payload))),
      )
      .handle("removeSpaceCapabilities", (ctx) =>
        attemptAsync(() => host.space.capabilityRemove(ctx.params.name, capability(ctx.payload))),
      )
      .handle("setupInspect", () => setup("Setup inspect"))
      .handle("setupHomeSelect", () => setup("Setup Home selection"))
      .handle("setupPlan", () => setup("Setup planning"))
      .handle("setupExecute", () => setup("Setup execution"))
      .handle("setupProgress", () => setup("Setup progress"))
      .handleRaw("setupProgressEvents", () => setup("Setup progress events"))
      .handle("setupCancel", () => setup("Setup cancellation"))
      .handle("setupComplete", () => setup("Setup completion"))
  }),
)

const host = WopalSpaceHostService.layerFor({ host: { wopalHome: data.wopalHome, directory: data.directory } })
const routes = HttpApiBuilder.layer(LocalApi).pipe(
  Layer.provide(handlers),
  Layer.provide(schemaErrorLayer),
  Layer.provide(host),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provideMerge(NodeServices.layer),
)
const web = HttpRouter.toWebHandler(routes, { disableLogger: true })
let closed = false
let pending = 0
let idleWaiters: (() => void)[] = []
function whenIdle() {
  if (pending === 0) return Promise.resolve()
  return new Promise<void>((resolve) => idleWaiters.push(resolve))
}
const aborts = new Map<number, AbortController>()
type RequestMessage = {
  type: "request"
  id: number
  request: { url: string; method: string; headers: [string, string][]; body?: string }
}
type AbortMessage = { type: "abort"; id: number }
type CloseMessage = { type: "close"; id: number }
type Message = RequestMessage | AbortMessage | CloseMessage

parentPort!.on("message", async (message: Message) => {
  if (message.type === "abort") return aborts.get(message.id)?.abort()
  if (message.type === "close") {
    closed = true
    await whenIdle()
    await web.dispose()
    parentPort!.postMessage({ type: "closed", id: message.id })
    return
  }
  if (closed) return parentPort!.postMessage({ type: "error", id: message.id, message: "local worker is closed" })
  pending++
  const controller = new AbortController()
  aborts.set(message.id, controller)
  try {
    const request = new Request(new URL(message.request.url, "http://local.invalid"), {
      method: message.request.method,
      headers: message.request.headers,
      body: message.request.body === undefined ? undefined : Buffer.from(message.request.body, "base64"),
      signal: controller.signal,
    })
    const response = await web.handler(request, Context.makeUnsafe<unknown>(new Map()))
    const bytes = new Uint8Array(await response.arrayBuffer())
    parentPort!.postMessage({
      type: "response",
      id: message.id,
      response: {
        status: response.status,
        headers: [...response.headers.entries()],
        body: Buffer.from(bytes).toString("base64"),
      },
    })
  } catch (error) {
    parentPort!.postMessage({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    aborts.delete(message.id)
    pending--
    if (pending === 0) {
      for (const resolve of idleWaiters) resolve()
      idleWaiters = []
    }
  }
})
parentPort!.postMessage({ type: "ready" })
