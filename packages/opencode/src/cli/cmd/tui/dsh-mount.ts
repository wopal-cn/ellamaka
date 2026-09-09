import { Global } from "@wopal/ellamaka-core/global"
import { join } from "node:path"
import {
  DEFAULT_DSH_RUNTIME_MANIFEST,
  initializeDshRuntime,
  resolveInstallAnchor,
} from "@wopal/ellamaka-cordis/runtime"
import { createDshRuntimeApi } from "@wopal/ellamaka-cordis/runtime/loader"
import { setDshStatus } from "@/workbench/dsh-status"

const CONTAINER_KEY = "__ellamakaDshContainer"

export interface DshMountOptions {
  /** The wopal home (`$WOPAL_HOME`); the dsh home derives as `<home>/dsh`. */
  wopalHome?: string
  /** Path to the dedicated dsh-plugins log file. */
  logFile?: string
}

export interface DshMountHandle {
  dispose(): Promise<void>
}

/**
 * Mount the dsh tool container for the in-process TUI.
 *
 * The TUI has no iframe surface, so it mounts only the tool container
 * (ellamaka-tools profile, agent-loop plugins disabled) and exposes it on
 * `globalThis.__ellamakaDshContainer` for the dsh-adapter plugin. Tools then
 * execute with a lightweight per-call context — no live dsh sessions.
 *
 * Assembly (DESIGN-dsh-poc §3.4.4): the unified Runtime Manager gates on
 * `ELLAMAKA_DSH` itself (`=0` → `disabled` with zero file access) and is
 * called unconditionally; `ready` mounts the tool container with the closure
 * runtime injected; `disabled`/`degraded` return `undefined` and the TUI runs
 * untouched.
 */
export async function mountDshIfEnabled(opts: DshMountOptions = {}): Promise<DshMountHandle | undefined> {
  const wopalHome = opts.wopalHome ?? Global.Path.wopalHome
  const logFile = opts.logFile ?? join(Global.Path.log, "dsh-plugins.log")
  const manifest = DEFAULT_DSH_RUNTIME_MANIFEST
  const home = join(wopalHome, "dsh")

  // B-class official-layout resolution (`resolveDshHome()` env reads) looks
  // up `$DSH_HOME` and falls back to `~/.dsh` when it is unset. Point it at
  // the DSH home so agent presets and every other env-reading plugin land in
  // `$WOPAL_HOME/dsh/home`, matching the dev.sh / Desktop-sidecar host
  // contract (constraint #10). The env write is process-local: the TUI never
  // mutates the caller's shell environment.
  process.env.DSH_HOME = join(home, "home")

  const status = await initializeDshRuntime({
    wopalHome,
    logFile,
    entry: "tui",
    manifest,
  })
  // Publish the terminal runtime status so /global/health answers with a
  // runtime fact even when the TUI (not the workbench) hosts the server.
  setDshStatus(status)
  if (status !== "ready") return undefined

  const anchor = resolveInstallAnchor(wopalHome, manifest)

  // Degrade boundary (B-06): a broken closure must never crash the TUI host.
  // Load the closure runtime, then init+mount; any failure is logged, partial
  // resources are disposed, and the TUI keeps running with no dsh.
  type DshModule = typeof import("@wopal/ellamaka-cordis/dsh-web")
  type DshHubCtx = Parameters<DshModule["mountDshTools"]>[0]
  let hub: { ctx: DshHubCtx; dispose(): Promise<void> } | undefined
  try {
    const runtime = createDshRuntimeApi(anchor.path)
    const { CordisHub } = await import("@wopal/ellamaka-cordis")
    const { mountDshTools } = await import("@wopal/ellamaka-cordis/dsh-web")
    // The closure-resolved context is injected so the hub NEVER falls back to
    // the host package closure, which packaged builds do not carry (B-01).
    hub = new CordisHub(null, { context: new runtime.cordis.Context() })
    const host = await mountDshTools(hub.ctx, {
      home,
      port: 0,
      logFile,
      installAnchor: anchor.path,
      runtime,
    })
    ;(globalThis as Record<string, unknown>)[CONTAINER_KEY] = hub.ctx

    // Plugin Runtime Service (D-02): the TUI hosts a single tool container;
    // the watcher replays store changes into it. A degraded watcher never
    // breaks the TUI.
    let pluginService: { stop(): Promise<void> } | undefined
    try {
      const { startDshPluginService } = await import("@wopal/ellamaka-cordis/plugins/runtime")
      pluginService = startDshPluginService({
        home,
        containers: [{ profile: "ellamaka-tools", ctx: hub.ctx, includeEntry: host.includeEntry }],
      })
    } catch (error) {
      console.error(`dsh plugin runtime service failed to start: ${(error as Error).message}`)
    }

    return {
      dispose: async () => {
        delete (globalThis as Record<string, unknown>)[CONTAINER_KEY]
        await pluginService?.stop()
        await host.dispose()
        await hub?.dispose()
      },
    }
  } catch (error) {
    console.error(`dsh tool container mount failed: ${(error as Error).message}`)
    try {
      await hub?.dispose()
    } catch {
      // Best-effort partial disposal; the TUI continues regardless.
    }
    delete (globalThis as Record<string, unknown>)[CONTAINER_KEY]
    return undefined
  }
}
