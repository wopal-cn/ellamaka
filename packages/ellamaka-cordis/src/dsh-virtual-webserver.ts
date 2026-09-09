/**
 * VirtualWebServer — a Cordis `webServer` service that saves route tables and
 * upgrade sockets instead of binding a real socket.
 *
 * The DSH single-port scheme (DESIGN-dsh-poc §2.1) mounts the official dsh
 * web plugins onto the Ellamaka listener. Those plugins register their routes
 * against the `webServer` service; this implementation provides that service
 * without creating a second listening socket. It implements the official
 * `@deepseek-ai/dsh-host-webserver` surface (`register`, `registerUpgrade`,
 * `registerFallback`, `tapIndex`, `collectIndexInjections`, `renderIndex`,
 * `applyIndexTaps`, `host`, `port`) so the official plugins compose unchanged.
 *
 * HTTP dispatch is exact → longest-prefix → fallback; upgrade dispatch is
 * exact-path only. `renderIndex` renders the Cordis `webserver/index-inject`
 * table first, then the raw taps in registration order. The iframe adaptation
 * rewrites DSH static asset URLs to `/dsh/*` and injects a browser script that
 * maps same-origin `fetch`/`WebSocket`/`EventSource` to `/dsh/*` (external and
 * already-prefixed URLs stay unchanged). Upgrade sockets dispatched through
 * this server are tracked and closed on dispose, so Node `closeAllConnections()`
 * does not strand raw WebSockets.
 *
 * No runtime `@deepseek-ai/*` value is statically imported here: the cordis
 * `Service` registration is replicated via `ctx.reflect.provide`, and the dsh
 * `renderIndexInjections` renderer is resolved lazily from the DSH runtime
 * loader (DESIGN-dsh-poc §3.4.6).
 *
 * @module @wopal/ellamaka-cordis/dsh-virtual-webserver
 */
import type { Context } from "@deepseek-ai/cordis"
import type { IndexInjection } from "@deepseek-ai/dsh-host-webserver"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { createPackageDshRuntimeApi, type DshRuntimeApi } from "./runtime/loader.js"

/** The prefix under which the DSH surface is mounted on the Ellamaka listener. */
export const DSH_MOUNT_PREFIX = "/dsh"

/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' matches p and p/<anything>. */
export type WebRouteKind = "exact" | "prefix"

/** One named route registration. */
export interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle. */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** One exact-path HTTP upgrade registration. */
export interface WebUpgradeRoute {
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns protocol negotiation and the upgraded socket after dispatch. */
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

/** VirtualWebServer options (mirrors the official Config shape). */
export interface VirtualWebServerOptions {
  /** The bind host the virtual server reports. */
  host: "127.0.0.1" | "0.0.0.0"
  /** The port the virtual server reports (the Ellamaka public port). */
  port: number
  /**
   * The DSH runtime handle to resolve `hostWebserver.renderIndexInjections`
   * from (DESIGN-dsh-poc §3.4.6). Production mounts inject the closure-resolved
   * runtime (B-01); when omitted the module falls back to the package closure —
   * a dev-only convenience that packaged hosts must never rely on.
   */
  runtime?: DshRuntimeApi
}

/** Extract the pathname from a raw request target, defaulting to `/`. */
function pathnameOf(url: string | undefined): string {
  if (!url) return "/"
  const qIndex = url.indexOf("?")
  return qIndex === -1 ? url : url.slice(0, qIndex)
}

/**
 * VirtualWebServer — a Cordis `webServer` service that saves route tables and
 * upgrade sockets instead of binding a real socket.
 */
export class VirtualWebServer {
  private readonly exact = new Map<string, WebRoute>()
  private readonly prefixes = new Map<string, WebRoute>()
  private readonly upgrades = new Map<string, WebUpgradeRoute>()
  private readonly upgradedSockets = new Set<Duplex>()
  private readonly indexTaps: ((html: string) => string)[] = []
  private fallback: WebRoute["handler"] | undefined
  private server: Server | undefined
  private readonly config: VirtualWebServerOptions
  /** The cordis context this service is registered on. */
  readonly ctx: Context

