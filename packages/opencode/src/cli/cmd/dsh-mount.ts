import { Global } from "@wopal/ellamaka-core/global"
import { join } from "node:path"
import os from "node:os"
import type { Listener } from "../../server/server"
import { Effect } from "effect"
import {
  DEFAULT_DSH_RUNTIME_MANIFEST,
  initializeDshRuntime,
  resolveInstallAnchor,
} from "@wopal/ellamaka-cordis/runtime"
import { createDshRuntimeApi } from "@wopal/ellamaka-cordis/runtime/loader"
import { resolveInstallCommand } from "@wopal/ellamaka-cordis/plugins/install-command"
import { setDshUrlGetter } from "@/workbench/dsh-url"
import { setDshStatus } from "@/workbench/dsh-status"

/**
 * The DSH connection-fence authorities derived from the user's CORS trust
 * decision. The CORS surface (`server.cors` in settings.jsonc + `--cors`
 * flags, merged in `resolveNetworkOptions`) is the ONE place a user declares
 * "this remote origin is trusted"; the DSH fence follows that decision —
 * full Origins (`http://192.168.1.5:3000`) are reduced to the `host:port`
 * authority the fence compares, already-authority strings pass through, and
 * entries that parse as neither are skipped (fail closed, same as an empty
 * list).
 */
export function trustedHostsFromCors(cors: readonly string[]): string[] {
  const hosts: string[] = []
  for (const entry of cors) {
    let authority: string | undefined
    try {
      const url = new URL(entry)
      authority = url.host
    } catch {
      if (/^[a-z0-9._-]+(:\d+)?$/i.test(entry)) authority = entry
    }
    if (authority && !hosts.includes(authority)) hosts.push(authority)
  }
  return hosts
}

const WILDCARD_HOSTNAMES = new Set(["0.0.0.0", "::", "[::]"])

/** True when the bind hostname is a wildcard address (`0.0.0.0` / `::`). */
export function isWildcardBind(hostname: string): boolean {
  return WILDCARD_HOSTNAMES.has(hostname)
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

function formatAuthority(hostname: string, port: number): string {
  // Only bare IPv6 literals (two or more colons, not already bracketed) need
  // brackets before the port is appended.
  const isBareIpv6 = hostname.split(":").length > 2 && !hostname.startsWith("[")
  const host = isBareIpv6 ? `[${hostname}]` : hostname
  return `${host}:${port}`
}

/**
 * The authorities the server itself serves on. This is the fence's baseline
 * trust: whatever address a request reaches this process through IS this
 * process, so it never needs a user configuration entry to be accepted.
 * Loopback hostnames are skipped because the fence already trusts them. A
 * wildcard bind has no single self name, so every local interface address is
 * admitted for the bound port.
 */
export function selfDshAuthorities(
  bind: { hostname: string; port: number },
  localAddresses: readonly string[],
): string[] {
  const hosts: string[] = []
  const push = (value: string) => {
    if (!hosts.includes(value)) hosts.push(value)
  }
  if (WILDCARD_HOSTNAMES.has(bind.hostname)) {
    for (const address of localAddresses) push(formatAuthority(address, bind.port))
  } else if (!LOOPBACK_HOSTNAMES.has(bind.hostname)) {
    push(formatAuthority(bind.hostname, bind.port))
  }
  return hosts
}

/**
 * The complete fence allowlist: user CORS trust (cross-origin deployments)
 * plus the server's own serving authorities (baseline self-trust). One trust
 * decision for the user, and no way for the server to reject itself.
 */
export function trustedDshAuthorities(
  bind: { hostname: string; port: number },
  cors: readonly string[],
  localAddresses: readonly string[],
): string[] {
  const hosts = trustedHostsFromCors(cors)
  for (const authority of selfDshAuthorities(bind, localAddresses)) {
    if (!hosts.includes(authority)) hosts.push(authority)
  }
  return hosts
}

/**
 * Detect the non-internal interface addresses of this machine. The mount site
 * feeds these to `selfDshAuthorities` so a wildcard bind (`*:9999`) admits the
 * LAN addresses its browser clients actually use. Reads local interface state
 * only — no network probing.
 */
export function localDshInterfaceAddresses(): string[] {
  const addresses: string[] = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      const bare = entry.address.split("%")[0]
      // Link-local IPv6 (fe80::/10) is scope-bound to one interface and never
      // a browsing authority — skip it to keep the fence list predictable.
      if (/^fe80:/i.test(bare)) continue
      if (!addresses.includes(bare)) addresses.push(bare)
    }
  }
  return addresses
}

