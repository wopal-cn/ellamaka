import { describe, expect, test, beforeEach } from "bun:test"
import {
  SidecarSupervisor,
  type SidecarRuntimeState,
  type SidecarRuntimeStatus,
  type SidecarSpawnResult,
  type SidecarSpawnFactory,
} from "./sidecar-supervisor"

// ── Test Helpers ──────────────────────────────────────────────────────────

function createSpawnResult(): {
  result: SidecarSpawnResult
  passHealth: () => void
  failHealth: (error: Error) => void
} {
  let healthResolve!: () => void
  let healthReject!: (error: Error) => void
  const healthWait = new Promise<void>((res, rej) => {
    healthResolve = res
    healthReject = rej
  })

  return {
    result: {
      listener: { stop: async () => {} },
      health: { wait: healthWait },
    },
    passHealth: () => healthResolve(),
    failHealth: (error) => healthReject(error),
  }
}

class MockSpawner {
  private onExitCallback: ((code: number) => void) | undefined
  private pendingResolve: ((result: SidecarSpawnResult) => void) | undefined
  private pendingReject: ((error: Error) => void) | undefined
  callCount = 0

  spawn: SidecarSpawnFactory = async (_hostname, _port, _password, options) => {
    this.callCount++
    this.onExitCallback = options.onExit
    return new Promise<SidecarSpawnResult>((resolve, reject) => {
      this.pendingResolve = resolve
      this.pendingReject = reject
    })
  }

  resolve(result: SidecarSpawnResult) {
    this.pendingResolve?.(result)
    this.pendingResolve = undefined
    this.pendingReject = undefined
  }

  reject(error: Error) {
    this.pendingReject?.(error)
    this.pendingResolve = undefined
    this.pendingReject = undefined
  }

  triggerExit(code: number) {
    this.onExitCallback?.(code)
  }
}