  constructor(ctx: Context, config: VirtualWebServerOptions) {
    this.ctx = ctx
    this.config = config
    // Register this instance as the `webServer` service without a runtime
    // `Service` base-class import: mirror the cordis `Service` registration
    // (name + instance) through the context's reflection layer.
    ctx.reflect.provide("webServer", this)
  }

  /** The reported port (the Ellamaka public port). */
  get port(): number {
    return this.config.port
  }

  /** The reported bind host. */
  get host(): "127.0.0.1" | "0.0.0.0" {
    return this.config.host
  }

  /**
   * Register a named route. Duplicate (kind, path) throws — route patterns are
   * a composition-level contract, so a collision is a misconfiguration.
   */
  register(route: WebRoute): () => void {
    const table = route.kind === "exact" ? this.exact : this.prefixes
    if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    table.set(route.path, route)
    return () => {
      table.delete(route.path)
    }
  }

  /**
   * Register an exact-path HTTP upgrade route. Duplicate paths throw because
   * one socket can have only one protocol owner.
   */
  registerUpgrade(route: WebUpgradeRoute): () => void {
    if (this.upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
    this.upgrades.set(route.path, route)
    return () => {
      this.upgrades.delete(route.path)
    }
  }

  /**
   * Claim the fallback seat. One owner only — a second registration throws.
   */
  registerFallback(handler: WebRoute["handler"]): () => void {
    if (this.fallback !== undefined) throw new Error("webserver: fallback already registered")
    this.fallback = handler
    return () => {
      this.fallback = undefined
    }
  }

  /**
   * Register a raw-HTML index transform. `renderIndex` applies taps in
   * registration order after rendering the structured rows.
   */
  tapIndex(transform: (html: string) => string): () => void {
    this.indexTaps.push(transform)
    return () => {
      const at = this.indexTaps.indexOf(transform)
      if (at !== -1) this.indexTaps.splice(at, 1)
    }
  }

  /** Longest-prefix-wins over the prefix table after an exact-table miss. */
  private match(pathname: string): WebRoute | undefined {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best: WebRoute | undefined
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }

  /**
   * Run an index.html body through the registered taps in registration order.
   */
  applyIndexTaps(html: string): string {
    let out = html
    for (const transform of this.indexTaps) out = transform(out)
    return out
  }

  /**
   * Gather the structured injection table: one `webserver/index-inject` emit,
   * every subscriber pushes its current rows.
   */
  collectIndexInjections(): IndexInjection[] {
    const table: IndexInjection[] = []
    this.ctx.emit("webserver/index-inject", table)
    return table
  }

  /**
   * Render one index.html body: the structured injection table first, then the
   * raw `tapIndex` transforms over the result.
   */
  renderIndex(html: string): string {
    const runtime = this.config.runtime ?? createPackageDshRuntimeApi()
    const { renderIndexInjections } = runtime.hostWebserver
    return this.applyIndexTaps(renderIndexInjections(html, this.collectIndexInjections()))
  }

  /**
   * Rewrite DSH static asset URLs to the `/dsh` mount and drop the PWA
   * manifest link (the iframe does not need it). The rc.1 dist uses
   * document-relative `./assets/...` URLs anchored by the official injected
   * `<base href="/">`, which under the iframe would resolve outside the
   * mount — so both root-relative and `./`-relative URLs are absolutized onto
   * the prefix. External and already `/dsh`-prefixed URLs stay unchanged.
   */
  rewriteIndex(html: string): string {
    const prefix = DSH_MOUNT_PREFIX
    const hasMountPrefix = (p: string): boolean => p === prefix || p.startsWith(`${prefix}/`)
    const rewrite = (url: string): string => {
      if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("//")) return url
      if (hasMountPrefix(url)) return url
      return prefix + url.replace(/^\.\//, "/")
    }
    // Drop the PWA manifest link.
    let out = html.replace(/<link[^>]*rel=["']manifest["'][^>]*>/gi, "")
    // Rewrite href/src attributes that reference DSH assets (root-relative or
    // document-relative forms).
    out = out.replace(/(href|src)=(["'])(\.\.?\/[^"']*)\2/gi, (match, attr, quote, url) => {
      return `${attr}=${quote}${rewrite(url)}${quote}`
    })
    out = out.replace(/(href|src)=(["'])(\/[^"']*)\2/gi, (match, attr, quote, url) => {
      return `${attr}=${quote}${rewrite(url)}${quote}`
    })
    return out
  }

  /**
   * The browser iframe prefix-adaptation script. Maps same-origin
   * `fetch`/`WebSocket`/`EventSource` to `/dsh/*`; external URLs and already
   * `/dsh`-prefixed URLs stay unchanged.
   */
  iframeAdapterScript(): string {
    const prefix = DSH_MOUNT_PREFIX
    return `(() => {
  const prefix = ${JSON.stringify(prefix)};
  const ownOrigin = typeof location !== "undefined" ? location.origin : null;
  const hasMountPrefix = (p) => p === prefix || p.startsWith(prefix + "/");
  const adaptAbsolute = (url) => {
    try {
      const target = new URL(url);
      if (!ownOrigin) return url;
      const origin = new URL(ownOrigin);
      if (target.host !== origin.host) return url;
      if (hasMountPrefix(target.pathname)) return url;
      return target.protocol + "//" + target.host + prefix + target.pathname + target.search;
    } catch (e) { return url; }
  };
  const adapt = (url) => {
    if (typeof URL !== "undefined" && url instanceof URL) url = url.href;
    if (typeof url !== "string" || url === "") return url;
    if (url.startsWith("//")) return url;
    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("ws://") || url.startsWith("wss://")) {
      return adaptAbsolute(url);
    }
    if (hasMountPrefix(url)) return url;
    return prefix + url;
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (typeof URL !== "undefined" && input instanceof URL) input = new URL(adapt(input.href));
    else if (typeof input === "string") input = adapt(input);
    else if (input && typeof input.url === "string") input = new Request(adapt(input.url), input);
    return origFetch(input, init);
  };
  const OrigWS = globalThis.WebSocket;
  globalThis.WebSocket = class extends OrigWS {
    constructor(url, protocols) { super(adapt(url), protocols); }
  };
  const OrigES = globalThis.EventSource;
  globalThis.EventSource = class extends OrigES {
    constructor(url, options) { super(adapt(url), options); }
  };
  if (typeof document !== "undefined" && document.createElement) {
    const origCreateElement = document.createElement.bind(document);
    document.createElement = (tag, options) => {
      const el = origCreateElement(tag, options);
      if (tag !== "script") return el;
      const desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "src");
      if (desc && desc.set) {
        const nativeSet = desc.set;
        const nativeGet = desc.get;
        Object.defineProperty(el, "src", {
          get() { return nativeGet ? nativeGet.call(this) : undefined; },
          set(v) { nativeSet.call(this, adapt(v)); },
          configurable: true,
        });
      }
      return el;
    };
  }
})();`
  }

  /**
   * Rewrite a root-relative redirect Location onto the `/dsh` mount — the
   * outbound twin of {@link rewriteIndex}. The official browser-auth flow
   * answers its token exchange with `303 Location: /` (and 303s to `/` when a
   * token-bearing index is re-fetched), which in the single-port scheme is the
   * Ellamaka root, not the DSH surface. External and already-prefixed
   * locations pass through unchanged.
   */
  rewriteLocation(value: string): string {
    if (!value.startsWith("/") || value === DSH_MOUNT_PREFIX || value.startsWith(`${DSH_MOUNT_PREFIX}/`)) {
      return value
    }
    return DSH_MOUNT_PREFIX + value
  }

  /**
   * Adapt one outbound response: `writeHead` and `setHeader` Location headers
   * are prefixed onto the `/dsh` mount (see {@link rewriteLocation}). Applied
   * per request, so a handler that never writes a redirect is untouched.
   */
  private adaptResponse(res: ServerResponse): void {
    const rewrite = (value: string): string => this.rewriteLocation(value)
    const originalWriteHead = res.writeHead.bind(res)
    const wrappedWriteHead = (...args: unknown[]): ServerResponse => {
      for (let at = 1; at < args.length; at += 1) {
        const arg = args[at]
        if (Array.isArray(arg)) {
          for (let index = 0; index + 1 < arg.length; index += 2) {
            if (typeof arg[index] === "string" && String(arg[index]).toLowerCase() === "location" && typeof arg[index + 1] === "string") {
              arg[index + 1] = rewrite(arg[index + 1] as string)
            }
          }
        } else if (typeof arg === "object" && arg !== null) {
          for (const [name, value] of Object.entries(arg)) {
            if (name.toLowerCase() === "location" && typeof value === "string") {
              ;(arg as Record<string, unknown>)[name] = rewrite(value)
            }
          }
        }
      }
      return originalWriteHead(...(args as Parameters<ServerResponse["writeHead"]>))
    }
    res.writeHead = wrappedWriteHead as typeof res.writeHead
    const originalSetHeader = res.setHeader.bind(res)
    res.setHeader = (name: string, value: number | string | readonly string[]): ServerResponse => {
      if (name.toLowerCase() === "location" && typeof value === "string") return originalSetHeader(name, rewrite(value))
      return originalSetHeader(name, value)
    }
  }

  /**
   * Dispatch a request through the virtual route tables. Matched paths go to
   * the registered handler; everything else falls back or 404s. Usable as a
   * `NodeRouteMount.request` so the Ellamaka listener can mount this server
   * under `/dsh`.
   */
  request(req: IncomingMessage, res: ServerResponse): void {
    this.adaptResponse(res)
    const path = pathnameOf(req.url)
    const route = this.match(path)
    if (route !== undefined) {
      this.run(route.handler(req, res), req, res)
      return
    }
    const fallback = this.fallback
    if (fallback === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    this.run(fallback(req, res), req, res)
  }

  /**
   * Dispatch an upgrade through the virtual upgrade table (exact-path only).
   * Usable as a `NodeRouteMount.upgrade` so the Ellamaka listener can mount
   * this server under `/dsh`.
   */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = pathnameOf(req.url)
    const route = this.upgrades.get(path)
    if (route === undefined) {
      socket.destroy()
      return
    }
    this.upgradedSockets.add(socket)
    socket.once("close", () => {
      this.upgradedSockets.delete(socket)
    })
    this.runUpgrade(route.handler(req, socket, head), socket)
  }

  /**
   * Attach the virtual server to a raw `node:http.Server`. Installs the
   * request/upgrade dispatchers that route matched paths to the registered
   * handlers and 404/fallback everything else.
   */
  attach(server: Server): void {
    this.server = server
    server.on("request", (req, res) => this.request(req, res))
    server.on("upgrade", (req, socket, head) => this.upgrade(req, socket, head))
  }

  /** Run a request handler, terminating safely on rejection/throw. */
  private run(result: void | Promise<void>, req: IncomingMessage, res: ServerResponse): void {
    const onError = (error: unknown) => {
      this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(400)
      res.end()
    }
    if (result && typeof (result as Promise<void>).catch === "function") {
      ;(result as Promise<void>).catch(onError)
    }
  }

  /** Run an upgrade handler, destroying the socket on rejection/throw. */
  private runUpgrade(result: void | Promise<void>, socket: Duplex): void {
    const onError = (error: unknown) => {
      this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      socket.destroy()
    }
    if (result && typeof (result as Promise<void>).catch === "function") {
      ;(result as Promise<void>).catch(onError)
    }
  }

  /**
   * Close every upgrade socket dispatched through this server. Called on host
   * dispose so Node `closeAllConnections()` does not strand raw WebSockets.
   */
  dispose(): void {
    for (const socket of this.upgradedSockets) {
      socket.destroy()
    }
    this.upgradedSockets.clear()
  }
}
