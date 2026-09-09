import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, utilityProcess } from "electron"
import type { Details } from "electron"
import { WSL_ENABLED_KEY } from "./constants"
import { getUserShell, loadShellEnv, mergeShellEnv, resolveShellPath } from "./shell-env"
import { getStore } from "./store"
import type { SqliteMigrationProgress } from "../preload/types"
import type { SidecarSpawnFactory } from "./sidecar-supervisor"
import {
  captureSidecarExperimentalConfig,
  getCapturedSidecarExperimentalConfig,
  isSidecarOnlyOpencodeKey,
  stripSidecarOpencodeEnv,
} from "./sidecar-credentials"

export type WslConfig = { enabled: boolean }

export type HealthCheck = { wait: Promise<void> }

type SidecarMessage =
  | { type: "sqlite"; progress: SqliteMigrationProgress }
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

export type SidecarLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR"

export type SidecarListener = {
  stop(): Promise<void>
  setLogLevel(level: SidecarLogLevel): void
}

export type SpawnedServer = {
  listener: SidecarListener
  health: { wait: Promise<void> }
}

const SIDECAR_SERVICE_NAME = "ellamaka server"
const SIDECAR_START_STALL_TIMEOUT = 60_000
const SIDECAR_STOP_TIMEOUT = 6_000

type SpawnLocalServerOptions = {
  needsMigration: boolean
  onSqliteProgress?: (progress: SqliteMigrationProgress) => void
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
}

export function getWslConfig(): WslConfig {
  const value = getStore().get(WSL_ENABLED_KEY)
  return { enabled: typeof value === "boolean" ? value : false }
}

export function setWslConfig(config: WslConfig) {
  getStore().set(WSL_ENABLED_KEY, config.enabled)
}

export function preferAppEnv() {
  const appEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const shell = process.platform === "win32" ? null : getUserShell()
  const shellEnv = shell ? loadShellEnv(shell) : null
  const merged = mergeShellEnv(shellEnv, appEnv)
  const resolvedPath = resolveShellPath(shellEnv, appEnv.PATH)
  if (resolvedPath !== undefined) merged.PATH = resolvedPath
  // The login shell may carry sidecar-only OPENCODE_* values (e.g. a developer
  // who exported them in their shell rc). Those belong to the sidecar process
  // (delivered via createSidecarEnv), never to the Electron main process, so
  // capture the user-configured experimental switches to forward to the sidecar
  // (D-03: move into createSidecarEnv, never discard), then strip them from the
  // merged env before writing back — and drop any that are already present in
  // process.env (predicate-matched, so the root switch and any
  // OPENCODE_EXPERIMENTAL_* engine flag are covered).
  captureSidecarExperimentalConfig(merged)
  const clean = stripSidecarOpencodeEnv(merged)
  for (const key of Object.keys(process.env)) {
    if (isSidecarOnlyOpencodeKey(key)) delete process.env[key]
  }
  Object.assign(process.env, clean)
}

