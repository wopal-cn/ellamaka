import { Worker } from "node:worker_threads"
import { createOpencodeClient, type OpencodeClient } from "./v2/client.js"

type Ontology = OpencodeClient["wopalSpace"]["ontology"]
type Space = OpencodeClient["wopalSpace"]["space"]
export type EllamakaLocalClient = { readonly wopalSpace: { readonly ontology: Ontology; readonly space: Space } }
export interface EllamakaLocalOptions {
  wopalHome?: string
  directory?: string
  /** Absolute Worker asset location for launchers that relocate the artifact, including SEA consumers. */
  workerPath?: URL
}
export interface EllamakaLocal {
  client: EllamakaLocalClient
  dispose(): Promise<void>
  /** @internal Protocol-level request for SDK verification. */
  request(path: string, init?: RequestInit): Promise<Response>
}

type ResponseMessage = {
  type: "response"
  id: number
  response: { status: number; headers: [string, string][]; body: string }
}
type ErrorMessage = { type: "error"; id: number; message: string }
type ReadyMessage = { type: "ready" }
type ClosedMessage = { type: "closed"; id: number }
type WorkerMessage = ResponseMessage | ErrorMessage | ReadyMessage | ClosedMessage

function unsupported(pathname: string): Response | undefined {
  if (pathname.startsWith("/wopal-space/ontologies") || pathname.startsWith("/wopal-space/spaces")) return undefined
  return new Response(
    JSON.stringify({
      name: "WopalSpaceRequestError",
      data: {
        code: "LOCAL_OPERATION_UNSUPPORTED",
        message: `${pathname} is not available through the trusted-local SDK transport`,
        suggestion: "Use an authenticated Ellamaka Server for Setup and Runtime operations.",
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  )
}

export async function createEllamakaLocalClient(options: EllamakaLocalOptions = {}): Promise<EllamakaLocal> {
  const worker = new Worker(options.workerPath ?? new URL("./local/worker.js", import.meta.url), {
    workerData: {
      wopalHome: options.wopalHome ?? process.env.WOPAL_HOME ?? "",
      directory: options.directory ?? process.cwd(),
    },
  })
  let nextID = 0
  let closed = false
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const inFlight = new Map<
    number,
    {
      resolve: (value: Response) => void
      reject: (error: Error) => void
      abort: AbortController
      promise?: Promise<Response>
    }
  >()

  function fail(error: Error) {
    rejectReady(error)
    for (const pending of inFlight.values()) {
      pending.abort.abort(error)
      pending.reject(error)
    }
    inFlight.clear()
  }

  worker.on("message", (message: WorkerMessage) => {
    if (message.type === "ready") return resolveReady()
    if (message.type === "error" && message.id === undefined)
      return fail(new Error(message.message ?? "local Worker failed"))
    if (message.id === undefined) return
    const pending = inFlight.get(message.id)
    if (!pending) return
    inFlight.delete(message.id)
    if (message.type === "error") return pending.reject(new Error(message.message ?? "local Worker request failed"))
    if (message.type !== "response" || !message.response)
      return pending.reject(new Error("local Worker returned no response"))
    pending.resolve(
      new Response(Buffer.from(message.response.body, "base64"), {
        status: message.response.status,
        headers: message.response.headers,
      }),
    )
  })
  worker.on("error", fail)
  worker.on("exit", (code) => {
    if (!closed) fail(new Error(`local Worker exited unexpectedly with code ${code}`))
  })
  await ready

  const localFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init)
    const url = new URL(request.url)
    const rejected = unsupported(url.pathname)
    if (rejected) return rejected
    if (closed)
      return Response.json(
        { name: "LocalClientDisposed", data: { message: "local client is disposed" } },
        { status: 410 },
      )

    const id = nextID++
    const controller = new AbortController()
    const abort = () => {
      controller.abort(request.signal.reason)
      worker.postMessage({ type: "abort", id })
    }
    if (request.signal.aborted) abort()
    else request.signal.addEventListener("abort", abort, { once: true })
    const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer()).toString("base64")
    const promise = new Promise<Response>((resolve, reject) => {
      inFlight.set(id, { resolve, reject, abort: controller })
      worker.postMessage({
        type: "request",
        id,
        request: { url: url.href, method: request.method, headers: [...request.headers.entries()], body },
      })
    }).finally(() => request.signal.removeEventListener("abort", abort))
    const entry = inFlight.get(id)
    if (entry) entry.promise = promise
    return promise
  }) as typeof fetch

  const generated = createOpencodeClient({ baseUrl: "http://local.invalid", fetch: localFetch })
  return {
    client: { wopalSpace: { ontology: generated.wopalSpace.ontology, space: generated.wopalSpace.space } },
    request: (path: string, init?: RequestInit) => localFetch(new URL(path, "http://local.invalid"), init),
    async dispose() {
      if (closed) return
      closed = true
      await Promise.allSettled([...inFlight.values()].flatMap((pending) => (pending.promise ? [pending.promise] : [])))
      const id = nextID++
      await new Promise<void>((resolve, reject) => {
        const onMessage = (message: { type: string; id?: number }) => {
          if (message.type !== "closed" || message.id !== id) return
          worker.off("message", onMessage)
          resolve()
        }
        worker.on("message", onMessage)
        worker.once("error", reject)
        worker.postMessage({ type: "close", id })
      })
      await worker.terminate()
    },
  }
}
