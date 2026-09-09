import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow, ipcMain } from "electron"

import contextMenu from "electron-context-menu"

import type { InitStep, SidecarRuntimeState, SqliteMigrationProgress } from "../preload/types"
import { checkAppExists } from "./apps"
import { CHANNEL, UPDATER_ENABLED } from "./constants"
import { broadcastSidecarState, registerIpcHandlers, sendDeepLinks, sendMenuCommand, sendSqliteMigrationProgress, unregisterIpcHandlers } from "./ipc"
import { exportDebugLogs, initCrashReporter, initLogging, isDebugLogging, setSidecarLogLevelHandler, startNetLog, toggleDebugLogging, write as writeLog } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import { createSidecarSpawner, preferAppEnv } from "./server"
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
import { resolveOnboardingMode, probeWopalHomeFromShell } from "./onboarding-gate"
import { getOnboardingLogger } from "./onboarding-logger"
import { isVmwareVirtualGpu } from "./gpu-detect"
import { recoverMainWindow } from "./window-show-guard"
import { Deferred, Effect, Fiber } from "effect"

const APP_NAMES: Record<string, string> = {
  main: "Ellamaka Main",
  beta: "Ellamaka Beta",
  prod: "Ellamaka",
}
const APP_IDS: Record<string, string> = {
  main: "ai.ellamaka.desktop.main",
  beta: "ai.ellamaka.desktop.beta",
  prod: "ai.ellamaka.desktop",
}
const TEST_ONBOARDING = process.env.OPENCODE_TEST_ONBOARDING === "1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let mainWindow: BrowserWindow | null = null
let supervisor: SidecarSupervisor | null = null

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
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

