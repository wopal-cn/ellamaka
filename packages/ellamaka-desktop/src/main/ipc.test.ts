/**
 * Note: registerIpcHandlers directly imports electron, and bun's mock.module
 * cannot fully simulate electron's hundreds of named exports (CJS interop limitation).
 * This test verifies the Deps contract functions that index.ts injects into
 * registerIpcHandlers — each dep function is tested with a real SidecarSupervisor
 * instance, which is equivalent to verifying the handler logic.
 * IPC channel name mapping is statically defined in ipc.ts and not in test scope.
 */
import { describe, expect, test, beforeEach } from "bun:test"
import { SidecarSupervisor, type SidecarRuntimeState, type SidecarSpawnResult, type SidecarSpawnFactory } from "./sidecar-supervisor"
import { IPC_HANDLE_CHANNELS, IPC_EVENT_CHANNELS } from "./ipc-channels"

// ── Test Helpers ──────────────────────────────────────────────────────────

function createSpawnResult(): {
  result: SidecarSpawnResult
  passHealth: () => void
  failHealth: (error: Error) => void
} {
  let healthResolve!: () => void
  let healthReject!: (error: Error) => void
  const healthWait = new Promise<void>((res, rej) => { healthResolve = res; healthReject = rej })
  return {
    result: { listener: { stop: async () => {} }, health: { wait: healthWait } },
    passHealth: () => healthResolve(),
    failHealth: (error) => healthReject(error),
  }
}

class MockSpawner {
  private onExitCallback: ((code: number) => void) | undefined
  private pendingResolve: ((result: SidecarSpawnResult) => void) | undefined
  private pendingReject: ((error: Error) => void) | undefined
  callCount = 0
  spawn: SidecarSpawnFactory = async (_h, _p, _pw, options) => {
    this.callCount++; this.onExitCallback = options.onExit
    return new Promise<SidecarSpawnResult>((resolve, reject) => { this.pendingResolve = resolve; this.pendingReject = reject })
  }
  resolve(result: SidecarSpawnResult) { this.pendingResolve?.(result); this.pendingResolve = undefined; this.pendingReject = undefined }
  reject(error: Error) { this.pendingReject?.(error); this.pendingResolve = undefined; this.pendingReject = undefined }
  triggerExit(code: number) { this.onExitCallback?.(code) }
}

function createSupervisor(mockSpawner: MockSpawner) {
  return new SidecarSupervisor({
    spawn: mockSpawner.spawn,
    setTimeout: ((cb: () => void, ms: number) => setTimeout(cb, ms)) as typeof setTimeout,
    clearTimeout: ((id: any) => clearTimeout(id)) as typeof clearTimeout,
    hostname: "127.0.0.1", port: 12345, password: "test-password",
    backoffMs: [10, 20, 30], maxAttempts: 3, stableWindowMs: 100,
  })
}

function tick(ms = 5): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

// ── Tests ─────────────────────────────────────────────────────────────────

