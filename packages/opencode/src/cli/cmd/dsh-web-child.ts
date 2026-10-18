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
 * Wrap an already-running child listener into a proxying container. Exported
 * for tests and reuse; `spawnWebChildContainer` composes it with the spawn.
 */
export function webChildProxyContainer(child: { port: number; authPath?: string }): WebChildContainer {
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
  const proxyUpgrade = (req: IncomingMessage, socket: Duplex, _head: Buffer): void => {
    const upstream = httpRequest({
      host: "127.0.0.1",
      port: child.port,
      path: req.url ?? "/",
      method: req.method,
      headers: req.headers,
    })
    upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      const headers = [`HTTP/1.1 101 Switching Protocols`]
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (Array.isArray(value)) for (const entry of value) headers.push(`${key}: ${entry}`)
        else if (value !== undefined) headers.push(`${key}: ${value}`)
      }
      socket.write(`${headers.join("\r\n")}\r\n\r\n`)
      if (upstreamHead.length > 0) socket.write(upstreamHead)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
    })
    upstream.on("error", () => socket.destroy())
    socket.on("error", () => upstream.destroy())
    upstream.end()
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
