import { describe, expect, test } from "bun:test"
import { Context } from "@deepseek-ai/cordis"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { once } from "node:events"
import { connect } from "node:net"
import { Duplex } from "node:stream"
import { VirtualWebServer, type VirtualWebServerOptions } from "../src/dsh-virtual-webserver"

/** A minimal cordis context with an emit/on pair for index-inject. */
function makeCtx() {
  return new Context()
}

function makeServer() {
  const server = createServer()
  return server
}

async function listen(server: Server) {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return { port, baseUrl: `http://127.0.0.1:${port}` }
}

async function get(baseUrl: string, path: string) {
  const res = await fetch(baseUrl + path)
  return { status: res.status, body: await res.text() }
}

/** Run a browser script in an isolated VM with fake fetch/WebSocket/EventSource. */
function runInIsolatedVm(script: string, calls: { fetch: unknown[]; ws: unknown[]; es: unknown[] }) {
  const sandbox = {
    fetch: (...args: unknown[]) => {
      calls.fetch.push(args)
      return Promise.resolve({ ok: true })
    },
    WebSocket: class {
      constructor(...args: unknown[]) {
        calls.ws.push(args)
      }
    },
    EventSource: class {
      constructor(...args: unknown[]) {
        calls.es.push(args)
      }
    },
    console,
  }
  const vm = require("node:vm")
  vm.runInNewContext(script, sandbox)
  return sandbox
}

describe("VirtualWebServer route matching", () => {
  test("exact wins over prefix; longest prefix wins among prefixes", async () => {
    const ctx = makeCtx()
    const vws = new VirtualWebServer(ctx, { host: "127.0.0.1", port: 0 })
    const server = makeServer()
    const { baseUrl } = await listen(server)
    vws.attach(server)

    const seen: string[] = []
    vws.register({ kind: "exact", path: "/api/x", handler: (req, res) => { seen.push("exact"); res.writeHead(200); res.end("exact") } })
    vws.register({ kind: "prefix", path: "/api", handler: (req, res) => { seen.push("prefix-api"); res.writeHead(200); res.end("prefix-api") } })
    vws.register({ kind: "prefix", path: "/api/x", handler: (req, res) => { seen.push("prefix-x"); res.writeHead(200); res.end("prefix-x") } })

    expect((await get(baseUrl, "/api/x")).body).toBe("exact")
    expect((await get(baseUrl, "/api/y")).body).toBe("prefix-api")
    expect((await get(baseUrl, "/api/x/y")).body).toBe("prefix-x")

    server.close()
  })

  test("no route falls back; no fallback returns 404", async () => {
    const ctx = makeCtx()
    const vws = new VirtualWebServer(ctx, { host: "127.0.0.1", port: 0 })
    const server = makeServer()
    const { baseUrl } = await listen(server)
    vws.attach(server)

    expect((await get(baseUrl, "/nope")).status).toBe(404)

    vws.registerFallback((req, res) => { res.writeHead(200); res.end("fallback") })
    expect((await get(baseUrl, "/nope")).body).toBe("fallback")

    server.close()
  })

  test("duplicate route/upgrade/fallback throws like the official WebServer", () => {
    const ctx = makeCtx()
    const vws = new VirtualWebServer(ctx, { host: "127.0.0.1", port: 0 })
    vws.register({ kind: "exact", path: "/a", handler: () => {} })
    expect(() => vws.register({ kind: "exact", path: "/a", handler: () => {} })).toThrow(/duplicate exact route/)
    vws.registerUpgrade({ path: "/up", handler: () => {} })
    expect(() => vws.registerUpgrade({ path: "/up", handler: () => {} })).toThrow(/duplicate upgrade route/)
    vws.registerFallback(() => {})
    expect(() => vws.registerFallback(() => {})).toThrow(/fallback already registered/)
  })
})

