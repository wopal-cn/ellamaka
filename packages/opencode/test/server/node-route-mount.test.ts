import { describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { once } from "node:events"
import { connect } from "node:net"
import { installDispatcher, matchMount, stripPrefix, type NodeRouteMount } from "../../src/server/node-route-mount"

async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return { server, port, baseUrl: `http://127.0.0.1:${port}` }
}

async function get(baseUrl: string, path: string) {
  const res = await fetch(baseUrl + path)
  return { status: res.status, body: await res.text() }
}

describe("node route mount pure helpers", () => {
  test("matchMount matches exact prefix and prefix/... but not prefixx", () => {
    const mounts: NodeRouteMount[] = [{ prefix: "/dsh", request: () => {} }]
    expect(matchMount(mounts, "/dsh")).toBe(mounts[0])
    expect(matchMount(mounts, "/dsh/api/x?q=1")).toBe(mounts[0])
    expect(matchMount(mounts, "/dshx")).toBeUndefined()
    expect(matchMount(mounts, "/api/x")).toBeUndefined()
    expect(matchMount(mounts, undefined)).toBeUndefined()
  })

  test("stripPrefix strips the prefix and preserves the query", () => {
    expect(stripPrefix("/dsh", "/dsh")).toBe("/")
    expect(stripPrefix("/dsh/api/x?q=1", "/dsh")).toBe("/api/x?q=1")
    expect(stripPrefix("/dsh/api/events.mux", "/dsh")).toBe("/api/events.mux")
  })
})

describe("node route mount dispatcher", () => {
  test("routes /dsh to the mounted handler with stripped url and preserves query", async () => {
    const { server, baseUrl } = await startServer((req, res) => {
      res.writeHead(200)
      res.end("base:" + req.url)
    })
    const dispatcher = installDispatcher(server)
    const seen: string[] = []
    dispatcher.mount({
      prefix: "/dsh",
      request: (req, res) => {
        seen.push(req.url!)
        res.writeHead(200)
        res.end("mounted:" + req.url)
      },
    })

    expect((await get(baseUrl, "/dsh")).body).toBe("mounted:/")
    expect((await get(baseUrl, "/dsh/api/x?q=1")).body).toBe("mounted:/api/x?q=1")
    expect(seen).toEqual(["/", "/api/x?q=1"])

    server.close()
  })

  test("non-matching paths fall through to the base handler in order", async () => {
    const { server, baseUrl } = await startServer((req, res) => {
      res.writeHead(200)
      res.end("base:" + req.url)
    })
    const dispatcher = installDispatcher(server)
    dispatcher.mount({
      prefix: "/dsh",
      request: (req, res) => {
        res.writeHead(200)
        res.end("mounted")
      },
    })

    expect((await get(baseUrl, "/dshx")).body).toBe("base:/dshx")
    expect((await get(baseUrl, "/api/x")).body).toBe("base:/api/x")

    server.close()
  })

  test("disposer removes the mount and paths return to the base handler", async () => {
    const { server, baseUrl } = await startServer((req, res) => {
      res.writeHead(200)
      res.end("base:" + req.url)
    })
    const dispatcher = installDispatcher(server)
    const dispose = dispatcher.mount({
      prefix: "/dsh",
      request: (req, res) => {
        res.writeHead(200)
        res.end("mounted")
      },
    })

    expect((await get(baseUrl, "/dsh/x")).body).toBe("mounted")
    dispose()
    expect((await get(baseUrl, "/dsh/x")).body).toBe("base:/dsh/x")

    server.close()
  })

  test("mounted handler rejection terminates the request safely without double-write", async () => {
    const { server, baseUrl } = await startServer((req, res) => {
      res.writeHead(200)
      res.end("base")
    })
    const dispatcher = installDispatcher(server)
    dispatcher.mount({
      prefix: "/dsh",
      request: () => {
        throw new Error("boom")
      },
    })

    const res = await fetch(baseUrl + "/dsh")
    expect(res.status).toBe(500)
    await res.text()

    server.close()
  })

  test("upgrade /dsh/... routes to the mounted upgrade handler with stripped url", async () => {
    const { server, port } = await startServer((req, res) => {
      res.writeHead(200)
      res.end("base")
    })
    const dispatcher = installDispatcher(server)
    const seen: string[] = []
    dispatcher.mount({
      prefix: "/dsh",
      request: (req, res) => {
        res.writeHead(200)
        res.end("mounted")
      },
      upgrade: (req, socket) => {
        seen.push(req.url!)
        socket.end()
      },
    })

    const socket = connect(port, "127.0.0.1")
    socket.write(
      "GET /dsh/api/events.mux HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "\r\n",
    )
    await once(socket, "close")
    expect(seen).toEqual(["/api/events.mux"])

    server.close()
  })
})
