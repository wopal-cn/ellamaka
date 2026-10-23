export type SidecarRuntimeStatus = "starting" | "ready" | "lost" | "restarting" | "failed" | "stopped"

export type SidecarTerminalReason = "user" | "update" | "quit"

export type SidecarLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR"

export type SidecarRuntimeState = {
  generation: number
  status: SidecarRuntimeStatus
  connection?: { url: string; username: string; password: string }
  attempt: number
  nextRetryAt?: number
  errorCode?: string
}

export type SidecarSpawnResult = {
  listener: {
    stop: () => Promise<void>
    setLogLevel: (level: SidecarLogLevel) => void
    adoptLegacyDshHome?: () => void
  }
  health: { wait: Promise<void> }
}

export type SidecarSpawnOptions = {
  onSqliteProgress?: (progress: any) => void
  onDshLegacyAdoptionRequired?: () => void
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
}

export type SidecarSpawnFactory = (
  hostname: string,
  port: number,
  password: string,
  options: SidecarSpawnOptions,
) => Promise<SidecarSpawnResult>

export type SidecarSupervisorDeps = {
  spawn: SidecarSpawnFactory
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  hostname: string
  port: number
  password: string
  backoffMs?: number[]
  maxAttempts?: number
  stableWindowMs?: number
  onSqliteProgress?: (progress: any) => void
  onDshLegacyAdoptionRequired?: () => void
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
}

type Listener = (state: SidecarRuntimeState) => void

const DEFAULT_BACKOFF_MS = [1000, 2000, 5000]
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_STABLE_WINDOW_MS = 60_000

function cloneState(state: SidecarRuntimeState): SidecarRuntimeState {
  return {
    generation: state.generation,
    status: state.status,
    connection: state.connection ? { ...state.connection } : undefined,
    attempt: state.attempt,
    nextRetryAt: state.nextRetryAt,
    errorCode: state.errorCode,
  }
}

export function nextBackoffMs(attempt: number, backoffMs: number[]): number {
  const index = Math.min(attempt, backoffMs.length - 1)
  return backoffMs[index] ?? backoffMs[backoffMs.length - 1] ?? 5000
}

export function isTerminalReason(reason: string): reason is SidecarTerminalReason {
  return reason === "user" || reason === "update" || reason === "quit"
}

export class SidecarSupervisor {
  private state: SidecarRuntimeState
  private listeners: Set<Listener> = new Set()
  private operationQueue: Promise<void> = Promise.resolve()
  private currentSpawn: SidecarSpawnResult | null = null
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private stableTimer: ReturnType<typeof setTimeout> | undefined
  private terminalReason: SidecarTerminalReason | undefined
  private waitForReadyResolve: ((state: SidecarRuntimeState) => void) | undefined
  private waitForReadyReject: ((error: Error) => void) | undefined
  private suppressNextExit = false

  private deps: {
    spawn: SidecarSpawnFactory
    setTimeout: typeof setTimeout
    clearTimeout: typeof clearTimeout
    hostname: string
    port: number
    password: string
    backoffMs: number[]
    maxAttempts: number
    stableWindowMs: number
    onSqliteProgress?: (progress: any) => void
    onDshLegacyAdoptionRequired?: () => void
    onStdout?: (message: string) => void
    onStderr?: (message: string) => void
    onExit?: (code: number) => void
  }

  constructor(deps: SidecarSupervisorDeps) {
    this.deps = {
      backoffMs: deps.backoffMs ?? DEFAULT_BACKOFF_MS,
      maxAttempts: deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      stableWindowMs: deps.stableWindowMs ?? DEFAULT_STABLE_WINDOW_MS,
      ...deps,
    }

    this.state = {
      generation: 0,
      status: "stopped",
      attempt: 0,
    }
  }

  getState(): SidecarRuntimeState {
    return cloneState(this.state)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  start(): Promise<void> {
    return this.enqueue(() => this.doStart())
  }

  restart(trigger: "user" | "auto"): Promise<void> {
    return this.enqueue(() => this.doRestart(trigger))
  }

  stop(reason: SidecarTerminalReason): Promise<void> {
    return this.enqueue(() => this.doStop(reason))
  }

  setLogLevel(level: SidecarLogLevel): void {
    this.currentSpawn?.listener.setLogLevel(level)
  }

  adoptLegacyDshHome(): void {
    this.currentSpawn?.listener.adoptLegacyDshHome?.()
  }

  waitForReady(): Promise<SidecarRuntimeState> {
    return new Promise<SidecarRuntimeState>((resolve, reject) => {
      if (this.state.status === "ready") {
        resolve(cloneState(this.state))
        return
      }
      if (this.state.status === "failed" || this.state.status === "stopped") {
        reject(new Error(`Sidecar is ${this.state.status}`))
        return
      }
      this.waitForReadyResolve = resolve
      this.waitForReadyReject = reject
    })
  }

  // ── Private ────────────────────────────────────────────────────────────

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const prev = this.operationQueue
    this.operationQueue = prev.then(fn, fn)
    return this.operationQueue
  }

  private setState(partial: Partial<SidecarRuntimeState>) {
    Object.assign(this.state, partial)
    this.notify()
  }

