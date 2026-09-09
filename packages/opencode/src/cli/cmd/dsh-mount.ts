import { Global } from "@wopal/ellamaka-core/global"
import { join } from "node:path"
import type { Listener } from "../../server/server"
import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { Config } from "@/config/config"
import {
  DEFAULT_DSH_RUNTIME_MANIFEST,
  initializeDshRuntime,
  resolveInstallAnchor,
} from "@wopal/ellamaka-cordis/runtime"
import { createDshRuntimeApi } from "@wopal/ellamaka-cordis/runtime/loader"
import { resolveInstallCommand } from "@wopal/ellamaka-cordis/plugins/install-command"
import { setDshUrlGetter } from "@/workbench/dsh-url"
import { setDshStatus } from "@/workbench/dsh-status"

export interface DshEngineMountOptions {
  /** Override the wopal home; defaults to `$WOPAL_HOME`. */
  wopalHome?: string
  /** Override the dsh-plugins log file; defaults to `$WOPAL_HOME/logs/dsh-plugins.log`. */
  logFile?: string
  /** The entry name the runtime manager logs under; defaults to `serve`. */
  entry?: "serve" | "web"
}

/**
 * Read `ellamaka.dsh.trustedHosts` from the global settings.jsonc
 * (auth-fix-1, D-02: the official config surface, default-value layer).
 * Goes through the standard Config loader (`getGlobal`) so the value gets
 * the SAME variable substitution (`{env:VAR}`, `{file:path}`) and schema
 * acceptance as every other settings key (W-01); the loader already degrades
 * a broken settings file to `{}`, and a missing key yields the fail-closed
 * `[]` default — a broken settings file must not take down the dsh mount.
 *
 * This runs once per engine mount at startup, before any request can arrive,
 * so the loader's cached global snapshot is fresh by construction; reading
 * live instead of through the cache would risk a mid-run settings edit
 * half-applying to a running fence. A settings file that is unparsable or
 * schema-invalid dies inside the loader (sync throw, not a failed Effect),
 * so the catch below is the fail-closed backstop — matching the loader's own
 * broken-file semantics (log + `{}`) one layer up.
 */
export async function readDshTrustedHosts(): Promise<readonly string[]> {
  try {
    const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
    return [...(config.dsh?.trustedHosts ?? [])]
  } catch (error) {
    console.error("failed to read dsh.trustedHosts from global settings; using the empty default", error)
    return []
  }
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
      // auth-fix-1: the configured LAN authorities ride the web-runtime row
      // into the official webRuntime -> connection fence chain.
      trustedHosts: await readDshTrustedHosts(),
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
    setDshUrlGetter(() => {
      try {
        return new URL(dsh.authenticatedPath, server.url?.origin ?? "http://127.0.0.1").toString()
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
