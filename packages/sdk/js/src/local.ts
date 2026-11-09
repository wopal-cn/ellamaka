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
      reject: (error: unknown) => void
      abort: AbortController
      promise: Promise<Response>
      /** True once the request body has been read and posted to the Worker. */
      dispatched: boolean
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
    // Settle survivals even after dispose: an accepted call must never be left
    // pending just because the client already started shutting down.
    fail(new Error(closed ? "local client is disposed" : `local Worker exited unexpectedly with code ${code}`))
  })
  await ready

  const localFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init)
    const url = new URL(request.url)
    const rejected = unsupported(url.pathname)
    if (rejected) return rejected
    if (closed) return disposedResponse()
    // A signal that is already aborted must cancel before any work: fetch never
    // dispatches a pre-aborted request, and neither may the trusted-local path.
    if (request.signal.aborted) throw abortError(request.signal.reason)

    const id = nextID++
    const controller = new AbortController()
    let settle!: (value: Response | PromiseLike<Response>) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<Response>((resolve, fail) => {
      settle = resolve
      reject = fail
    })
    const entry = { resolve: settle, reject, abort: controller, promise, dispatched: false }
    inFlight.set(id, entry)

    const abort = () => {
      controller.abort(request.signal.reason)
      if (entry.dispatched) worker.postMessage({ type: "abort", id })
    }
    request.signal.addEventListener("abort", abort, { once: true })

    // Reading a stream body is asynchronous and the signal cannot interrupt it:
    // a cancelled call whose stream never ends would keep dispose waiting on a
    // request that was never dispatched. Race the read against the abort.
    const readBody = async (): Promise<Buffer | undefined> => {
      if (request.body === null) return undefined
      const aborted = new Promise<never>((_, fail) => {
        const onAbort = () => {
          void request.body?.cancel(request.signal.reason).catch(() => {})
          fail(abortError(request.signal.reason))
        }
        if (request.signal.aborted) onAbort()
        else request.signal.addEventListener("abort", onAbort, { once: true })
      })
      try {
        return Buffer.from(await Promise.race([request.arrayBuffer(), aborted]))
      } finally {
        // The race is settled; keep the losing side from becoming unhandled.
        aborted.catch(() => {})
      }
    }

    void (async () => {
      try {
        const body = (await readBody())?.toString("base64")
        // The body read is asynchronous, so the request can be aborted while it
        // runs. Never dispatch after that point. A request accepted before
        // dispose still runs: dispose drains accepted work instead of dropping it.
        if (request.signal.aborted) throw abortError(request.signal.reason)
        entry.dispatched = true
        worker.postMessage({
          type: "request",
          id,
          request: { url: url.href, method: request.method, headers: [...request.headers.entries()], body },
        })
      } catch (error) {
        // Remove first: a reply that raced the failure must not revive the entry.
        if (inFlight.delete(id)) reject(error)
      }
    })()

    return promise.finally(() => request.signal.removeEventListener("abort", abort))
  }) as typeof fetch

  const generated = createOpencodeClient({ baseUrl: "http://local.invalid", fetch: localFetch })
  return {
    client: { wopalSpace: { ontology: generated.wopalSpace.ontology, space: generated.wopalSpace.space } },
    request: (path: string, init?: RequestInit) => localFetch(new URL(path, "http://local.invalid"), init),
    async dispose() {
      if (closed) return
      closed = true
      // Drain accepted work: a request that started before dispose still reaches
      // the Worker and finishes its persisted write, and dispose does not return
      // while any accepted call is unsettled.
      await Promise.allSettled([...inFlight.values()].map((pending) => pending.promise))
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

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new DOMException("The operation was aborted.", "AbortError")
}

function disposedResponse(): Response {
  return Response.json({ name: "LocalClientDisposed", data: { message: "local client is disposed" } }, { status: 410 })
}