function createSupervisor(
  mockSpawner: MockSpawner,
  overrides?: { backoffMs?: number[]; maxAttempts?: number; stableWindowMs?: number },
) {
  return new SidecarSupervisor({
    spawn: mockSpawner.spawn,
    setTimeout: ((cb: () => void, ms: number) => setTimeout(cb, ms)) as typeof setTimeout,
    clearTimeout: ((id: any) => clearTimeout(id)) as typeof clearTimeout,
    hostname: "127.0.0.1",
    port: 12345,
    password: "test-password",
    backoffMs: overrides?.backoffMs ?? [10, 20, 30],
    maxAttempts: overrides?.maxAttempts ?? 3,
    stableWindowMs: overrides?.stableWindowMs ?? 100,
  })
}

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("SidecarSupervisor", () => {
  let mockSpawner: MockSpawner

  beforeEach(() => {
    mockSpawner = new MockSpawner()
  })

  // ── Initial State ──────────────────────────────────────────────────────

  test("initial state is stopped", () => {
    const supervisor = createSupervisor(mockSpawner)
    const state = supervisor.getState()
    expect(state.status).toBe("stopped")
    expect(state.generation).toBe(0)
    expect(state.attempt).toBe(0)
    expect(state.connection).toBeUndefined()
  })

  // ── starting → ready ──────────────────────────────────────────────────

  test("starting → ready on successful spawn and health check", async () => {
    const supervisor = createSupervisor(mockSpawner)
    const states: SidecarRuntimeStatus[] = []
    supervisor.subscribe((s) => states.push(s.status))

    const startPromise = supervisor.start()
    await tick()
    expect(supervisor.getState().status).toBe("starting")

    const { result, passHealth } = createSpawnResult()
    mockSpawner.resolve(result)
    await tick()
    // Still starting until health passes
    expect(supervisor.getState().status).toBe("starting")

    passHealth()
    await startPromise

    const state = supervisor.getState()
    expect(state.status).toBe("ready")
    expect(state.generation).toBe(1)
    expect(state.connection).toBeDefined()
    expect(state.connection!.url).toBe("http://127.0.0.1:12345")
    expect(state.connection!.username).toBe("ellamaka")
    expect(state.connection!.password).toBe("test-password")
    expect(state.attempt).toBe(0)

    // Verify state transition sequence
    expect(states[0]).toBe("starting")
    expect(states[states.length - 1]).toBe("ready")
  })

  test("ready connection is URL-only (no dshPort) and survives restart", async () => {
    const supervisor = createSupervisor(mockSpawner)
    const startPromise = supervisor.start()
    await tick()

    const { result, passHealth } = createSpawnResult()
    mockSpawner.resolve(result)
    await tick()
    passHealth()
    await startPromise

    const state = supervisor.getState()
    expect(state.status).toBe("ready")
    expect(state.connection!.url).toBe("http://127.0.0.1:12345")
    expect(state.connection!.username).toBe("ellamaka")
    expect(state.connection!.password).toBe("test-password")
    // The connection carries no dshPort — the DSH surface is served under /dsh
    // on the same listener, so no second-port discovery is needed.
    expect(state.connection).not.toHaveProperty("dshPort")

    // Restart keeps the URL-only connection.
    const restartPromise = supervisor.restart("user")
    await tick()
    const { result: result2, passHealth: passHealth2 } = createSpawnResult()
    mockSpawner.resolve(result2)
    await tick()
    passHealth2()
    await restartPromise

    const restarted = supervisor.getState()
    expect(restarted.status).toBe("ready")
    expect(restarted.connection!.url).toBe("http://127.0.0.1:12345")
    expect(restarted.connection).not.toHaveProperty("dshPort")
  })

  // ── starting → lost (spawn fails) ──────────────────────────────────────

  test("starting → lost when spawn throws", async () => {
    const supervisor = createSupervisor(mockSpawner)
    const states: SidecarRuntimeStatus[] = []
    supervisor.subscribe((s) => states.push(s.status))

    const startPromise = supervisor.start()
    await tick()
    expect(supervisor.getState().status).toBe("starting")

    mockSpawner.reject(new Error("spawn failed"))
    await startPromise

    const state = supervisor.getState()
    expect(state.status).toBe("lost")
    expect(state.errorCode).toBeDefined()
    expect(states).toContain("lost")
  })

  // ── ready → lost (sidecar exits) ───────────────────────────────────────

  test("ready → lost when sidecar exits unexpectedly", async () => {
    const supervisor = createSupervisor(mockSpawner)

    // Start and get to ready
    const startPromise = supervisor.start()
    await tick()
    const { result, passHealth } = createSpawnResult()
    mockSpawner.resolve(result)
    passHealth()
    await startPromise
    expect(supervisor.getState().status).toBe("ready")

    // Sidecar exits
    mockSpawner.triggerExit(1)
    await tick()

    const state = supervisor.getState()
    expect(state.status).toBe("lost")
    expect(state.errorCode).toBe("EXIT_1")
  })

  // ── lost → restarting (auto retry) ─────────────────────────────────────

  test("lost → restarting after backoff delay", async () => {
    const supervisor = createSupervisor(mockSpawner)

    // Start and get to ready
    const startPromise = supervisor.start()
    await tick()
    const r1 = createSpawnResult()
    mockSpawner.resolve(r1.result)
    r1.passHealth()
    await startPromise
    expect(supervisor.getState().status).toBe("ready")

    // Sidecar exits → lost
    mockSpawner.triggerExit(1)
    await tick()
    expect(supervisor.getState().status).toBe("lost")

    // After backoff, should transition to restarting and call spawn again
    await tick(20)
    expect(supervisor.getState().status).toBe("restarting")
    expect(mockSpawner.callCount).toBe(2)
  })

  // ── restarting → ready ─────────────────────────────────────────────────

  test("restarting → ready on successful restart", async () => {
    const supervisor = createSupervisor(mockSpawner)

    // Get to ready first
    const startPromise = supervisor.start()
    await tick()
    const r1 = createSpawnResult()
    mockSpawner.resolve(r1.result)
    r1.passHealth()
    await startPromise

    // Trigger exit → lost → restarting
    mockSpawner.triggerExit(1)
    await tick()
    await tick(20)
    expect(supervisor.getState().status).toBe("restarting")

    // Resolve the restart spawn
    const r2 = createSpawnResult()
    mockSpawner.resolve(r2.result)
    r2.passHealth()
    await tick()

    const state = supervisor.getState()
    expect(state.status).toBe("ready")
    expect(state.generation).toBe(2)
    expect(state.attempt).toBe(0)
  })

  // ── restarting → failed (3 consecutive failures) ────────────────────────

  test("restarting → failed after max attempts", async () => {
    const supervisor = createSupervisor(mockSpawner)

    // Get to ready
    const startPromise = supervisor.start()
    await tick()
    const r1 = createSpawnResult()
    mockSpawner.resolve(r1.result)
    r1.passHealth()
    await startPromise

    // Trigger exit → lost (attempt=1) → restarting
    mockSpawner.triggerExit(1)
    await tick()
    await tick(20)
    expect(supervisor.getState().status).toBe("restarting")

    // Fail first retry → lost (attempt=2)
    mockSpawner.reject(new Error("retry 1 failed"))
    await tick()
    expect(supervisor.getState().status).toBe("lost")

    // Second retry → restarting
    await tick(30)
    expect(supervisor.getState().status).toBe("restarting")
    // Fail second retry → attempt=3 → failed (maxAttempts=3)
    mockSpawner.reject(new Error("retry 2 failed"))
    await tick()

    // Should be failed after 3 attempts (initial exit + 2 retries)
    expect(supervisor.getState().status).toBe("failed")
    expect(supervisor.getState().attempt).toBe(3)
  })

  // ── failed → starting (user restart) ───────────────────────────────────

  test("failed → starting when user calls restart", async () => {
    const supervisor = createSupervisor(mockSpawner)

    // Get to ready
    const startPromise = supervisor.start()
    await tick()
    const r1 = createSpawnResult()
    mockSpawner.resolve(r1.result)
    r1.passHealth()
    await startPromise

    // Force to failed: exit → retry fails → retry fails → failed
    mockSpawner.triggerExit(1)
    await tick()
    await tick(20) // backoff 10ms
    expect(supervisor.getState().status).toBe("restarting")
    mockSpawner.reject(new Error("fail 1"))
    await tick()
    expect(supervisor.getState().status).toBe("lost")

    await tick(30) // backoff 20ms
    expect(supervisor.getState().status).toBe("restarting")
    mockSpawner.reject(new Error("fail 2"))
    await tick()
    // attempt=3 → failed
    expect(supervisor.getState().status).toBe("failed")

    // User triggers restart
    const restartPromise = supervisor.restart("user")
    await tick()
    expect(supervisor.getState().status).toBe("starting")
    expect(supervisor.getState().attempt).toBe(0)

    const r2 = createSpawnResult()
    mockSpawner.resolve(r2.result)
    r2.passHealth()
    await restartPromise
    expect(supervisor.getState().status).toBe("ready")
  })

  // ── * → stopped (app quit) ─────────────────────────────────────────────

  test("any state → stopped on stop()", async () => {
    const supervisor = createSupervisor(mockSpawner)

    // Get to ready
    const startPromise = supervisor.start()
    await tick()
    const r1 = createSpawnResult()
    mockSpawner.resolve(r1.result)
    r1.passHealth()
    await startPromise
    expect(supervisor.getState().status).toBe("ready")

    // Stop
    await supervisor.stop("quit")
    expect(supervisor.getState().status).toBe("stopped")
  })

  // ── 60s stable window resets attempt counter ───────────────────────────

  test("stable window resets attempt counter", async () => {
    const supervisor = createSupervisor(mockSpawner, { stableWindowMs: 50 })

    // Get to ready
    const startPromise = supervisor.start()
    await tick()
    const r1 = createSpawnResult()
    mockSpawner.resolve(r1.result)
    r1.passHealth()
    await startPromise
    expect(supervisor.getState().status).toBe("ready")

    // Wait for stable window
    await tick(60)
    // Attempt counter should be 0 (already 0, but stable window timer fired)
    expect(supervisor.getState().attempt).toBe(0)

    // Trigger exit → lost (attempt=1) → restarting
    mockSpawner.triggerExit(1)
    await tick()
    await tick(20)
    expect(supervisor.getState().status).toBe("restarting")

    // Fail first retry → lost (attempt=2)
    mockSpawner.reject(new Error("fail"))
    await tick()
    expect(supervisor.getState().attempt).toBe(2)

    // Second retry succeeds
    await tick(30)
    const r2 = createSpawnResult()
    mockSpawner.resolve(r2.result)
    r2.passHealth()
    await tick()
    expect(supervisor.getState().status).toBe("ready")
    expect(supervisor.getState().attempt).toBe(0) // Reset on success
  })

  // ── Serialization: concurrent operations merge ─────────────────────────

  test("concurrent restart() calls are serialized", async () => {
    const supervisor = createSupervisor(mockSpawner)

    // Get to ready
    const startPromise = supervisor.start()
    await tick()
    const r1 = createSpawnResult()
    mockSpawner.resolve(r1.result)
    r1.passHealth()
    await startPromise

    // Trigger exit and immediately call restart before auto-retry fires
    mockSpawner.triggerExit(1)
    await tick()

    // Call restart (queued after doLost); auto-retry timer gets cancelled
    const p1 = supervisor.restart("user")
    await tick()
    expect(supervisor.getState().status).toBe("starting")

    const r2 = createSpawnResult()
    mockSpawner.resolve(r2.result)
    r2.passHealth()

    await p1
    expect(supervisor.getState().status).toBe("ready")
  })

  // ── Terminal reason: user stop prevents auto restart ───────────────────

  test("terminal reason prevents auto restart", async () => {
    const supervisor = createSupervisor(mockSpawner)

    // Get to ready
    const startPromise = supervisor.start()
    await tick()
    const r1 = createSpawnResult()
    mockSpawner.resolve(r1.result)
    r1.passHealth()
    await startPromise

    // Stop with terminal reason
    await supervisor.stop("user")
    expect(supervisor.getState().status).toBe("stopped")

    // start() should not restart when stopped with terminal reason
    // (start is a no-op when already stopped with terminal reason)
    mockSpawner.callCount = 0
    await supervisor.start()
    await tick()
    // Should not have called spawn again
    expect(mockSpawner.callCount).toBe(0)
  })

  // ── subscribe and unsubscribe ──────────────────────────────────────────

  test("subscribe returns unsubscribe function", async () => {
    const supervisor = createSupervisor(mockSpawner)
    const states: SidecarRuntimeStatus[] = []
    const unsub = supervisor.subscribe((s) => states.push(s.status))

    const startPromise = supervisor.start()
    await tick()
    const r1 = createSpawnResult()
    mockSpawner.resolve(r1.result)
    r1.passHealth()
    await startPromise

    expect(states.length).toBeGreaterThan(0)

    // Unsubscribe
    unsub()
    const countBefore = states.length

    // Trigger exit - should not receive updates
    mockSpawner.triggerExit(1)
    await tick()
    expect(states.length).toBe(countBefore)
  })

  // ── waitForReady ───────────────────────────────────────────────────────

  test("waitForReady resolves when ready", async () => {
    const supervisor = createSupervisor(mockSpawner)

    // Start the supervisor first (initial state is stopped, which now rejects)
    supervisor.start()
    await tick()

    const readyPromise = supervisor.waitForReady()

    const r1 = createSpawnResult()
    mockSpawner.resolve(r1.result)
    r1.passHealth()

    const state = await readyPromise
    expect(state.status).toBe("ready")
  })

  test("waitForReady rejects when failed", async () => {
    const supervisor = createSupervisor(mockSpawner, { maxAttempts: 1, backoffMs: [5] })

    // Start first so state is not "stopped"
    supervisor.start()
    await tick()

    let rejected = false
    supervisor.waitForReady().catch(() => { rejected = true })

    // First spawn fails immediately
    mockSpawner.reject(new Error("fail"))
    await tick()
    // No more retries (maxAttempts=1), should go to failed
    await tick(10)

    expect(rejected).toBe(true)
    expect(supervisor.getState().status).toBe("failed")
  })

  // ── getState returns a copy ────────────────────────────────────────────

  test("getState returns a defensive copy", () => {
    const supervisor = createSupervisor(mockSpawner)
    const state1 = supervisor.getState()
    const state2 = supervisor.getState()
    expect(state1).not.toBe(state2)
    expect(state1).toEqual(state2)
  })

  // ── B-01: restart("user") preserves auto-restart ───────────────────────

  test("restart('user') success does not disable auto-restart", async () => {
    const supervisor = createSupervisor(mockSpawner)

    // Get to ready
    const startPromise = supervisor.start()
    await tick()
    const r1 = createSpawnResult()
    mockSpawner.resolve(r1.result)
    r1.passHealth()
    await startPromise
    expect(supervisor.getState().status).toBe("ready")

    // Sidecar crashes → lost → auto-retry scheduled
    mockSpawner.triggerExit(1)
    await tick()
    expect(supervisor.getState().status).toBe("lost")

    // User calls restart — don't await, resolve spawn first
    const restartPromise = supervisor.restart("user")
    await tick()
    expect(supervisor.getState().status).toBe("starting")

    // Resolve the user-triggered spawn
    const r2 = createSpawnResult()
    mockSpawner.resolve(r2.result)
    r2.passHealth()
    await restartPromise
    expect(supervisor.getState().status).toBe("ready")
    expect(supervisor.getState().generation).toBe(2)

    // Now sidecar crashes again — auto-restart should still work
    mockSpawner.triggerExit(1)
    await tick()
    expect(supervisor.getState().status).toBe("lost")

    // After backoff, should auto-retry
    await tick(20)
    expect(supervisor.getState().status).toBe("restarting")
    expect(mockSpawner.callCount).toBeGreaterThanOrEqual(3)
  })

  // ── W-09: restart from ready forces restart ────────────────────────────

  test("restart from ready stops current sidecar and spawns new one", async () => {
    const supervisor = createSupervisor(mockSpawner)

    // Get to ready
    const startPromise = supervisor.start()
    await tick()
    const r1 = createSpawnResult()
    mockSpawner.resolve(r1.result)
    r1.passHealth()
    await startPromise
    expect(supervisor.getState().status).toBe("ready")
    expect(supervisor.getState().generation).toBe(1)

    // Call restart from ready
    const restartPromise = supervisor.restart("user")
    await tick()
    expect(supervisor.getState().status).toBe("starting")

    const r2 = createSpawnResult()
    mockSpawner.resolve(r2.result)
    r2.passHealth()
    await restartPromise

    expect(supervisor.getState().status).toBe("ready")
    expect(supervisor.getState().generation).toBe(2)
    expect(mockSpawner.callCount).toBe(2)
  })

  // ── W-11: restart from ready suppresses doLost ──────────────────────────

  test("restart from ready does not emit 'lost' state to listeners", async () => {
    const supervisor = createSupervisor(mockSpawner)
    const states: SidecarRuntimeStatus[] = []
    supervisor.subscribe((s) => states.push(s.status))

    // Get to ready with a spawn that triggers exit on stop
    const startPromise = supervisor.start()
    await tick()
    const r1 = createSpawnResult()
    // Override stop to trigger exit (simulating real sidecar behavior)
    let exitCode = 0
    r1.result.listener.stop = async () => { mockSpawner.triggerExit(exitCode) }
    mockSpawner.resolve(r1.result)
    r1.passHealth()
    await startPromise
    expect(supervisor.getState().status).toBe("ready")
    states.length = 0 // Reset

    // Restart from ready — suppressNextExit should prevent "lost"
    exitCode = 0 // clean exit
    const restartPromise = supervisor.restart("user")
    await tick()

    // Should see "starting" but NOT "lost" (suppressed by suppressNextExit)
    expect(states).toContain("starting")
    expect(states).not.toContain("lost")

    const r2 = createSpawnResult()
    mockSpawner.resolve(r2.result)
    r2.passHealth()
    await restartPromise
    expect(supervisor.getState().status).toBe("ready")
  })

  // ── W-12: health check during spawn exit ───────────────────────────────

  test("exit during health check increments attempt only once", async () => {
    const supervisor = createSupervisor(mockSpawner)

    // Start spawn
    supervisor.start()
    await tick()
    const r1 = createSpawnResult()
    mockSpawner.resolve(r1.result)
    // Don't pass health yet — sidecar exits during health check
    mockSpawner.triggerExit(1)
    // Now fail health
    r1.failHealth(new Error("health failed"))
    await tick()

    // attempt should be incremented only once (from doLost), not twice
    expect(supervisor.getState().attempt).toBe(1)
    expect(supervisor.getState().status).toBe("lost")
  })
})
