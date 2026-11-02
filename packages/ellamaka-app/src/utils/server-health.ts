import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { createSdkForServer } from "./server"
import { Accessor, createEffect, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

export type DshRuntimeStatus = "disabled" | "preparing" | "ready" | "degraded"
export type DshRuntimeHealth = {
  web: DshRuntimeStatus
  tools: DshRuntimeStatus
}

/** Health records are keyed by the concrete connection, including sidecar generation. */
export function resolveServerHealthKey(
  key: ServerConnection.Key,
  current?: ServerConnection.Any,
): ServerConnection.Key {
  return current ? ServerConnection.key(current) : key
}

export type CorePreparationState = "READY" | "NEEDS_PREPARATION" | "PREPARING" | "BUSY" | "DEGRADED"

/** One Core Preparation step, as reported by `/global/health`. */
export type CorePreparationStep = {
  step: string
  state: CorePreparationState
  code?: string
}

/**
 * Runtime Core Preparation facts. Read live from health on every probe and
 * never persisted into Setup state (DESIGN-onboarding.md).
 */
export type CorePreparationHealth = {
  state: CorePreparationState
  steps: readonly CorePreparationStep[]
  run?: { step: string; phase: string; elapsedMs: number }
}

export type ServerHealth = {
  healthy: boolean
  version?: string
  dsh?: DshRuntimeHealth
  preparation?: CorePreparationHealth
  /** The server rejected the stored credentials (HTTP 401). */
  unauthorized?: boolean
}

interface CheckServerHealthOptions {
  timeoutMs?: number
  signal?: AbortSignal
  retryCount?: number
  retryDelayMs?: number
}

const defaultTimeoutMs = 3000
const defaultRetryCount = 2
const defaultRetryDelayMs = 100
const cacheMs = 750
const healthCache = new Map<
  string,
  { at: number; done: boolean; fetch: typeof globalThis.fetch; promise: Promise<ServerHealth> }
>()

function cacheKey(server: ServerConnection.HttpBase) {
  return `${server.url}\n${server.username ?? ""}\n${server.password ?? ""}`
}

function timeoutSignal(timeoutMs: number) {
  const timeout = Reflect.get(AbortSignal, "timeout")
  if (typeof timeout === "function") {
    try {
      const signal: unknown = Reflect.apply(timeout, AbortSignal, [timeoutMs])
      if (!(signal instanceof AbortSignal)) throw new TypeError("AbortSignal.timeout returned an invalid signal")
      return {
        signal,
        clear: undefined as (() => void) | undefined,
      }
    } catch {}
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Narrow the SDK's `preparation` payload to the shape the wizard renders.
 *
 * The SDK type is the wire contract; this keeps a single reading site so the
 * UI never indexes into an untyped response. Unknown states are dropped rather
 * than guessed — a step the client cannot interpret must not gate navigation.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readStep(value: unknown): CorePreparationStep | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.step !== "string" || !isPreparationState(value.state)) return undefined
  return {
    step: value.step,
    state: value.state,
    ...(typeof value.code === "string" ? { code: value.code } : {}),
  }
}

function readRun(value: unknown): CorePreparationHealth["run"] {
  if (!isRecord(value)) return undefined
  if (typeof value.step !== "string" || typeof value.phase !== "string") return undefined
  return {
    step: value.step,
    phase: value.phase,
    elapsedMs: typeof value.elapsedMs === "number" ? value.elapsedMs : 0,
  }
}

function readPreparation(value: unknown): CorePreparationHealth | undefined {
  if (!isRecord(value) || !isPreparationState(value.state)) return undefined
  const steps: CorePreparationStep[] = []
  for (const entry of Array.isArray(value.steps) ? value.steps : []) {
    const step = readStep(entry)
    if (step) steps.push(step)
  }
  const run = readRun(value.run)
  return { state: value.state, steps, ...(run ? { run } : {}) }
}

function isPreparationState(value: unknown): value is CorePreparationState {
  return (
    value === "READY" ||
    value === "NEEDS_PREPARATION" ||
    value === "PREPARING" ||
    value === "BUSY" ||
    value === "DEGRADED"
  )
}

function retryable(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return false
  if (!(error instanceof Error)) return false
  if (error.name === "AbortError" || error.name === "TimeoutError") return false
  if (error instanceof TypeError) return true
  return /network|fetch|econnreset|econnrefused|enotfound|timedout/i.test(error.message)
}

export async function checkServerHealth(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  opts?: CheckServerHealthOptions,
): Promise<ServerHealth> {
  const timeout = opts?.signal ? undefined : timeoutSignal(opts?.timeoutMs ?? defaultTimeoutMs)
  const signal = opts?.signal ?? timeout?.signal
  const retryCount = opts?.retryCount ?? defaultRetryCount
  const retryDelayMs = opts?.retryDelayMs ?? defaultRetryDelayMs
  const next = (count: number, error: unknown, response?: Response): Promise<ServerHealth> => {
    // A 401 is a definitive credential rejection, never a transient network
    // failure — report it immediately so the UI can ask for fresh credentials
    // instead of spinning on retries.
    if (response?.status === 401) return Promise.resolve({ healthy: false, unauthorized: true })
    if (count >= retryCount || !retryable(error, signal)) return Promise.resolve({ healthy: false })
    return wait(retryDelayMs * (count + 1), signal)
      .then(() => attempt(count + 1))
      .catch(() => ({ healthy: false }))
  }
  const attempt = (count: number): Promise<ServerHealth> =>
    createSdkForServer({
      server,
      fetch,
      signal,
    })
      .global.health()
      .then((x) =>
        x.error
          ? next(count, x.error, x.response)
          : {
              healthy: x.data?.healthy ?? false,
              version: x.data?.version,
              ...(x.data?.dsh !== undefined ? { dsh: x.data.dsh } : {}),
              ...(readPreparation(x.data?.preparation) !== undefined
                ? { preparation: readPreparation(x.data.preparation) }
                : {}),
            },
      )
      .catch((error) => next(count, error))
  return attempt(0).finally(() => timeout?.clear?.())
}

const pollMs = 10_000

export function useCheckServerHealth() {
  const platform = usePlatform()
  const fetcher = platform.fetch ?? globalThis.fetch

  return (http: ServerConnection.HttpBase, opts?: CheckServerHealthOptions) => {
    if (
      opts?.signal ||
      opts?.timeoutMs !== undefined ||
      opts?.retryCount !== undefined ||
      opts?.retryDelayMs !== undefined
    )
      return checkServerHealth(http, fetcher, opts)
    const key = cacheKey(http)
    const hit = healthCache.get(key)
    const now = Date.now()
    if (hit && hit.fetch === fetcher && (!hit.done || now - hit.at < cacheMs)) return hit.promise
    const promise = checkServerHealth(http, fetcher).finally(() => {
      const next = healthCache.get(key)
      if (!next || next.promise !== promise) return
      next.done = true
      next.at = Date.now()
    })
    healthCache.set(key, { at: now, done: false, fetch: fetcher, promise })
    return promise
  }
}

export const useServerHealth = (servers: Accessor<ServerConnection.Any[]>, enabled: Accessor<boolean>) => {
  const checkServerHealth = useCheckServerHealth()
  const [status, setStatus] = createStore({} as Record<ServerConnection.Key, ServerHealth | undefined>)

  createEffect(() => {
    if (!enabled()) {
      setStatus(reconcile({}))
      return
    }
    const list = servers()
    let dead = false

    const refresh = async () => {
      const results: Record<string, ServerHealth> = {}
      await Promise.all(
        list.map(async (conn) => {
          results[ServerConnection.key(conn)] = await checkServerHealth(conn.http)
        }),
      )
      if (dead) return
      setStatus(reconcile(results))
    }

    void refresh()
    const id = setInterval(() => void refresh(), pollMs)
    onCleanup(() => {
      dead = true
      clearInterval(id)
    })
  })

  return status
}
