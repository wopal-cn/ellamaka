import { drizzle } from "drizzle-orm/node-sqlite/driver"
import * as http from "node:http"
import * as tls from "node:tls"
import { register } from "node:module"
import { join } from "node:path"
import { homedir } from "node:os"
import { listenThenClearCredentials } from "./sidecar-credentials"
import { currentSidecarLogLevel, setSidecarLogLevel } from "./sidecar-log-level"

register(new URL("./source-ts-loader.js", import.meta.url), import.meta.url)

type NodeTlsWithSystemCertificates = typeof tls & {
  getCACertificates: (type: "default" | "system") => string[]
  setDefaultCACertificates: (certificates: string[]) => void
}

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  needsMigration: boolean
  /** The wopal home the dsh runtime manager resolves closures under. */
  wopalHome?: string
  /** Plugin-log directory; each profile derives `dsh-plugins-<profile>.log`. */
  pluginLogDir?: string
  /** Path to the dedicated DSH runtime-manager log file. */
  runtimeLogFile?: string
}

type StopCommand = { type: "stop" }
type SetLogLevelCommand = { type: "setLogLevel"; level: "DEBUG" | "INFO" | "WARN" | "ERROR" }
type AdoptLegacyDshHomeCommand = { type: "adoptLegacyDshHome" }
type SidecarCommand = StartCommand | StopCommand | SetLogLevelCommand | AdoptLegacyDshHomeCommand