export async function spawnLocalServer(
  hostname: string,
  port: number,
  password: string,
  options: SpawnLocalServerOptions,
) {
  const sidecar = join(dirname(fileURLToPath(import.meta.url)), "sidecar.js")
  const child = utilityProcess.fork(sidecar, [], {
    cwd: process.cwd(),
    env: createSidecarEnv(password),
    serviceName: SIDECAR_SERVICE_NAME,
    stdio: "pipe",
    execArgv: ["--experimental-strip-types", "--expose-internals"],
  })
  let exited = false
  const exit = defer<number>()

  const onProcessGone = (_event: unknown, details: Details) => {
    if (details.type !== "Utility" || details.name !== SIDECAR_SERVICE_NAME) return
    options.onStderr?.(`utility process gone reason=${details.reason} exitCode=${details.exitCode}`)
  }

  app.on("child-process-gone", onProcessGone)
  child.once("exit", (code) => {
    exited = true
    app.off("child-process-gone", onProcessGone)
    options.onExit?.(code)
    exit.resolve(code)
  })
  child.on("error", (error) => options.onStderr?.(`utility process error: ${serializeError(error).message}`))

  child.stdout?.on("data", (chunk: Buffer) => options.onStdout?.(chunk.toString("utf8").trimEnd()))
  child.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8").trimEnd()))

  await new Promise<void>((resolve, reject) => {
    let done = false
    let timeout: NodeJS.Timeout

    const fail = (error: Error) => {
      if (done) return
      done = true
      cleanup()
      reject(error)
    }

    const refreshTimeout = () => {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        fail(new Error(`Sidecar did not become ready within ${SIDECAR_START_STALL_TIMEOUT}ms: ${sidecar}`))
      }, SIDECAR_START_STALL_TIMEOUT)
    }

    const onMessage = (message: SidecarMessage) => {
      if (message.type === "sqlite") {
        refreshTimeout()
        options.onSqliteProgress?.(message.progress)
        return
      }
      if (message.type === "ready") {
        if (done) return
        done = true
        cleanup()
        resolve()
        return
      }
      if (message.type === "error") {
        fail(Object.assign(new Error(message.error.message), { stack: message.error.stack }))
      }
    }
    const onExit = (code: number) => {
      fail(new Error(`Sidecar exited before ready with code ${code}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.off("message", onMessage)
      child.off("exit", onExit)
    }

    child.on("message", onMessage)
    child.on("exit", onExit)
    refreshTimeout()
    child.postMessage({
      type: "start",
      hostname,
      port,
      password,
      needsMigration: options.needsMigration,
      // Pass the wopal home and dsh-plugins log path explicitly so the sidecar
      // drives the unified DSH Runtime Manager from the same WOPAL_HOME the
      // Electron main process resolved (probe + shell-merge in index.ts), not
      // from a possibly-stale child env.
      wopalHome: process.env.WOPAL_HOME,
      logFile: process.env.WOPAL_HOME ? join(process.env.WOPAL_HOME, "logs", "dsh-plugins.log") : undefined,
    })
  }).catch((error) => {
    if (!exited) child.kill()
    throw error
  })

  const wait = (async () => {
    const url = `http://${hostname}:${port}`
    let healthy = false
    const gone = exit.promise.then((code) => {
      if (healthy) return
      throw new Error(`Sidecar exited before health check passed with code ${code}`)
    })

    const ready = async () => {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (await checkHealth(url, password)) {
          healthy = true
          return
        }
      }
    }

    await Promise.race([ready(), gone])
  })()

  let stopping: Promise<void> | undefined

  return {
    listener: {
      stop: () => {
        if (stopping) return stopping
        if (exited) return Promise.resolve()
        child.postMessage({ type: "stop" })
        stopping = Promise.race([
          exit.promise.then(() => undefined),
          delay(SIDECAR_STOP_TIMEOUT).then(() => {
            if (!exited) child.kill()
          }),
        ])
        return stopping
      },
      setLogLevel: (level: SidecarLogLevel) => {
        if (!exited) child.postMessage({ type: "setLogLevel", level })
      },
    },
    health: { wait },
  }
}

export async function checkHealth(url: string, password?: string | null): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`ellamaka:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Builds the explicit env for the sidecar utility process. Credentials and the
 * engine switches are written here — never into the main process's
 * process.env — so the sidecar child env carries exactly what the engine needs
 * and no other process (agent terminal, etc.) inherits server credentials.
 */
export function createSidecarEnv(password: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
  )
  delete env.DEBUG
  if (process.platform === "linux") delete env.LD_PRELOAD
  // Desktop defaults are applied first, then the user-configured experimental
  // switches captured by preferAppEnv are overlaid so explicit user intent wins
  // (e.g. OPENCODE_EXPERIMENTAL_LSP_TY set in the shell reaches the sidecar).
  return Object.assign(env, {
    OPENCODE_SERVER_USERNAME: "ellamaka",
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_CLIENT: "ellamaka-desktop",
    OPENCODE_DISABLE_EMBEDDED_WEB_UI: "true",
    OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    // Official rc.1 packages resolve their harness home through $DSH_HOME
    // directly (e.g. dsh-agent-presets' user preset root), bypassing every
    // ctx/config seam the integration owns. Point it at the official-layout
    // home so those resolutions land inside $WOPAL_HOME/dsh/home (A1 layout
    // alignment) and never touch ~/.dsh.
    DSH_HOME: join(process.env.WOPAL_HOME ?? "", "dsh", "home"),
  }, getCapturedSidecarExperimentalConfig())
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Creates a SidecarSpawnFactory that wraps spawnLocalServer.
 * This is the injectable factory used by SidecarSupervisor.
 */
export function createSidecarSpawner(needsMigration: boolean): SidecarSpawnFactory {
  return (hostname, port, password, options) =>
    spawnLocalServer(hostname, port, password, {
      needsMigration,
      onSqliteProgress: options.onSqliteProgress,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
      onExit: options.onExit,
    })
}
