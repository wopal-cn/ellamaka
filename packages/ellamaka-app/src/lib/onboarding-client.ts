/**
 * Onboarding HTTP/SSE client.
 *
 * The single communication seam between the migrated onboarding UI and the
 * mounted `/api/onboarding` surface. It replaces the Electron IPC bridge the
 * desktop renderer used to talk through: REST calls are plain `fetch`, live
 * progress is an `EventSource` subscription. Both are injectable through
 * structural interfaces so tests can exercise request construction and event
 * dispatch without a network.
 *
 * Credential resolution mirrors the SDK client (`@/utils/server`): a Basic
 * authorization header on requests, and the URL-borne `auth_token` query for
 * SSE (EventSource cannot carry custom headers).
 *
 * @module
 */
import { authFromToken, authTokenFromCredentials } from "@/utils/server"

// ── Wire contract (mirrors @wopal/ellamaka-onboarding/types) ──────────

/** The canonical wizard steps, in order. */
export const ONBOARDING_STEPS = [
  "system-check",
  "install-cli",
  "ontology-setup",
  "create-space",
  "ai-provider",
  "done",
] as const

export type OnboardingStepName = (typeof ONBOARDING_STEPS)[number]

/** `github-auth` and `inspect` are executable pseudo steps. */
export type OnboardingExecutableStep = OnboardingStepName | "inspect" | "github-auth"

/** The read-only view served by `GET /state`. */
export interface OnboardingStateView {
  completed: boolean
  currentStep: OnboardingStepName | "done"
  completedSteps: OnboardingStepName[]
}

/** A probe result: operation-specific shape. */
export type OnboardingProbeResult = Record<string, unknown>

export interface OnboardingStepError {
  code?: string
  message?: string
  suggestion?: string
  details?: string
}

/** The result of executing one step. */
export interface OnboardingStepResult {
  status: "completed" | "reused" | "skipped" | "failed"
  result?: Record<string, unknown>
  error?: OnboardingStepError
}

/** Progress payload pushed over SSE and to the executor's progress callback. */
export interface OnboardingProgress {
  step?: string
  phase?: string
  percent?: number
  message?: string
  suggestion?: string
  details?: string
}

/** An SSE event envelope. `type` discriminates the stream. */
export type OnboardingEvent =
  | ({ type: "progress" } & OnboardingProgress)
  | { type: "log"; step?: string; message: string }
  | { type: "error"; step?: string; code?: string; message: string; details?: string }
  | { type: "complete"; completed: true }

export interface OnboardingCredentials {
  username?: string
  password: string
}

/**
 * The subset of `EventSource` the client depends on. Declared structurally so
 * tests can inject a lightweight stream double; the real `EventSource` class
 * satisfies it as-is.
 */
export interface OnboardingEventStream {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
  removeEventListener?(type: "message", listener: (event: MessageEvent) => void): void
  close(): void
}

/** Constructor shape of an injectable event stream. */
export type OnboardingEventStreamFactory = new (url: string) => OnboardingEventStream

/** Injectable fetch shape; `globalThis.fetch` satisfies it as-is. */
export type OnboardingFetch = (url: string, init?: RequestInit) => Promise<Response>

export interface OnboardingClientOptions {
  /** Mount prefix; defaults to the same-origin relative `/api/onboarding`. */
  baseUrl?: string
  /** Basic-auth credentials, or `null` when the server runs passwordless. */
  credentials?: OnboardingCredentials | null
  /** Test seam; defaults to `globalThis.fetch`. */
  fetch?: OnboardingFetch
  /** Test seam; defaults to the ambient `EventSource`. */
  eventSource?: OnboardingEventStreamFactory
}

/** The stable error code reported when the completion health gate refuses. */
export const ONBOARDING_HEALTH_GATE_FAILED = "ONBOARDING_HEALTH_GATE_FAILED"

/**
 * The `POST /complete` response. The gate only persists `completed: true` when
 * the machine reports `verdict === "healthy"`; otherwise it refuses with a
 * structured error carrying the verdict and its reason.
 */
export type OnboardingCompleteResult =
  | { completed: true }
  | { status: "failed"; error: { code: typeof ONBOARDING_HEALTH_GATE_FAILED; message: string } }

export interface OnboardingClient {
  getState(): Promise<OnboardingStateView>
  probe(kind: string): Promise<OnboardingProbeResult>
  executeStep(step: OnboardingExecutableStep, input?: unknown): Promise<OnboardingStepResult>
  cancel(): Promise<{ ok: true }>
  complete(): Promise<OnboardingCompleteResult>
  /** Subscribe to the SSE stream; returns a disposer that closes it. */
  subscribe(listener: (event: OnboardingEvent) => void): () => void
}