// Allocate an ephemeral loopback port. Honors OPENCODE_PORT for tests/dev,
// otherwise binds to a kernel-assigned port (listen 0) and returns it.
const allocatePort = Effect.gen(function* () {
  const fromEnv = process.env.OPENCODE_PORT
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
// (real sidecar). Shared by fresh-boot and in-process transition paths so the
// menu's restart/relaunch/export actions always bind to the live supervisor.
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
  // When set, transition reuses this window (reload to workbench renderer)
  // instead of creating a new BrowserWindow. Used by onboarding→workbench
  // in-process transition.
  existingWindow?: BrowserWindow | null
  // Deferred resolved by the loading window's ready-to-show. Only used on
  // fresh boot when a sqlite migration overlay is shown.
  loadingComplete?: Deferred.Deferred<void, never>
  // Fresh boot awaits sidecar readiness before showing the window; transition
  // starts the sidecar in the background and reloads immediately — the
  // workbench renderer's await-initialization call waits for readiness.
  awaitSidecarReady?: boolean
}

// Bring up the workbench: allocate port, spawn SidecarSupervisor, replace
// IPC handlers (onboarding stubs → real sidecar handlers), fork sidecar
// startup, then either show a fresh window (fresh boot) or reload the
// existing onboarding window to the workbench renderer (in-process
// transition). No process restart, so WOPAL_HOME and other dev.sh-injected
// env vars are preserved across the transition.
const startWorkbench = (opts: StartWorkbenchOpts = {}) =>
  Effect.gen(function* () {
    if (!TEST_ONBOARDING) migrate()
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

    const needsMigration = needsJsonMigration()

    const port = yield* allocatePort
    const hostname = "127.0.0.1"
    const url = `http://${hostname}:${port}`
    const password = randomUUID()

    supervisor = new SidecarSupervisor({
      spawn: createSidecarSpawner(needsMigration),
      setTimeout,
      clearTimeout,
      hostname,
      port,
      password,
      onSqliteProgress: (progress) => initEmitter.emit("sqlite", progress),
      onStdout: (message) => writeLog("server", "stdout", { message }),
      onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
      onExit: (code) => writeLog("utility", "sidecar exited", { code }, "warn"),
    })

    setSidecarLogLevelHandler((level) => supervisor?.setLogLevel(level))
    supervisor.subscribe((state: SidecarRuntimeState) => {
      setDshProxyTarget(state.status === "ready" ? state.connection?.url : undefined)
      broadcastSidecarState(state)
    })

    // Replace any previously-registered handlers (onboarding stubs during
    // in-process transition; no-op on fresh boot since none were registered)
    // with real sidecar handlers. Electron forbids a second handler for the
    // same channel, so unregister first.
    unregisterIpcHandlers()
    registerIpcHandlers({
      homePath: process.env.WOPAL_HOME,
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
      getWindowConfig: () => ({ updaterEnabled: UPDATER_ENABLED, version: getReleaseInfo().displayVersion, dshProxyOrigin: getDshHttpProxyOrigin() }),
      consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
      getDisplayBackend: async () => null,
      setDisplayBackend: async () => undefined,
      parseMarkdown: async (markdown) => parseMarkdown(markdown),
      checkAppExists: (appName) => checkAppExists(appName),
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

    // forkDetach (not forkChild) so the sidecar survives the transition
    // path's parent-fiber termination. forkChild auto-supervises: when the
    // parent (startWorkbench) returns, the child is terminated — which would
    // kill the sidecar mid-startup in the transition path (where we reload
    // the window and return without awaiting). The fresh-boot path still
    // awaits this fiber explicitly below. forkDetach detaches from the
    // parent scope so the sidecar keeps running in the background.
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

    if (opts.awaitSidecarReady) {
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
      if (!opts.existingWindow) {
        mainWindow = createMainWindow()
      }
      if (mainWindow) attachWorkbenchChrome(mainWindow)
      overlay?.close()
    } else {
      // Transition: sidecar starts in background; reload the existing window
      // to the workbench renderer. The renderer re-fetches get-onboarding-mode
      // (now "workbench" because onboarding.json is completed) and calls
      // await-initialization, which waits for the forked sidecar to ready.
      if (opts.existingWindow) {
        mainWindow = opts.existingWindow
        opts.existingWindow.webContents.reload()
      }
      if (mainWindow) attachWorkbenchChrome(mainWindow)
    }
  })

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : `ai.ellamaka.desktop.${CHANNEL}`
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `ellamaka-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.OPENCODE_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "Ellamaka Dev")
  app.setAppUserModelId(appId)
  app.setPath(
    "userData",
    onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
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
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged && process.env.ELAMAKA_DESKTOP_CDP === "1") {
    app.commandLine.appendSwitch("remote-debugging-port", "9222")
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  preferAppEnv()

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("ellamaka://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    // Show + focus the existing window, or recreate it if it was destroyed or
    // never created. The new window shows itself via ready-to-show/fallback;
    // it decides its own mode (onboarding vs workbench) from state, so no
    // IPC re-registration or onboarding setup is needed here.
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
    getSidecarState: () => {
      if (supervisor) return supervisor.getState()
      const mode = resolveOnboardingMode(process.env.WOPAL_HOME)
      if (mode === "onboarding") {
        return { status: "stopped", onboarding: true } as any
      }
      return undefined
    },
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

  // GUI cold-start does not inherit shell rc variables, so process.env.WOPAL_HOME
  // is empty when launched from Finder/Dock. install.sh wrote WOPAL_HOME into
  // the user's shell rc at install time; probe the login shell to recover it
  // so onboarding state resolves against the same WOPAL_HOME the terminal
  // `wopal` command uses. Env var (dev mode, explicit override) wins; probe
  // only fills the gap when env is absent.
  if (!process.env.WOPAL_HOME) {
    const probed = probeWopalHomeFromShell()
    if (probed) {
      process.env.WOPAL_HOME = probed
      logger.log("probed WOPAL_HOME from shell env", { home: probed })
    }
  }

  const onboardingMode = resolveOnboardingMode(process.env.WOPAL_HOME)
  if (onboardingMode === "onboarding") {
    // Start each onboarding session with a clean debug trail. The previous
    // run's entries (kept until a completed wizard clears them, or a crash /
    // quit left them behind) must not bleed into this session's log.
    getOnboardingLogger(process.env.WOPAL_HOME).clear()
    app.setAsDefaultProtocolClient("ellamaka")
    registerRendererProtocol()
    setDockIcon()
    setupAutoUpdater()

    registerIpcHandlers({
      homePath: process.env.WOPAL_HOME,
      killSidecar: () => Promise.resolve(),
      awaitInitialization: Effect.fnUntraced(
        function* (sendStep) {
          return { url: "", username: null, password: null } as any
        },
        (e) => Effect.runPromise(e),
      ),
      getWindowConfig: () => ({ updaterEnabled: UPDATER_ENABLED, version: getReleaseInfo().displayVersion, dshProxyOrigin: getDshHttpProxyOrigin() }),
      consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
      getDisplayBackend: async () => null,
      setDisplayBackend: async () => undefined,
      parseMarkdown: async (markdown) => parseMarkdown(markdown),
      checkAppExists: (appName) => checkAppExists(appName),
      loadingWindowComplete: () => Deferred.doneUnsafe(loadingComplete, Effect.void),
      runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail, killSidecar),
      checkUpdate: async () => checkUpdate(),
      installUpdate: async () => installUpdate(killSidecar),
      setBackgroundColor: (color) => setBackgroundColor(color),
      exportDebugLogs: () => exportDebugLogs(),
      recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
      getSidecarState: () => ({ status: "stopped", onboarding: true } as any),
      restartSidecar: () => Promise.resolve(),
      subscribeToSidecarState: () => () => {},
    })

    mainWindow = createMainWindow()
    if (mainWindow) {
      interceptWindowClose(mainWindow, {
        getSidecarState: () => ({ status: "stopped", onboarding: true } as any),
        stopSidecar: () => Promise.resolve(),
      })
      createMenu({
        trigger: (id) => {
          const win = BrowserWindow.getFocusedWindow() ?? mainWindow
          if (win) sendMenuCommand(win, id)
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
        restartSidecar: () => {},
        exportLogs: () => {
          void exportDebugLogs()
        },
        toggleDebugLogging: () => {
          toggleDebugLogging()
        },
        isDebugLogging: () => isDebugLogging(),
      })
    }

    // In-process transition from onboarding to workbench. DoneStep calls
    // window.api.onboardingTransitionToWorkbench() instead of relaunch(). We
    // unregister onboarding handlers, bring up the real sidecar via
    // startWorkbench, then reload the existing window — no process restart,
    // so WOPAL_HOME and other env vars are preserved. The renderer re-reads
    // get-onboarding-mode (now "workbench" since onboarding.json is completed)
    // and renders the workbench.
    ipcMain.handle("onboarding-transition-to-workbench", async () => {
      try {
        await Effect.runPromise(startWorkbench({ existingWindow: mainWindow, awaitSidecarReady: false }))
        return { status: "ok" as const }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.log("onboarding→workbench transition failed", { message })
        return { status: "error" as const, message }
      }
    })

    return
  }

  // Fresh-boot workbench path: allocate port, start sidecar, await
  // readiness, then show a fresh window. The onboarding branch above also
  // registers an in-process transition handler that calls startWorkbench
  // with existingWindow=mainWindow when the user finishes onboarding.
  yield* startWorkbench({ awaitSidecarReady: true, loadingComplete })
})

Effect.runFork(main)