/**
 * A ROUTABLE origin for the dsh launch-token entry. `server.url` carries the
 * bind hostname verbatim, so a wildcard bind (`--hostname 0.0.0.0`, or
 * `--mdns` which defaults it) yields `http://0.0.0.0:port` — an address a
 * browser cannot meaningfully use, and whose minted dsh cookie authority
 * every real request then fails. When the serving request carries a Host
 * header, that is the origin the user's browser is actually talking to (LAN
 * IP, mdns name, loopback), so it wins; a wildcard bind without a Host falls
 * back to concrete `localhost`; a concrete bind keeps its own hostname (a
 * request Host may still differ — NAT/proxy views — and wins the same way).
 */
export function routableDshOrigin(hostname: string, port: number, requestHost: string | undefined): string {
  if (requestHost) {
    try {
      const url = new URL(`http://${requestHost}`)
      url.port = String(port)
      if (port === 80) url.port = ""
      return url.origin
    } catch {
      // Malformed Host header — fall through to the bind-derived origin.
    }
  }
  if (WILDCARD_HOSTNAMES.has(hostname)) {
    return `http://localhost${port === 80 ? "" : `:${port}`}`
  }
  return `http://${hostname}${port === 80 ? "" : `:${port}`}`
}

export interface DshEngineMountOptions {
  /** Override the wopal home; defaults to `$WOPAL_HOME`. */
  wopalHome?: string
  /** Override the dsh-plugins log file; defaults to `$WOPAL_HOME/logs/dsh-plugins.log`. */
  logFile?: string
  /** The entry name the runtime manager logs under; defaults to `serve`. */
  entry?: "serve" | "web"
  /**
   * The merged CORS origin list (`server.cors` + `--cors`, resolved by the
   * network options before the server binds). The DSH fence derives its
   * trusted authorities from this list — one trust decision, one surface.
   */
  cors?: readonly string[]
}

export interface DshEngineHandle {
  /** The mount path the dsh web engine serves under (always `/dsh`). */
  readonly mountPath: string
  dispose(): Promise<void>
}

/**
 * The launch command the dsh install worker re-launches for `dsh plugin`
 * operations. The decision table lives in the cordis package's
 * `install-command` module so every host agrees on it; this call site supplies
 * the facts of THIS process.
 *
 * `allowEngineFallback: false`: a CLI host can always name its own launcher,
 * and consulting `<WOPAL_HOME>/bin` would let a stale binary left by an older
 * install win over the one actually running.
 */
function resolveEllamakaCommand(): string[] {
  return (
    resolveInstallCommand({
      argv: process.argv,
      execPath: process.execPath,
      isBun: process.versions.bun !== undefined,
      env: process.env,
      allowEngineFallback: false,
    }) ?? [process.execPath]
  )
}

/**
 * Mount the full dsh engine (web + tool containers) on a running Ellamaka
 * server under `/dsh` (single-port scheme, DESIGN-ellamaka-dsh §2.1). Shared by
 * the `serve` and `web` commands; the TUI uses its tools-only variant in
 * `tui/dsh-mount.ts`.
 *
 * Assembly (DESIGN-ellamaka-dsh §3.4.4/§3.4.5):
 * 1. The unified Runtime Manager runs first — it gates on `ELLAMAKA_DSH`
 *    itself (`=0` → `disabled` with zero file access), so it is called
 *    unconditionally; no manual kill-switch check here.
 * 2. `ready` → resolve the install anchor for the manifest's fingerprint,
 *    load the six official DSH modules from the closure via
 *    `createDshRuntimeApi`, and mount web + tool containers with that runtime
 *    injected (the Bridge never statically imports `@deepseek-ai/*`).
 * 3. `disabled`/`degraded` → `undefined` is returned and the host keeps
 *    running untouched (no `console.warn`; the manager already logged the
 *    structured diagnosis).
 */
