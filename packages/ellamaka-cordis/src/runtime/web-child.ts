/**
 * The `dsh:web` child-process boundary (DESIGN.md#unified-reload--lifecycle,
 * 隔离边界).
 *
 * The web container runs in a NEW managed child process so a code or
 * package-version change gets a clean module graph: native `import()` and the
 * internal loader both cache modules by URL, so an in-process remount can
 * never adopt new code. The child:
 *
 *  - boots the real `web` profile (`bootDshWeb`) with the closure runtime,
 *  - serves it on a REAL loopback `node:http` listener (port `0` = OS-assigned;
 *    the parent owns the public socket and proxies `/dsh` to this port),
 *  - acquires its own shared Home lease for the time it actually uses the Home
 *    (DESIGN: "Home shared lock 覆盖实际用 Home 的子进程存活时间"),
 *  - reports readiness as ONE JSON line on stdout (`{"ready":true,"port":N}`),
 *  - shuts down gracefully on a `shutdown` line on stdin (dispose + lease
 *    release), exiting 0.
 *
 * The parent-side spawn + proxy lives in the opencode host assembly
 * (`dsh-mount.ts` builder); this module holds the child role and the argv
 * contract so both sides stay in one file. The marker-argv interception
 * mirrors the PTC child pattern (`runBunPtcChildIfRequested`).
 */
import { appendFileSync } from "node:fs"
import { createServer, type RequestListener, type Server, type ServerResponse, type IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

export const WEB_CHILD_MARKER = "--ellamaka-dsh-web-child"

/** One JSON readiness line the parent parses from the child's stdout. */
export function webChildReadyLine(port: number, authPath: string): string {
  return `${JSON.stringify({ ready: true, port, authPath })}\n`
}

/** Parsed child argv contract. */
export interface WebChildOptions {
  /** The Ellamaka territory root (`$WOPAL_HOME/dsh`). */
  home: string
  /** The loopback port for the child listener; `0` asks the OS. */
  port: number
  /** Explicit install anchor (`@deepseek-ai/dsh/package.json` in the closure). */
  installAnchor?: string
  /** Plugin-log directory (`dsh-plugins-web.log` derives inside the mount). */
  logDir?: string
  /** Non-loopback authorities accepted by the connection fence. */
  trustedHosts?: readonly string[]
}

/** Parse the child argv contract (`--marker --home H --port P ...`). */
export function parseWebChildArgs(argv: readonly string[]): WebChildOptions | undefined {
  const marker = argv.indexOf(WEB_CHILD_MARKER)
  if (marker < 0) return undefined
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(name, marker)
    return at >= 0 ? (argv[at + 1] as string | undefined) : undefined
  }
  const home = value("--home")
  const portRaw = value("--port")
  if (!home || !portRaw || !/^\d+$/.test(portRaw)) {
    throw new Error("ellamaka-cordis: invalid dsh web child invocation; --home and --port are required")
  }
  const trustedHosts = argv.flatMap((arg, index) =>
    arg === "--trusted-host" && index > marker ? [argv[index + 1]] : [],
  )
  return {
    home,
    port: Number(portRaw),
    installAnchor: value("--install-anchor"),
    logDir: value("--log-dir"),
    trustedHosts: trustedHosts.length > 0 ? trustedHosts : undefined,
  }
}

/**
 * Enter the child role when argv carries the marker; returns `false` for a
 * normal CLI invocation so the host entry can continue normally.
 */
export async function runWebChildIfRequested(argv: readonly string[]): Promise<boolean> {
  const options = parseWebChildArgs(argv)
  if (options === undefined) return false
  await serveWebChild(options)
  return true
}

/**
 * The child serving loop: boot the web container, listen on a real loopback
 * socket, write the ready line, then wait for the shutdown command on stdin.
 * Resolves (exit 0) after a graceful dispose; the caller's process exits.
 */