// ── Errors ────────────────────────────────────────────────────────────

export interface OnboardingClientErrorOptions {
  code?: string
  status: number
  details?: unknown
}

export class OnboardingClientError extends Error {
  readonly code?: string
  readonly status: number
  readonly details?: unknown

  constructor(message: string, options: OnboardingClientErrorOptions) {
    super(message)
    this.name = "OnboardingClientError"
    this.code = options.code
    this.status = options.status
    this.details = options.details
  }
}

// ── Credentials ───────────────────────────────────────────────────────

/**
 * Resolve onboarding credentials from a server connection (or any URL):
 * an explicit password wins, otherwise the `auth_token` query is decoded —
 * the same exchange the SDK client performs on startup.
 */
export function credentialsFromConnection(
  input: { url?: string; username?: string; password?: string } | null | undefined,
): OnboardingCredentials | null {
  if (!input) return null
  if (input.password) return { username: input.username ?? "ellamaka", password: input.password }
  if (!input.url) return null
  try {
    const token = new URL(input.url).searchParams.get("auth_token")
    return authFromToken(token) ?? null
  } catch {
    return null
  }
}

// ── Client factory ────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "/api/onboarding"

interface NormalizedErrorBody {
  code?: string
  message?: string
  details?: unknown
}

function normalizeErrorBody(body: unknown): NormalizedErrorBody | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null
  if (!("error" in body)) return null
  const error: unknown = body.error
  if (typeof error !== "object" || error === null || Array.isArray(error)) return null
  return {
    code: "code" in error && typeof error.code === "string" ? error.code : undefined,
    message: "message" in error && typeof error.message === "string" ? error.message : undefined,
    details: "details" in error ? error.details : undefined,
  }
}

/**
 * Build an onboarding client. Closure-based (no `this`), so callers can pass
 * method references around freely.
 */
export function createOnboardingClient(options: OnboardingClientOptions = {}): OnboardingClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  const credentials = options.credentials ?? null
  const fetchImpl: OnboardingFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const EventSourceImpl = options.eventSource ?? globalThis.EventSource

  const authHeader = (): Record<string, string> | undefined => {
    if (!credentials?.password) return undefined
    return { Authorization: `Basic ${authTokenFromCredentials(credentials)}` }
  }

  // `any` at this internal seam: the wire payload is validated by the server
  // and re-typed by each public method's declared return type.
  const request = async (path: string, init: RequestInit = {}): Promise<any> => {
    const headers = new Headers(init.headers)
    const auth = authHeader()
    if (auth) for (const [key, value] of Object.entries(auth)) headers.set(key, value)
    if (init.body !== undefined) headers.set("Content-Type", "application/json")

    const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers })

    const raw = await response.text().catch(() => "")
    let body: unknown
    try {
      body = raw.trim() ? JSON.parse(raw) : undefined
    } catch {
      body = undefined
    }

    if (!response.ok) {
      const normalized = normalizeErrorBody(body)
      throw new OnboardingClientError(normalized?.message ?? `HTTP ${response.status}`, {
        code: normalized?.code,
        status: response.status,
        details: normalized?.details ?? body,
      })
    }

    return body
  }

  const streamUrl = (): string => {
    const token = credentials?.password ? authTokenFromCredentials(credentials) : undefined
    return token ? `${baseUrl}/stream?auth_token=${encodeURIComponent(token)}` : `${baseUrl}/stream`
  }

  return {
    getState: () => request("/state", { method: "GET" }),

    probe: (kind) => request("/probe", { method: "POST", body: JSON.stringify({ kind }) }),

    executeStep: (step, input) =>
      request("/execute", {
        method: "POST",
        body: JSON.stringify(input === undefined ? { step } : { step, input }),
      }),

    cancel: () => request("/cancel", { method: "POST" }),

    complete: () => request("/complete", { method: "POST" }),

    subscribe(listener) {
      const source = new EventSourceImpl(streamUrl())
      let disposed = false

      const dispose = () => {
        if (disposed) return
        disposed = true
        source.removeEventListener?.("message", onMessage)
        source.close()
      }

      const onMessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") return
        let payload: OnboardingEvent
        try {
          payload = JSON.parse(event.data)
        } catch {
          return
        }
        listener(payload)
        // The server ends the stream right after `complete`; closing here
        // prevents EventSource's automatic reconnect against a dead surface.
        if (payload.type === "complete") dispose()
      }

      source.addEventListener("message", onMessage)
      return dispose
    },
  }
}