export async function mountDshEngine(
  server: Listener,
  opts: DshEngineMountOptions = {},
): Promise<DshEngineHandle | undefined> {
  const wopalHome = opts.wopalHome ?? Global.Path.wopalHome
  const logFile = opts.logFile ?? join(Global.Path.log, "dsh-plugins.log")
  const manifest = DEFAULT_DSH_RUNTIME_MANIFEST
  const home = join(wopalHome, "dsh")

  // B-class official-layout resolution (`resolveDshHome()` env reads) looks
  // up `$DSH_HOME` and falls back to `~/.dsh` when it is unset. Point it at
  // the DSH home so agent presets and every other env-reading plugin land in
  // `$WOPAL_HOME/dsh/home`, matching the dev.sh / Desktop-sidecar host
  // contract (constraint #10). The env write is process-local: the CLI host
  // never mutates the caller's shell environment.
  process.env.DSH_HOME = join(home, "home")

  const status = await initializeDshRuntime({
    wopalHome,
    logFile,
    entry: opts.entry ?? "serve",
    manifest,
  })
  // Publish the terminal runtime status so /global/health can answer with a
  // runtime fact (disabled / ready / degraded) instead of the raw kill switch.
  setDshStatus(status)
  if (status !== "ready") return undefined

  const anchor = resolveInstallAnchor(wopalHome, manifest)

  // Degrade boundary (B-06): a closure whose module exports are broken must
  // never crash the CLI host. Load the closure runtime, then init+mount; any
  // failure is logged (structured), partial resources are disposed, and the
  // host keeps running with no dsh. Never process.exit here.
  type DshModule = typeof import("@wopal/ellamaka-cordis/dsh-web")
  type DshHubCtx = Parameters<DshModule["mountDshWeb"]>[0]
  type DshHub = { ctx: DshHubCtx; dispose(): Promise<void> }
  let webHub: DshHub | undefined
  let toolsHub: DshHub | undefined
  let unmountDsh: (() => void) | undefined
  try {
    const runtime = createDshRuntimeApi(anchor.path)
    const { CordisHub } = await import("@wopal/ellamaka-cordis")
    const { mountDshTools, mountDshWeb } = await import("@wopal/ellamaka-cordis/dsh-web")
    // The closure-resolved context is injected so the hub NEVER falls back to
    // the host package closure, which packaged builds do not carry (B-01).
    webHub = new CordisHub(null, { context: new runtime.cordis.Context() })
    toolsHub = new CordisHub(null, { context: new runtime.cordis.Context() })
    // The CLI serve/web runtime is bun, which lacks
    // node:module.stripTypeScriptTypes, so code-runtime is disabled here; the
    // Desktop sidecar (Node 22.18+) keeps it enabled.
    const dsh = await mountDshWeb(webHub.ctx, {
      home,
      port: server.port,
      logFile,
      installAnchor: anchor.path,
      runtime,
      disableCodeRuntime: true,
      ellamakaCommand: resolveEllamakaCommand(),
      // The fence allowlist rides the web-runtime row into the official
      // webRuntime -> connection fence chain: user CORS trust for cross-origin
      // deployments, plus the server's own serving authorities so it never
      // rejects the address a client actually reaches it through (wildcard
      // binds admit every local interface address on the bound port).
      trustedHosts: trustedDshAuthorities(
        { hostname: server.hostname, port: server.port },
        opts.cors ?? [],
        localDshInterfaceAddresses(),
      ),
    })
    unmountDsh = server.mountNodeRoute({
      prefix: dsh.mountPath,
      // auth-fix-3: the dsh mount brings its own complete browser-auth
      // (launch-token → signed cookie fence), so it declares "self" on the
      // host auth stack it bypasses.
      auth: "self",
      request: (req, res) => dsh.webServer.request(req, res),
      upgrade: (req, socket, head) => dsh.webServer.upgrade(req, socket, head),
    })
    // The Workbench iframe enters the DSH surface through the official rc.1
    // browser-auth launch token; publish the mount-computed entry getter so
    // the /workbench/dsh-url endpoint answers with it (undefined until now).
    // The origin is resolved PER REQUEST from the Host header: a wildcard
    // bind (`--hostname 0.0.0.0` / `--mdns`) makes server.url non-routable,
    // and the minted cookie's authority must match the host the browser
    // actually talks to (routableDshOrigin).
    setDshUrlGetter((requestHost) => {
      try {
        const origin = routableDshOrigin(server.hostname, server.port, requestHost)
        return new URL(dsh.authenticatedPath, origin).toString()
      } catch {
        return undefined
      }
    })
    console.log(`dsh web engine mounted at ${dsh.mountPath}`)
    webHub.ctx.logger("dsh-web").info("dsh engine mounted")

    const toolsHost = await mountDshTools(toolsHub.ctx, {
      home,
      port: 0,
      logFile,
      installAnchor: anchor.path,
      runtime,
    })
    toolsHub.ctx.logger("dsh-tools").info("tool container mounted")
    ;(globalThis as Record<string, unknown>).__ellamakaDshContainer = toolsHub.ctx

    // Plugin Runtime Service (D-02): the server process watches the plugin
    // store and replays include patches into both containers when CLI-side
    // installs change it. A degraded watcher never breaks the engine. The
    // container logger is injected so store/replay failures land in the
    // dsh-plugins log with structure (rook W-02).
    let pluginService: { replay(): Promise<{ ok: true } | { ok: false; error: string }>; stop(): Promise<void> } | undefined
    try {
      const { startDshPluginService } = await import("@wopal/ellamaka-cordis/plugins/runtime")
      const watcherLog = webHub.ctx.logger("dsh-plugins")
      pluginService = startDshPluginService({
        home,
        containers: [
          { profile: "web", ctx: webHub.ctx, includeEntry: dsh.includeEntry, stackContext: dsh.stackContext },
          { profile: "ellamaka-tools", ctx: toolsHub.ctx, includeEntry: toolsHost.includeEntry, stackContext: toolsHost.stackContext },
        ],
        logger: {
          info: (message, extra) => watcherLog.info(message, extra),
          warn: (message, extra) => watcherLog.warn(message, extra),
          error: (message, extra) => watcherLog.error(message, extra),
        },
      })
      dsh.pluginActivation?.bind(() => pluginService!.replay())
    } catch (error) {
      webHub.ctx.logger("dsh-plugins").warn("plugin runtime service failed to start", {
        error: (error as Error).message,
      })
    }

    return {
      mountPath: dsh.mountPath,
      dispose: async () => {
        // dsh.dispose() closes the VirtualWebServer's upgrade sockets first,
        // then unmounts the dsh plugin tree from the web hub.
        setDshUrlGetter(() => undefined)
        unmountDsh?.()
        await pluginService?.stop()
        await dsh.dispose()
        await toolsHost.dispose()
        await webHub?.dispose()
        await toolsHub?.dispose()
      },
    }
  } catch (error) {
    // Never crash the host: log, dispose partial resources, and continue
    // without dsh (B-06).
    console.error(`dsh engine mount failed: ${(error as Error).message}`)
    try {
      unmountDsh?.()
      await webHub?.dispose()
      await toolsHub?.dispose()
    } catch {
      // Best-effort partial disposal; the host continues regardless.
    }
    delete (globalThis as Record<string, unknown>).__ellamakaDshContainer
    return undefined
  }
}
