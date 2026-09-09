type DshFetch = (input: URL, init: RequestInit) => Promise<Response>
type HeadersWithSetCookie = Headers & { getSetCookie?: () => string[] }
import * as nodeHttp from "node:http"
import type { Duplex } from "node:stream"

export function isDshPath(pathname: string): boolean {
  return pathname === "/dsh" || pathname.startsWith("/dsh/")
}

export function createDshProxy(fetch: DshFetch) {
  let target: URL | undefined
  const cookies = new Map<string, string>()

  function setTarget(value?: string): void {
    const next = value ? new URL(value) : undefined
    if (target?.origin !== next?.origin) cookies.clear()
    target = next
  }

  async function handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url)
    if (!isDshPath(url.pathname) || !target) return

    const headers = new Headers(request.headers)
    headers.delete("connection")
    headers.delete("content-length")
    headers.delete("cookie")
    headers.delete("host")
    headers.delete("origin")
    headers.delete("referer")
    headers.set("origin", target.origin)
    if (cookies.size) headers.set("cookie", [...cookies.values()].join("; "))

    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers,
      redirect: "manual",
      signal: request.signal,
    }
    if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
      init.body = request.body
      init.duplex = "half"
    }

    const response = await fetch(new URL(url.pathname + url.search, target), init)
    storeCookies(cookies, response.headers)
    const responseHeaders = new Headers(response.headers)
    responseHeaders.delete("set-cookie")
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  }

  return { handle, setTarget }
}

/**
 * The DSH session cookie captured from the browser-auth token exchange. The
 * http proxy reuses it for the requests it forwards, and a WS upgrade carries
 * the same `Cookie` header so the mux connection authenticates too.
 */
export function cookieHeader(cookies: Map<string, string>): string | undefined {
  return cookies.size ? [...cookies.values()].join("; ") : undefined
}

export function getSetCookieValues(headers: Headers): string[] {
  const getSetCookie = (headers as HeadersWithSetCookie).getSetCookie
  const values = getSetCookie?.call(headers)
  if (values?.length) return values
  const value = headers.get("set-cookie")
  return value ? [value] : []
}

/**
 * A real HTTP proxy for the DSH surface. The packaged renderer lives on the
 * privileged `oc://renderer` origin, where Chromium refuses WebSocket URLs
 * ("The URL's scheme must be either 'http', 'https', 'ws', or 'wss'"). The
 * DSH realtime channel (remote.mux) needs WebSocket, so the desktop iframe
 * targets this standard-HTTP proxy instead: the same-origin cookie is
 * managed here, `/dsh/*` requests and WS upgrades are forwarded to the
 * sidecar target.
 */
export function createDshHttpProxy() {
  const cookies = new Map<string, string>()
  let target: URL | undefined

  function setTarget(value?: string): void {
    const next = value ? new URL(value) : undefined
    if (target?.origin !== next?.origin) cookies.clear()
    target = next
  }

  const server = nodeHttp.createServer((req, res) => {
    if (!target || !isDshPath(req.url ?? "/")) {
      res.writeHead(404)
      res.end()
      return
    }
    const url = new URL(req.url ?? "/", target)
    const headers: Record<string, string | string[] | undefined> = { ...req.headers }
    delete headers.host
    delete headers.origin
    delete headers.referer
    delete headers.cookie
    headers.origin = target.origin
    const cookie = cookieHeader(cookies)
    if (cookie) headers.cookie = cookie
    const proxyReq = nodeHttp.request(
      {
        method: req.method,
        hostname: target.hostname,
        port: target.port,
        path: url.pathname + url.search,
        headers,
      },
      (proxyRes) => {
        const setCookies = nodeHeaderSetCookies(proxyRes.headers)
        storeCookiesFromStrings(cookies, setCookies)
        delete proxyRes.headers["set-cookie"]
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.statusMessage ?? "", proxyRes.headers as never)
        proxyRes.pipe(res)
      },
    )
    proxyReq.on("error", () => {
      res.writeHead(502)
      res.end()
    })
    req.pipe(proxyReq)
  })

  // Forward DSH WebSocket upgrades to the sidecar's upgrade route.
  server.on("upgrade", (req, socket: Duplex, head) => {
    if (!target || !isDshPath(req.url ?? "/")) {
      socket.destroy()
      return
    }
    const url = new URL(req.url ?? "/", target)
    const headers: Record<string, string | string[] | undefined> = { ...req.headers }
    delete headers.host
    delete headers.origin
    delete headers.cookie
    const cookie = cookieHeader(cookies)
    if (cookie) headers.cookie = cookie
    const proxyReq = nodeHttp.request({
      method: "GET",
      hostname: target.hostname,
      port: target.port,
      path: url.pathname + url.search,
      headers: { ...headers, connection: "Upgrade", upgrade: "websocket" },
    })
    proxyReq.on("upgrade", (proxyRes, proxySocket: Duplex, proxyHead) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${proxyRes.headers["sec-websocket-accept"] ?? ""}\r\n` +
          "\r\n",
      )
      if (proxyHead?.length) socket.write(proxyHead)
      proxySocket.pipe(socket)
      socket.pipe(proxySocket)
    })
    proxyReq.on("error", () => socket.destroy())
    proxyReq.end()
  })

  function listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, "127.0.0.1", () => {
        const address = server.address()
        resolve(typeof address === "object" && address ? address.port : port)
      })
    })
  }

  return { server, listen, setTarget, cookies }
}

/** Extract set-cookie values from a node:http raw headers object. */
function nodeHeaderSetCookies(headers: nodeHttp.IncomingHttpHeaders): string[] {
  const value = headers["set-cookie"]
  if (Array.isArray(value)) return value
  return value ? [value] : []
}

function storeCookiesFromStrings(cookies: Map<string, string>, values: string[]): void {
  for (const value of values) {
    const pair = value.split(";", 1)[0]?.trim()
    if (!pair) continue
    const separator = pair.indexOf("=")
    if (separator <= 0) continue
    const name = pair.slice(0, separator)
    if (/(?:^|;)\s*max-age=0(?:;|$)/i.test(value)) {
      cookies.delete(name)
      continue
    }
    cookies.set(name, pair)
  }
}

function storeCookies(cookies: Map<string, string>, headers: Headers): void {
  for (const value of setCookieValues(headers)) {
    const pair = value.split(";", 1)[0]?.trim()
    if (!pair) continue
    const separator = pair.indexOf("=")
    if (separator <= 0) continue
    const name = pair.slice(0, separator)
    if (/(?:^|;)\s*max-age=0(?:;|$)/i.test(value)) {
      cookies.delete(name)
      continue
    }
    cookies.set(name, pair)
  }
}

function setCookieValues(headers: Headers): string[] {
  const getSetCookie = (headers as HeadersWithSetCookie).getSetCookie
  const values = getSetCookie?.call(headers)
  if (values?.length) return values
  const value = headers.get("set-cookie")
  return value ? [value] : []
}