describe("VirtualWebServer index taps", () => {
  test("applyIndexTaps runs taps in registration order; dispose removes one", () => {
    const ctx = makeCtx()
    const vws = new VirtualWebServer(ctx, { host: "127.0.0.1", port: 0 })
    const disposeA = vws.tapIndex((html) => html + "A")
    vws.tapIndex((html) => html + "B")
    expect(vws.applyIndexTaps("x")).toBe("xAB")
    disposeA()
    expect(vws.applyIndexTaps("x")).toBe("xB")
  })

  test("renderIndex renders index-inject rows first, then raw taps; __DSH_BOOT__ preserved", () => {
    const ctx = makeCtx()
    ctx.on("webserver/index-inject", (table: unknown[]) => {
      table.push({ kind: "script", placement: "head", text: "window.__DSH_BOOT__ = {x:1}" })
    })
    const vws = new VirtualWebServer(ctx, { host: "127.0.0.1", port: 0 })
    vws.tapIndex((html) => html + "<!--tap-->")
    const html = "<html><head></head><body></body></html>"
    const out = vws.renderIndex(html)
    expect(out).toContain("window.__DSH_BOOT__")
    expect(out).toContain("<!--tap-->")
    // injection lands before the tap
    expect(out.indexOf("__DSH_BOOT__")).toBeLessThan(out.indexOf("<!--tap-->"))
  })
})

describe("VirtualWebServer index static rewrite", () => {
  test("rewrites /assets, /favicon.svg, /plugins to /dsh and removes manifest link", () => {
    const ctx = makeCtx()
    const vws = new VirtualWebServer(ctx, { host: "127.0.0.1", port: 0 })
    const html = `<!doctype html><html><head>
      <link rel="manifest" href="/manifest.webmanifest" />
      <link rel="icon" href="/favicon.svg" />
      <script type="module" src="/assets/index.js"></script>
      <link rel="stylesheet" href="/assets/index.css">
    </head><body></body></html>`
    const out = vws.rewriteIndex(html)
    expect(out).not.toContain("manifest.webmanifest")
    expect(out).toContain('href="/dsh/favicon.svg"')
    expect(out).toContain('src="/dsh/assets/index.js"')
    expect(out).toContain('href="/dsh/assets/index.css"')
  })
})

