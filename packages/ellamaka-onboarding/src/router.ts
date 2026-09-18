/**
 * HTTP + SSE routing for the onboarding surface.
 *
 * Built directly on `node:http` primitives — the mount point receives
 * `IncomingMessage`/`ServerResponse` from the host dispatcher, so a framework
 * would only add a translation layer. Every handler is a thin adapter over
 * {@link OnboardingService}; the service owns all domain behavior.
 *
 * Routes (relative to the mount prefix):
 *
 * | Method | Path       | Response                                    |
 * | ------ | ---------- | ------------------------------------------- |
 * | GET    | `/state`   | 200 state view                              |
 * | POST   | `/probe`   | 200 probe payload, 503 when busy            |
 * | POST   | `/execute` | 200 StepResult, 503 when busy               |
 * | POST   | `/cancel`  | 200 `{ ok: true }`                          |
 * | POST   | `/complete`| 200 `{ completed: true }` or a health-gate refusal |
 * | GET    | `/stream`  | 200 SSE stream of progress/log/error/complete |
 *
 * @module @wopal/ellamaka-onboarding/router
 */
import type { IncomingMessage, ServerResponse } from "node:http"

import { checkOnboardingAuth, type OnboardingAuthOptions } from "./auth"
import { OnboardingBusyError, type OnboardingService } from "./service"
import { ONBOARDING_OPERATION_BUSY, type OnboardingEvent, type OnboardingExecutableStep } from "./types"

export interface OnboardingRouterOptions extends OnboardingAuthOptions {
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number
}

export interface OnboardingRouter {
  request(req: IncomingMessage, res: ServerResponse): Promise<void>
}

interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  pathname: string
  query: URLSearchParams
}

const MAX_BODY_BYTES = 1024 * 1024

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  })
  res.end(body)
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } })
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const chunks: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.byteLength
      if (total > MAX_BODY_BYTES) return { ok: false, message: "Request body exceeds 1 MiB." }
      chunks.push(buffer)
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }

  const raw = Buffer.concat(chunks).toString("utf-8").trim()
  if (!raw) return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false, message: "Request body is not valid JSON." }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Build the router over one service instance. The router is stateless beyond
 * the service reference; all mutable state lives in the service.
 */
