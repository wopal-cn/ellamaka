import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { BrowserWindow, Notification, app, clipboard, dialog, ipcMain, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@wopal/ellamaka-app/desktop-menu"

import type {
  InitStep,
  FatalRendererError,
  ServerReadyData,
  SidecarRuntimeState,
  SqliteMigrationProgress,
  TitlebarTheme,
  WindowConfig,
} from "../preload/types"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { getStore } from "./store"
import { setTitlebar, updateTitlebar } from "./windows"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

type Deps = {
  killSidecar: () => Promise<void> | void
  awaitInitialization: (sendStep: (step: InitStep) => void) => Promise<ServerReadyData>
  getWindowConfig: () => Promise<WindowConfig> | WindowConfig
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  loadingWindowComplete: () => void
  runUpdater: (alertOnFail: boolean) => Promise<void> | void
  checkUpdate: () => Promise<{ updateAvailable: boolean; version?: string }>
  installUpdate: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
  getSidecarState: () => SidecarRuntimeState
  restartSidecar: () => Promise<void> | void
  subscribeToSidecarState: (listener: (state: SidecarRuntimeState) => void) => () => void
  homePath?: string
}

import { createOnboardingIpcHandlers } from "./onboarding-ipc"
import { persistWopalHomeEnv } from "./shell-env"
import { IPC_HANDLE_CHANNELS, IPC_EVENT_CHANNELS } from "./ipc-channels"

export function registerIpcHandlers(deps: Deps) {
  const onboardingHandlers = createOnboardingIpcHandlers({
    homePath: deps.homePath,
    persistWopalHomeEnv,
    broadcastProgress: (progress) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("onboarding-progress", progress)
      }
    }
  })
  // Remove existing handlers before re-registering (dev HMR may call this twice)
  for (const channel of [
    "get-onboarding-mode",
    "onboarding-get-state",
    "onboarding-set-current-step",
    "onboarding-execute-step",
    "onboarding-complete",
    "onboarding-probe",
    "onboarding-set-wopal-home",
    "onboarding-cancel-step",
    "onboarding-renderer-log",
  ]) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle("get-onboarding-mode", () => onboardingHandlers["get-onboarding-mode"]())
  ipcMain.handle("onboarding-get-state", () => onboardingHandlers["onboarding-get-state"]())
  ipcMain.handle("onboarding-set-current-step", (_event, step) =>
    onboardingHandlers["onboarding-set-current-step"](_event, step),
  )
  ipcMain.handle("onboarding-execute-step", (event, step, input) =>
    onboardingHandlers["onboarding-execute-step"](event, step, input),
  )
  ipcMain.handle("onboarding-complete", () => onboardingHandlers["onboarding-complete"]())
  ipcMain.handle("onboarding-probe", (_event, kind: string) =>
    onboardingHandlers["onboarding-probe"](_event, kind),
  )
  ipcMain.handle("onboarding-set-wopal-home", (event, path: string) =>
    onboardingHandlers["onboarding-set-wopal-home"](event, path),
  )
  ipcMain.handle("onboarding-cancel-step", () =>
    onboardingHandlers["onboarding-cancel-step"](),
  )
  ipcMain.handle("onboarding-renderer-log", (_event, message: string) =>
    onboardingHandlers["onboarding-renderer-log"](_event, message),
  )

  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("await-initialization", (event: IpcMainInvokeEvent) => {
    const send = (step: InitStep) => event.sender.send("init-step", step)
    return deps.awaitInitialization(send)
  })
  ipcMain.handle("get-window-config", () => deps.getWindowConfig())
  ipcMain.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.on("loading-window-complete", () => deps.loadingWindowComplete())
  ipcMain.handle("run-updater", (_event: IpcMainInvokeEvent, alertOnFail: boolean) => deps.runUpdater(alertOnFail))
  ipcMain.handle("check-update", () => deps.checkUpdate())
  ipcMain.handle("install-update", () => deps.installUpdate())
  ipcMain.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  ipcMain.handle("export-debug-logs", () => deps.exportDebugLogs())
  ipcMain.handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  ipcMain.handle("get-sidecar-state", () => deps.getSidecarState())
  ipcMain.handle("restart-sidecar", () => deps.restartSidecar())
  ipcMain.handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  ipcMain.handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    getStore(name).set(key, value)
  })
  ipcMain.handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    getStore(name).delete(key)
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(name).clear()
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })

  ipcMain.handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "open-file-picker",
    async (
      _event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; accept?: string[]; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  ipcMain.on("open-link", (_event: IpcMainEvent, url: string) => {
    void shell.openExternal(url)
  })

  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  ipcMain.on("show-notification", (event: IpcMainEvent, title: string, body?: string, href?: string) => {
    const notification = new Notification({ title, body })
    notification.on("click", () => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) {
        win.show()
        win.focus()
      }
      if (href) {
        event.sender.send("notification-click", href)
      }
    })
    notification.show()
  })

  ipcMain.handle("get-window-count", () => BrowserWindow.getAllWindows().length)

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.on("relaunch", () => {
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  ipcMain.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  ipcMain.handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action)
  })
  ipcMain.handle("save-recent-model", (_event: IpcMainInvokeEvent, rawModel: { providerID?: string; modelID?: string } | string) => {
    let providerID = ""
    let modelID = ""

    if (typeof rawModel === "string") {
      const parts = rawModel.split("/")
      providerID = parts[0] || ""
      modelID = parts.slice(1).join("/") || ""
    } else if (rawModel && typeof rawModel === "object") {
      providerID = rawModel.providerID || ""
      modelID = rawModel.modelID || ""
    }

    if (!providerID || !modelID) return

    const stateDir = process.env.WOPAL_HOME
      ? path.join(process.env.WOPAL_HOME, "ellamaka/state")
      : (deps.homePath ? path.join(deps.homePath, "ellamaka/state") : path.join(os.homedir(), ".local/state/opencode"))
    const filePath = path.join(stateDir, "model.json")

    let data: { recent?: Array<{ providerID: string; modelID: string }>; favorite?: any; variant?: any } = {
      recent: [],
      favorite: [],
      variant: {},
    }
    try {
      if (fs.existsSync(filePath)) {
        data = JSON.parse(fs.readFileSync(filePath, "utf-8"))
      }
    } catch {}

    const recent = Array.isArray(data.recent) ? data.recent : []
    const filteredRecent = recent.filter(
      (item) => !(item.providerID === providerID && item.modelID === modelID)
    )

    data.recent = [{ providerID, modelID }, ...filteredRecent].slice(0, 10)

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8")
    } catch {}
  })
}

