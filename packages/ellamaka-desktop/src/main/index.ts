import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow, dialog } from "electron"

import contextMenu from "electron-context-menu"

import type { InitStep, SidecarRuntimeState, SqliteMigrationProgress } from "../preload/types"
import { checkAppExists } from "./apps"
import { CHANNEL, UPDATER_ENABLED } from "./constants"
import {
  broadcastSidecarState,
  registerIpcHandlers,
  sendDeepLinks,
  sendMenuCommand,
  sendSqliteMigrationProgress,
  unregisterIpcHandlers,
} from "./ipc"
import {
  exportDebugLogs,
  initCrashReporter,
  initLogging,
  isDebugLogging,
  setSidecarLogLevelHandler,
  startNetLog,
  toggleDebugLogging,
  write as writeLog,
} from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import { createSidecarSpawner, type DesktopHostEnvironment } from "./server"
import { SidecarSupervisor } from "./sidecar-supervisor"
import {
  createLoadingWindow,
  createMainWindow,
  registerRendererProtocol,
  setDshProxyTarget,
  getDshHttpProxyOrigin,
  setRelaunchHandler,
  setBackgroundColor,
  setDockIcon,
} from "./windows"
import { migrate } from "./migrate"
import { needsJsonMigration } from "./migration-check"
import { enableQuitGuard, interceptWindowClose } from "./quit-guard"
import { getReleaseInfo } from "./release-info"
import { checkUpdate, checkForUpdates, installUpdate, setupAutoUpdater } from "./updater"
import { bindDesktopProductRoot } from "./onboarding-gate"
import { resolveDesktopHostEnvironment } from "./shell-env"
import { isVmwareVirtualGpu } from "./gpu-detect"
import { recoverMainWindow } from "./window-show-guard"
import { resolveAppId, resolveUserDataPath } from "./user-data"
import { Deferred, Effect, Fiber } from "effect"

const APP_NAMES: Record<string, string> = {
  main: "Ellamaka Main",
  beta: "Ellamaka Beta",
  stable: "Ellamaka",
}
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let mainWindow: BrowserWindow | null = null

/**
 * One-time confirmation for an unversioned DSH Home. The sidecar reports the
 * need after the window is available; the dialog never blocks server startup
 * or native sessions. Declining keeps DSH degraded.
 */
let pendingDshLegacyAdoption = false
async function confirmDshLegacyAdoption() {
  if (!mainWindow) {
    pendingDshLegacyAdoption = true
    return
  }
  pendingDshLegacyAdoption = false
  const result = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "DSH Home adoption",
    message: "An existing DSH Home needs a one-time adoption",
    detail:
      "Quit any older Ellamaka or DSH processes first. Ellamaka will back up Home before recording the new version.",
    buttons: ["Back up and adopt", "Not now"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  if (result.response === 0) supervisor?.adoptLegacyDshHome()
}
let supervisor: SidecarSupervisor | null = null

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    const withProxy = http as typeof http & { setGlobalProxyFromEnv?: () => void }
    withProxy.setGlobalProxyFromEnv?.()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
}

function setInitStep(step: InitStep) {
  initStep = step
  logger.log("init step", { step })
  initEmitter.emit("step", step)
}

async function killSidecar() {
  if (!supervisor) return
  await supervisor.stop("quit")
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

// Allocate an ephemeral loopback port. Honors ELLAMAKA_PORT for tests/dev,
// otherwise binds to a kernel-assigned port (listen 0) and returns it.
const allocatePort = Effect.gen(function* () {
  const fromEnv = process.env.ELLAMAKA_PORT
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  const res = yield* Deferred.make<number, unknown>()
  const server = createServer()
  server.on("error", (e) => Deferred.failSync(res, () => e))
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (typeof address !== "object" || !address) {
      server.close()
      Deferred.failSync(res, () => new Error("Failed to get port"))
      return
    }
    const port = address.port
    server.close(() => Effect.runSync(Deferred.succeed(res, port)))
  })
  return yield* Deferred.await(res)
})

// Attach window close-intercept + application menu used by the workbench
// (real sidecar) so the menu's restart/relaunch/export actions always bind to
// the live supervisor.
function attachWorkbenchChrome(win: BrowserWindow) {
  interceptWindowClose(win, {
    getSidecarState: () => supervisor?.getState(),
    stopSidecar: killSidecar,
  })
  createMenu({
    trigger: (id) => {
      const w = BrowserWindow.getFocusedWindow() ?? mainWindow
      if (w) sendMenuCommand(w, id)
    },
    checkForUpdates: () => {
      void checkForUpdates(true, killSidecar)
    },
    relaunch: () => {
      void killSidecar().finally(() => {
        app.relaunch()
        app.exit(0)
      })
    },
    restartSidecar: () => {
      void supervisor?.restart("user")
    },
    exportLogs: () => {
      void exportDebugLogs()
    },
    toggleDebugLogging: () => {
      toggleDebugLogging()
    },
    isDebugLogging: () => isDebugLogging(),
  })
}