describe("IPC Deps contract (integration with SidecarSupervisor)", () => {
  let mockSpawner: MockSpawner
  let supervisor: SidecarSupervisor

  beforeEach(() => {
    mockSpawner = new MockSpawner()
    supervisor = createSupervisor(mockSpawner)
  })

  describe("getSidecarState", () => {
    test("returns supervisor.getState()", () => {
      const getSidecarState = () => supervisor.getState()
      const state = getSidecarState()
      expect(state.status).toBe("stopped")
      expect(state.generation).toBe(0)
    })

    test("reflects state changes after start", async () => {
      const getSidecarState = () => supervisor.getState()
      supervisor.start(); await tick()
      expect(getSidecarState().status).toBe("starting")
    })
  })

  describe("restartSidecar", () => {
    test("calls supervisor.restart('user')", async () => {
      const restartSidecar = () => supervisor.restart("user")
      supervisor.start(); await tick()
      const r1 = createSpawnResult(); mockSpawner.resolve(r1.result); r1.passHealth(); await tick()
      expect(supervisor.getState().status).toBe("ready")

      const p = restartSidecar(); await tick()
      expect(supervisor.getState().status).toBe("starting")
      const r2 = createSpawnResult(); mockSpawner.resolve(r2.result); r2.passHealth()
      await p
      expect(supervisor.getState().status).toBe("ready")
      expect(supervisor.getState().generation).toBe(2)
    })
  })

  describe("subscribeToSidecarState", () => {
    test("listener receives state updates from supervisor", async () => {
      const received: SidecarRuntimeState[] = []
      const subscribeToSidecarState = (listener: (state: SidecarRuntimeState) => void) => supervisor.subscribe(listener)
      const unsub = subscribeToSidecarState((state) => received.push(state))
      supervisor.start(); await tick()
      expect(received.length).toBeGreaterThanOrEqual(1)
      expect(received[0].status).toBe("starting")
      unsub()
      const countAfterUnsub = received.length
      const r1 = createSpawnResult(); mockSpawner.resolve(r1.result); r1.passHealth()
      expect(received.length).toBe(countAfterUnsub)
    })

    test("unsubscribe stops receiving updates", async () => {
      const received: SidecarRuntimeState[] = []
      const subscribeToSidecarState = (listener: (state: SidecarRuntimeState) => void) => supervisor.subscribe(listener)
      const unsub = subscribeToSidecarState((state) => received.push(state))
      expect(received.length).toBe(0)
      supervisor.start(); await tick()
      expect(received.length).toBeGreaterThanOrEqual(1)
      unsub()
      const countAfterUnsub = received.length
      const r1 = createSpawnResult(); mockSpawner.resolve(r1.result); r1.passHealth()
      expect(received.length).toBe(countAfterUnsub)
    })
  })

  describe("awaitInitialization", () => {
    test("resolves when supervisor is ready", async () => {
      const awaitInitialization = async (sendStep: (step: any) => void) => {
        sendStep({ phase: "server_waiting" })
        const state = await supervisor.waitForReady()
        return { url: state.connection?.url ?? "", username: state.connection?.username ?? null, password: state.connection?.password ?? null }
      }
      supervisor.start(); await tick()
      const r1 = createSpawnResult(); mockSpawner.resolve(r1.result); r1.passHealth(); await tick()
      const result = await awaitInitialization(() => {})
      expect(result.url).toBe("http://127.0.0.1:12345")
      expect(result.username).toBe("ellamaka")
      expect(result.password).toBe("test-password")
    })

    test("rejects when supervisor is failed", async () => {
      const awaitInitialization = async () => {
        try { await supervisor.waitForReady() } catch (e) { throw e }
        return { url: "", username: null, password: null }
      }
      supervisor.start(); await tick()
      mockSpawner.reject(new Error("fail")); await tick()
      await tick(20); mockSpawner.reject(new Error("fail again")); await tick()
      await tick(40); mockSpawner.reject(new Error("fail again")); await tick()
      expect(supervisor.getState().status).toBe("failed")
      await expect(awaitInitialization()).rejects.toThrow()
    })
  })
})

// Channel name lists exported from ipc.ts. registerIpcHandlers registers
// every channel by literal name; unregisterIpcHandlers must clear the exact
// same set so re-registration (dev HMR) can replace handlers without Electron
// throwing "attempted to register a second handler". This test keeps the two
// lists in lockstep with the actual registrations.
describe("IPC channel registry (unregister coverage)", () => {
  // Every ipcMain.handle(...) channel registered in ipc.ts. Sourced by grep
  // over the file; must stay a superset of __IPC_HANDLE_CHANNELS.
  const EXPECTED_HANDLE_CHANNELS = new Set([
    "kill-sidecar",
    "await-initialization",
    "get-window-config",
    "consume-initial-deep-links",
    "get-display-backend",
    "set-display-backend",
    "parse-markdown",
    "check-app-exists",
    "run-updater",
    "check-update",
    "install-update",
    "set-background-color",
    "export-debug-logs",
    "record-fatal-renderer-error",
    "get-sidecar-state",
    "restart-sidecar",
    "store-get",
    "store-set",
    "store-delete",
    "store-clear",
    "store-keys",
    "store-length",
    "open-directory-picker",
    "open-file-picker",
    "save-file-picker",
    "open-path",
    "read-clipboard-image",
    "get-window-count",
    "get-window-focused",
    "set-window-focus",
    "show-window",
    "get-zoom-factor",
    "set-zoom-factor",
    "set-titlebar",
    "run-desktop-menu-action",
    "save-recent-model",
  ])

  const EXPECTED_EVENT_CHANNELS = new Set([
    "loading-window-complete",
    "open-link",
    "show-notification",
    "relaunch",
  ])

  test("IPC_HANDLE_CHANNELS covers every handle channel registered in ipc.ts", () => {
    const actual = new Set(IPC_HANDLE_CHANNELS as readonly string[])
    for (const ch of EXPECTED_HANDLE_CHANNELS) {
      expect(actual.has(ch), `missing in IPC_HANDLE_CHANNELS: ${ch}`).toBe(true)
    }
    // No phantom channels in the list (would silently no-op in unregister but
    // signals drift from the source of truth)
    for (const ch of actual) {
      expect(EXPECTED_HANDLE_CHANNELS.has(ch), `phantom channel in IPC_HANDLE_CHANNELS: ${ch}`).toBe(true)
    }
  })

  test("IPC_EVENT_CHANNELS covers every event channel registered in ipc.ts", () => {
    const actual = new Set(IPC_EVENT_CHANNELS as readonly string[])
    for (const ch of EXPECTED_EVENT_CHANNELS) {
      expect(actual.has(ch), `missing in IPC_EVENT_CHANNELS: ${ch}`).toBe(true)
    }
    for (const ch of actual) {
      expect(EXPECTED_EVENT_CHANNELS.has(ch), `phantom channel in IPC_EVENT_CHANNELS: ${ch}`).toBe(true)
    }
  })
})