type SidecarMessage =
  | { type: "sqlite"; progress: { type: "InProgress"; value: number } | { type: "Done" } }
  | { type: "ready" }
  | { type: "dshLegacyAdoptionRequired" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type Listener = {
  port: number
  stop(close?: boolean): void | Promise<void>
  mountNodeRoute(mount: {
    prefix: string
    /** Mirrors NodeRouteMount.auth: every mount bypasses the host auth stack. */
    auth: "self" | "public"
    request(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void
    upgrade?(req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void
  }): () => void
}

type WarningLogger = {
  warn(message?: unknown, extra?: Record<string, unknown>): void
}

type DshPluginLogger = WarningLogger & {
  info(message?: unknown, extra?: Record<string, unknown>): void
  error(message?: unknown, extra?: Record<string, unknown>): void
}

const parentPort = getParentPort()
let listener: Listener | undefined
let dshHost:
  | {
      dispose(): Promise<void>
      ctx?: unknown
      includeEntry?: { id: string; update(options: unknown): Promise<void> }
      stackContext?: unknown
      pluginActivation?: { bind(replay: () => Promise<{ ok: true } | { ok: false; error: string }>): void }
    }
  | undefined
let dshToolsHost:
  | {
      dispose(): Promise<void>
      ctx?: unknown
      includeEntry?: { id: string; update(options: unknown): Promise<void> }
      stackContext?: unknown
    }
  | undefined
let dshPluginService:
  | {
      stop(): Promise<void>
      replay(): Promise<{ ok: true } | { ok: false; error: string }>
    }
  | undefined
/** The sidecar's effective level lives in the single hub (`sidecar-log-level.ts`). */
const sidecarLogLevel = {
  get current(): "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" {
    return currentSidecarLogLevel()
  },
}
/** Disposer for the /api/onboarding mount; runs before the listener stops. */
let disposeOnboarding: (() => void) | undefined

/**
 * The dsh runtime initialised once per launch (W-02). The manager's
 * profile-specific preparation still shares one closure/Home and one loaded
 * runtime. The cached launch state carries each profile's own preparation
 * terminal so Web and Tools activation can proceed independently.
 */
let dshLaunchState:
  | {
      webStatus: import("virtual:opencode-server").DshRuntimeStatus
      toolsStatus: import("virtual:opencode-server").DshRuntimeStatus
      web: boolean
      tools: boolean
      profiles: readonly ("web" | "ellamaka-tools")[]
      reason?: string
      anchor?: import("virtual:opencode-server").DshInstallAnchor
      runtime?: import("virtual:opencode-server").DshRuntimeApi
    }
  | undefined
let dshIntent: { web: boolean; tools: boolean; profiles: readonly ("web" | "ellamaka-tools")[] } | undefined
let currentStartCommand: StartCommand | undefined
let dshWatcherStarted = false
let dshInitialization: Promise<void> | undefined
let dshHomeAccess: { lease: import("virtual:opencode-server").DshHomeRuntimeLease; homeVersion: number } | undefined

/**
 * The sidecar's message contract, exported so the wiring stays directly
 * assertable regardless of bun's shared module registry across test files
 * (the module-scope `parentPort.on` binding below happens exactly once, in
 * whichever test file imports this module first).
 */
export function handleSidecarMessage(data: unknown) {
  const command = parseCommand(data)
  if (!command) return
  if (command.type === "stop") {
    void stop()
    return
  }
  if (command.type === "setLogLevel") {
    void setLogLevel(command.level)
    return
  }
  if (command.type === "adoptLegacyDshHome") {
    void adoptLegacyDshHome()
    return
  }
  void start(command)
}

parentPort.on("message", (event) => {
  handleSidecarMessage(event.data)
})

async function start(command: StartCommand) {
  try {
    ensureLoopbackNoProxy()
    const { Database, JsonMigration, Log, Server } = await import("virtual:opencode-server")
    // Desktop dev tooling controls the sidecar through the double-L
    // `ELLAMAKA_DESKTOP_*` variables (shared with the onboarding reader):
    //   ELLAMAKA_DESKTOP_DEV=1 → dev channel (honors WOPAL_DEBUG_LOG_DIR and
    //   the role-derived `ellamaka-dev-sidecar.log` file)
    // The level follows the unified mechanism (ELLAMAKA_LOG_LEVEL →
    // wopal.logging.level → INFO); the Desktop debug toggle can still lower it
    // at runtime through `setLogLevel`.
    const sidecarDev = process.env.ELLAMAKA_DESKTOP_DEV === "1"
    const initialLevel = Log.resolveEffectiveLevel()
    setSidecarLogLevel(initialLevel)
    process.env.ELLAMAKA_LOG_LEVEL = initialLevel
    await Log.init({
      print: false,
      level: initialLevel,
      dev: sidecarDev,
      role: "sidecar",
    })
    const startupLog = Log.create({ service: "sidecar" })
    useSystemCertificates(startupLog)
    useEnvProxy(startupLog)

    if (command.needsMigration) {
      await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
        progress: (event: { current: number; total: number }) => {
          parentPort.postMessage({
            type: "sqlite",
            progress: {
              type: "InProgress",
              value: event.total === 0 ? 100 : Math.round((event.current / event.total) * 100),
            },
          })
        },
      })
      parentPort.postMessage({ type: "sqlite", progress: { type: "Done" } })
    }

    // Credentials were delivered via the utilityProcess.fork env and are
    // captured by ServerAuth during Server.listen: listenerLayer provides a
    // fresh ConfigProvider.fromEnv() on every listen, so the auth config
    // snapshots process.env at that point. listenThenClearCredentials keeps the
    // credentials present for the whole listen call, then deletes them so the
    // engine PTY children (which forward ...process.env) never inherit them.
    const serverListener = await listenThenClearCredentials<Listener>(() =>
      Server.listen({
        port: command.port,
        hostname: command.hostname,
        username: "ellamaka",
        password: command.password,
        cors: ["oc://renderer"],
      }),
    )
    listener = serverListener
    // Onboarding HTTP surface (Plan #230): the same /api/onboarding mount the
    // CLI `serve` command registers, installed directly on the Ellamaka
    // listener. The package is compiled into this bundle, so the dynamic import
    // resolves to the inlined module. `home` follows the start command's
    // WOPAL_HOME (the same value dshLaunch resolves) and the password captured
    // from the command (the env credentials are already cleared) puts the
    // surface behind the same credential the rest of the sidecar enforces. The
    // mount is removed in stop() before the listener closes.
    {
      const { mountOnboarding } = await import("@wopal/ellamaka-onboarding/mount")
      disposeOnboarding = mountOnboarding(serverListener, {
        home: command.wopalHome,
        serverPassword: command.password,
      })
    }
    // Server readiness is independent from DSH readiness: the window and the
    // native Runtime must not wait for DSH preparation (DESIGN-desktop.md).
    currentStartCommand = command
    const { resolveDshProfileIntent, setDshStatus } = await import("virtual:opencode-server")
    dshIntent = await resolveDshProfileIntent(dshLaunch(command).wopalHome, process.env)
    setDshStatus("web", dshIntent.web ? "preparing" : "disabled")
    setDshStatus("tools", dshIntent.tools ? "preparing" : "disabled")
    parentPort.postMessage({ type: "ready" })

    // Optional dsh engine (single-process, DESIGN-dsh-base.md). The
    // unified CorePreparation host service (consumed via `virtual:opencode-server`,
    // which the opencode sidecar bundle exports) uses the profile-specific Web setting and `ELLAMAKA_DSH_TOOLS` intent
    // (`=0` → disabled with zero file access) and materialises the closure on
    // demand; `disabled`/`degraded` never block the sidecar — the server runs
    // untouched. The web VirtualWebServer mounts onto the Ellamaka listener
    // under /dsh; the tool container (ellamaka-tools profile) feeds the
    // dsh-adapter so Workbench sessions can adopt container tools. A single
    // initialisation per launch is shared by both mounts (W-02); each mount is
    // wrapped in a degrade boundary so a broken closure never exits the
    // sidecar (B-06).
    dshInitialization = initializeDsh(command)
    await dshInitialization
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

/** Resolve the wopal home plus the DSH runtime log file and plugin-log directory. */
function dshLaunch(command: StartCommand) {
  const wopalHome = command.wopalHome ?? process.env.WOPAL_HOME ?? join(homedir(), ".wopal")
  const logDir = command.pluginLogDir ?? join(wopalHome, "logs")
  const runtimeLogFile = command.runtimeLogFile ?? join(wopalHome, "logs", "dsh-runtime.log")
  return { wopalHome, logDir, runtimeLogFile, home: join(wopalHome, "dsh") }
}

/**
 * Resolve the launch command for the dshmarket install worker (A3
 * desktopPnpm): the executable plus prefix args that reach the ellamaka CLI
 * entry, so the worker spawns `<command> dsh plugin --profile web ...` and
 * installs run through the ellamaka Bun installer. Without it the market
 * probes no `desktopProfiles` service and falls back to spawning the
 * OFFICIAL `dsh` CLI — whose installer is pnpm — and any install then fails
 * against private `@wopal/*` profile dependencies while pnpm quarantines
 * every previously installed plugin into `node_modules/.ignored/`.
 *
 * `process.execPath` is unusable here: under `utilityProcess.fork` it
 * resolves to Electron's helper executable, not a CLI, and `argv[1]` is the
 * sidecar bundle. So this host is the one case that needs the engine-binary
 * fallback — the shared `resolveInstallCommand` decision table
 * (`@wopal/ellamaka-cordis/plugins/install-command`) is asked with
 * `allowEngineFallback: true`, which:
 * 1. prefers `ELLAMAKA_DSH_INSTALL_COMMAND` — an authoritative
 *    whitespace-separated command string. dev.sh sets `bun
 *    <root>/packages/opencode/src/index.ts` so installs work without building
 *    the engine binary. The executable may be a PATH command such as `bun`,
 *    so that branch intentionally does not use existsSync: spawn resolves it
 *    using the sidecar PATH. An explicit invalid value must fail visibly
 *    instead of silently falling through to an older installed engine binary
 *    with a different CLI surface.
 * 2. otherwise falls back to `<wopalHome>/bin/ellamaka` — the engine binary
 *    the engine installer lays down under the WOPAL_HOME bin directory
 *    (resolveEngineBinaryPath in wopal-cli). `wopalHome` comes from the start
 *    command / sidecar env (the same value dshLaunch resolves), NOT from `~`
 *    directly — packaged desktop users with a custom WOPAL_HOME must resolve
 *    against their own home, and the env may be absent in the utility process.
 * Returns undefined when neither yields a usable command; the web mount
 * then logs `dsh.desktop.web.no-install-worker` and the market keeps its
 * CLI-spawn fallback (install attempts surface the mismatch explicitly).
 */
export async function resolveEllamakaInstallCommand(wopalHomeOverride?: string): Promise<string[] | undefined> {
  const wopalHome = wopalHomeOverride ?? process.env.WOPAL_HOME ?? join(homedir(), ".wopal")
  // Reached through the same seam every other cordis entry point uses; the
  // dynamic import keeps the sidecar's module-eval order unchanged.
  const { resolveInstallCommand } = await import("virtual:opencode-server")
  return resolveInstallCommand({
    argv: process.argv,
    execPath: process.execPath,
    isBun: process.versions.bun !== undefined,
    // The override is read from the same env the shared resolver consults;
    // injecting the resolved home keeps a custom WOPAL_HOME authoritative.
    env: { ...process.env, WOPAL_HOME: wopalHome },
    allowEngineFallback: true,
  })
}
/**
 * Mount the dsh web engine after unified product CorePreparation.
 *
 * Prepares the dsh host resources exactly once per launch (W-02) and reuses the
 * outcome for both the web and tool mounts. Only on `ready` does it resolve
 * the install anchor, load the closure runtime and mount the VirtualWebServer
 * onto the Ellamaka listener under `/dsh`. `disabled`/`degraded` return
 * without mounting (no warn: the manager already logged the structured
 * diagnosis). A broken closure degrades instead of crashing the sidecar
 * (B-06).
 */
async function mountDshIfPresent(command: StartCommand, legacyAdoptionConfirmed = false): Promise<void> {
  const { wopalHome, logDir, home } = dshLaunch(command)
  const { bootDshWeb, setDshUrlGetter, Log, toDshLogLevel } = await import("virtual:opencode-server")
  const sidecarLog = Log.create({ service: "dsh-desktop" })
  try {
    sidecarLog.info("dsh.desktop.web.start", { home, logDir })
    const launch = await initDshLaunch(command, legacyAdoptionConfirmed)
    if (!launch.web) return
    if (launch.webStatus !== "ready" || !launch.anchor || !launch.runtime) {
      sidecarLog.warn("dsh.desktop.web.skip", { status: launch.webStatus })
      return
    }
    sidecarLog.info("dsh.desktop.web.boot", { anchor: launch.anchor.path })
    const runtime = launch.runtime
    const ellamakaCommand = await resolveEllamakaInstallCommand(wopalHome)
    if (!ellamakaCommand) {
      sidecarLog.warn("dsh.desktop.web.no-install-worker", {
        reason: "no ELLAMAKA_DSH_INSTALL_COMMAND and no engine binary under WOPAL_HOME/bin",
      })
    }
    const host = await bootDshWeb({
      home,
      port: listener?.port ?? 0,
      installAnchor: launch.anchor.path,
      logDir,
      logLevel: toDshLogLevel(sidecarLogLevel.current),
      getLogLevel: () => toDshLogLevel(sidecarLogLevel.current),
      runtime,
      ellamakaCommand,
    })
    // Mount the VirtualWebServer under /dsh on the Ellamaka listener. The dsh
    // mount brings its own complete browser-auth (launch-token → signed
    // cookie fence), so it declares "self" on the host auth stack it bypasses.
    const unmount = listener?.mountNodeRoute({
      prefix: host.mountPath,
      auth: "self",
      request: (req, res) => host.webServer.request(req, res),
      upgrade: (req, socket, head) => host.webServer.upgrade(req, socket, head),
    })
    dshHost = {
      ctx: host.ctx,
      includeEntry: host.includeEntry,
      stackContext: host.stackContext,
      pluginActivation: host.pluginActivation,
      dispose: async () => {
        setDshUrlGetter(() => undefined)
        unmount?.()
        await host.dispose()
      },
    }
    // rc.1 browser-auth: publish the launch-token entry on the same
    // process-singleton holder the CLI mount uses, so the `/workbench/dsh-url`
    // endpoint answers with it and the Workbench iframe enters through the
    // authenticated flow instead of the unauthenticated `/dsh/` fallback.
    setDshUrlGetter(() => {
      try {
        return new URL(
          host.authenticatedPath,
          `http://${command.hostname}:${listener?.port ?? command.port}`,
        ).toString()
      } catch {
        return undefined
      }
    })
    const { setDshStatus } = await import("virtual:opencode-server")
    setDshStatus("web", "ready")
    sidecarLog.info("dsh.desktop.web.mounted", { mountPath: host.mountPath })
  } catch (error) {
    const { setDshStatus } = await import("virtual:opencode-server")
    setDshStatus("web", "degraded")
    // A broken closure must never exit the sidecar (B-06).
    sidecarLog.error("dsh.desktop.web.failed", {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    })
  }
}

/**
 * Mount the dsh tool container (ellamaka-tools profile) after the unified
 * CorePreparation result, and expose it via `globalThis.__ellamakaDshContainer` so
 * the dsh-adapter plugin can project container tools into ellamaka's
 * ToolRegistry. Same manager call as the web engine (single-flight, and this
 * launch's shared init result), only mounting on `ready`. `disabled`/`degraded`
 * skip silently; the adapter degrades to no projected tools and ellamaka
 * builtins keep serving.
 */
async function mountDshToolsIfPresent(command: StartCommand, legacyAdoptionConfirmed = false): Promise<void> {
  const { logDir, home } = dshLaunch(command)
  const { bootDshTools, Log, toDshLogLevel } = await import("virtual:opencode-server")
  const sidecarLog = Log.create({ service: "dsh-desktop" })
  try {
    const launch = await initDshLaunch(command, legacyAdoptionConfirmed)
    if (!launch.tools) return
    if (launch.toolsStatus !== "ready" || !launch.anchor || !launch.runtime) {
      sidecarLog.warn("dsh.desktop.tools.skip", { status: launch.toolsStatus })
      return
    }
    const runtime = launch.runtime
    sidecarLog.info("dsh.desktop.tools.boot", { anchor: launch.anchor.path })
    const host = await bootDshTools({
      home,
      port: 0,
      installAnchor: launch.anchor.path,
      logDir,
      logLevel: toDshLogLevel(sidecarLogLevel.current),
      getLogLevel: () => toDshLogLevel(sidecarLogLevel.current),
      runtime,
    })
    dshToolsHost = {
      ctx: host.ctx,
      includeEntry: host.includeEntry,
      stackContext: host.stackContext,
      dispose: () => host.dispose(),
    }
    ;(globalThis as Record<string, unknown>).__ellamakaDshContainer = host.ctx
    const { setDshStatus } = await import("virtual:opencode-server")
    setDshStatus("tools", "ready")
    sidecarLog.info("dsh.desktop.tools.mounted")
  } catch (error) {
    const { setDshStatus } = await import("virtual:opencode-server")
    setDshStatus("tools", "degraded")
    delete (globalThis as Record<string, unknown>).__ellamakaDshContainer
    // A broken closure must never exit the sidecar (B-06).
    sidecarLog.error("dsh.desktop.tools.failed", {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    })
  }
}

/**
 * Prepare DSH resources once per launch and cache the activation inputs
 * (W-02). Each profile keeps its own preparation terminal while both reuse the
 * same Home lease, install anchor and closure runtime.
 */
async function initDshLaunch(
  command: StartCommand,
  legacyAdoptionConfirmed = false,
): Promise<NonNullable<typeof dshLaunchState>> {
  if (dshLaunchState) return dshLaunchState
  const { wopalHome, runtimeLogFile } = dshLaunch(command)
  const {
    DEFAULT_DSH_RUNTIME_MANIFEST,
    acquireDshHomeRuntimeAccess,
    prepareDshProfiles,
    resolveInstallAnchor,
    createDshRuntimeApi,
    Log,
    toDshLogLevel,
  } = await import("virtual:opencode-server")
  const sidecarLog = Log.create({ service: "dsh-desktop" })
  const manifest = DEFAULT_DSH_RUNTIME_MANIFEST
  const intent =
    dshIntent ?? (await (await import("virtual:opencode-server")).resolveDshProfileIntent(wopalHome, process.env))
  dshIntent = intent
  sidecarLog.info("dsh.desktop.prepare.start", { wopalHome, runtimeLogFile })
  const preparation = await prepareDshProfiles({
    wopalHome,
    runtimeLogFile,
    logLevel: toDshLogLevel(sidecarLogLevel.current),
    profiles: intent.profiles,
    ...(legacyAdoptionConfirmed ? { legacyAdoptionConfirmed: true } : {}),
  })
  const webStatus: import("virtual:opencode-server").DshRuntimeStatus =
    preparation.web.status === "prepared" ? "ready" : preparation.web.status
  const toolsStatus: import("virtual:opencode-server").DshRuntimeStatus =
    preparation.tools.status === "prepared" ? "ready" : preparation.tools.status
  const reason = preparation.web.preparation?.reason ?? preparation.tools.preparation?.reason
  sidecarLog.info("dsh.desktop.prepare.status", {
    web: webStatus,
    tools: toolsStatus,
    ...(reason ? { reason } : {}),
  })
  if (webStatus !== "ready" && toolsStatus !== "ready") {
    dshLaunchState = { webStatus, toolsStatus, ...intent, ...(reason ? { reason } : {}) }
    return dshLaunchState
  }
  const homeAccess = await acquireDshHomeRuntimeAccess({
    wopalHome,
    closureVersion: manifest.closureVersion,
  })
  if (!homeAccess.ok) {
    sidecarLog.error("dsh.desktop.home-access.failed", {
      reason: homeAccess.reason,
      homeVersion: homeAccess.homeVersion,
      closureVersion: manifest.closureVersion,
    })
    const { setDshStatus } = await import("virtual:opencode-server")
    if (intent.web) setDshStatus("web", "degraded")
    if (intent.tools) setDshStatus("tools", "degraded")
    dshLaunchState = {
      webStatus: intent.web ? "degraded" : "disabled",
      toolsStatus: intent.tools ? "degraded" : "disabled",
      ...intent,
    }
    return dshLaunchState
  }
  dshHomeAccess = { lease: homeAccess.lease, homeVersion: homeAccess.homeVersion }
  try {
    const anchor = resolveInstallAnchor(wopalHome, manifest)
    const runtime = createDshRuntimeApi(anchor.path)
    sidecarLog.info("dsh.desktop.init.ready", { anchor: anchor.path, genId: anchor.genId })
    dshLaunchState = { webStatus, toolsStatus, ...intent, anchor, runtime, ...(reason ? { reason } : {}) }
    return dshLaunchState
  } catch (error) {
    await dshHomeAccess.lease.release()
    dshHomeAccess = undefined
    sidecarLog.error("dsh.desktop.init.load.failed", {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    })
    const { setDshStatus } = await import("virtual:opencode-server")
    if (intent.web) setDshStatus("web", "degraded")
    if (intent.tools) setDshStatus("tools", "degraded")
    dshLaunchState = {
      webStatus: intent.web ? "degraded" : "disabled",
      toolsStatus: intent.tools ? "degraded" : "disabled",
      ...intent,
    }
    return dshLaunchState
  }
}

/**
 * Prepare and mount DSH after server readiness. A failure degrades DSH only;
 * the listener, native Runtime and window stay available.
 */
async function initializeDsh(command: StartCommand, legacyAdoptionConfirmed = false): Promise<void> {
  try {
    // Prepare shared closure/Home and both requested profile resources first,
    // then activate Web and Tools independently. A slow or failed profile load
    // must not delay the other profile reaching its own terminal status.
    await initDshLaunch(command, legacyAdoptionConfirmed)
    await Promise.all([
      mountDshIfPresent(command, legacyAdoptionConfirmed),
      mountDshToolsIfPresent(command, legacyAdoptionConfirmed),
    ])
    if (!dshWatcherStarted && (dshHost?.includeEntry || dshToolsHost?.includeEntry)) {
      await startDshPluginWatcher(command)
      if (dshPluginService) dshWatcherStarted = true
    }
    if (dshLaunchState?.reason === "DSH_HOME_LEGACY_ADOPTION_REQUIRED")
      parentPort.postMessage({ type: "dshLegacyAdoptionRequired" })
  } catch (error) {
    const { Log, setDshStatus } = await import("virtual:opencode-server")
    if (dshIntent?.web) setDshStatus("web", "degraded")
    if (dshIntent?.tools) setDshStatus("tools", "degraded")
    Log.create({ service: "dsh-desktop" }).error("dsh.desktop.initialize.failed", {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    })
  }
}

/** One-time adoption requested by the window-level confirmation dialog. */
async function adoptLegacyDshHome(): Promise<void> {
  const command = currentStartCommand
  if (!command) return
  // The startup preparation may still be running; wait so adoption never
  // races it into two mounts of the same profile.
  await dshInitialization?.catch(() => undefined)
  const { Log } = await import("virtual:opencode-server")
  Log.create({ service: "dsh-desktop" }).info("dsh.desktop.legacy-adoption.start")
  dshLaunchState = undefined
  if (dshHomeAccess) {
    await dshHomeAccess.lease.release()
    dshHomeAccess = undefined
  }
  await initializeDsh(command, true)
}

/**
 * Start the Plugin Runtime Service (D-02, rook B-07): watch the plugin store
 * and hot-replay include patches into whichever profiles are running, so dsh plugin
 * add/remove/enable/disable executed while the Desktop app runs take effect
 * without a restart. A failed watcher start
 * degrades without crashing the sidecar (B-06).
 */
async function startDshPluginWatcher(command: StartCommand): Promise<void> {
  if (!dshHost?.includeEntry && !dshToolsHost?.includeEntry) {
    const { Log } = await import("virtual:opencode-server")
    Log.create({ service: "dsh-desktop" }).warn("dsh.desktop.watcher.skip", {
      reason: "no dsh profile is mounted",
    })
    return
  }
  const { home } = dshLaunch(command)
  try {
    const { startDshPluginService, Log } = await import("virtual:opencode-server")
    const sidecarLog = Log.create({ service: "dsh-desktop" })
    const containers = [
      ...(dshHost?.includeEntry
        ? [{ profile: "web", ctx: dshHost.ctx, includeEntry: dshHost.includeEntry, stackContext: dshHost.stackContext }]
        : []),
      ...(dshToolsHost?.includeEntry
        ? [
            {
              profile: "ellamaka-tools",
              ctx: dshToolsHost.ctx,
              includeEntry: dshToolsHost.includeEntry,
              stackContext: dshToolsHost.stackContext,
            },
          ]
        : []),
    ]
    dshPluginService = startDshPluginService({
      home,
      containers,
      // The mounted web context owns the dsh-plugins exporter. Routing the
      // watcher through it avoids the service's console fallback, which the
      // Desktop main process would otherwise relay as a WARN for every event.
      logger: dshPluginLogger(dshHost?.ctx ?? dshToolsHost?.ctx, sidecarLog),
    })
    dshHost?.pluginActivation?.bind(() => dshPluginService!.replay())
    sidecarLog.info("dsh.desktop.watcher.started")
  } catch (error) {
    // A failed watcher must never exit the sidecar (B-06); installs simply
    // apply at next launch.
    const { Log } = await import("virtual:opencode-server")
    Log.create({ service: "dsh-desktop" }).error("dsh.desktop.watcher.failed", {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    })
  }
}

async function stop() {
  try {
    delete (globalThis as Record<string, unknown>).__ellamakaDshContainer
    // Stop the store watcher FIRST so it cannot replay into containers that
    // are mid-dispose (rook B-07).
    await dshPluginService?.stop()
    dshPluginService = undefined
    await dshToolsHost?.dispose()
    dshToolsHost = undefined
    await dshHost?.dispose()
    dshHost = undefined
    if (dshHomeAccess) await dshHomeAccess.lease.release()
    dshHomeAccess = undefined
    // Unregister the onboarding mount before the listener closes (Plan #230).
    disposeOnboarding?.()
    disposeOnboarding = undefined
    await listener?.stop()
  } finally {
    listener = undefined
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

async function setLogLevel(level: "DEBUG" | "INFO" | "WARN" | "ERROR") {
  const { Log } = await import("virtual:opencode-server")
  setSidecarLogLevel(level)
  // The hub owns the process-tree value: keep the inherited env in sync so a
  // child launched after a live toggle speaks the toggled level too.
  process.env.ELLAMAKA_LOG_LEVEL = level
  Log.setLevel(level)
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

function useSystemCertificates(log: WarningLogger) {
  try {
    const nodeTls = tls as NodeTlsWithSystemCertificates
    nodeTls.setDefaultCACertificates([
      ...new Set([...nodeTls.getCACertificates("default"), ...nodeTls.getCACertificates("system")]),
    ])
  } catch (error) {
    log.warn("failed to load system certificates", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function useEnvProxy(log: WarningLogger) {
  try {
    const setGlobalProxyFromEnv = Reflect.get(http, "setGlobalProxyFromEnv")
    if (typeof setGlobalProxyFromEnv !== "function") throw new Error("setGlobalProxyFromEnv unavailable")
    Reflect.apply(setGlobalProxyFromEnv, http, [])
  } catch (error) {
    log.warn("failed to load proxy environment", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function dshPluginLogger(ctx: unknown, fallback: DshPluginLogger): DshPluginLogger {
  if (typeof ctx !== "object" || ctx === null || !("logger" in ctx) || typeof ctx.logger !== "function") {
    return fallback
  }
  try {
    const logger = ctx.logger("dsh-plugins")
    if (typeof logger === "object" && logger !== null) {
      const info = Reflect.get(logger, "info")
      const warn = Reflect.get(logger, "warn")
      const error = Reflect.get(logger, "error")
      if (typeof info === "function" && typeof warn === "function" && typeof error === "function") {
        return {
          info: (message, extra) => Reflect.apply(info, logger, [message, extra]),
          warn: (message, extra) => Reflect.apply(warn, logger, [message, extra]),
          error: (message, extra) => Reflect.apply(error, logger, [message, extra]),
        }
      }
    }
  } catch {
    // The sidecar still has its structured log as a safe fallback.
  }
  return fallback
}

function parseCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return undefined
  const command = value as Partial<StartCommand | StopCommand | SetLogLevelCommand>
  if (command.type === "stop") return { type: "stop" }
  if (command.type === "setLogLevel") {
    if (
      command.level === "DEBUG" ||
      command.level === "INFO" ||
      command.level === "WARN" ||
      command.level === "ERROR"
    ) {
      return { type: "setLogLevel", level: command.level }
    }
    return undefined
  }
  if (command.type !== "start") return undefined
  if (typeof command.hostname !== "string") return undefined
  if (typeof command.port !== "number") return undefined
  if (typeof command.password !== "string") return undefined
  if (typeof command.needsMigration !== "boolean") return undefined
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    needsMigration: command.needsMigration,
    wopalHome: typeof command.wopalHome === "string" ? command.wopalHome : undefined,
    pluginLogDir: typeof command.pluginLogDir === "string" ? command.pluginLogDir : undefined,
    runtimeLogFile: typeof command.runtimeLogFile === "string" ? command.runtimeLogFile : undefined,
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function getParentPort() {
  const port = process.parentPort as ParentPort | undefined
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