interface StartWorkbenchOpts {
  // Deferred resolved by the loading window's ready-to-show. Only used on
  // fresh boot when a sqlite migration overlay is shown.
  loadingComplete?: Deferred.Deferred<void>
  // The one Host Environment snapshot resolved for this launch. Every consumer
  // (sidecar env, DSH paths, IPC state root, restarts) reuses it unchanged.
  host: DesktopHostEnvironment
}

// Bring up the workbench: allocate port, spawn SidecarSupervisor, register
// IPC handlers, fork sidecar startup, await readiness, then show the window.
const startWorkbench = (opts: StartWorkbenchOpts) =>
  Effect.gen(function* () {
    migrate()
    app.setAsDefaultProtocolClient("ellamaka")
    registerRendererProtocol()
    setDockIcon()
    setupAutoUpdater()
    yield* Effect.promise(() => startNetLog()).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          logger.warn("failed to start net log", error)
        }),
      ),
    )

    const needsMigration = needsJsonMigration(process.env, opts.host.home)

    const port = yield* allocatePort
    const hostname = "127.0.0.1"
    const url = `http://${hostname}:${port}`
    const password = randomUUID()

    supervisor = new SidecarSupervisor({
      spawn: createSidecarSpawner(needsMigration, opts.host),
      setTimeout,
      clearTimeout,
      hostname,
      port,
      password,
      onSqliteProgress: (progress) => initEmitter.emit("sqlite", progress),
      onDshLegacyAdoptionRequired: () => void confirmDshLegacyAdoption(),
      onStdout: (message) => writeLog("server", "stdout", { message }),
      onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
      onExit: (code) => writeLog("utility", "sidecar exited", { code }, "warn"),
    })

    setSidecarLogLevelHandler((level) => supervisor?.setLogLevel(level))
    supervisor.subscribe((state: SidecarRuntimeState) => {
      setDshProxyTarget(state.status === "ready" ? state.connection?.url : undefined)
      broadcastSidecarState(state)
    })

    // Remove any previously-registered handlers before registering (defensive
    // idempotence for dev HMR; no-op on fresh boot). Electron forbids a second
    // handler for the same channel.
    unregisterIpcHandlers()
    registerIpcHandlers({
      homePath: opts.host.home,
      killSidecar: () => killSidecar(),
      awaitInitialization: Effect.fnUntraced(
        function* (sendStep) {
          sendStep(initStep)
          const listener = (step: InitStep) => sendStep(step)
          initEmitter.on("step", listener)
          try {
            logger.log("awaiting server ready")
            const state = yield* Effect.promise(() => supervisor!.waitForReady())
            logger.log("server ready", { url: state.connection?.url })
            return {
              url: state.connection?.url ?? "",
              username: state.connection?.username ?? null,
              password: state.connection?.password ?? null,
            }
          } finally {
            initEmitter.off("step", listener)
          }
        },
        (e) => Effect.runPromise(e),
      ),
      getWindowConfig: () => ({
        updaterEnabled: UPDATER_ENABLED,
        version: getReleaseInfo().displayVersion,
        dshProxyOrigin: getDshHttpProxyOrigin(),
      }),
      consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
      getDisplayBackend: async () => null,
      setDisplayBackend: async () => undefined,
      parseMarkdown: async (markdown) => parseMarkdown(markdown),
      // Native app discovery runs in Main, which keeps the GUI-minimal inherited
      // PATH. Pass the resolved Host Environment so a login-shell-only executable
      // is still found without writing the shell env back into process.env.
      checkAppExists: (appName) => checkAppExists(appName, opts.host.env),
      loadingWindowComplete: () => {
        if (opts.loadingComplete) Deferred.doneUnsafe(opts.loadingComplete, Effect.void)
      },
      runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail, killSidecar),
      checkUpdate: async () => checkUpdate(),
      installUpdate: async () => installUpdate(killSidecar),
      setBackgroundColor: (color) => setBackgroundColor(color),
      exportDebugLogs: () => exportDebugLogs(),
      recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
      getSidecarState: () => supervisor!.getState(),
      restartSidecar: () => supervisor!.restart("user"),
      subscribeToSidecarState: (listener) => supervisor!.subscribe(listener),
    })

    // forkDetach (not forkChild) so the sidecar keeps running in the
    // background while the main fiber returns and the window is shown.
    // forkChild auto-supervises: when the parent (startWorkbench) returns,
    // the child is terminated, which would kill the sidecar mid-startup.
    const loadingTask = yield* Effect.gen(function* () {
      logger.log("sidecar connection started", { url })
      initEmitter.on("sqlite", (progress: SqliteMigrationProgress) => {
        setInitStep({ phase: "sqlite_waiting" })
        if (mainWindow) sendSqliteMigrationProgress(mainWindow, progress)
      })
      ensureLoopbackNoProxy()
      useEnvProxy()
      logger.log("starting sidecar supervisor", { url })
      yield* Effect.promise(() => supervisor!.start())
      logger.log("loading task finished")
    }).pipe(Effect.forkDetach)

    let overlay: BrowserWindow | null = null
    if (needsMigration) {
      const show = yield* loadingTask.pipe(
        Fiber.await,
        Effect.timeout("1 second"),
        Effect.as(false),
        Effect.catch(() => Effect.succeed(true)),
      )
      if (show) {
        overlay = createLoadingWindow()
        yield* Effect.sleep("1 second")
      }
    }
    yield* Fiber.await(loadingTask)
    setInitStep({ phase: "done" })
    if (overlay && opts.loadingComplete) yield* Deferred.await(opts.loadingComplete)
    mainWindow = createMainWindow()
    if (mainWindow) attachWorkbenchChrome(mainWindow)
    overlay?.close()
    if (mainWindow && pendingDshLegacyAdoption) void confirmDshLegacyAdoption()
  })

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  const appId = resolveAppId(app.isPackaged, CHANNEL)
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "Ellamaka Dev")
  app.setAppUserModelId(appId)
  // Electron userData always lives under the OS standard app-data directory,
  // keyed by appId. Development builds use a distinct appId
  // (`ai.ellamaka.desktop.<channel>` vs `ai.ellamaka.desktop.local`), so dev
  // runs never touch the packaged app's settings without redirecting userData
  // into WOPAL_HOME — see #233 for the regression this avoids.
  app.setPath("userData", resolveUserDataPath(app.isPackaged, app.getPath("appData"), CHANNEL))
  logger = initLogging()
  initCrashReporter()

  // On Windows VMs (VMware SVGA 3D virtual GPU) the GPU compositor never
  // completes the first frame, so `ready-to-show` never fires and the window
  // stays hidden. Disable hardware acceleration before any window is created.
  // Fail-open: detection errors never block startup.
  if (isVmwareVirtualGpu()) {
    app.disableHardwareAcceleration()
    writeLog("main", "hardware acceleration disabled", { reason: "vmware-svga" })
  }

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged && process.env.ELLAMAKA_DESKTOP_CDP === "1") {
    app.commandLine.appendSwitch("remote-debugging-port", process.env.ELLAMAKA_DESKTOP_CDP_PORT ?? "9222")
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("ellamaka://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    // Show + focus the existing window, or recreate it if it was destroyed or
    // never created. The new window shows itself via ready-to-show/fallback;
    // no IPC re-registration or mode setup is needed here.
    mainWindow = recoverMainWindow(mainWindow, () => createMainWindow())
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("will-quit", () => {
    void killSidecar()
  })

  // Install quit guard: Cmd+Q confirmation + macOS window-all-closed / activate
  enableQuitGuard({
    getMainWindow: () => mainWindow,
    getSidecarState: () => supervisor?.getState(),
    stopSidecar: killSidecar,
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: webContents.getURL(), details }, "error")
  })

  setRelaunchHandler(() => {
    void killSidecar().finally(() => {
      app.relaunch()
      app.exit(0)
    })
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void killSidecar().finally(() => app.exit(0))
    })
  }

  const loadingComplete = Deferred.makeUnsafe<void>()

  yield* Effect.promise(() => app.whenReady())

  // Resolve the Host Environment exactly once for this run: POSIX login shell
  // resolution, the global `wopal.execution.shellEnv` policy, and the effective
  // product root all come from this one snapshot. It is passed explicitly to
  // the sidecar and IPC; the Main process never re-probes for WOPAL_HOME.
  const host = yield* Effect.promise(() => resolveDesktopHostEnvironment())
  // Bind the resolved root into the initialized product path view before any
  // consumer reads it (Global.Path is computed once at module load, so setting
  // the env var alone would leave the view stale). Only the product root is
  // bound; the full snapshot is never written back, and the sidecar receives it
  // explicitly through createSidecarEnv.
  bindDesktopProductRoot(host.home)

  // Single startup path: the sidecar always starts, then the main window
  // renders the embedded app, which routes to onboarding or workbench based
  // on its own state.
  yield* startWorkbench({ loadingComplete, host })
})

Effect.runFork(main)
