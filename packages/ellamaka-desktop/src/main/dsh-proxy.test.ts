import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { createDshHttpProxy, createDshProxy, isDshPath } from "./dsh-proxy"

describe("createDshProxy", () => {
  test("forwards the launch-token exchange and reuses its cookie", async () => {
    const requests: Array<{ url: string; headers: Headers }> = []
    const proxy = createDshProxy(async (input, init) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) })
      if (requests.length === 1) {
        return new Response(null, {
          status: 303,
          headers: {
            location: "/dsh/",
            "set-cookie": "dsh_session=authenticated; HttpOnly; SameSite=Strict",
          },
        })
      }
      return new Response("ok")
    })
    proxy.setTarget("http://127.0.0.1:4097")

    const exchange = await proxy.handle(new Request("oc://renderer/dsh/?token=launch-token"))
    const authenticated = await proxy.handle(new Request("oc://renderer/dsh/api/session"))

    expect(exchange?.status).toBe(303)
    expect(exchange?.headers.get("location")).toBe("/dsh/")
    expect(exchange?.headers.get("set-cookie")).toBeNull()
    expect(await authenticated?.text()).toBe("ok")
    expect(requests).toHaveLength(2)
    expect(requests[0]?.url).toBe("http://127.0.0.1:4097/dsh/?token=launch-token")
    expect(requests[0]?.headers.get("origin")).toBe("http://127.0.0.1:4097")
    expect(requests[1]?.headers.get("cookie")).toBe("dsh_session=authenticated")
  })

  test("does not claim non-DSH routes or requests without a target", async () => {
    const proxy = createDshProxy(async () => new Response("unexpected"))

    expect(await proxy.handle(new Request("oc://renderer/index.html"))).toBeUndefined()
    expect(await proxy.handle(new Request("oc://renderer/dsh/"))).toBeUndefined()
  })
})

describe("createDshHttpProxy", () => {
  test("proxies /dsh requests and strips set-cookie into the session jar", async () => {
    // A fake sidecar: serves /dsh/ index and mints a session cookie on the
    // token exchange. WS upgrade forwarding is exercised by the runtime
    // (bun's node:http shim cannot surface 101 upgrades); it is verified in
    // the packaged app under real Node.
    const backend = createServer((req, res) => {
      if (req.url?.startsWith("/dsh/?token=")) {
        res.writeHead(303, { location: "/dsh/", "set-cookie": "dsh_auth=s1; HttpOnly; SameSite=Strict" })
        res.end()
        return
      }
      if (req.url?.startsWith("/dsh/")) {
        res.writeHead(200, { "content-type": "text/html" })
        res.end("<!doctype html><h1>dsh index</h1>")
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve))
    const backendAddr = backend.address()
    const backendPort = typeof backendAddr === "object" && backendAddr ? backendAddr.port : 0

    const proxy = createDshHttpProxy()
    proxy.setTarget(`http://127.0.0.1:${backendPort}`)
    const port = await proxy.listen(0)

    try {
      // Token exchange: the proxy captures the Set-Cookie and returns the 303.
      const exchange = await fetch(`http://127.0.0.1:${port}/dsh/?token=t`, { redirect: "manual" })
      expect(exchange.status).toBe(303)
      expect(exchange.headers.get("set-cookie")).toBeNull()

      // The captured session cookie is replayed on subsequent /dsh requests.
      const res = await fetch(`http://127.0.0.1:${port}/dsh/`)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain("dsh index")
      expect(proxy.cookies.get("dsh_auth")).toBe("dsh_auth=s1")
    } finally {
      proxy.server.close()
      await new Promise<void>((resolve) => backend.close(() => resolve()))
    }
  })
})