describe("VirtualWebServer iframe prefix adaptation", () => {
  test("fetch /api/x -> /dsh/api/x; WebSocket /api/events.mux -> /dsh/api/events.mux; EventSource /plugins/events -> /dsh/plugins/events", () => {
    const ctx = makeCtx()
    const vws = new VirtualWebServer(ctx, { host: "127.0.0.1", port: 0 })
    const calls = { fetch: [], ws: [], es: [] }
    const script = vws.iframeAdapterScript()
    runInIsolatedVm(script, calls)
    // The adapter installs wrappers; drive them by evaluating the wrapped calls.
    const sandbox = runInIsolatedVm(
      script +
        `;fetch("/api/x"); new WebSocket("/api/events.mux"); new EventSource("/plugins/events");`,
      calls,
    )
    expect(calls.fetch[0][0]).toBe("/dsh/api/x")
    expect(calls.ws[0][0]).toBe("/dsh/api/events.mux")
    expect(calls.es[0][0]).toBe("/dsh/plugins/events")
  })

  test("external URLs and existing /dsh URLs stay unchanged", () => {
    const ctx = makeCtx()
    const vws = new VirtualWebServer(ctx, { host: "127.0.0.1", port: 0 })
    const calls = { fetch: [], ws: [], es: [] }
    const script = vws.iframeAdapterScript()
    runInIsolatedVm(
      script +
        `;fetch("https://example.com/x"); fetch("/dsh/api/y"); new WebSocket("wss://example.com/ws"); new EventSource("/dsh/plugins/events");`,
      calls,
    )
    expect(calls.fetch[0][0]).toBe("https://example.com/x")
    expect(calls.fetch[1][0]).toBe("/dsh/api/y")
    expect(calls.ws[0][0]).toBe("wss://example.com/ws")
    expect(calls.es[0][0]).toBe("/dsh/plugins/events")
  })

  test("prefix matching is boundary-exact: /dsh-market/* and /dshm/* are NOT treated as already-prefixed", () => {
    const ctx = makeCtx()
    const vws = new VirtualWebServer(ctx, { host: "127.0.0.1", port: 0 })
    const calls = { fetch: [], ws: [], es: [] }
    const script = vws.iframeAdapterScript()
    runInIsolatedVm(
      script +
        `;fetch("/dsh-market/registry"); fetch("/dshm-webdav"); fetch("/dsh"); fetch("/dsh/exact");`,
      calls,
    )
    // Sibling paths sharing the "/dsh" character prefix must be prefixed too —
    // a bare startsWith("/dsh") swallowed the market catalog (HTTP 404 in the
    // iframe) by treating /dsh-market/* as already mounted.
    expect(calls.fetch[0][0]).toBe("/dsh/dsh-market/registry")
    expect(calls.fetch[1][0]).toBe("/dsh/dshm-webdav")
    expect(calls.fetch[2][0]).toBe("/dsh")
    expect(calls.fetch[3][0]).toBe("/dsh/exact")
  })

  test("same-origin absolute URLs (RPC + WebSocket) are adapted to the /dsh prefix", () => {
    const ctx = makeCtx()
    const vws = new VirtualWebServer(ctx, { host: "127.0.0.1", port: 0 })
    const script = vws.iframeAdapterScript()
    const calls = { fetch: [], ws: [], es: [] }
    const sandbox = {
      location: { origin: "http://localhost:4097" },
      URL,
      fetch: (...args: unknown[]) => { calls.fetch.push(args); return Promise.resolve({ ok: true }) },
      WebSocket: class { constructor(...args: unknown[]) { calls.ws.push(args) } },
      EventSource: class { constructor(...args: unknown[]) { calls.es.push(args) } },
      console,
    }
    const vm = require("node:vm")
    vm.runInNewContext(
      script +
        `;fetch("http://localhost:4097/api/host.describe", { method: "POST" }); new WebSocket("ws://localhost:4097/api/events.mux"); new WebSocket("ws://localhost:4097/dsh/api/events.mux"); fetch(new URL("/api/events.mux", "http://localhost:4097"));`,
      sandbox,
    )
    expect(calls.fetch[0][0]).toBe("http://localhost:4097/dsh/api/host.describe")
    expect(calls.ws[0][0]).toBe("ws://localhost:4097/dsh/api/events.mux")
    expect(calls.ws[1][0]).toBe("ws://localhost:4097/dsh/api/events.mux")
    expect(String(calls.fetch[1][0])).toBe("http://localhost:4097/dsh/api/events.mux")
  })

  test("dynamically loaded plugin script bundles are adapted to /dsh", () => {
    const ctx = makeCtx()
    const vws = new VirtualWebServer(ctx, { host: "127.0.0.1", port: 0 })
    const script = vws.iframeAdapterScript()
    const created: Array<Record<string, unknown>> = []
    // Model an HTMLScriptElement prototype carrying a native src accessor.
    const scriptProto = {}
    Object.defineProperty(scriptProto, "src", {
      get() { return this.__src },
      set(v) { this.__src = v },
      configurable: true,
    })
    function makeEl() {
      const el = { addEventListener: () => {}, remove: () => {}, async: false } as Record<string, unknown>
      Object.setPrototypeOf(el, scriptProto)
      created.push(el)
      return el
    }
    const documentStub = {
      createElement: () => makeEl(),
      head: { append: () => {} },
      prototype: 0,
    }
    // Simulate HTMLScriptElement.prototype in the sandbox.
    const sandbox = {
      document: documentStub,
      HTMLScriptElement: {
        prototype: scriptProto,
      },
      console,
      Request: class Request { url: string; constructor(url: string, _init?: unknown) { this.url = url } },
      WebSocket: class {},
      EventSource: class {},
    }
    const vm = require("node:vm")
    vm.runInNewContext(
      script +
        `;const s = document.createElement("script"); s.src = "/plugins/@deepseek-ai/dsh-session-log-export/client.js?rev=abc"; s.src = "https://example.com/x.js";`,
      sandbox,
    )
    expect(created).toHaveLength(1)
    expect(created[0].src).toBe("https://example.com/x.js")
  })

  test("script bundle without an existing /dsh prefix is prefixed", () => {
    const ctx = makeCtx()
    const vws = new VirtualWebServer(ctx, { host: "127.0.0.1", port: 0 })
    const script = vws.iframeAdapterScript()
    const scriptProto = {}
    Object.defineProperty(scriptProto, "src", {
      get() { return this.__src },
      set(v) { this.__src = v },
      configurable: true,
    })
    const el = { addEventListener: () => {}, remove: () => {}, async: false } as Record<string, unknown>
    Object.setPrototypeOf(el, scriptProto)
    const documentStub = {
      createElement: () => el,
      head: { append: () => {} },
    }
    const sandbox = {
      document: documentStub,
      HTMLScriptElement: { prototype: scriptProto },
      console,
      Request: class Request { url: string; constructor(url: string, _init?: unknown) { this.url = url } },
      WebSocket: class {},
      EventSource: class {},
    }
    const vm = require("node:vm")
    vm.runInNewContext(
      script +
        `;const s = document.createElement("script"); s.src = "/plugins/@deepseek-ai/dsh-client-hmr/client.js?rev=123";`,
      sandbox,
    )
    expect(el.src).toBe("/dsh/plugins/@deepseek-ai/dsh-client-hmr/client.js?rev=123")
  })
})

