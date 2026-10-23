import { randomUUID } from "node:crypto"
import path from "node:path"

export type PreparationTarget = { kind: "host" } | { kind: "instance"; directory: string }

export type PreparationState = "READY" | "NEEDS_PREPARATION" | "PREPARING" | "BUSY" | "DEGRADED"

export type CorePreparationRun = {
  runId: string
  sequence: number
  step: string
  phase: string
  elapsedMs: number
}

export type CorePreparationStepResult = {
  state: Exclude<PreparationState, "PREPARING">
  code?: string
}

export type CorePreparationResult = {
  target: PreparationTarget
  state: PreparationState
  reason?: string
  run?: CorePreparationRun
  steps: { step: string; state: PreparationState; code?: string }[]
}

export type CorePreparationEvent = {
  runId: string
  sequence: number
  target: PreparationTarget
  step: string
  phase: string
  state: PreparationState
  elapsedMs: number
  current?: number
  total?: number
  unit?: string
  code?: string
}

export interface CorePreparationService {
  inspect(target: PreparationTarget): Promise<CorePreparationResult>
  prepare(
    request: { target: PreparationTarget; reason?: string },
    options?: { signal?: AbortSignal; onProgress?: (event: CorePreparationEvent) => void },
  ): Promise<CorePreparationResult>
}

export interface CorePreparationContributor {
  step: string
  target: "host" | "instance"
  inspect(target: PreparationTarget): Promise<CorePreparationStepResult>
  prepare(
    target: PreparationTarget,
    context: {
      signal: AbortSignal
      report(progress: { phase: string; current?: number; total?: number; unit?: string }): void
    },
  ): Promise<CorePreparationStepResult>
}

type ProgressObserver = (event: CorePreparationEvent) => void

type ActivePreparation = {
  readonly target: PreparationTarget
  readonly runId: string
  readonly startedAt: number
  readonly controller: AbortController
  readonly observers: Set<ProgressObserver>
  sequence: number
  latestEvent?: CorePreparationEvent
  promise: Promise<CorePreparationResult>
}

const PREPARATION_CANCELLED = "PREPARATION_CANCELLED"
const PREPARATION_FAILED = "PREPARATION_FAILED"

function normalizeTarget(target: PreparationTarget): PreparationTarget {
  if (target.kind === "host") return { kind: "host" }
  return { kind: "instance", directory: path.resolve(target.directory) }
}

function targetKey(hostKey: string, target: PreparationTarget): string {
  return target.kind === "host" ? `${hostKey}\0host` : `${hostKey}\0instance\0${target.directory}`
}

function stateFromSteps(steps: CorePreparationResult["steps"]): PreparationState {
  if (steps.some((step) => step.state === "DEGRADED")) return "DEGRADED"
  if (steps.some((step) => step.state === "BUSY")) return "BUSY"
  if (steps.some((step) => step.state === "PREPARING")) return "PREPARING"
  if (steps.some((step) => step.state === "NEEDS_PREPARATION")) return "NEEDS_PREPARATION"
  return "READY"
}

function failureCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string" && code.length > 0) return code
  }
  return PREPARATION_FAILED
}

function runSnapshot(event: CorePreparationEvent | undefined): CorePreparationRun | undefined {
  if (!event) return undefined
  return {
    runId: event.runId,
    sequence: event.sequence,
    step: event.step,
    phase: event.phase,
    elapsedMs: event.elapsedMs,
  }
}

function safeNotify(observer: ProgressObserver, event: CorePreparationEvent): void {
  try {
    observer(event)
  } catch {
    // Observers are read-only projections. A broken or disconnected observer
    // must never change the shared preparation task's lifecycle.
  }
}