export function createOnboardingRouter(
  service: OnboardingService,
  options: OnboardingRouterOptions = {},
): OnboardingRouter {
  const handleGetState = async (ctx: RouteContext) => {
    sendJson(ctx.res, 200, service.getState())
  }

  const handleProbe = async (ctx: RouteContext) => {
    const body = await readJsonBody(ctx.req)
    if (!body.ok) return sendError(ctx.res, 400, "ONBOARDING_REQUEST_INVALID", body.message)
    const kind = asRecord(body.value)?.kind
    if (typeof kind !== "string" || !kind.trim()) {
      return sendError(ctx.res, 400, "ONBOARDING_REQUEST_INVALID", "Field 'kind' (string) is required.")
    }
    try {
      sendJson(ctx.res, 200, await service.probe(kind.trim()))
    } catch (err) {
      if (err instanceof OnboardingBusyError) return sendBusy(ctx.res, err)
      throw err
    }
  }

  const handleExecute = async (ctx: RouteContext) => {
    const body = await readJsonBody(ctx.req)
    if (!body.ok) return sendError(ctx.res, 400, "ONBOARDING_REQUEST_INVALID", body.message)
    const payload = asRecord(body.value) ?? {}
    const step = payload.step
    if (typeof step !== "string" || !step.trim()) {
      return sendError(ctx.res, 400, "ONBOARDING_REQUEST_INVALID", "Field 'step' (string) is required.")
    }
    try {
      sendJson(ctx.res, 200, await service.executeStep(step.trim() as OnboardingExecutableStep, payload.input))
    } catch (err) {
      if (err instanceof OnboardingBusyError) return sendBusy(ctx.res, err)
      throw err
    }
  }

  const handleCancel = async (ctx: RouteContext) => {
    sendJson(ctx.res, 200, service.cancel())
  }

  const handleComplete = async (ctx: RouteContext) => {
    sendJson(ctx.res, 200, await service.complete())
  }

  const handleStream = async (ctx: RouteContext) => {
    const { res } = ctx
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })
    // Flush headers immediately so clients can observe stream establishment.
    res.flushHeaders?.()

    let closed = false
    const writeEvent = (event: OnboardingEvent) => {
      if (closed || res.writableEnded) return
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    const writeComment = () => {
      if (closed || res.writableEnded) return
      res.write(": keep-alive\n\n")
    }

    // Initial frame: confirms the stream is live to EventSource consumers.
    writeComment()

    const onProgress = (event: OnboardingEvent) => writeEvent(event)
    const onLog = (event: OnboardingEvent) => writeEvent(event)
    const onError = (event: OnboardingEvent) => writeEvent(event)
    const onComplete = (event: OnboardingEvent) => {
      writeEvent(event)
      close()
    }

    const close = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      service.events.off("progress", onProgress)
      service.events.off("log", onLog)
      service.events.off("error", onError)
      service.events.off("complete", onComplete)
      if (!res.writableEnded) res.end()
    }

    const heartbeat = setInterval(writeComment, 15000)
    // Never keep the event loop (or the process) alive for a stream alone.
    heartbeat.unref?.()

    service.events.on("progress", onProgress)
    service.events.on("log", onLog)
    service.events.on("error", onError)
    service.events.on("complete", onComplete)

    ctx.req.on("close", close)
    ctx.res.on("close", close)
    ctx.res.on("error", close)
  }

  const sendBusy = (res: ServerResponse, err: OnboardingBusyError) => {
    sendError(res, 503, ONBOARDING_OPERATION_BUSY, err.message)
  }

  const routeTable: Record<string, { methods: string[]; handler: (ctx: RouteContext) => Promise<void> }> = {
    "/state": { methods: ["GET"], handler: handleGetState },
    "/probe": { methods: ["POST"], handler: handleProbe },
    "/execute": { methods: ["POST"], handler: handleExecute },
    "/cancel": { methods: ["POST"], handler: handleCancel },
    "/complete": { methods: ["POST"], handler: handleComplete },
    "/stream": { methods: ["GET"], handler: handleStream },
  }

  return {
    async request(req, res) {
      const method = (req.method ?? "GET").toUpperCase()
      let url: URL
      try {
        url = new URL(req.url ?? "/", "http://localhost")
      } catch {
        return sendError(res, 400, "ONBOARDING_REQUEST_INVALID", "Malformed request target.")
      }

      const auth = checkOnboardingAuth(req, options)
      if (!auth.ok) {
        if (auth.code === "SECURITY_BLOCK") return sendError(res, auth.status, auth.code, auth.message)
        // Deliberately no `WWW-Authenticate` header: it would make browsers
        // pop a native Basic dialog that an SPA cannot intercept.
        return sendError(res, auth.status, auth.code, auth.message)
      }

      const pathname = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname
      const route = routeTable[pathname]
      if (!route) return sendError(res, 404, "ONBOARDING_NOT_FOUND", `Unknown onboarding route: ${pathname}`)
      if (!route.methods.includes(method)) {
        res.setHeader("Allow", route.methods.join(", "))
        return sendError(res, 405, "ONBOARDING_METHOD_NOT_ALLOWED", `${method} is not allowed for ${pathname}.`)
      }

      try {
        await route.handler({ req, res, pathname, query: url.searchParams })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[onboarding] ${method} ${pathname} failed: ${message}`)
        if (!res.headersSent) sendError(res, 500, "ONBOARDING_INTERNAL_ERROR", message)
        else if (!res.writableEnded) res.end()
      }
    },
  }
}
