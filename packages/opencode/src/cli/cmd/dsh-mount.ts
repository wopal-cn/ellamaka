import { Global } from "@wopal/ellamaka-core/global"
import { trackDshToolsInitialization } from "@wopal/ellamaka-cordis/dsh-adapter/host"
import * as Log from "@wopal/ellamaka-core/util/log"
import { join } from "node:path"
import os from "node:os"
import type { Listener } from "../../server/server"
import {
  DEFAULT_DSH_RUNTIME_MANIFEST,
  acquireDshHomeRuntimeAccess,
  resolveInstallAnchor,
  toDshLogLevel,
} from "@wopal/ellamaka-cordis/runtime"
import { createDshRuntimeApi } from "@wopal/ellamaka-cordis/runtime/loader"
import { resolveInstallCommand } from "@wopal/ellamaka-cordis/plugins/install-command"
import { createDependencyRebuildGate } from "@wopal/ellamaka-cordis/plugins/rebuild-gate"
import { profileDirOf } from "@wopal/ellamaka-cordis/plugins/compose"
import { setDshUrlGetter } from "@/workbench/dsh-url"
import { setDshStatus } from "@/workbench/dsh-status"
import { prepareDshProfiles, writeCorePreparationProgress } from "@/core/preparation"
import { emitRuntimeReloaded } from "@/server/runtime-reload"
import { resolveDshProfileIntent } from "@/config/wopal-product-settings"

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
  /** Override the plugin-log directory; defaults to `$WOPAL_HOME/logs`.
   * Each profile derives its own file (`dsh-plugins-<profile>.log`). */
  logDir?: string
  /** Override the DSH runtime-manager log; defaults to `<logDir>/dsh-runtime.log`. */
  runtimeLogFile?: string
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
 * server under `/dsh` (single-port scheme, DESIGN-dsh-base.md). Shared by
 * the `serve` and `web` commands; the TUI uses its tools-only variant in
 * `tui/dsh-mount.ts`.
 *
 * Assembly (DESIGN-dsh-base.md):
 * 1. Product CorePreparation runs first and owns the `Web disabled + ELLAMAKA_DSH_TOOLS=0` zero-access gate.
 * 2. `READY` → resolve the install anchor for the manifest's fingerprint,
 *    load the six official DSH modules from the closure via
 *    `createDshRuntimeApi`, and mount web + tool containers with that runtime
 *    injected (the Bridge never statically imports `@deepseek-ai/*`).
 * 3. `disabled`/`degraded` → `undefined` is returned and the native host keeps
 *    running untouched; DSH failure never owns listener liveness.
 */
export function mountDshEngine(
  server: Listener,
  opts: DshEngineMountOptions = {},
): Promise<DshEngineHandle | undefined> {
  return trackDshToolsInitialization(mountDshEngineImpl(server, opts))
}

