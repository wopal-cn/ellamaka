import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type {
  CorePreparationEvent,
  CorePreparationResult,
  CorePreparationService,
} from "@wopal/ellamaka-core/preparation"
import {
  DEFAULT_DSH_RUNTIME_MANIFEST,
  createDshPreparationService,
  readDshHomeState,
  type DshLogLevel,
} from "@wopal/ellamaka-cordis/runtime"
import { GlobalBus } from "@/bus/global"
import { setDshStatus } from "@/workbench/dsh-status"
import "./preparation-event"

export type DshHostPreparationStatus = "disabled" | "prepared" | "degraded"

export type DshHostPreparationOptions = {
  wopalHome: string
  runtimeLogFile: string
  logLevel?: DshLogLevel
  print?: boolean
  env?: Record<string, string | undefined>
  onProgress?: (event: CorePreparationEvent) => void
}

export type DshRuntimeHealth = {
  closureVersion: number
  homeVersion?: number
  reasonCode?: string
}

type HostRuntime = {
  key: string
  service: CorePreparationService
  options: DshHostPreparationOptions
  preparing: boolean
  lastResult?: CorePreparationResult
  lastPublished?: { runId: string; sequence: number }
}

const hosts = new Map<string, HostRuntime>()
let current: HostRuntime | undefined
let disabledRuntime: DshRuntimeHealth | undefined

function enabled(env: Record<string, string | undefined>): boolean {
  return env.ELLAMAKA_DSH !== "0"
}

function hostKey(options: DshHostPreparationOptions): string {
  return `${resolve(options.wopalHome)}::${DEFAULT_DSH_RUNTIME_MANIFEST.fingerprint ?? DEFAULT_DSH_RUNTIME_MANIFEST.closureVersion}`
}

function publish(
  runtime: HostRuntime | undefined,
  event: CorePreparationEvent,
  observer?: (event: CorePreparationEvent) => void,
) {
  observer?.(event)
  if (runtime?.lastPublished?.runId === event.runId && runtime.lastPublished.sequence >= event.sequence) return
  if (runtime) runtime.lastPublished = { runId: event.runId, sequence: event.sequence }
  GlobalBus.emit("event", {
    directory: "global",
    payload: { type: "core.preparation", properties: event },
  })
}

function getRuntime(options: DshHostPreparationOptions): HostRuntime {
  const key = hostKey(options)
  const found = hosts.get(key)
  if (found) {
    found.options = options
    return found
  }
  const runtime: HostRuntime = {
    key,
    options,
    preparing: false,
    service: createDshPreparationService({
      wopalHome: options.wopalHome,
      logFile: options.runtimeLogFile,
      logLevel: options.logLevel,
      print: options.print,
      env: options.env,
      manifest: DEFAULT_DSH_RUNTIME_MANIFEST,
      closureVersion: DEFAULT_DSH_RUNTIME_MANIFEST.closureVersion,
    }),
  }
  hosts.set(key, runtime)
  return runtime
}

export async function prepareDshHost(options: DshHostPreparationOptions): Promise<{
  status: DshHostPreparationStatus
  preparation?: CorePreparationResult
}> {
  const env = options.env ?? process.env
  if (!enabled(env)) {
    setDshStatus("disabled")
    disabledRuntime = { closureVersion: DEFAULT_DSH_RUNTIME_MANIFEST.closureVersion }
    const event: CorePreparationEvent = {
      runId: randomUUID(),
      sequence: 1,
      target: { kind: "host" },
      step: "dsh",
      phase: "skipped",
      state: "READY",
      elapsedMs: 0,
      code: "DSH_DISABLED",
    }
    publish(undefined, event, options.onProgress)
    return { status: "disabled" }
  }

  disabledRuntime = undefined
  const runtime = getRuntime({ ...options, env })
  current = runtime
  runtime.preparing = true
  setDshStatus("preparing")
  try {
    const preparation = await runtime.service.prepare(
      { target: { kind: "host" }, reason: "product-startup" },
      { onProgress: (event) => publish(runtime, event, options.onProgress) },
    )
    runtime.lastResult = preparation
    if (preparation.state !== "READY") {
      setDshStatus("degraded")
      return { status: "degraded", preparation }
    }
    return { status: "prepared", preparation }
  } finally {
    runtime.preparing = false
  }
}

export function writeCorePreparationProgress(event: CorePreparationEvent): void {
  const elapsed = `${(event.elapsedMs / 1000).toFixed(1)}s`
  const amount =
    event.current === undefined
      ? ""
      : event.total === undefined
        ? ` ${event.current}${event.unit ? ` ${event.unit}` : ""}`
        : ` ${event.current}/${event.total}${event.unit ? ` ${event.unit}` : ""}`
  const code = event.code ? ` ${event.code}` : ""
  const line = `core-preparation ${event.step} ${event.phase} ${elapsed}${amount}${code}`
  // TTY may update the current line; non-TTY/CI gets stable line events.
  if (process.stderr.isTTY) process.stderr.write(`\r${line}\x1b[K`)
  else process.stderr.write(`${line}\n`)
}

export async function getCorePreparationHealth(): Promise<{
  dshRuntime: DshRuntimeHealth
  preparation?: CorePreparationResult
}> {
  // Health must preserve the kill-switch zero-access boundary even when a test
  // or embedding host toggles the environment after module evaluation.
  if (process.env.ELLAMAKA_DSH === "0") {
    return { dshRuntime: { closureVersion: DEFAULT_DSH_RUNTIME_MANIFEST.closureVersion } }
  }
  if (disabledRuntime) return { dshRuntime: disabledRuntime }
  const runtime = current
  if (!runtime) return { dshRuntime: { closureVersion: DEFAULT_DSH_RUNTIME_MANIFEST.closureVersion } }

  const preparation = runtime.preparing ? await runtime.service.inspect({ kind: "host" }) : runtime.lastResult
  const state = await readDshHomeState(runtime.options.wopalHome)
  const homeVersion = "closureVersion" in state ? state.closureVersion : undefined
  const reasonCode = preparation?.reason
  return {
    dshRuntime: {
      closureVersion: DEFAULT_DSH_RUNTIME_MANIFEST.closureVersion,
      ...(homeVersion === undefined ? {} : { homeVersion }),
      ...(reasonCode ? { reasonCode } : {}),
    },
    ...(preparation ? { preparation } : {}),
  }
}
