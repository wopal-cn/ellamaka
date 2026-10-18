/**
 * The host-side assembly of the `dsh:web` cold reload (DESIGN.md#unified-reload
 * --lifecycle 隔离边界): "bun standalone serve 以全新 bun 子进程承载 web 容器、
 * 宿主经 node:http 代理转发 /dsh".
 *
 * `spawnWebChildContainer` is the `ColdRebuildBuilder`'s process boundary: it
 * launches the SAME binary in the child role (`<ellamaka> dsh web-child`,
 * resolved by the caller through `resolveEllamakaCommand` — the compiled
 * binary re-launches itself, dev mode re-launches `bun src/index.ts`), parses
 * the child's one JSON ready line from stdout, and wraps the child's real
 * loopback listener into a `ColdRebuildContainer` that PROXIES requests and
 * upgrades over `node:http`. The child owns its Home lease for its lifetime
 * (cordis `web-child.ts`), so the parent holds no second lease for it.
 *
 * The parent keeps the listening socket and mounts the DshWebColdReload
 * controller's stable handlers under `/dsh` (dsh-mount.ts); rebuilds swap the
 * proxy target without remounting, so the browser-facing URL never changes.
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http"
import { WebSocketServer, type WebSocket as ServerSocket } from "ws"
import { spawn as nodeSpawn } from "node:child_process"
import type { Duplex } from "node:stream"
import type { ColdRebuildContainer } from "@wopal/ellamaka-cordis/runtime/web-cold-reload"

/** The minimal child-process surface the builder needs (spawn-injectable). */
export interface WebChildProcess {
  readonly pid: number
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  kill(): void
  exited: Promise<number>
}

/** Options for one child spawn. */
export interface SpawnWebChildOptions {
  /** Spawns the child in the web-container role; injectable for tests. */
  spawn: () => WebChildProcess
  /**
   * The loopback port the child must bind; `0` lets the OS assign one (the
   * ready line carries the bound port).
   */
  port: number
  /** The Ellamaka territory root (`$WOPAL_HOME/dsh`) passed to the child. */
  home: string
  /** Ready-line deadline; a child that neither readies nor exits rejects. */
  readyTimeoutMs?: number
}

/** One built child container: proxying + child ownership. */
export interface WebChildContainer extends ColdRebuildContainer {
  /** The child's bound loopback port. */
  readonly port: number
  /**
   * The child's browser-auth entry query (`/?token=…`, child-root relative).
   * The parent re-attaches it under its `/dsh` mount when composing the
   * Workbench iframe URL — without it the official fence 401s every bare
   * visit.
   */
  readonly authPath?: string
}

/**
 * Handshake headers the `ws` client generates for its OWN dial. Forwarding
 * them would either duplicate (key/version) or contradict (protocol,
 * extensions) the upstream handshake. Everything else — Host, Cookie,
 * Origin, Authorization, user agent — belongs to the original browser request
 * and must reach the child unchanged, because the child's DSH fences
 * authenticate against exactly those values.
 */
const UPSTREAM_OWNED_HEADERS = new Set([
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-accept",
  "sec-websocket-protocol",
])

/**
 * Bun's WebSocket accepts the browser-standard constructor plus a Bun-only
 * `headers` option; the DOM lib types stop at `protocols`. Bind the runtime
 * constructor once so the dial stays typed without a per-call assertion.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Bun's constructor takes a headers option the DOM lib does not declare
const NativeWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket

/** The original upgrade request headers, minus the ones `ws` must own. */
function upstreamUpgradeHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const forwarded: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || UPSTREAM_OWNED_HEADERS.has(name)) continue
    forwarded[name] = Array.isArray(value) ? value.join(", ") : value
  }
  return forwarded
}

/**
 * Wrap an already-running child listener into a proxying container. Exported
 * for tests and reuse; `spawnWebChildContainer` composes it with the spawn.
 */