async function mountDshEngineImpl(
  server: Listener,
  opts: DshEngineMountOptions = {},
): Promise<DshEngineHandle | undefined> {
  const wopalHome = opts.wopalHome ?? Global.Path.wopalHome
  const logDir = opts.logDir ?? Global.Path.log
  const runtimeLogFile = opts.runtimeLogFile ?? join(logDir, "dsh-runtime.log")
  const manifest = DEFAULT_DSH_RUNTIME_MANIFEST
  const home = join(wopalHome, "dsh")
  const intent = await resolveDshProfileIntent(wopalHome)

  const preparation = await prepareDshProfiles({
    wopalHome,
    runtimeLogFile,
    logLevel: toDshLogLevel(process.env.ELLAMAKA_LOG_LEVEL),
    print: process.argv.includes("--print-logs"),
    onProgress: writeCorePreparationProgress,
    profiles: intent.profiles,
  })
  if (preparation.web.status !== "prepared" && preparation.tools.status !== "prepared") return undefined

  const homeAccess = await acquireDshHomeRuntimeAccess({
    wopalHome,
    closureVersion: manifest.closureVersion,
  })
  if (!homeAccess.ok) {
    if (intent.web) setDshStatus("web", "degraded")
    if (intent.tools) setDshStatus("tools", "degraded")
    Log.Default.error("dsh home access denied", {
      reason: homeAccess.reason,
      homeVersion: homeAccess.homeVersion,
      closureVersion: manifest.closureVersion,
    })
    return undefined
  }

  const previousDshHome = process.env.DSH_HOME
  const activeDshHome = join(home, "home")
  process.env.DSH_HOME = activeDshHome
  const restoreDshHome = () => {
    if (process.env.DSH_HOME !== activeDshHome) return
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  }

  const anchor = resolveInstallAnchor(wopalHome, manifest)
  let runtime: ReturnType<typeof createDshRuntimeApi>
  try {
    runtime = createDshRuntimeApi(anchor.path)
  } catch (error) {
    if (intent.web) setDshStatus("web", "degraded")
    if (intent.tools) setDshStatus("tools", "degraded")
    restoreDshHome()
    await homeAccess.lease.release()
    Log.Default.error("dsh runtime load failed", { error: error instanceof Error ? error.message : String(error) })
    return undefined
  }

  type DshModule = typeof import("@wopal/ellamaka-cordis/dsh-web")
  type DshHubCtx = Parameters<DshModule["mountDshTools"]>[0]
  type DshHub = { ctx: DshHubCtx; dispose(): Promise<void> }
  type ToolsHost = Awaited<ReturnType<DshModule["mountDshTools"]>>
  let toolsHub: DshHub | undefined
  let toolsHost: ToolsHost | undefined
  let unmountDsh: (() => void) | undefined
  let webReloader: import("@wopal/ellamaka-cordis/runtime/web-cold-reload").DshWebColdReload | undefined
  let pluginService:
    | { replay(): Promise<{ ok: true } | { ok: false; error: string }>; stop(): Promise<void> }
    | undefined

  const mountWeb = async () => {
    if (!(intent.web && preparation.web.status === "prepared")) return
    try {
      const { DshWebColdReload } = await import("@wopal/ellamaka-cordis/runtime/web-cold-reload")
      const { spawnDetachedWebChild, spawnWebChildContainer, webChildArgs } = await import("./dsh-web-child")
      const childCommand = webChildArgs(resolveEllamakaCommand(), {
        home,
        port: 0,
        installAnchor: anchor.path,
        logDir,
        trustedHosts: trustedDshAuthorities(
          { hostname: server.hostname, port: server.port },
          opts.cors ?? [],
          localDshInterfaceAddresses(),
        ),
      })
      let dshAuthQuery = ""
      const reloader = new DshWebColdReload({
        build: async () => {
          const container = await spawnWebChildContainer({
            spawn: () =>
              spawnDetachedWebChild(
                childCommand,
                Object.fromEntries(
                  Object.entries(process.env).filter(
                    (entry): entry is [string, string] => typeof entry[1] === "string",
                  ),
                ),
              ),
            port: 0,
            home,
            readyTimeoutMs: 120_000,
          })
          dshAuthQuery = container.authPath ?? ""
          return { container, publish: () => {} }
        },
        logger: {
          info: (message, extra) => Log.Default.info(message, extra),
          warn: (message, extra) => Log.Default.warn(message, extra),
          error: (message, extra) => Log.Default.error(message, extra),
        },
        onRebuilt: (result) => {
          if (result.ok) emitRuntimeReloaded("dsh:web")
        },
      })
      webReloader = reloader
      await reloader.ensureBuilt()
      const requestHandler = reloader.requestHandler()
      const upgradeHandler = reloader.upgradeHandler()
      const mountPath = "/dsh" as const
      unmountDsh = server.mountNodeRoute({
        prefix: mountPath,
        auth: "self",
        request: (req, res) => {
          void requestHandler(req, res)
        },
        upgrade: (req, socket, head) => {
          upgradeHandler(req, socket, head)
        },
      })
      setDshUrlGetter((requestHost) => {
        try {
          const origin = routableDshOrigin(server.hostname, server.port, requestHost)
          return new URL(`${mountPath}/${dshAuthQuery.replace(/^\//, "")}`, origin).toString()
        } catch {
          return undefined
        }
      })
      setDshStatus("web", "ready")
      Log.Default.info("dsh web engine mounted", { mountPath, revision: reloader.revision })
    } catch (error) {
      setDshStatus("web", "degraded")
      setDshUrlGetter(() => undefined)
      unmountDsh?.()
      await webReloader?.dispose().catch(() => {})
      webReloader = undefined
      unmountDsh = undefined
      Log.Default.error("dsh web profile load failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const mountTools = async () => {
    if (!(intent.tools && preparation.tools.status === "prepared")) return
    try {
      const { CordisHub } = await import("@wopal/ellamaka-cordis")
      const { mountDshTools } = await import("@wopal/ellamaka-cordis/dsh-web")
      toolsHub = new CordisHub(null, { context: new runtime.cordis.Context() })
      toolsHost = await mountDshTools(toolsHub.ctx, {
        home,
        port: 0,
        logDir,
        logLevel: toDshLogLevel(process.env.ELLAMAKA_LOG_LEVEL),
        installAnchor: anchor.path,
        runtime,
      })
      ;(globalThis as Record<string, unknown>).__ellamakaDshContainer = toolsHub.ctx
      setDshStatus("tools", "ready")
      toolsHub.ctx.logger("dsh-tools").info("tool container mounted")
    } catch (error) {
      setDshStatus("tools", "degraded")
      delete (globalThis as Record<string, unknown>).__ellamakaDshContainer
      await toolsHost?.dispose().catch(() => {})
      await toolsHub?.dispose().catch(() => {})
      toolsHost = undefined
      toolsHub = undefined
      Log.Default.error("dsh tools profile load failed; native tools remain available", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  await Promise.all([mountWeb(), mountTools()])

  if (webReloader || (toolsHub && toolsHost)) {
    try {
      const { startDshPluginService } = await import("@wopal/ellamaka-cordis/plugins/runtime")
      type Container = Parameters<typeof startDshPluginService>[0]["containers"][number]
      const containers: Container[] = []
      if (toolsHub && toolsHost) {
        containers.push({
          profile: "ellamaka-tools",
          ctx: toolsHub.ctx,
          includeEntry: toolsHost.includeEntry,
          stackContext: toolsHost.stackContext,
        })
      }
      if (webReloader) {
        const reloader = webReloader
        containers.push({
          profile: "web",
          includeEntry: { id: "web-child", update: async () => {} },
          rebuild: createDependencyRebuildGate({
            profileDir: profileDirOf(home, "web"),
            rebuild: () => reloader.rebuild(),
          }),
        })
      }
      pluginService = startDshPluginService({
        home,
        containers,
        logger: {
          info: (message, extra) => Log.Default.info(message, extra),
          warn: (message, extra) => Log.Default.warn(message, extra),
          error: (message, extra) => Log.Default.error(message, extra),
        },
      })
    } catch (error) {
      Log.Default.warn("dsh plugin runtime service failed to start", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (!webReloader && !toolsHub) {
    restoreDshHome()
    await homeAccess.lease.release()
    return undefined
  }

  return {
    mountPath: "/dsh",
    dispose: async () => {
      try {
        if (intent.web) setDshStatus("web", "disabled")
        if (intent.tools) setDshStatus("tools", "disabled")
        setDshUrlGetter(() => undefined)
        delete (globalThis as Record<string, unknown>).__ellamakaDshContainer
        unmountDsh?.()
        await pluginService?.stop()
        await webReloader?.dispose()
        await toolsHost?.dispose()
        await toolsHub?.dispose()
      } finally {
        restoreDshHome()
        await homeAccess.lease.release()
      }
    },
  }
}