describe("VirtualWebServer outbound redirect rewriting", () => {
  test("3xx Location at root is prefixed with /dsh; already-prefixed and external stay unchanged", async () => {
    const ctx = makeCtx()
    const vws = new VirtualWebServer(ctx, { host: "127.0.0.1", port: 0 })
    const server = makeServer()
    const { baseUrl } = await listen(server)
    vws.attach(server)

    vws.register({ kind: "exact", path: "/login", handler: (req, res) => { res.writeHead(303, { location: "/" }); res.end() } })
    vws.register({ kind: "exact", path: "/clean", handler: (req, res) => { res.writeHead(303, { location: "/assets/x" }); res.end() } })
    vws.register({ kind: "exact", path: "/prefixed", handler: (req, res) => { res.writeHead(303, { location: "/dsh/y" }); res.end() } })
    vws.register({ kind: "exact", path: "/external", handler: (req, res) => { res.writeHead(303, { location: "http://example.com/" }); res.end() } })
    vws.register({ kind: "exact", path: "/ok", handler: (req, res) => { res.writeHead(200, { "x-hint": "/" }); res.end("ok") } })

    const login = await fetch(baseUrl + "/login", { redirect: "manual" })
    expect(login.status).toBe(303)
    expect(login.headers.get("location")).toBe("/dsh/")
    const clean = await fetch(baseUrl + "/clean", { redirect: "manual" })
    expect(clean.headers.get("location")).toBe("/dsh/assets/x")
    const prefixed = await fetch(baseUrl + "/prefixed", { redirect: "manual" })
    expect(prefixed.headers.get("location")).toBe("/dsh/y")
    const external = await fetch(baseUrl + "/external", { redirect: "manual" })
    expect(external.headers.get("location")).toBe("http://example.com/")
    const ok = await fetch(baseUrl + "/ok")
    expect(ok.status).toBe(200)
    expect(ok.headers.get("x-hint")).toBe("/")

    server.close()
  })

  test("fallback-seat redirects are rewritten too", async () => {
    const ctx = makeCtx()
    const vws = new VirtualWebServer(ctx, { host: "127.0.0.1", port: 0 })
    const server = makeServer()
    const { baseUrl } = await listen(server)
    vws.attach(server)
    vws.registerFallback((req, res) => { res.writeHead(302, { Location: "/welcome" }); res.end() })

    const res = await fetch(baseUrl + "/deep/path", { redirect: "manual" })
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/dsh/welcome")

    server.close()
  })
})

describe("VirtualWebServer upgrade socket cleanup", () => {
  test("host dispose closes sockets dispatched through the virtual webserver", async () => {
    const ctx = makeCtx()
    const vws = new VirtualWebServer(ctx, { host: "127.0.0.1", port: 0 })
    const server = makeServer()
    const { port } = await listen(server)
    vws.attach(server)

    let socketClosed = false
    vws.registerUpgrade({
      path: "/api/events.mux",
      handler: (req, socket) => {
        socket.once("close", () => { socketClosed = true })
      },
    })

    const socket = connect(port, "127.0.0.1")
    socket.write(
      "GET /api/events.mux HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "\r\n",
    )
    await once(socket, "connect")
    // Give the upgrade dispatch a tick to register the socket.
    await new Promise((r) => setTimeout(r, 20))

    vws.dispose()
    await once(socket, "close")
    expect(socketClosed).toBe(true)

    server.close()
  })
})