  private notify() {
    const snapshot = cloneState(this.state)
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Swallow listener errors
      }
    }

    // Resolve/reject waitForReady
    if (this.state.status === "ready" && this.waitForReadyResolve) {
      this.waitForReadyResolve(snapshot)
      this.waitForReadyResolve = undefined
      this.waitForReadyReject = undefined
    }
    if ((this.state.status === "failed" || this.state.status === "stopped") && this.waitForReadyReject) {
      this.waitForReadyReject(new Error(`Sidecar is ${this.state.status}`))
      this.waitForReadyResolve = undefined
      this.waitForReadyReject = undefined
    }
  }

  private clearTimers() {
    if (this.retryTimer !== undefined) {
      this.deps.clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
    if (this.stableTimer !== undefined) {
      this.deps.clearTimeout(this.stableTimer)
      this.stableTimer = undefined
    }
  }

  private async doStart(): Promise<void> {
    if (this.state.status === "ready" || this.state.status === "starting") {
      return
    }
    if (this.state.status === "stopped" && this.terminalReason) {
      return
    }

    this.terminalReason = undefined
    this.clearTimers()
    this.setState({ status: "starting", attempt: 0, errorCode: undefined })

    try {
      await this.spawnAndWait()
    } catch {
      // doStart failure is handled by spawnAndWait → doLost
    }
  }

  private async doRestart(trigger: "user" | "auto"): Promise<void> {
    // Only doStop sets terminalReason; restart never does.
    // "user" trigger means the user explicitly requested a restart (e.g. via IPC),
    // "auto" trigger is the internal retry mechanism.

    // No-op if already in a stable or transitional state
    if (this.state.status === "starting" || this.state.status === "restarting") {
      return
    }

    if (this.state.status === "ready") {
      // Force restart from ready: suppress doLost during stop, then start anew
      this.suppressNextExit = true
      if (this.currentSpawn) {
        try {
          await this.currentSpawn.listener.stop()
        } catch {}
        this.currentSpawn = null
      }
      this.clearTimers()
      this.setState({ status: "starting", errorCode: undefined, attempt: 0 })
      try {
        await this.spawnAndWait()
      } catch {
        // spawnAndWait calls doLost internally
      }
      return
    }

    if (this.state.status === "failed" && trigger === "auto") {
      return
    }

    if (this.state.status === "stopped" && this.terminalReason) {
      return
    }

    this.clearTimers()
    // Reset attempt counter for user-triggered restarts
    const attempt = trigger === "user" ? 0 : this.state.attempt
    this.setState({ status: "starting", errorCode: undefined, attempt })

    try {
      await this.spawnAndWait()
    } catch {
      // spawnAndWait calls doLost internally
    }
  }

  private async doStop(reason: SidecarTerminalReason): Promise<void> {
    this.terminalReason = reason
    this.clearTimers()

    // Kill current sidecar
    if (this.currentSpawn) {
      try {
        await this.currentSpawn.listener.stop()
      } catch {
        // Swallow stop errors
      }
      this.currentSpawn = null
    }

    this.setState({ status: "stopped", attempt: 0, errorCode: undefined, connection: undefined })
  }

  private async spawnAndWait(): Promise<void> {
    const { hostname, port, password } = this.deps

    try {
      const result = await this.deps.spawn(hostname, port, password, {
        onSqliteProgress: this.deps.onSqliteProgress,
        onDshLegacyAdoptionRequired: this.deps.onDshLegacyAdoptionRequired,
        onStdout: this.deps.onStdout,
        onStderr: this.deps.onStderr,
        onExit: (code: number) => {
          this.deps.onExit?.(code)
          this.handleExit(code)
        },
      })

      this.currentSpawn = result

      // Wait for health check
      await result.health.wait

      // Success
      this.setState({
        status: "ready",
        generation: this.state.generation + 1,
        attempt: 0,
        errorCode: undefined,
        nextRetryAt: undefined,
        connection: {
          url: `http://${hostname}:${port}`,
          username: "ellamaka",
          password,
        },
      })

      // Start stable window timer
      this.startStableWindow()
    } catch (error) {
      this.currentSpawn = null
      const message = error instanceof Error ? error.message : String(error)
      this.doLost(message)
    }
  }

  private handleExit(code: number) {
    if (this.state.status === "stopped") return
    if (this.suppressNextExit) {
      this.suppressNextExit = false
      this.currentSpawn = null
      return
    }
    this.currentSpawn = null
    this.doLost(`EXIT_${code}`)
  }

  private doLost(errorCode: string) {
    if (this.state.status === "stopped") return
    // Prevent double-call: handleExit may fire while we're already processing a loss
    if (this.state.status === "lost") return

    this.clearTimers()
    this.setState({
      status: "lost",
      errorCode,
      attempt: this.state.attempt + 1,
    })

    if (this.terminalReason) {
      this.setState({ status: "stopped" })
      return
    }

    if (this.state.attempt >= this.deps.maxAttempts) {
      this.setState({ status: "failed" })
      return
    }

    // Schedule retry
    const delay = nextBackoffMs(this.state.attempt - 1, this.deps.backoffMs)
    this.setState({ nextRetryAt: Date.now() + delay })

    this.retryTimer = this.deps.setTimeout(() => {
      this.retryTimer = undefined
      this.enqueue(() => this.doRetry())
    }, delay)
  }

  private async doRetry(): Promise<void> {
    if (this.state.status !== "lost") return
    if (this.terminalReason) return

    this.setState({ status: "restarting" })

    try {
      await this.spawnAndWait()
    } catch {
      // spawnAndWait calls doLost internally
    }
  }

  private startStableWindow() {
    if (this.stableTimer !== undefined) {
      this.deps.clearTimeout(this.stableTimer)
    }
    this.stableTimer = this.deps.setTimeout(() => {
      this.stableTimer = undefined
      if (this.state.status === "ready") {
        this.setState({ attempt: 0 })
      }
    }, this.deps.stableWindowMs)
  }
}