// All channels registered by registerIpcHandlers live in ./ipc-channels.ts
// (electron-free so tests can import them without the electron mock). See
// that file for the contract and the lockstep invariant with this function.

// Exported for structural tests (re-exported from the channel registry).
export { IPC_HANDLE_CHANNELS as __IPC_HANDLE_CHANNELS, IPC_EVENT_CHANNELS as __IPC_EVENT_CHANNELS } from "./ipc-channels"

// Remove every channel registered by registerIpcHandlers. Idempotent —
// removeHandler/removeAllListeners are no-ops for unknown channels. Called
// during in-process onboarding→workbench transition so real sidecar handlers
// can replace the onboarding-mode stubs without Electron throwing
// "attempted to register a second handler".
export function unregisterIpcHandlers() {
  for (const ch of IPC_HANDLE_CHANNELS) {
    ipcMain.removeHandler(ch)
  }
  for (const ch of IPC_EVENT_CHANNELS) {
    ipcMain.removeAllListeners(ch)
  }
}

export function sendSqliteMigrationProgress(win: BrowserWindow, progress: SqliteMigrationProgress) {
  win.webContents.send("sqlite-migration-progress", progress)
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}

export function broadcastSidecarState(state: SidecarRuntimeState) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("sidecar-state", state)
  }
}
