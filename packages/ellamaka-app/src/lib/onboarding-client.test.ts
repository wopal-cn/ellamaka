import { describe, expect, test } from "bun:test"
import type { OnboardingEventStream } from "./onboarding-client"
import {
  createOnboardingClient,
  credentialsFromConnection,
  OnboardingClientError,
  type OnboardingEvent,
  type OnboardingFetch,
} from "./onboarding-client"

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

function mockFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const fetchImpl: OnboardingFetch = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { fetchImpl, calls }
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** Parse a recorded request body; `undefined` when the call carried none. */
function requestBody(call: FetchCall): unknown {
  const body = call.init?.body
  return typeof body === "string" ? JSON.parse(body) : undefined
}

/** Await a rejecting promise and assert the failure shape. */
async function expectClientError(promise: Promise<unknown>): Promise<OnboardingClientError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof OnboardingClientError) return error
    throw error
  }
  throw new Error("Expected the request to reject with OnboardingClientError")
}

class MockEventSource implements OnboardingEventStream {
  static instances: MockEventSource[] = []

  static reset() {
    MockEventSource.instances = []
  }

  readonly url: string
  closed = false
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>()

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  addEventListener(type: "message", listener: (event: MessageEvent) => void) {
    this.listenersFor(type).add(listener)
  }

  removeEventListener(type: "message", listener: (event: MessageEvent) => void) {
    this.listenersFor(type).delete(listener)
  }

  close() {
    this.closed = true
    this.listeners.clear()
  }

  emit(type: string, data: unknown) {
    for (const listener of this.listenersFor(type)) {
      listener(new MessageEvent(type, { data: JSON.stringify(data) }))
    }
  }

  private listenersFor(type: string) {
    const existing = this.listeners.get(type)
    if (existing) return existing
    const created = new Set<(event: MessageEvent) => void>()
    this.listeners.set(type, created)
    return created
  }
}