export async function serveWebChild(options: WebChildOptions): Promise<void> {
  // Diagnostics: env-gated stderr trace plus an always-on bounded file trace.
  // A silent early exit inside the nested DSH boot would otherwise be
  // indistinguishable from a clean boot that never happened.
  const trace = (step: string): void => {
    if (process.env.ELLAMAKA_WEB_CHILD_TRACE === "1") process.stderr.write(`[web-child] ${step}\n`)
    try {
      appendFileSync("/tmp/ellamaka-web-child-trace.log", `${Date.now()} [${process.pid}] ${step}\n`)
    } catch {
      // Diagnostics only.
    }
  }
  trace("enter")
  const { DSH_CLOSURE_VERSION, acquireDshHomeRuntimeAccess } = await import("./manager.js")
  const { createDshRuntimeApi } = await import("./loader.js")
  const { bootDshWeb } = await import("../dsh-web.js")
  trace("imports ok")

  // The child owns a Home lease for as long as it uses the Home — a newer
  // closure must not switch Home underneath this live container.
  const homeAccess = await acquireDshHomeRuntimeAccess({
    wopalHome: options.home.replace(/\/dsh$/, ""),
    closureVersion: DSH_CLOSURE_VERSION,
  })
  if (!homeAccess.ok) {
    process.stderr.write(`dsh web child: Home access denied: ${homeAccess.reason}\n`)
    process.exit(1)
  }

  let host: Awaited<ReturnType<typeof bootDshWeb>> | undefined
  let server: Server | undefined
  try {
    const runtime = options.installAnchor ? createDshRuntimeApi(options.installAnchor) : undefined
    trace("runtime resolved")
    host = await bootDshWeb({
      home: options.home,
      port: options.port,
      logDir: options.logDir,
      installAnchor: options.installAnchor,
      runtime,
      trustedHosts: options.trustedHosts,
    })
    trace("booted")
    // The VirtualWebServer answers (req, res) directly — the child binds it to
    // a REAL loopback socket the parent proxies to. No prefix stripping here:
    // the parent's mount already strips `/dsh` before proxying.
    server = createServer(webRequest(host))
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) =>
      host!.webServer.upgrade(req, socket, head),
    )
    await new Promise<void>((resolve) => server!.listen(options.port, "127.0.0.1", resolve))
    const address = server.address()
    const boundPort = typeof address === "object" && address !== null ? address.port : options.port
    // The browser-auth entry the parent must hand the Workbench iframe: the
    // official fence only mints a cookie for a FIRST visit carrying the launch
    // token (`?token=…`); a bare visit 401s forever. The child owns the
    // connection service, so it reports the token-carrying query here — the
    // parent re-attaches it under its `/dsh` mount per request origin.
    const connection: unknown = host.ctx.get("connection")
    if (
      typeof connection !== "object" ||
      connection === null ||
      !("authenticatedUrl" in connection) ||
      typeof connection.authenticatedUrl !== "function"
    ) {
      throw new Error("dsh web child: profile did not provide the connection service")
    }
    const authUrl = new URL(connection.authenticatedUrl("http://dsh.invalid"))
    const authPath = `/?${authUrl.searchParams}`
    process.stdout.write(webChildReadyLine(boundPort, authPath))
    trace(`ready written, port=${boundPort}`)

    // Graceful shutdown: one `shutdown` line on stdin, OR stdin EOF. EOF is
    // the orphan guard: the parent holds the write end for the child's whole
    // lifetime and never ends it deliberately, so EOF can only mean the parent
    // process DIED (SIGKILL — no dispose chain can run). A lingering detached
    // child would hold its Home lease and port forever. SIGTERM/SIGHUP are NOT
    // re-registered here — the DSH profile boot installs its own bounded
    // signal shutdown (interrupt → dispose → forced exit ≤5s); a second
    // handler racing it double-disposes the container and hangs the exit.
    // The parent's process-tree cleanup therefore relies on the profile's own
    // signal path; stdin `shutdown`/EOF is the host-coordinated channel that
    // also releases the child's Home lease before exit.
    await new Promise<void>((resolve) => {
      const finish = () => {
        process.stdin.off("data", onData)
        process.stdin.off("end", onEnd)
        resolve()
      }
      const onData = (chunk: Buffer | string) => {
        if (chunk.toString().trim() === "shutdown") finish()
      }
      const onEnd = () => finish()
      process.stdin.setEncoding("utf8")
      process.stdin.on("data", onData)
      process.stdin.on("end", onEnd)
    })
    trace("shutdown received")
  } catch (error) {
    trace(`serve loop threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    throw error
  } finally {
    try {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
      await host?.dispose()
    } catch {
      // Best-effort teardown; the child exits regardless.
    }
    await homeAccess.lease.release()
    process.exit(0)
  }
}

/** Feed one already-stripped request to the VirtualWebServer. */
function webRequest(host: Awaited<ReturnType<typeof import("../dsh-web.js").bootDshWeb>>): RequestListener {
  return (req: IncomingMessage, res: ServerResponse) => host.webServer.request(req, res)
}
