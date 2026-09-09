/**
 * Controlled Node route mounts for the Ellamaka listener.
 *
 * The Effect HTTP stack registers its `request`/`upgrade` handlers directly on
 * a raw `node:http.Server` (via `@effect/platform-node`). This module captures
 * those listeners after the layer is built and installs a stable dispatcher
 * that can route a prefix (`/dsh`) to a mounted handler while every other path
 * falls through to the original Effect listeners in their original order.
 *
 * The dispatcher only exposes `mount()` and its disposer — it never exposes
 * the raw server. Prefix matching is by pathname boundary (`/dsh` and
 * `/dsh/*`, never `/dshx`), the query string is preserved, and the mounted
 * handler receives the stripped `req.url`. A mounted handler that throws or
 * rejects is safely terminated (500 when headers are not yet sent) and logged,
 * without re-entering the original handler.
 *
 * @module @opencode-ai/server/node-route-mount
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"

/** A mounted route: a prefix plus request/upgrade handlers. */
export interface NodeRouteMount {
  /** The pathname prefix to match (`/dsh`). */
  readonly prefix: string
  /** Handle a matched request; `req.url` is stripped of the prefix. */
  request(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  /** Handle a matched upgrade; `req.url` is stripped of the prefix. */
  upgrade?(req: IncomingMessage, socket: Duplex, head: Buffer): void | Promise<void>
}

/** The dispatcher installed on a raw server. */
export interface NodeRouteDispatcher {
  /** Register a mount; returns a disposer that removes it. */
  mount(mount: NodeRouteMount): () => void
}

/** Extract the pathname from a raw request target, defaulting to `/`. */
function pathnameOf(url: string | undefined): string {
  if (!url) return "/"
  const qIndex = url.indexOf("?")
  return qIndex === -1 ? url : url.slice(0, qIndex)
}

/**
 * Match a request target against the mounted prefixes by pathname boundary.
 * Matches the exact prefix and `prefix/...`, never `prefixx`.
 */
export function matchMount(
  mounts: readonly NodeRouteMount[],
  url: string | undefined,
): NodeRouteMount | undefined {
  const path = pathnameOf(url)
  for (const mount of mounts) {
    if (path === mount.prefix || path.startsWith(mount.prefix + "/")) return mount
  }
  return undefined
}

/**
 * Strip a prefix from a request target, preserving the query string. The root
 * of the prefix maps to `/`.
 */
export function stripPrefix(url: string, prefix: string): string {
  const qIndex = url.indexOf("?")
  const query = qIndex === -1 ? "" : url.slice(qIndex)
  const path = qIndex === -1 ? url : url.slice(0, qIndex)
  const rest = path.slice(prefix.length)
  return (rest === "" ? "/" : rest) + query
}

/** Terminate a request after a mounted handler failed, without double-write. */
function handleRequestError(req: IncomingMessage, res: ServerResponse, error: unknown): void {
  console.error("node route mount request error", error)
  if (!res.headersSent) {
    res.writeHead(500)
  }
  if (!res.writableEnded) {
    res.end()
  }
}

/** Terminate an upgrade socket after a mounted handler failed. */
function handleUpgradeError(socket: Duplex, error: unknown): void {
  console.error("node route mount upgrade error", error)
  socket.destroy()
}

/**
 * Install the route dispatcher on a raw server.
 *
 * Captures the already-registered `request`/`upgrade` listeners (the Effect
 * HTTP handlers), removes them, and installs a single dispatcher per event.
 * The dispatcher routes matched prefixes to mounted handlers and forwards
 * everything else to the captured listeners with the server as `this`.
 */
export function installDispatcher(server: Server): NodeRouteDispatcher {
  const mounts: NodeRouteMount[] = []
  const originalRequest = server.listeners("request")
  const originalUpgrade = server.listeners("upgrade")
  server.removeAllListeners("request")
  server.removeAllListeners("upgrade")

  server.on("request", (req, res) => {
    const mount = matchMount(mounts, req.url)
    if (mount) {
      req.url = stripPrefix(req.url!, mount.prefix)
      try {
        const result = mount.request(req, res)
        if (result && typeof (result as Promise<void>).catch === "function") {
          ;(result as Promise<void>).catch((error) => handleRequestError(req, res, error))
        }
      } catch (error) {
        handleRequestError(req, res, error)
      }
      return
    }
    for (const listener of originalRequest) {
      listener.call(server, req, res)
    }
  })

  server.on("upgrade", (req, socket, head) => {
    const mount = matchMount(mounts, req.url)
    if (mount && mount.upgrade) {
      req.url = stripPrefix(req.url!, mount.prefix)
      try {
        const result = mount.upgrade(req, socket, head)
        if (result && typeof (result as Promise<void>).catch === "function") {
          ;(result as Promise<void>).catch((error) => handleUpgradeError(socket, error))
        }
      } catch (error) {
        handleUpgradeError(socket, error)
      }
      return
    }
    for (const listener of originalUpgrade) {
      listener.call(server, req, socket, head)
    }
  })

  return {
    mount(mount) {
      mounts.push(mount)
      return () => {
        const index = mounts.indexOf(mount)
        if (index !== -1) mounts.splice(index, 1)
      }
    },
  }
}
