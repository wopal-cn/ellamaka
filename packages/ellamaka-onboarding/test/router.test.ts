import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { createServer, request as httpRequest, type IncomingMessage } from "node:http"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { AddressInfo } from "node:net"

import { checkOnboardingAuth } from "../src/auth"
import { createOnboardingRouter } from "../src/router"
import { mountOnboarding } from "../src/mount"
import { OnboardingService } from "../src/service"
import { ONBOARDING_OPERATION_BUSY, type NodeRouteMount, type OnboardingStepResult } from "../src/types"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tempHome(): string {
  return join(tmpdir(), `ellamaka-onboarding-router-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

interface TestHost {
  origin: string
  mount: NodeRouteMount
  stop: () => Promise<void>
}

/**
 * A lightweight host that mimics the opencode dispatcher: it matches the
 * mounted prefix by pathname boundary and strips it before invoking the
 * mount's request handler.
 */
async function startHost(mount: NodeRouteMount): Promise<TestHost> {
  const host = createServer((req, res) => {
    if (req.url === mount.prefix || (req.url?.startsWith(mount.prefix + "/") ?? false)) {
      req.url = (req.url ?? "/").slice(mount.prefix.length) || "/"
      void Promise.resolve(mount.request(req, res)).catch(() => {
        if (!res.headersSent) res.writeHead(500)
        if (!res.writableEnded) res.end()
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve))
  const { port } = host.address() as AddressInfo

  return {
    origin: `http://127.0.0.1:${port}`,
    mount,
    stop: () => new Promise<void>((resolve, reject) => host.close((err) => (err ? reject(err) : resolve()))),
  }
}

/** Build the router mount directly from an injected service. */
function routerMount(service: OnboardingService, options: { serverPassword?: string } = {}): NodeRouteMount {
  const router = createOnboardingRouter(service, options)
  return { prefix: "/api/onboarding", auth: "self", request: (req, res) => router.request(req, res) }
}

interface HttpResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
  json: () => any
}

function send(
  origin: string,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const payload =
      options.body === undefined
        ? undefined
        : typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body)
    const req = httpRequest(
      `${origin}${path}`,
      {
        method,
        headers: {
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) }
            : {}),
          ...options.headers,
        },
      },
      (res) => {
        let body = ""
        res.setEncoding("utf-8")
        res.on("data", (chunk) => (body += chunk))
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body),
          }),
        )
      },
    )
    req.on("error", reject)
    if (payload) req.write(payload)
    req.end()
  })
}

const authHeader = (user: string, password: string) => `Basic ${btoa(`${user}:${password}`)}`

/** A fake IncomingMessage exposing just the fields the auth check reads. */
function fakeRequest(input: { remoteAddress?: string; authorization?: string; url?: string }): IncomingMessage {
  return {
    headers: input.authorization ? { authorization: input.authorization } : {},
    socket: { remoteAddress: input.remoteAddress },
    url: input.url ?? "/state",
  } as unknown as IncomingMessage
}

/** An executor that resolves only when the returned release function is called. */
function gatedExecutor(): {
  executor: () => Promise<OnboardingStepResult>
  started: Promise<void>
  release: () => void
} {
  let release!: () => void
  const gate = new Promise<OnboardingStepResult>((resolve) => {
    release = () => resolve({ status: "completed" })
  })
  let signalStarted!: () => void
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve
  })
  return {
    executor: async () => {
      signalStarted()
      return gate
    },
    started,
    release,
  }
}

let testHome: string

beforeEach(() => {
  testHome = tempHome()
  mkdirSync(testHome, { recursive: true })
})

