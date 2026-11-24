import { describe, expect, test, spyOn } from "bun:test"
import { createPluginServerFetch } from "../../src/plugin/server-fetch"

describe("plugin host transport", () => {
  test("dispatches embedded requests in-process without touching the network", async () => {
    const received: Request[] = []
    const network = spyOn(globalThis, "fetch")
    try {
      const fetch = createPluginServerFetch(undefined, async (request) => {
        received.push(request)
        return Response.json({ ok: true })
      })
      const response = await fetch("http://opencode.internal/session/ses_x", { method: "POST" })
      expect(response.ok).toBe(true)
      expect(received.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
        ["POST", "/session/ses_x"],
      ])
      expect(network).not.toHaveBeenCalled()
    } finally {
      network.mockRestore()
    }
  })

  test("preserves no-idle-timeout behavior when an HTTP listener is present", async () => {
    const network = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => Response.json({ ok: true }), { preconnect: () => {} }),
    )
    try {
      const fetch = createPluginServerFetch(new URL("http://127.0.0.1:8123"), () => {
        throw new Error("unexpected in-process dispatch")
      })
      const response = await fetch(new Request("http://127.0.0.1:8123/session/ses_x"))
      expect(response.ok).toBe(true)
      expect(network).toHaveBeenCalledTimes(1)
      const request = network.mock.calls[0]?.[0] as Request & { timeout?: boolean }
      expect(request.url).toBe("http://127.0.0.1:8123/session/ses_x")
      expect(request.timeout).toBe(false)
    } finally {
      network.mockRestore()
    }
  })
})