export function webChildProxyContainer(child: { port: number; authPath?: string }): WebChildContainer {
  // One noServer acceptor per container generation; dispose drops it.
  const socketWss = new WebSocketServer({ noServer: true })
  const proxyRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: child.port,
        path: req.url ?? "/",
        method: req.method,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502)
      if (!res.writableEnded) res.end()
    })
    if (typeof (req as { pipe?: unknown }).pipe === "function") req.pipe(upstream)
    else upstream.end()
  }
  // Bun swallows every socket.write() on a node:http upgrade socket
  // (oven-sh/bun#9882, #35325): the `upgrade` event fires, writes report
  // success, and no byte ever reaches the wire — so raw-byte tunnels can
  // never answer a browser's 101. The `ws` package's noServer handleUpgrade
  // takes Bun's native handoff and DOES reach the wire (that is also why the
  // child's own WS works) and terminates the browser's handshake.
  //
  // The upstream dial uses Bun's NATIVE WebSocket, not the `ws` client: the
  // websocket package's client drives `node:http`'s upgrade event, which Bun
  // does not deliver for a server response, so every dial died on the child's
  // 101 handshake. The native client completes it and accepts custom headers.
  //
  // The child is the same DSH web container the browser would have reached
  // directly, so its fences still apply: the /api trust fence reads Host and
  // Origin, and browser-auth derives the cookie NAME from the Host authority
  // before verifying the cookie. Dialing with the loopback authority and no
  // Cookie therefore fails no matter how valid the browser session is — the
  // browser's own handshake headers must survive the proxy hop.
  const proxyUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const upstream = new NativeWebSocket(`ws://127.0.0.1:${child.port}${req.url ?? "/"}`, {
      headers: upstreamUpgradeHeaders(req.headers),
    })
    upstream.binaryType = "arraybuffer"
    let clientWs: ServerSocket | undefined
    const backlog: (string | ArrayBuffer)[] = []
    const closeBoth = () => {
      try {
        clientWs?.close()
      } catch {
        // already closing/closed
      }
      try {
        upstream.close()
      } catch {
        // already closing/closed
      }
    }
    // Complete the browser handshake only AFTER the child accepted: a rejected
    // upstream must surface as a failed connection, never as a 101 that is
    // torn down right afterwards (that reads as an endless reconnect loop).
    upstream.onopen = () => {
      try {
        socketWss.handleUpgrade(req, socket, head, (accepted) => {
          clientWs = accepted
          // Preserve the frame kind: the DSH RPC protocol mixes JSON text
          // frames with binary payloads, and a text frame sent upstream as a
          // binary frame makes the child close the connection on decode.
          accepted.on("message", (data, isBinary) => {
            const payload = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
            upstream.send(isBinary ? payload : payload.toString())
          })
          for (const frame of backlog) upstream.send(frame)
          backlog.length = 0
          accepted.on("close", closeBoth)
        })
      } catch {
        upstream.close()
        socket.destroy()
      }
    }
    upstream.onmessage = (event: MessageEvent) => {
      // `binaryType = "arraybuffer"` (set above) narrows non-text frames; the
      // DOM event type keeps `data` as `any`, so narrow by inspection instead.
      const payload: unknown = event.data
      const frame = typeof payload === "string" ? payload : payload instanceof ArrayBuffer ? payload : undefined
      if (frame === undefined) return
      if (clientWs) clientWs.send(frame)
      else backlog.push(frame)
    }
    // A failed dial (auth reject, child down) closes without ever opening; the
    // browser must see that, not a handshake we already answered.
    upstream.onerror = () => {
      if (!clientWs) socket.destroy()
    }
    upstream.onclose = () => {
      if (clientWs) closeBoth()
      else socket.destroy()
    }
    // The browser may give up while the upstream is still dialing.
    socket.on("close", () => {
      if (clientWs) return
      try {
        upstream.close()
      } catch {
        // already closing/closed
      }
    })
  }
  return {
    port: child.port,
    authPath: child.authPath,
    handleRequest: proxyRequest,
    handleUpgrade: proxyUpgrade,
    dispose: undefined,
  }
}