describe("onboarding-client", () => {
  test("getState constructs a GET /state request and parses the view", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse(200, { completed: false, currentStep: "install-cli", completedSteps: ["system-check"] }),
    )
    const client = createOnboardingClient({ fetch: fetchImpl })

    const state = await client.getState()

    expect(state).toEqual({ completed: false, currentStep: "install-cli", completedSteps: ["system-check"] })
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe("/api/onboarding/state")
    expect(calls[0].init?.method).toBe("GET")
  })

  test("probe posts {kind} as JSON with the JSON content type", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(200, { userName: "sam" }))
    const client = createOnboardingClient({ fetch: fetchImpl })

    const result = await client.probe("system-user")

    expect(result).toEqual({ userName: "sam" })
    expect(calls[0].url).toBe("/api/onboarding/probe")
    expect(calls[0].init?.method).toBe("POST")
    expect(new Headers(calls[0].init?.headers).get("content-type")).toBe("application/json")
    expect(requestBody(calls[0])).toEqual({ kind: "system-user" })
  })

  test("executeStep posts {step, input} and omits input when undefined", async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResponse(200, { status: "completed" }))
    const client = createOnboardingClient({ fetch: fetchImpl })

    await client.executeStep("system-check", { customHomePath: "/tmp/wopal" })
    await client.executeStep("done")

    expect(calls[0].url).toBe("/api/onboarding/execute")
    expect(requestBody(calls[0])).toEqual({
      step: "system-check",
      input: { customHomePath: "/tmp/wopal" },
    })
    const second = requestBody(calls[1])
    expect(second).toEqual({ step: "done" })
    expect(second && typeof second === "object" && "input" in second && second.input !== undefined).toBe(false)
  })

  test("cancel and complete post to their endpoints and parse acknowledgements", async () => {
    const { fetchImpl, calls } = mockFetch((url) =>
      url.endsWith("/cancel") ? jsonResponse(200, { ok: true }) : jsonResponse(200, { completed: true }),
    )
    const client = createOnboardingClient({ fetch: fetchImpl })

    expect(await client.cancel()).toEqual({ ok: true })
    expect(await client.complete()).toEqual({ completed: true })
    expect(calls.map((call) => call.url)).toEqual(["/api/onboarding/cancel", "/api/onboarding/complete"])
    expect(calls[0].init?.method).toBe("POST")
  })

  test("attaches the Basic credentials header when credentials are provided", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse(200, { completed: false, currentStep: "system-check", completedSteps: [] }),
    )
    const client = createOnboardingClient({
      credentials: { username: "ellamaka", password: "secret" },
      fetch: fetchImpl,
    })

    await client.getState()

    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(`Basic ${btoa("ellamaka:secret")}`)
  })

  test("normalizes a 503 busy response into OnboardingClientError", async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse(503, {
        error: { code: "ONBOARDING_OPERATION_BUSY", message: "Onboarding operation already running." },
      }),
    )
    const client = createOnboardingClient({ fetch: fetchImpl })

    const error = await expectClientError(client.probe("home"))

    expect(error.code).toBe("ONBOARDING_OPERATION_BUSY")
    expect(error.status).toBe(503)
    expect(error.message).toBe("Onboarding operation already running.")
  })

  test("normalizes non-busy failures and falls back to HTTP status for empty bodies", async () => {
    const unauthorized = mockFetch(() =>
      jsonResponse(401, { error: { code: "UNAUTHORIZED", message: "Unauthorized" } }),
    )
    const client = createOnboardingClient({ fetch: unauthorized.fetchImpl })

    const authError = await expectClientError(client.executeStep("done"))
    expect(authError.code).toBe("UNAUTHORIZED")
    expect(authError.status).toBe(401)
    expect(authError.message).toBe("Unauthorized")

    const empty = mockFetch(() => new Response("", { status: 502 }))
    const emptyClient = createOnboardingClient({ fetch: empty.fetchImpl })
    const emptyError = await expectClientError(emptyClient.getState())
    expect(emptyError.code).toBeUndefined()
    expect(emptyError.status).toBe(502)
    expect(emptyError.message).toBe("HTTP 502")
  })

  test("subscribe opens /stream without credentials and dispatches message events", () => {
    MockEventSource.reset()
    const client = createOnboardingClient({ eventSource: MockEventSource })
    const events: OnboardingEvent[] = []

    client.subscribe((event) => events.push(event))

    const source = MockEventSource.instances[0]
    expect(source.url).toBe("/api/onboarding/stream")
    source.emit("message", { type: "progress", phase: "starting", message: "开始系统检查…" })
    expect(events).toEqual([{ type: "progress", phase: "starting", message: "开始系统检查…" }])
  })

  test("subscribe appends the auth_token query when credentials exist", () => {
    MockEventSource.reset()
    const client = createOnboardingClient({
      credentials: { password: "secret" },
      eventSource: MockEventSource,
    })

    client.subscribe(() => {})

    const token = btoa("ellamaka:secret")
    expect(MockEventSource.instances[0].url).toBe(`/api/onboarding/stream?auth_token=${encodeURIComponent(token)}`)
  })

  test("a complete event reaches the listener and closes the stream", () => {
    MockEventSource.reset()
    const client = createOnboardingClient({ eventSource: MockEventSource })
    const events: OnboardingEvent[] = []

    client.subscribe((event) => events.push(event))

    const source = MockEventSource.instances[0]
    source.emit("message", { type: "complete", completed: true })
    expect(events).toEqual([{ type: "complete", completed: true }])
    expect(source.closed).toBe(true)

    source.emit("message", { type: "progress", message: "late" })
    expect(events.length).toBe(1)
  })

  test("unsubscribe closes the stream and stops dispatching", () => {
    MockEventSource.reset()
    const client = createOnboardingClient({ eventSource: MockEventSource })
    const events: OnboardingEvent[] = []

    const dispose = client.subscribe((event) => events.push(event))
    const source = MockEventSource.instances[0]
    dispose()

    expect(source.closed).toBe(true)
    source.emit("message", { type: "progress", message: "after dispose" })
    expect(events.length).toBe(0)

    dispose()
    expect(source.closed).toBe(true)
  })

  test("credentialsFromConnection resolves password, auth_token URL, or null", () => {
    expect(credentialsFromConnection({ password: "secret" })).toEqual({ username: "ellamaka", password: "secret" })
    expect(credentialsFromConnection({ username: "sam", password: "secret" })).toEqual({
      username: "sam",
      password: "secret",
    })

    const token = btoa("ellamaka:secret")
    expect(
      credentialsFromConnection({ url: `http://127.0.0.1:4096?auth_token=${encodeURIComponent(token)}` }),
    ).toEqual({ username: "ellamaka", password: "secret" })

    expect(credentialsFromConnection({ url: "http://127.0.0.1:4096" })).toBe(null)
    expect(credentialsFromConnection(null)).toBe(null)
    expect(credentialsFromConnection(undefined)).toBe(null)
  })
})