afterEach(() => {
  if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// HTTP API contract
// ---------------------------------------------------------------------------

describe("onboarding router endpoints", () => {
  test("GET /state returns the onboarding state view", async () => {
    const host = await startHost(routerMount(new OnboardingService({ home: testHome })))
    try {
      const res = await send(host.origin, "GET", "/api/onboarding/state")
      expect(res.status).toBe(200)
      expect(res.json()).toEqual({ completed: false, currentStep: "system-check", completedSteps: [] })
    } finally {
      await host.stop()
    }
  })

  test("POST /execute runs the step and returns the StepResult body", async () => {
    const service = new OnboardingService({
      home: testHome,
      executeStep: async () => ({ status: "completed", result: { ok: true } }),
    })
    const host = await startHost(routerMount(service))
    try {
      const res = await send(host.origin, "POST", "/api/onboarding/execute", {
        body: { step: "system-check", input: { customHomePath: testHome } },
      })
      expect(res.status).toBe(200)
      expect(res.json()).toEqual({ status: "completed", result: { ok: true } })
    } finally {
      await host.stop()
    }
  })

  test("POST /execute with an invalid step body returns 400", async () => {
    const host = await startHost(routerMount(new OnboardingService({ home: testHome })))
    try {
      const res = await send(host.origin, "POST", "/api/onboarding/execute", { body: { input: {} } })
      expect(res.status).toBe(400)
      expect(res.json().error.code).toBe("ONBOARDING_REQUEST_INVALID")
    } finally {
      await host.stop()
    }
  })

  test("POST /execute while busy returns 503 ONBOARDING_OPERATION_BUSY", async () => {
    const gated = gatedExecutor()
    const service = new OnboardingService({ home: testHome, executeStep: gated.executor })
    service.events.on("error", () => {})
    const host = await startHost(routerMount(service))
    try {
      const first = send(host.origin, "POST", "/api/onboarding/execute", { body: { step: "system-check" } })
      await gated.started

      const busy = await send(host.origin, "POST", "/api/onboarding/execute", { body: { step: "install-cli" } })
      expect(busy.status).toBe(503)
      expect(busy.json().error.code).toBe(ONBOARDING_OPERATION_BUSY)

      gated.release()
      expect((await first).status).toBe(200)
    } finally {
      await host.stop()
    }
  })

  test("POST /probe returns 200 with the probe payload", async () => {
    const host = await startHost(routerMount(new OnboardingService({ home: testHome })))
    try {
      const res = await send(host.origin, "POST", "/api/onboarding/probe", { body: { kind: "home" } })
      expect(res.status).toBe(200)
      expect(res.json()).toEqual({ homePath: testHome, wopalHome: testHome })
    } finally {
      await host.stop()
    }
  })

  test("POST /probe while busy returns 503 ONBOARDING_OPERATION_BUSY", async () => {
    const gated = gatedExecutor()
    const service = new OnboardingService({ home: testHome, executeStep: gated.executor })
    const host = await startHost(routerMount(service))
    try {
      const first = send(host.origin, "POST", "/api/onboarding/execute", { body: { step: "system-check" } })
      await gated.started

      const busy = await send(host.origin, "POST", "/api/onboarding/probe", { body: { kind: "home" } })
      expect(busy.status).toBe(503)
      expect(busy.json().error.code).toBe(ONBOARDING_OPERATION_BUSY)

      gated.release()
      await first
    } finally {
      await host.stop()
    }
  })

  test("POST /cancel returns { ok: true }", async () => {
    const host = await startHost(routerMount(new OnboardingService({ home: testHome })))
    try {
      const res = await send(host.origin, "POST", "/api/onboarding/cancel")
      expect(res.status).toBe(200)
      expect(res.json()).toEqual({ ok: true })
    } finally {
      await host.stop()
    }
  })

  test("POST /complete returns { completed: true } and triggers onComplete", async () => {
    let completed = 0
    const service = new OnboardingService({ home: testHome, onComplete: () => void (completed += 1) })
    const host = await startHost(routerMount(service))
    try {
      const res = await send(host.origin, "POST", "/api/onboarding/complete")
      expect(res.status).toBe(200)
      expect(res.json()).toEqual({ completed: true })
      expect(completed).toBe(1)

      const state = await send(host.origin, "GET", "/api/onboarding/state")
      expect(state.json().completed).toBe(true)
    } finally {
      await host.stop()
    }
  })

  test("an unknown path under the prefix returns 404", async () => {
    const host = await startHost(routerMount(new OnboardingService({ home: testHome })))
    try {
      const res = await send(host.origin, "GET", "/api/onboarding/nope")
      expect(res.status).toBe(404)
    } finally {
      await host.stop()
    }
  })

  test("a wrong method on a known path returns 405", async () => {
    const host = await startHost(routerMount(new OnboardingService({ home: testHome })))
    try {
      expect((await send(host.origin, "GET", "/api/onboarding/execute")).status).toBe(405)
      expect((await send(host.origin, "POST", "/api/onboarding/state")).status).toBe(405)
    } finally {
      await host.stop()
    }
  })

  test("invalid JSON in the request body returns 400", async () => {
    const host = await startHost(routerMount(new OnboardingService({ home: testHome })))
    try {
      const res = await send(host.origin, "POST", "/api/onboarding/execute", { body: "{bad json" })
      expect(res.status).toBe(400)
    } finally {
      await host.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// SSE stream
// ---------------------------------------------------------------------------

describe("onboarding SSE stream", () => {
  test("GET /stream emits progress frames as text/event-stream", async () => {
    const service = new OnboardingService({
      home: testHome,
      executeStep: async (_step, _input, onProgress) => {
        onProgress?.({ message: "halfway" })
        return { status: "completed", result: {} }
      },
    })
    const host = await startHost(routerMount(service))
    const controller = new AbortController()
    try {
      const response = await fetch(`${host.origin}/api/onboarding/stream`, { signal: controller.signal })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/event-stream")

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      const execute = send(host.origin, "POST", "/api/onboarding/execute", { body: { step: "system-check" } })

      let buffered = ""
      let sawProgress = false
      const deadline = Date.now() + 3000
      while (Date.now() < deadline && !sawProgress) {
        const { value, done } = await reader.read()
        if (done) break
        buffered += decoder.decode(value, { stream: true })
        sawProgress = buffered.includes('"type":"progress"')
      }

      expect(sawProgress).toBe(true)
      expect(buffered).toContain("data: ")
      expect(buffered).toContain('"step":"system-check"')

      controller.abort()
      await execute.catch(() => {})
    } finally {
      controller.abort()
      await host.stop()
    }
  })

  test("POST /complete delivers a complete frame over an open stream and ends it", async () => {
    const service = new OnboardingService({ home: testHome })
    const host = await startHost(routerMount(service))
    const controller = new AbortController()
    try {
      const response = await fetch(`${host.origin}/api/onboarding/stream`, { signal: controller.signal })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()

      const complete = await send(host.origin, "POST", "/api/onboarding/complete")
      expect(complete.json()).toEqual({ completed: true })

      let buffered = ""
      let sawComplete = false
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        buffered += decoder.decode(value, { stream: true })
        if (buffered.includes('"type":"complete"')) {
          sawComplete = true
          break
        }
      }

      expect(sawComplete).toBe(true)
      expect(buffered).toContain('"completed":true')

      // The router closes the stream right after writing the frame, so the
      // next read observes the end rather than a keep-alive heartbeat.
      const tail = await reader.read()
      expect(tail.done).toBe(true)
    } finally {
      controller.abort()
      await host.stop()
    }
  })

  test("a client disconnect releases the stream and leaves the service usable", async () => {
    const host = await startHost(routerMount(new OnboardingService({ home: testHome })))
    try {
      const controller = new AbortController()
      const response = await fetch(`${host.origin}/api/onboarding/stream`, { signal: controller.signal })
      expect(response.status).toBe(200)
      controller.abort()
      await new Promise((resolve) => setTimeout(resolve, 50))

      const listeners = host.mount ? undefined : undefined
      void listeners
      const res = await send(host.origin, "GET", "/api/onboarding/state")
      expect(res.status).toBe(200)
    } finally {
      await host.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe("onboarding auth middleware", () => {
  test("loopback requests without credentials are allowed when no password is set", () => {
    const result = checkOnboardingAuth(fakeRequest({ remoteAddress: "127.0.0.1" }), { serverPassword: undefined })
    expect(result).toEqual({ ok: true })
  })

  test("loopback requests without credentials are rejected with 401 when a password is set", () => {
    const result = checkOnboardingAuth(fakeRequest({ remoteAddress: "127.0.0.1" }), { serverPassword: "secret" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })

  test("a valid Basic credential is accepted", () => {
    const result = checkOnboardingAuth(
      fakeRequest({ remoteAddress: "127.0.0.1", authorization: authHeader("ellamaka", "secret") }),
      { serverPassword: "secret" },
    )
    expect(result).toEqual({ ok: true })
  })

  test("a valid Bearer token is accepted", () => {
    const result = checkOnboardingAuth(fakeRequest({ remoteAddress: "10.0.0.5", authorization: "Bearer secret" }), {
      serverPassword: "secret",
    })
    expect(result).toEqual({ ok: true })
  })

  test("a wrong password is rejected with 401", () => {
    const result = checkOnboardingAuth(
      fakeRequest({ remoteAddress: "127.0.0.1", authorization: authHeader("ellamaka", "wrong") }),
      { serverPassword: "secret" },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(401)
  })

  test("a non-loopback request without a password is blocked with 403 SECURITY_BLOCK", () => {
    const result = checkOnboardingAuth(fakeRequest({ remoteAddress: "10.0.0.5" }), { serverPassword: undefined })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.code).toBe("SECURITY_BLOCK")
    }
  })

  test("IPv4-mapped loopback is recognized as loopback", () => {
    const result = checkOnboardingAuth(fakeRequest({ remoteAddress: "::ffff:127.0.0.1" }), {
      serverPassword: undefined,
    })
    expect(result).toEqual({ ok: true })
  })

  test("an auth_token query credential is accepted", () => {
    const result = checkOnboardingAuth(
      fakeRequest({ remoteAddress: "10.0.0.5", url: `/state?auth_token=${btoa("ellamaka:secret")}` }),
      {
        serverPassword: "secret",
      },
    )
    expect(result).toEqual({ ok: true })
  })

  test("HTTP endpoints enforce authentication end to end", async () => {
    const host = await startHost(routerMount(new OnboardingService({ home: testHome }), { serverPassword: "secret" }))
    try {
      const anonymous = await send(host.origin, "GET", "/api/onboarding/state")
      expect(anonymous.status).toBe(401)

      const authorized = await send(host.origin, "GET", "/api/onboarding/state", {
        headers: { Authorization: authHeader("ellamaka", "secret") },
      })
      expect(authorized.status).toBe(200)
    } finally {
      await host.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// mountOnboarding
// ---------------------------------------------------------------------------

describe("mountOnboarding", () => {
  test("mounts an /api/onboarding prefix with auth self and returns a working disposer", () => {
    const mounted: NodeRouteMount[] = []
    const server = {
      mountNodeRoute(mount: NodeRouteMount): () => void {
        mounted.push(mount)
        return () => {
          const index = mounted.indexOf(mount)
          if (index !== -1) mounted.splice(index, 1)
        }
      },
    }

    const dispose = mountOnboarding(server, { home: testHome })
    expect(mounted.length).toBe(1)
    expect(mounted[0]!.prefix).toBe("/api/onboarding")
    expect(mounted[0]!.auth).toBe("self")
    expect(typeof mounted[0]!.request).toBe("function")

    dispose()
    expect(mounted.length).toBe(0)
  })

  test("honors a custom prefix", () => {
    const mounted: NodeRouteMount[] = []
    const server = {
      mountNodeRoute(mount: NodeRouteMount): () => void {
        mounted.push(mount)
        return () => {
          const index = mounted.indexOf(mount)
          if (index !== -1) mounted.splice(index, 1)
        }
      },
    }

    const dispose = mountOnboarding(server, { home: testHome, prefix: "/custom/onboarding" })
    expect(mounted[0]!.prefix).toBe("/custom/onboarding")
    dispose()
  })

  test("the mounted surface serves requests through a host dispatcher", async () => {
    let mounted: NodeRouteMount | undefined
    const server = {
      mountNodeRoute(mount: NodeRouteMount): () => void {
        mounted = mount
        return () => {
          mounted = undefined
        }
      },
    }

    const host = createServer((req, res) => {
      if (!mounted) {
        res.writeHead(404)
        res.end()
        return
      }
      req.url = (req.url ?? "/").slice(mounted.prefix.length) || "/"
      void Promise.resolve(mounted.request(req, res))
    })
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve))
    const { port } = host.address() as AddressInfo

    mountOnboarding(server, { home: testHome })
    try {
      const res = await send(`http://127.0.0.1:${port}`, "GET", "/api/onboarding/state")
      expect(res.status).toBe(200)
      expect(res.json()).toEqual({ completed: false, currentStep: "system-check", completedSteps: [] })
    } finally {
      await new Promise<void>((resolve) => host.close(() => resolve()))
    }
  })
})