/** Read ONE ready line from the child's stdout, racing child exit. */
async function readReadyLine(
  child: WebChildProcess,
  timeoutMs: number,
): Promise<{ ready: boolean; port: number; authPath?: string }> {
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    const exitRace = child.exited.then(
      () => null,
      () => null,
    )
    const timeoutRace = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
    while (true) {
      const winner = await Promise.race([
        reader.read().then((result) => (result.done ? null : result.value)),
        exitRace.then(() => "EXIT" as const),
        timeoutRace.then(() => "TIMEOUT" as const),
      ])
      if (winner === "EXIT") {
        const code = await child.exited
        throw new Error(`dsh web child exited before ready (code ${code})`)
      }
      if (winner === "TIMEOUT") {
        throw new Error(`dsh web child did not report ready within ${timeoutMs}ms`)
      }
      if (winner === null) {
        const code = await child.exited
        throw new Error(`dsh web child stdout ended before ready (code ${code})`)
      }
      buffer += decoder.decode(winner, { stream: true })
      const lineEnd = buffer.indexOf("\n")
      if (lineEnd >= 0) {
        const line = buffer.slice(0, lineEnd).trim()
        if (line.startsWith("{")) {
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            throw new Error(`dsh web child reported an invalid ready line: ${line}`)
          }
          if (typeof parsed !== "object" || parsed === null) {
            throw new Error(`dsh web child reported an invalid ready line: ${line}`)
          }
          const record = parsed as { ready?: unknown; port?: unknown; authPath?: unknown }
          const port = record["port"]
          if (record["ready"] !== true || typeof port !== "number" || port <= 0) {
            throw new Error(`dsh web child reported an invalid ready line: ${line}`)
          }
          // authPath is optional in the parsed shape (tolerant), but the
          // builder surfaces it so the iframe entry can carry the token.
          const authPath = typeof record["authPath"] === "string" ? record["authPath"] : undefined
          return { ready: true, port, authPath }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Spawn the web child detached (own process group) and wait for its ready
 * line, then return the proxying container.
 *
 * `detached` is a correctness requirement, not an optimization: the DSH
 * profile boot inside the child spawns its own subprocess supervisor, and a
 * signal targeting THAT supervisor's process group must not reach the web
 * child itself (observed: an early stray SIGTERM racing the boot silently
 * ended the child, exit 0). An own group makes every group-targeted kill from
 * inside the child stay inside it.
 */
export function spawnDetachedWebChild(command: readonly string[], env: Record<string, string>): WebChildProcess {
  const child = nodeSpawn(command[0], command.slice(1), {
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  return {
    pid: child.pid!,
    stdout: toWebReadable(child.stdout),
    stderr: toWebReadable(child.stderr),
    kill: () => {
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    },
    exited: new Promise<number>((resolve) => {
      child.on("exit", (code, signal) => resolve(code ?? (signal === "SIGKILL" ? 137 : 1)))
    }),
  }
}

/** Adapt a node Readable into the WebReadableStream surface the builder reads. */
function toWebReadable(readable: import("node:stream").Readable | null): ReadableStream<Uint8Array> {
  if (readable === null) throw new Error("dsh web child was spawned without pipe stdio")
  return new ReadableStream<Uint8Array>({
    start(controller) {
      readable.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      readable.on("end", () => controller.close())
      readable.on("error", (error) => controller.error(error))
    },
    cancel() {
      readable.destroy()
    },
  })
}

/**
 * Spawn the web child, wait for its ready line, and return the proxying
 * container. The child is NOT killed on builder failure here: the caller's
 * lifecycle (DshWebColdReload degradation) owns the container it received,
 * and a failed spawn never produced one — the rejected child exits on its own
 * (or the caller kills `child.pid` from its own error path).
 */
export async function spawnWebChildContainer(options: SpawnWebChildOptions): Promise<WebChildContainer> {
  const child = options.spawn()
  // Drain the child's stderr into a bounded buffer so a failed boot surfaces
  // its profile-boot diagnostics in the parent's error instead of vanishing.
  const stderrTail: string[] = []
  void (async () => {
    const reader = child.stderr.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      stderrTail.push(decoder.decode(value))
      if (stderrTail.length > 20) stderrTail.shift()
    }
  })()
  let ready: { ready: boolean; port: number; authPath?: string }
  try {
    ready = await readReadyLine(child, options.readyTimeoutMs ?? 120_000)
  } catch (error) {
    const tail = stderrTail.join("").trim()
    if (tail.length > 0) {
      child.kill()
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; child stderr tail: ${tail.slice(-2000)}`,
        {
          cause: error,
        },
      )
    }
    throw error
  }
  const container = webChildProxyContainer({ port: ready.port, authPath: ready.authPath })
  return {
    ...container,
    dispose: async () => {
      child.kill()
      await child.exited.catch(() => undefined)
    },
  }
}

/**
 * Build the child launch argv for the hidden `dsh web-child` command. The
 * caller passes `resolveEllamakaCommand()`'s output (executable + prefix args
 * reaching the CLI entry) and the RESOLVED install anchor — the packaged
 * binary's own closure does not carry `@deepseek-ai/*`, so the child MUST
 * resolve the runtime from the closure anchor like every other host (B-01).
 */
export function webChildArgs(
  command: readonly string[],
  options: { home: string; port: number; installAnchor: string; logDir?: string },
): string[] {
  return [
    ...command,
    "dsh",
    "web-child",
    "--home",
    options.home,
    "--port",
    String(options.port),
    "--install-anchor",
    options.installAnchor,
    ...(options.logDir ? ["--log-dir", options.logDir] : []),
  ]
}

export * as DshWebChild from "./dsh-web-child"
