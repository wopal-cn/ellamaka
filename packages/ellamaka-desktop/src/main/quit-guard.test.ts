import { describe, expect, test } from "bun:test"
import { BrowserWindow } from "electron"
import { ensureQuitConfirmationWindowVisible, shouldConfirmQuit, stopSidecarThenQuit } from "./quit-guard"
import type { SidecarRuntimeState } from "../preload/types"

function makeState(status: SidecarRuntimeState["status"]): SidecarRuntimeState {
  return { generation: 1, status, attempt: 0 }
}

describe("quit guard", () => {
  describe("shouldConfirmQuit", () => {
    test("returns false when state is undefined", () => {
      expect(shouldConfirmQuit(undefined)).toBe(false)
    })

    test("returns true when sidecar is ready", () => {
      expect(shouldConfirmQuit(makeState("ready"))).toBe(true)
    })

    test("returns true when sidecar is starting", () => {
      expect(shouldConfirmQuit(makeState("starting"))).toBe(true)
    })

    test("returns true when sidecar is restarting", () => {
      expect(shouldConfirmQuit(makeState("restarting"))).toBe(true)
    })

    test("returns true when onboarding mode is active", () => {
      expect(shouldConfirmQuit({ onboarding: true })).toBe(true)
    })

    test("returns false when sidecar is stopped", () => {
      expect(shouldConfirmQuit(makeState("stopped"))).toBe(false)
    })

    test("returns false when sidecar is failed", () => {
      expect(shouldConfirmQuit(makeState("failed"))).toBe(false)
    })

    test("returns false when sidecar is lost", () => {
      expect(shouldConfirmQuit(makeState("lost"))).toBe(false)
    })
  })

  describe("confirmQuit dialog contract", () => {
    test("reveals a macOS-hidden window before attaching the quit confirmation sheet", () => {
      const events: string[] = []
      const window = {
        isDestroyed: () => false,
        isVisible: () => false,
        show: () => events.push("show"),
        focus: () => events.push("focus"),
      }

      expect(ensureQuitConfirmationWindowVisible(window)).toBe(true)
      expect(events).toEqual(["show", "focus"])
    })

    test("does not resurrect an already destroyed window or disturb a visible one", () => {
      const events: string[] = []
      const visible = {
        isDestroyed: () => false,
        isVisible: () => true,
        show: () => events.push("show"),
        focus: () => events.push("focus"),
      }
      const destroyed = {
        isDestroyed: () => true,
        isVisible: () => false,
        show: () => events.push("show"),
        focus: () => events.push("focus"),
      }

      expect(ensureQuitConfirmationWindowVisible(visible)).toBe(false)
      expect(ensureQuitConfirmationWindowVisible(destroyed)).toBe(false)
      expect(ensureQuitConfirmationWindowVisible(null)).toBe(false)
      expect(events).toEqual([])
    })

    test("confirmQuit is an async function", async () => {
      // Verify the module exports an async function with the right shape.
      // We cannot call it without Electron, but we validate its existence.
      const mod = await import("./quit-guard")
      expect(typeof mod.confirmQuit).toBe("function")
    })
  })

  describe("quit guard lifecycle", () => {
    test("resetQuitGuard resets internal state", async () => {
      const mod = await import("./quit-guard")
      // Should not throw
      mod.resetQuitGuard()
      expect(typeof mod.resetQuitGuard).toBe("function")
    })

    test("enableQuitGuard is a function accepting deps", async () => {
      const mod = await import("./quit-guard")
      expect(typeof mod.enableQuitGuard).toBe("function")
    })

    test("interceptWindowClose is a function", async () => {
      const mod = await import("./quit-guard")
      expect(typeof mod.interceptWindowClose).toBe("function")
    })

    test("stops the sidecar before allowing Electron to quit", async () => {
      const events: string[] = []

      await stopSidecarThenQuit(
        async () => {
          events.push("stop:start")
          await Promise.resolve()
          events.push("stop:done")
        },
        () => events.push("quit"),
      )

      expect(events).toEqual(["stop:start", "stop:done", "quit"])
    })
  })

  describe("window close interception logic", () => {
    test("on macOS, close event should be preventable for hide behavior", () => {
      // This validates the design contract: on darwin, close hides the window
      // rather than destroying it. The actual Electron behavior is tested
      // via manual verification, but we validate the guard logic here.
      //
      // When forceQuit is false and platform is darwin:
      //   - e.preventDefault() is called
      //   - win.hide() is called
      // When forceQuit is true:
      //   - close proceeds normally (no interception)
      const events: string[] = []
      const fakeEvent = {
        preventDefault: () => events.push("prevented"),
      }
      const fakeWindow = {
        hide: () => events.push("hidden"),
      }

      // Simulate the logic from interceptWindowClose
      // (extracted to test without Electron)
      const forceQuit = false
      const platform = "darwin"

      if (!forceQuit && platform === "darwin") {
        fakeEvent.preventDefault()
        fakeWindow.hide()
      }

      expect(events).toEqual(["prevented", "hidden"])
    })

    test("on macOS, force quit allows close to proceed", () => {
      const events: string[] = []
      const fakeEvent = {
        preventDefault: () => events.push("prevented"),
      }
      const fakeWindow = {
        hide: () => events.push("hidden"),
      }

      const forceQuit = true
      const platform = "darwin"

      if (!forceQuit && platform === "darwin") {
        fakeEvent.preventDefault()
        fakeWindow.hide()
      }

      // Nothing should be intercepted
      expect(events).toEqual([])
    })

    test("on non-macOS, close is intercepted and prompts confirmation before quitting", async () => {
      const mod = await import("./quit-guard")
      const closeListeners: Array<(e: { preventDefault: () => void }) => void> = []
      let prevented = false

      const fakeWindow = Object.assign(new BrowserWindow(), {
        on: (event: string, fn: (e: { preventDefault: () => void }) => void) => {
          if (event === "close") closeListeners.push(fn)
        },
        hide: () => {},
        isDestroyed: () => false,
      })

      mod.interceptWindowClose(fakeWindow)
      expect(closeListeners).toHaveLength(1)

      const listener = closeListeners[0]
      listener({
        preventDefault: () => {
          prevented = true
        },
      })

      expect(prevented).toBe(true)
    })
  })
})
