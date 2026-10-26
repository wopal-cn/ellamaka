import { describe, expect, test } from "bun:test"
import { ServerConnection } from "@/context/server"
import { checkServerHealth, resolveServerHealthKey } from "./server-health"

const server: ServerConnection.HttpBase = {
  url: "http://localhost:4096",
}

function abortFromInput(input: RequestInfo | URL, init?: RequestInit) {
  if (init?.signal) return init.signal
  if (input instanceof Request) return input.signal
  return undefined
}

function mockFetch(run: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return Object.assign(run, { preconnect: globalThis.fetch.preconnect }) satisfies typeof globalThis.fetch
}

describe("checkServerHealth", () => {
  test("returns healthy response with version", async () => {
    const fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ healthy: true, version: "1.2.3" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )

    const result = await checkServerHealth(server, fetch)

    expect(result).toEqual({ healthy: true, version: "1.2.3" })
  })

  test("preserves the Wopal CLI handshake status", async () => {
    const fetch = mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            healthy: true,
            version: "1.2.3",
            cli: {
              state: "incompatible",
              requiredVersion: "0.3.4",
              actualVersion: "0.3.3",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    )

    const result = await checkServerHealth(server, fetch)

    expect(result).toEqual({
      healthy: true,
      version: "1.2.3",
      cli: {
        state: "incompatible",
        requiredVersion: "0.3.4",
        actualVersion: "0.3.3",
      },
    })
  })

  test("preserves the dsh runtime status when the server reports it", async () => {
    const fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ healthy: true, version: "1.2.3", dsh: { web: "ready", tools: "degraded" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )

    const result = await checkServerHealth(server, fetch)

    expect(result).toEqual({ healthy: true, version: "1.2.3", dsh: { web: "ready", tools: "degraded" } })
  })

  test("omits the dsh flag when the server does not report it", async () => {
    const fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ healthy: true, version: "1.2.3" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )

    const result = await checkServerHealth(server, fetch)

    expect(result).toEqual({ healthy: true, version: "1.2.3" })
  })

  test("returns unhealthy when request fails", async () => {
    const fetch = mockFetch(async () => {
      throw new Error("network")
    })

    const result = await checkServerHealth(server, fetch)

    expect(result).toEqual({ healthy: false })
  })

  test("uses timeout fallback when AbortSignal.timeout is unavailable", async () => {
    const timeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: undefined,
    })

    let aborted = false
    const fetch = mockFetch(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = abortFromInput(input, init)
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true
              reject(new DOMException("Aborted", "AbortError"))
            },
            { once: true },
          )
        }),
    )

    const result = await checkServerHealth(server, fetch, {
      timeoutMs: 10,
    }).finally(() => {
      if (timeout) Object.defineProperty(AbortSignal, "timeout", timeout)
      if (!timeout) Reflect.deleteProperty(AbortSignal, "timeout")
    })

    expect(aborted).toBe(true)
    expect(result).toEqual({ healthy: false })
  })

  test("uses provided abort signal", async () => {
    let signal: AbortSignal | undefined
    const fetch = mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      signal = abortFromInput(input, init)
      return new Response(JSON.stringify({ healthy: true, version: "1.2.3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })

    const abort = new AbortController()
    await checkServerHealth(server, fetch, {
      signal: abort.signal,
    })

    expect(signal).toBe(abort.signal)
  })

  test("retries transient failures and eventually succeeds", async () => {
    let count = 0
    const fetch = mockFetch(async () => {
      count += 1
      if (count < 3) throw new TypeError("network")
      return new Response(JSON.stringify({ healthy: true, version: "1.2.3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })

    const result = await checkServerHealth(server, fetch, {
      retryCount: 2,
      retryDelayMs: 1,
    })

    expect(count).toBe(3)
    expect(result).toEqual({ healthy: true, version: "1.2.3" })
  })

  test("returns unhealthy when retries are exhausted", async () => {
    let count = 0
    const fetch = mockFetch(async () => {
      count += 1
      throw new TypeError("network")
    })

    const result = await checkServerHealth(server, fetch, {
      retryCount: 2,
      retryDelayMs: 1,
    })

    expect(count).toBe(3)
    expect(result).toEqual({ healthy: false })
  })
})

describe("resolveServerHealthKey", () => {
  test("uses the concrete sidecar generation key instead of the symbolic default", () => {
    const sidecar: ServerConnection.Sidecar = {
      type: "sidecar",
      variant: "base",
      generation: 2,
      http: { url: "http://127.0.0.1:4097" },
    }
    expect(resolveServerHealthKey(ServerConnection.Key.make("sidecar"), sidecar)).toBe(
      ServerConnection.Key.make("http://127.0.0.1:4097#gen2"),
    )
  })

  test("keeps the selected key while no connection is resolved", () => {
    expect(resolveServerHealthKey(ServerConnection.Key.make("sidecar"))).toBe(ServerConnection.Key.make("sidecar"))
  })
})