export function createCorePreparationService(options: {
  hostKey: string
  contributors: readonly CorePreparationContributor[]
  /** Re-emit the latest real phase while a long step is still running. */
  heartbeatMs?: number
}): CorePreparationService {
  const contributors = [...options.contributors]
  const stepsByTarget = new Map<"host" | "instance", Set<string>>()
  for (const contributor of contributors) {
    const steps = stepsByTarget.get(contributor.target) ?? new Set<string>()
    if (steps.has(contributor.step)) {
      throw new Error(`duplicate CorePreparation contributor step for ${contributor.target}: ${contributor.step}`)
    }
    steps.add(contributor.step)
    stepsByTarget.set(contributor.target, steps)
  }

  const active = new Map<string, ActivePreparation>()

  const contributorsFor = (target: PreparationTarget) => contributors.filter((item) => item.target === target.kind)

  const inspectSteps = async (target: PreparationTarget): Promise<CorePreparationResult["steps"]> =>
    Promise.all(
      contributorsFor(target).map(async (contributor) => {
        try {
          const result = await contributor.inspect(target)
          return { step: contributor.step, state: result.state, ...(result.code ? { code: result.code } : {}) }
        } catch (error) {
          return { step: contributor.step, state: "DEGRADED" as const, code: failureCode(error) }
        }
      }),
    )

  const resultFromSteps = (
    target: PreparationTarget,
    steps: CorePreparationResult["steps"],
    current?: ActivePreparation,
  ): CorePreparationResult => {
    const state = stateFromSteps(steps)
    const reason = steps.find((step) => step.state !== "READY" && step.code)?.code
    return {
      target,
      state,
      ...(reason ? { reason } : {}),
      ...(current?.latestEvent ? { run: runSnapshot(current.latestEvent) } : {}),
      steps,
    }
  }

  const inspect = async (input: PreparationTarget): Promise<CorePreparationResult> => {
    const target = normalizeTarget(input)
    const key = targetKey(options.hostKey, target)
    const current = active.get(key)
    const steps = await inspectSteps(target)
    const result = resultFromSteps(target, steps, current)
    if (!current) return result
    return {
      ...result,
      state: "PREPARING",
      ...(current.latestEvent ? { run: runSnapshot(current.latestEvent) } : {}),
    }
  }

  const emit = (
    current: ActivePreparation,
    step: string,
    progress: {
      phase: string
      current?: number
      total?: number
      unit?: string
      state?: PreparationState
      code?: string
    },
  ) => {
    const event: CorePreparationEvent = {
      runId: current.runId,
      sequence: ++current.sequence,
      target: current.target,
      step,
      phase: progress.phase,
      state: progress.state ?? "PREPARING",
      elapsedMs: Math.max(0, performance.now() - current.startedAt),
      ...(progress.current === undefined ? {} : { current: progress.current }),
      ...(progress.total === undefined ? {} : { total: progress.total }),
      ...(progress.unit === undefined ? {} : { unit: progress.unit }),
      ...(progress.code === undefined ? {} : { code: progress.code }),
    }
    current.latestEvent = event
    for (const observer of current.observers) safeNotify(observer, event)
  }

  const cancelledStep = (step: string) => ({
    step,
    state: "DEGRADED" as const,
    code: PREPARATION_CANCELLED,
  })

  const runPreparation = async (current: ActivePreparation): Promise<CorePreparationResult> => {
    const targetContributors = contributorsFor(current.target)
    const steps = await inspectSteps(current.target)

    for (let index = 0; index < targetContributors.length; index += 1) {
      const contributor = targetContributors[index]
      const previous = steps[index]
      if (previous.state === "READY") continue
      if (previous.state === "BUSY") return resultFromSteps(current.target, steps, current)

      if (current.controller.signal.aborted) {
        steps[index] = cancelledStep(contributor.step)
        return resultFromSteps(current.target, steps, current)
      }

      let prepared: CorePreparationStepResult
      let latestProgress: { phase: string; current?: number; total?: number; unit?: string } | undefined
      const heartbeatMs = options.heartbeatMs ?? 5_000
      const heartbeat =
        heartbeatMs > 0
          ? setInterval(() => {
              if (latestProgress) emit(current, contributor.step, latestProgress)
            }, heartbeatMs)
          : undefined
      heartbeat?.unref?.()
      try {
        prepared = await contributor.prepare(current.target, {
          signal: current.controller.signal,
          report: (progress) => {
            latestProgress = progress
            emit(current, contributor.step, progress)
          },
        })
      } catch (error) {
        if (heartbeat) clearInterval(heartbeat)
        if (current.controller.signal.aborted) {
          steps[index] = cancelledStep(contributor.step)
          emit(current, contributor.step, {
            phase: "cancelled",
            state: "DEGRADED",
            code: PREPARATION_CANCELLED,
          })
        } else {
          const code = failureCode(error)
          steps[index] = { step: contributor.step, state: "DEGRADED", code }
          emit(current, contributor.step, { phase: "failed", state: "DEGRADED", code })
        }
        return resultFromSteps(current.target, steps, current)
      } finally {
        if (heartbeat) clearInterval(heartbeat)
      }

      if (current.controller.signal.aborted && prepared.state !== "DEGRADED" && prepared.state !== "BUSY") {
        steps[index] = cancelledStep(contributor.step)
        emit(current, contributor.step, {
          phase: "cancelled",
          state: "DEGRADED",
          code: PREPARATION_CANCELLED,
        })
        return resultFromSteps(current.target, steps, current)
      }

      steps[index] = {
        step: contributor.step,
        state: prepared.state,
        ...(prepared.code ? { code: prepared.code } : {}),
      }
      if (prepared.state !== "READY") {
        emit(current, contributor.step, {
          phase: prepared.state === "BUSY" ? "blocked" : "failed",
          state: prepared.state,
          ...(prepared.code ? { code: prepared.code } : {}),
        })
        return resultFromSteps(current.target, steps, current)
      }
    }

    return resultFromSteps(current.target, steps, current)
  }

  const join = (
    current: ActivePreparation,
    options?: { signal?: AbortSignal; onProgress?: (event: CorePreparationEvent) => void },
  ): Promise<CorePreparationResult> => {
    const observer = options?.onProgress
    if (observer) {
      current.observers.add(observer)
      if (current.latestEvent) safeNotify(observer, current.latestEvent)
    }

    const signal = options?.signal
    const cancelShared = () => current.controller.abort(PREPARATION_CANCELLED)
    if (signal?.aborted) cancelShared()
    else signal?.addEventListener("abort", cancelShared, { once: true })

    return current.promise.finally(() => {
      if (observer) current.observers.delete(observer)
      signal?.removeEventListener("abort", cancelShared)
    })
  }

  const prepare: CorePreparationService["prepare"] = (request, callOptions) => {
    const target = normalizeTarget(request.target)
    const key = targetKey(options.hostKey, target)
    let current = active.get(key)
    if (!current) {
      let created: ActivePreparation
      const promise = Promise.resolve()
        .then(() => runPreparation(created))
        .finally(() => {
          if (active.get(key) === created) active.delete(key)
        })
      created = {
        target,
        runId: randomUUID(),
        startedAt: performance.now(),
        controller: new AbortController(),
        observers: new Set(),
        sequence: 0,
        promise,
      }
      active.set(key, created)
      current = created
    }
    return join(current, callOptions)
  }

  return { inspect, prepare }
}
