interface ImportMetaEnv {
  readonly OPENCODE_CHANNEL: string
  readonly MIN_WOPAL_CLI_VERSION: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:opencode-server" {
  export namespace Server {
    export const listen: typeof import("../../../opencode/dist/types/src/node").Server.listen
    export type Listener = import("../../../opencode/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../opencode/dist/types/src/node").Config.get
    export type Info = import("../../../opencode/dist/types/src/node").Config.Info
  }
  export namespace Log {
    export const init: typeof import("@wopal/ellamaka-core/util/log").Log.init
    export const setLevel: typeof import("@wopal/ellamaka-core/util/log").Log.setLevel
    export const create: typeof import("@wopal/ellamaka-core/util/log").Log.create
    export type Logger = import("@wopal/ellamaka-core/util/log").Log.Logger
  }
  export namespace Database {
    export const getPath: typeof import("../../../opencode/dist/types/src/node").Database.getPath
    export const Client: typeof import("../../../opencode/dist/types/src/node").Database.Client
  }
  export namespace JsonMigration {
    export type Progress = import("../../../opencode/dist/types/src/node").JsonMigration.Progress
    export const run: typeof import("../../../opencode/dist/types/src/node").JsonMigration.run
  }
  export const bootstrap: typeof import("../../../opencode/dist/types/src/node").bootstrap

  /**
   * The DSH runtime wiring surface (DESIGN-dsh-poc §3.4), re-exported as flat
   * symbols by the opencode `node.ts` and consumed by the sidecar to drive the
   * unified Runtime Manager and mount the web/tool containers. Typed
   * structurally so the desktop package needs no `@wopal/ellamaka-cordis`
   * dependency; the value side is compiled into the sidecar bundle.
   */
  export type DshRuntimeStatus = "disabled" | "preparing" | "ready" | "degraded"

  export interface DshRuntimeManifest {
    schema: "ellamaka.dsh-runtime/v1"
    bridgeAbi: number
    dependencies: Record<string, string>
    fingerprint?: string
  }

  export interface DshInstallAnchor {
    path: string
    genId: string
  }

  export interface DshInitializeOptions {
    wopalHome: string
    logFile: string
    entry: "serve" | "web" | "tui"
    manifest: DshRuntimeManifest
  }

  export const initializeDshRuntime: (options: DshInitializeOptions) => Promise<DshRuntimeStatus>
  export const DEFAULT_DSH_RUNTIME_MANIFEST: DshRuntimeManifest
  export const resolveInstallAnchor: (wopalHome: string, manifest: DshRuntimeManifest) => DshInstallAnchor
  export const createDshRuntimeApi: (installAnchor: string) => DshRuntimeApi

  /** The six official DSH runtime modules resolved from the closure. */
  export interface DshRuntimeApi {
    cordis: unknown
    pluginLoader: unknown
    appBoot: unknown
    cmdline: unknown
    launchEnv: unknown
    hostWebserver: unknown
  }

  export interface DshWebHostOptions {
    home?: string
    port: number
    installAnchor?: string
    logFile?: string
    runtime?: DshRuntimeApi
    disableCodeRuntime?: boolean
    /**
     * Launch command the dshmarket install worker re-spawns for `dsh plugin`
     * operations (A3 desktopPnpm). Omitting it leaves the market on its
     * CLI-spawn fallback (official `dsh` CLI, pnpm installer).
     */
    ellamakaCommand?: readonly string[]
  }

  export interface DshWebHost {
    mountPath: "/dsh"
    /** The rc.1 browser-auth launch-token entry path (`/dsh/?token=...`). */
    readonly authenticatedPath: string
    webServer: {
      request(req: unknown, res: unknown): void
      upgrade(req: unknown, socket: unknown, head: unknown): void
    }
    ctx: unknown
    includeEntry: DshPluginIncludeEntry
    stackContext: unknown
    pluginActivation?: {
      bind(replay: () => Promise<{ ok: true } | { ok: false; error: string }>): void
    }
    dispose(): Promise<void>
  }

  export interface DshToolsHost {
    ctx: unknown
    includeEntry: DshPluginIncludeEntry
    stackContext: unknown
    dispose(): Promise<void>
  }

  /** The include entry handle the Plugin Runtime Service replays patches on. */
  export interface DshPluginIncludeEntry {
    id: string
    update(options: unknown): Promise<void>
  }

  export interface DshPluginServiceOptions {
    home: string
    containers: Array<{
      profile: string
      ctx?: unknown
      includeEntry: DshPluginIncludeEntry
      stackContext?: unknown
    }>
    intervalMs?: number
  }

  export const bootDshWeb: (opts: DshWebHostOptions) => Promise<DshWebHost>
  export const bootDshTools: (opts: DshWebHostOptions) => Promise<DshToolsHost>
  export const startDshPluginService: (options: DshPluginServiceOptions) => {
    replay(): Promise<{ ok: true } | { ok: false; error: string }>
    stop(): Promise<void>
  }
  /** Publish the DSH runtime terminal status for `/global/health`. */
  export const setDshStatus: (status: DshRuntimeStatus) => void
  /** Publish (or clear with `() => undefined`) the authenticated entry getter. */
  export const setDshUrlGetter: (get: () => string | undefined) => void
}
