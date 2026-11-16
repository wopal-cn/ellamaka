import { describe, expect, test } from "bun:test"
import { Context } from "@deepseek-ai/cordis"
import { Peer } from "@deepseek-ai/dsh-client-connection"
import { createServer, type Server } from "node:http"
import { once } from "node:events"
import { VirtualWebServer } from "../src/dsh-virtual-webserver"

function makeCtx() {
  return new Context()
}

function makeServer() {
  return createServer()
}

async function listen(server: Server) {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return { baseUrl: `http://127.0.0.1:${port}` }
}

describe("VirtualWebServer RC.3 resource routes", () => {
  test("routes GET and HEAD through the official resource contract without trusting a request Host", async () => {
    const ctx = makeCtx()
    const vws = new VirtualWebServer(ctx, { host: "127.0.0.1", port: 0 })
    const server = makeServer()
    const { baseUrl } = await listen(server)
    vws.attach(server)
    const seen: { method: string; host: string; peer: unknown }[] = []
    const owner = new Peer(ctx, { principal: { kind: "owner" } })
    try {
      vws.register({
        kind: "exact",
        path: "/resource",
        resource: async (request, peer) => {
          seen.push({ method: request.method, host: new URL(request.url).host, peer })
          return new Response("from-official-resource", { status: 201, headers: { "x-resource": "yes" } })
        },
      })
      const response = await fetch(baseUrl + "/resource", { headers: { host: "untrusted.example" } })
      expect(response.status).toBe(201)
      expect(response.headers.get("x-resource")).toBe("yes")
      expect(await response.text()).toBe("from-official-resource")
      expect(seen[0]).toEqual({ method: "GET", host: "x", peer: undefined })

      const head = await fetch(baseUrl + "/resource", { method: "HEAD" })
      expect(head.status).toBe(201)
      expect(await head.text()).toBe("")
      const rejected = await fetch(baseUrl + "/resource", { method: "POST" })
      expect(rejected.status).toBe(405)
      expect(rejected.headers.get("allow")).toContain("GET")

      const inProcess = await vws.readResource(new Request("http://x/resource"), owner)
      expect(inProcess.status).toBe(201)
      expect(await inProcess.text()).toBe("from-official-resource")
      expect(seen.at(-1)?.peer).toBe(owner)
      expect((await vws.readResource(new Request("http://x/missing"), owner)).status).toBe(404)
      expect((await vws.readResource(new Request("http://x/resource", { method: "POST" }), owner)).status).toBe(405)
    } finally {
      await owner.dispose()
      vws.dispose()
      server.close()
    }
  })

  test("resource fallback serves HTTP and admitted in-process peers, not unmatched handler-only reads", async () => {
    const ctx = makeCtx()
    const vws = new VirtualWebServer(ctx, { host: "127.0.0.1", port: 0 })
    const server = makeServer()
    const { baseUrl } = await listen(server)
    vws.attach(server)
    const owner = new Peer(ctx, { principal: { kind: "owner" } })
    try {
      vws.registerFallback({ resource: async (_request, peer) => new Response(peer ? "peer" : "browser") })
      expect(await (await fetch(baseUrl + "/missing")).text()).toBe("browser")
      expect(await (await vws.readResource(new Request("http://x/missing"), owner)).text()).toBe("peer")
      vws.register({ kind: "exact", path: "/handler", handler: (_req, res) => res.end("handler") })
      expect((await vws.readResource(new Request("http://x/handler"), owner)).status).toBe(404)
    } finally {
      await owner.dispose()
      vws.dispose()
      server.close()
    }
  })
})
