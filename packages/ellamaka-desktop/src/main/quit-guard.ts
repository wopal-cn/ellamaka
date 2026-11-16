import { app, dialog, BrowserWindow } from "electron"
import type { SidecarRuntimeState } from "../preload/types"
import { getStore } from "./store"

let forceQuit = false
let confirmShowing = false
let shutdownInProgress = false

export type QuitStateInput = SidecarRuntimeState | { onboarding?: boolean; status?: string } | undefined

export function shouldConfirmQuit(state: QuitStateInput): boolean {
  if (!state) return false
  if ("onboarding" in state && state.onboarding) return true
  return state.status === "ready" || state.status === "starting" || state.status === "restarting"
}

function getLocaleText(isOnboarding = false) {
  let lang = ""
  try {
    const raw = getStore("opencode.global.dat").get("language")
    if (typeof raw === "string") {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === "object" && "locale" in parsed && typeof parsed.locale === "string") {
          lang = parsed.locale
        }
      } catch {
        lang = raw
      }
    } else if (raw && typeof raw === "object" && "locale" in raw) {
      const val = raw.locale
      if (typeof val === "string") lang = val
    }
  } catch {}

  if (!lang) {
    try {
      lang = app.getLocale()
    } catch {}
  }

  const isZh = lang.toLowerCase().startsWith("zh")
  if (isZh) {
    return {
      title: "退出 Ellamaka",
      message: "确定要退出 Ellamaka 吗？",
      detail: isOnboarding
        ? "向导配置尚未完成。退出应用将中断当前的设置流程。"
        : "后台 AI 引擎与终端会话正在运行中。退出应用将终止所有正在进行的任务。",
      buttons: ["退出应用", "取消"],
    }
  }

  return {
    title: "Quit Ellamaka?",
    message: "Are you sure you want to quit Ellamaka?",
    detail: isOnboarding
      ? "Onboarding setup is not complete. Quitting will interrupt the setup process."
      : "The AI backend and terminal sessions are running. Quitting will terminate all active tasks.",
    buttons: ["Quit", "Cancel"],
  }
}

/** macOS hides the main window instead of closing it. A confirmation sheet
 * attached to that hidden window would otherwise be invisible and block quit. */
export function ensureQuitConfirmationWindowVisible(
  win: Pick<BrowserWindow, "isDestroyed" | "isVisible" | "show" | "focus"> | null,
): boolean {
  if (!win || win.isDestroyed() || win.isVisible()) return false
  win.show()
  win.focus()
  return true
}

export async function confirmQuit(win: BrowserWindow | null, isOnboarding = false): Promise<boolean> {
  if (confirmShowing) return false
  confirmShowing = true
  try {
    ensureQuitConfirmationWindowVisible(win)
    const text = getLocaleText(isOnboarding)
    const options = {
      type: "warning" as const,
      buttons: text.buttons,
      defaultId: 1,
      cancelId: 1,
      title: text.title,
      message: text.message,
      detail: text.detail,
    }
    const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    return result.response === 0
  } finally {
    confirmShowing = false
  }
}

export async function stopSidecarThenQuit(stopSidecar: () => Promise<void>, quit: () => void) {
  try {
    await Promise.race([stopSidecar(), new Promise((resolve) => setTimeout(resolve, 1500))])
  } catch {
    // Ignore sidecar cleanup errors on exit
  } finally {
    quit()
  }
}

export function enableQuitGuard(deps: {
  getMainWindow: () => BrowserWindow | null
  getSidecarState: () => SidecarRuntimeState | undefined
  stopSidecar: () => Promise<void>
}) {
  const { getMainWindow, getSidecarState, stopSidecar } = deps

  app.on("window-all-closed", () => {
    if (process.platform === "darwin" && !forceQuit) {
      return
    }
  })

  app.on("activate", () => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.show()
      win.focus()
    }
  })

  app.on("before-quit", (e) => {
    if (forceQuit) return

    e.preventDefault()
    if (shutdownInProgress) return

    shutdownInProgress = true
    void (async () => {
      try {
        const state = getSidecarState() as QuitStateInput
        if (shouldConfirmQuit(state)) {
          const isOnboarding = state ? "onboarding" in state && Boolean(state.onboarding) : false
          const confirmed = await confirmQuit(getMainWindow(), isOnboarding)
          if (!confirmed) {
            shutdownInProgress = false
            return
          }
        }

        forceQuit = true

        try {
          await Promise.race([stopSidecar(), new Promise((resolve) => setTimeout(resolve, 1500))])
        } catch {
          // ignore
        }

        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.destroy()
        }

        app.quit()

        setTimeout(() => {
          process.exit(0)
        }, 500)
      } catch {
        forceQuit = true
        process.exit(0)
      }
    })()
  })
}

export type WindowCloseDeps = {
  getSidecarState?: () => SidecarRuntimeState | undefined
  stopSidecar?: () => Promise<void>
}

export function interceptWindowClose(win: BrowserWindow, deps?: WindowCloseDeps) {
  win.on("close", (e) => {
    if (forceQuit) return

    if (process.platform === "darwin") {
      e.preventDefault()
      win.hide()
      return
    }

    e.preventDefault()
    if (shutdownInProgress) return

    shutdownInProgress = true
    void (async () => {
      try {
        const state = deps?.getSidecarState?.() as QuitStateInput
        if (shouldConfirmQuit(state)) {
          const targetWin = win.isDestroyed() ? null : win
          const isOnboarding = state ? "onboarding" in state && Boolean(state.onboarding) : false
          const confirmed = await confirmQuit(targetWin, isOnboarding)
          if (!confirmed) {
            shutdownInProgress = false
            return
          }
        }

        forceQuit = true

        try {
          await Promise.race([
            (deps?.stopSidecar ?? (async () => {}))(),
            new Promise((resolve) => setTimeout(resolve, 1500)),
          ])
        } catch {
          // ignore
        }

        if (!win.isDestroyed()) {
          win.destroy()
        }

        app.quit()

        setTimeout(() => {
          process.exit(0)
        }, 500)
      } catch {
        forceQuit = true
        process.exit(0)
      }
    })()
  })
}

export function resetQuitGuard() {
  forceQuit = false
  confirmShowing = false
  shutdownInProgress = false
}
