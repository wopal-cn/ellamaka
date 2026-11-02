import { createFactSource } from "./facts"
import { createSetupGithubPort } from "./github"
import { fileCredentials, fileFoundation, fileHomeSeed } from "./home"
import { assertGoals, fingerprintOf, goalSatisfied, planSetup, satisfiedGoals, SetupGoalError } from "./planner"
import { redactSecret } from "./redact"
import { fileStateStore } from "./state"
import {
  SETUP_ERROR,
  SetupServiceError,
  setupPublicError,
  type SetupAction,
  type SetupActionId,
  type SetupCompleteResult,
  type SetupEvent,
  type SetupEventPhase,
  type SetupFacts,
  type SetupGoal,
  type SetupInspectResult,
  type SetupPlan,
  type SetupRunSnapshot,
  type SetupRunStatus,
  type SetupService,
  type SetupServiceOptions,
  type SetupSpaceInitResult,
  type SetupState,
  type SetupStepStatus,
} from "./types"

interface StoredPlan {
  planId: string
  goals: readonly SetupGoal[]
  actions: SetupAction[]
  /** Goals explicitly skipped by this plan; they satisfy only this plan's completion. */
  readonly skipped: Set<SetupGoal>
  fingerprint: string
  readonly createdAt: string
}

interface MutableRun {
  readonly runId: string
  readonly planId: string
  readonly actionId: SetupActionId
  readonly goal: SetupGoal
  readonly startedAt: string
  updatedAt: string
  status: SetupRunStatus
  sequence: number
  result?: Readonly<Record<string, unknown>>
  error?: { code: string; message: string; suggestion?: string }
  readonly events: SetupEvent[]
  readonly controller: AbortController
  /** Set when a cancel arrived while the action was already committing. */
  cancelRequested: boolean
  waiters: Array<() => void>
  settled: Promise<void>
  finish: () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function errorField(error: unknown, field: "code" | "message" | "suggestion"): string | undefined {
  if (!error || typeof error !== "object" || Array.isArray(error) || !(field in error)) return undefined
  const value = Reflect.get(error, field)
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function hasErrorCode(error: unknown, code: string): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current && typeof current === "object" && !Array.isArray(current); depth += 1) {
    if (errorField(current, "code") === code) return true
    current = "cause" in current ? current.cause : undefined
  }
  return false
}

const DEPENDENT_GOALS: readonly SetupGoal[] = ["space", "ontology"]

export function createSetupService(options: SetupServiceOptions): SetupService {
  const home = options.host.wopalHome
  const state = options.state ?? fileStateStore(home)
  const credentials = options.credentials ?? fileCredentials(home)
  const foundation = options.foundation ?? fileFoundation(home)
  const github = options.github ?? createSetupGithubPort(home)
  const homeSeed = options.homeSeed ?? fileHomeSeed(home)
  const factsSource =
    options.facts ??
    createFactSource({
      wopalHome: home,
      ...(options.homeBinding ? { homeBinding: options.homeBinding } : {}),
      ontology: options.ontology,
      space: options.space,
      state,
      credentials,
      github,
    })
  const now = options.now ?? (() => new Date())
  const newId = options.newId ?? (() => crypto.randomUUID())
  const plans = new Map<string, StoredPlan>()
  const runs = new Map<string, MutableRun>()
  // Plans and finished runs only serve reconnects inside this host process.
  const MAX_RETAINED = 64

  function retain<K, V>(map: Map<K, V>, limit: number): void {
    while (map.size > limit) {
      const oldest = map.keys().next()
      if (oldest.done) return
      map.delete(oldest.value)
    }
  }
  /** The single in-flight run for this host process. */
  let active: MutableRun | undefined
  /** Reservation for the plan revalidation window (see execute). */
  let reservation:
    | { readonly planId: string; readonly actionId: SetupActionId; readonly created: Promise<MutableRun> }
    | undefined

  function busyError(): SetupServiceError {
    return new SetupServiceError({
      code: SETUP_ERROR.busy,
      message: "Another setup action is still running on this host.",
      suggestion: "Wait for it to finish, then retry.",
    })
  }

  function timestamp(): string {
    return now().toISOString()
  }

  function snapshot(run: MutableRun): SetupRunSnapshot {
    return {
      runId: run.runId,
      planId: run.planId,
      actionId: run.actionId,
      goal: run.goal,
      status: run.status,
      sequence: run.sequence,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      ...(run.result ? { result: run.result } : {}),
      ...(run.error ? { error: run.error } : {}),
    }
  }

  function emit(run: MutableRun, phase: SetupEventPhase, message: string, error?: SetupEvent["error"]): void {
    run.sequence += 1
    run.updatedAt = timestamp()
    run.events.push({
      sequence: run.sequence,
      runId: run.runId,
      actionId: run.actionId,
      type: error ? "error" : "progress",
      phase,
      message: redactSecret(message),
      at: run.updatedAt,
      ...(error ? { error } : {}),
    })
    for (const notify of run.waiters.splice(0)) notify()
  }

  async function inspect(): Promise<SetupInspectResult> {
    let live: SetupFacts
    try {
      live = await factsSource.read()
    } catch (error) {
      throw new SetupServiceError({
        code: SETUP_ERROR.inspectFailed,
        message: "Setup inspection failed: " + (error instanceof Error ? error.message : String(error)),
        cause: error,
      })
    }
    const fingerprint = fingerprintOf(live)
    return { ...live, goals: satisfiedGoals(live), fingerprint }
  }

  async function plan(input: { goals: readonly SetupGoal[] }): Promise<SetupPlan> {
    let goals: SetupGoal[]
    try {
      goals = assertGoals(input.goals)
    } catch (error) {
      throw new SetupServiceError({
        code: SETUP_ERROR.goalInvalid,
        message: error instanceof SetupGoalError ? error.message : String(error),
        cause: error,
      })
    }
    const live = await factsSource.read()
    const plan: SetupPlan = {
      planId: newId(),
      goals,
      actions: planSetup({ goals, facts: live }),
      fingerprint: fingerprintOf(live),
      createdAt: timestamp(),
    }
    plans.set(plan.planId, {
      planId: plan.planId,
      goals: plan.goals,
      actions: [...plan.actions],
      skipped: new Set(),
      fingerprint: plan.fingerprint,
      createdAt: plan.createdAt,
    })
    retain(plans, MAX_RETAINED)
    return plan
  }

  function requirePlan(planId: string): StoredPlan {
    const stored = plans.get(planId)
    if (!stored) {
      throw new SetupServiceError({
        code: SETUP_ERROR.planNotFound,
        message: "This setup plan no longer exists. Generate a new plan and retry.",
      })
    }
    return stored
  }

  function requireAction(plan: StoredPlan, actionId: SetupActionId): SetupAction {
    const action = plan.actions.find((entry) => entry.actionId === actionId)
    if (!action) {
      throw new SetupServiceError({
        code: SETUP_ERROR.actionNotFound,
        message: "Action " + actionId + " is not pending in this plan.",
      })
    }
    return action
  }

  async function progress(runId: string): Promise<SetupRunSnapshot> {
    const run = runs.get(runId)
    if (!run) {
      throw new SetupServiceError({
        code: SETUP_ERROR.runNotFound,
        message: "Setup run " + runId + " is not known to this host.",
      })
    }
    return snapshot(run)
  }

  async function* progressEvents(input: {
    runId: string
    after?: number
    signal?: AbortSignal
  }): AsyncIterable<SetupEvent> {
    const run = runs.get(input.runId)
    if (!run) {
      throw new SetupServiceError({
        code: SETUP_ERROR.runNotFound,
        message: "Setup run " + input.runId + " is not known to this host.",
      })
    }
    let index = run.events.filter((event) => event.sequence <= (input.after ?? 0)).length
    for (;;) {
      while (index < run.events.length) {
        const event = run.events[index]
        if (!event) break
        index += 1
        yield event
      }
      if (run.status !== "queued" && run.status !== "running") return
      if (input.signal?.aborted) return
      await new Promise<void>((resolve) => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          input.signal?.removeEventListener("abort", done)
          resolve()
        }
        run.waiters.push(done)
        input.signal?.addEventListener("abort", done, { once: true })
      })
    }
  }

  function markStep(next: SetupState, goal: SetupGoal, status: SetupStepStatus, error?: string): SetupState {
    const errors: Record<string, string> = { ...next.errors }
    if (error) errors[goal] = redactSecret(error)
    else delete errors[goal]
    return {
      ...next,
      currentStep: goal,
      steps: { ...next.steps, [goal]: status },
      errors,
      updatedAt: timestamp(),
    }
  }

  async function persistStep(goal: SetupGoal, status: SetupStepStatus, error?: string): Promise<void> {
    const written = await state.update((read) => {
      if (read.status === "corrupt") {
        // Preserve the broken document as-is and report the failure instead of
        // silently replacing the user's recovery position.
        return { error: "The setup state file is unreadable; repair or remove it before continuing." }
      }
      const current: SetupState =
        read.status === "ok"
          ? read.state
          : { version: 1, currentStep: goal, steps: {}, errors: {}, completed: false, startedAt: null, updatedAt: null }
      return markStep({ ...current, startedAt: current.startedAt ?? timestamp() }, goal, status, error)
    })
    if (!written.ok) {
      throw new SetupServiceError({
        code: SETUP_ERROR.stateWriteFailed,
        message: "Failed to persist setup progress: " + written.reason,
      })
    }
  }

  async function actionFor(input: {
    actionId: SetupActionId
    payload: Record<string, unknown>
    signal: AbortSignal
    onProgress: (message: string) => void
  }): Promise<{ result: Record<string, unknown>; outcome: "completed" | "reused" | "skipped" }> {
    const { actionId, payload, signal, onProgress } = input
    switch (actionId) {
      case "foundation": {
        let ensured: Awaited<ReturnType<typeof foundation.ensure>>
        try {
          ensured = await foundation.ensure()
        } catch (error) {
          throw new SetupServiceError({
            code: SETUP_ERROR.foundationFailed,
            message: "Home foundation setup failed: " + (errorField(error, "message") ?? String(error)),
            cause: error,
          })
        }
        return {
          result: { path: ensured.path, created: [...ensured.created] },
          outcome: ensured.created.length === 0 ? "reused" : "completed",
        }
      }
      case "ontology": {
        onProgress("正在下载或复用能力本体。")
        const listed = await options.ontology.list()
        const requestedName = readString(payload.name)
        const existing = requestedName
          ? listed.items.find((item) => item.name === requestedName && item.available && item.readable)
          : listed.items.find((item) => item.available && item.readable)
        const identity = await github.inspect()
        const mode =
          payload.mode === "fork"
            ? "fork"
            : payload.mode === "clone"
              ? "clone"
              : (existing?.mode ?? (identity.configured ? "fork" : "clone"))
        if (mode === "fork" && existing?.mode !== "fork" && !identity.configured) {
          throw new SetupServiceError({
            code: SETUP_ERROR.githubFailed,
            message: "GitHub identity is unavailable for fork mode.",
            suggestion: "Authenticate GitHub first, or choose clone mode.",
          })
        }
        let installed: Awaited<ReturnType<SetupServiceOptions["ontology"]["install"]>>
        try {
          installed = await options.ontology.install(
            {
              ...(requestedName ? { name: requestedName } : existing ? { name: existing.name } : {}),
              ...(readString(payload.source) ? { source: readString(payload.source) } : {}),
              mode,
            },
            signal,
          )
        } catch (error) {
          if (mode === "fork" && hasErrorCode(error, "ONTOLOGY_FORK_UNAVAILABLE")) {
            throw new SetupServiceError({
              code: SETUP_ERROR.ontologyFailed,
              message: "GitHub fork provisioning failed while preparing the Ontology.",
              suggestion:
                errorField(error, "suggestion") ??
                "Verify GitHub authentication and repository permissions, then retry.",
              cause: error,
            })
          }
          throw new SetupServiceError({
            code: SETUP_ERROR.ontologyFailed,
            message: "Ontology setup failed: " + (errorField(error, "message") ?? String(error)),
            ...(errorField(error, "suggestion") ? { suggestion: errorField(error, "suggestion") } : {}),
            cause: error,
          })
        }
        onProgress("能力本体已经就绪，正在写入 Home 基础配置并创建能力目录。")
        try {
          const seeded = await homeSeed.seed(installed.path)
          return {
            result: {
              name: installed.name,
              path: installed.path,
              status: installed.status,
              mode,
              home: seeded,
            },
            outcome: "completed",
          }
        } catch (error) {
          throw new SetupServiceError({
            code: SETUP_ERROR.homeConfigFailed,
            message:
              "Ontology is ready, but Home base configuration failed: " +
              (error instanceof Error ? error.message : String(error)),
            suggestion: "Repair the Home settings or permissions, then retry the Ontology step.",
            cause: new SetupPartialResult({
              name: installed.name,
              path: installed.path,
              status: installed.status,
              mode,
            }),
          })
        }
      }
      case "space": {
        const root = readString(payload.path) ?? ""
        let initialized: SetupSpaceInitResult
        try {
          initialized = await options.space.init(
            { name: readString(payload.name) ?? basenameOf(root), root, type: readString(payload.type) ?? "" },
            signal,
            onProgress,
          )
        } catch (error) {
          throw new SetupServiceError({
            code: SETUP_ERROR.spaceFailed,
            message: "Space setup failed: " + (errorField(error, "message") ?? String(error)),
            ...(errorField(error, "suggestion") ? { suggestion: errorField(error, "suggestion") } : {}),
            cause: error,
          })
        }
        const base = { name: initialized.name, path: initialized.path, materialized: initialized.materialized }
        if (initialized.preparation.status === "ok") {
          return { result: { ...base, preparation: { status: "ok" } }, outcome: "completed" }
        }
        throw new SetupServiceError({
          code:
            initialized.preparation.status === "cancelled"
              ? SETUP_ERROR.operationCancelled
              : SETUP_ERROR.preparationFailed,
          message:
            initialized.preparation.status === "cancelled"
              ? "Space preparation was cancelled; the Space stays materialized."
              : "Space was materialized but its preparation failed: " +
                (initialized.preparation.error?.message ?? "unknown error"),
          suggestion: "Retry the space action; setup only re-prepares the existing Space.",
          cause: new SetupPartialResult(base),
        })
      }
      case "github": {
        if (payload.skip === true) {
          return { result: { mode: "clone" }, outcome: "skipped" }
        }
        const token = readString(payload.token)
        if (!token) {
          throw new SetupServiceError({
            code: SETUP_ERROR.inputRequired,
            message: "A GitHub token is required for this action.",
          })
        }
        let verification: { valid: boolean; account: string | null }
        try {
          verification = await github.verify(token)
        } catch (error) {
          throw new SetupServiceError({
            code: SETUP_ERROR.githubFailed,
            message: "GitHub verification failed: " + (error instanceof Error ? error.message : String(error)),
            cause: error,
          })
        }
        if (!verification.valid) {
          throw new SetupServiceError({
            code: SETUP_ERROR.githubInvalid,
            message: "GitHub rejected the supplied token.",
            suggestion: "Create a token with repo access and retry.",
          })
        }
        const written = await credentials.setGithubToken(token)
        if (!written.ok) {
          throw new SetupServiceError({
            code: SETUP_ERROR.githubFailed,
            message: "GitHub token could not be stored: " + written.reason,
          })
        }
        return {
          result: { account: verification.account, path: written.path, created: written.created },
          outcome: written.created ? "completed" : "reused",
        }
      }
      case "provider": {
        if (payload.skip === true) {
          return { result: { configured: false }, outcome: "skipped" }
        }
        const providerId = readString(payload.providerId) ?? readString(payload.provider)
        const apiKey = readString(payload.apiKey)
        if (!providerId || !apiKey) {
          throw new SetupServiceError({
            code: SETUP_ERROR.inputRequired,
            message: "A provider id and API key are required for this action.",
          })
        }
        const written = await credentials.setProviderKey({ providerId, apiKey })
        if (!written.ok) {
          throw new SetupServiceError({
            code: SETUP_ERROR.providerFailed,
            message: "Provider key could not be stored: " + written.reason,
          })
        }
        return {
          result: { providerId, path: written.path, created: written.created },
          outcome: written.created ? "completed" : "reused",
        }
      }
      default:
        throw new SetupServiceError({
          code: SETUP_ERROR.actionNotFound,
          message: "Unknown setup action " + String(actionId) + ".",
        })
    }
  }

  async function execute(input: {
    planId: string
    actionId: SetupActionId
    input?: unknown
    signal?: AbortSignal
  }): Promise<SetupRunSnapshot> {
    const plan = requirePlan(input.planId)

    if (active) {
      // A repeated request for the action already running reuses its run.
      if (active.actionId === input.actionId && active.planId === plan.planId) return snapshot(active)
      throw busyError()
    }
    if (reservation) {
      // The same action requested again while the first request is still
      // revalidating joins that request instead of duplicating the work.
      if (reservation.planId === plan.planId && reservation.actionId === input.actionId) {
        return snapshot(await reservation.created)
      }
      throw busyError()
    }

    const action = requireAction(plan, input.actionId)
    const pendingDependencies = action.dependsOn.filter((dependency) =>
      plan.actions.some((candidate) => candidate.actionId === dependency),
    )
    if (pendingDependencies.length > 0) {
      throw new SetupServiceError({
        code: SETUP_ERROR.dependencyPending,
        message: "Setup action " + action.actionId + " is waiting for: " + pendingDependencies.join(", ") + ".",
        suggestion: "Execute or explicitly skip the pending dependency actions first.",
      })
    }
    const payload = isRecord(input.input) ? input.input : {}
    requireInput(action, payload)

    let publish!: (run: MutableRun) => void
    let abandon!: (error: unknown) => void
    const created = new Promise<MutableRun>((resolve, reject) => {
      publish = resolve
      abandon = reject
    })
    // A request that lost the reservation race still observes the rejection.
    created.catch(() => {})
    const mine = { planId: plan.planId, actionId: input.actionId, created }
    reservation = mine

    try {
      // Revalidate the critical facts before the first persistent write.
      const live = await factsSource.read()
      if (fingerprintOf(live) !== plan.fingerprint) {
        throw new SetupServiceError({
          code: SETUP_ERROR.planStale,
          message: "Setup facts changed after this plan was generated.",
          suggestion: "Generate a new plan and retry.",
        })
      }

      const run = createRun(plan, action)
      if (input.signal?.aborted) {
        // A request cancelled inside the revalidation window never reaches the
        // action, so it returns a run that closed without any write.
        run.status = "cancelled"
        run.error = {
          code: SETUP_ERROR.operationCancelled,
          message: "The setup request was cancelled before it started.",
        }
        emit(run, "cancelled", run.error.message, run.error)
        run.finish()
        publish(run)
        return snapshot(run)
      }

      active = run
      publish(run)
      void drive(run, payload)
      return snapshot(run)
    } catch (error) {
      abandon(error)
      throw error
    } finally {
      if (reservation === mine) reservation = undefined
    }
  }

  function requireInput(action: SetupAction, payload: Record<string, unknown>): void {
    if (!action.requiresInput) return
    if (action.actionId === "github") {
      const token = readString(payload.token)
      const skip = payload.skip
      if (skip !== undefined && typeof skip !== "boolean") {
        throw new SetupServiceError({
          code: SETUP_ERROR.inputInvalid,
          message: "GitHub skip must be a boolean.",
        })
      }
      if (token && skip === true) {
        throw new SetupServiceError({
          code: SETUP_ERROR.inputInvalid,
          message: "Choose either GitHub authentication or clone-only continuation, not both.",
        })
      }
      if (!token && skip !== true) {
        throw new SetupServiceError({
          code: SETUP_ERROR.inputRequired,
          message: "A GitHub token or an explicit clone-only choice is required for this action.",
        })
      }
    }
    if (action.actionId === "provider") {
      const providerId = readString(payload.providerId) ?? readString(payload.provider)
      const apiKey = readString(payload.apiKey)
      const skip = payload.skip
      if (skip !== undefined && typeof skip !== "boolean") {
        throw new SetupServiceError({
          code: SETUP_ERROR.inputInvalid,
          message: "Provider skip must be a boolean.",
        })
      }
      if (skip === true && (providerId || apiKey)) {
        throw new SetupServiceError({
          code: SETUP_ERROR.inputInvalid,
          message: "Choose either provider configuration or skipping it, not both.",
        })
      }
      if (skip !== true && (!providerId || !apiKey)) {
        throw new SetupServiceError({
          code: SETUP_ERROR.inputRequired,
          message: "A provider id and API key, or an explicit skip choice, are required for this action.",
        })
      }
    }
    if (action.actionId === "space" && !readString(payload.path)) {
      throw new SetupServiceError({
        code: SETUP_ERROR.inputRequired,
        message: "A Space path is required for this action.",
      })
    }
  }

  function createRun(plan: StoredPlan, action: SetupAction): MutableRun {
    const startedAt = timestamp()
    let finish!: () => void
    const settled = new Promise<void>((resolve) => {
      finish = resolve
    })
    const run: MutableRun = {
      runId: newId(),
      planId: plan.planId,
      actionId: action.actionId,
      goal: action.goal,
      startedAt,
      updatedAt: startedAt,
      status: "running",
      sequence: 0,
      events: [],
      controller: new AbortController(),
      cancelRequested: false,
      waiters: [],
      settled,
      finish,
    }
    runs.set(run.runId, run)
    retain(runs, MAX_RETAINED)
    return run
  }

  async function drive(run: MutableRun, payload: Record<string, unknown>): Promise<void> {
    emit(run, "started", "Starting setup action " + run.actionId + ".")
    let outcome: "completed" | "reused" | "skipped" = "completed"
    try {
      // Persist the recovery position before the owned mutation starts. If the
      // process exits mid-action, the next inspect can treat this as a hint and
      // re-derive success from live facts rather than assuming the action won.
      // Foundation is the bootstrap exception: its owner must establish only
      // the WOPAL_HOME root before Setup itself may create ellamaka/state.
      if (run.goal !== "foundation") await persistStep(run.goal, "in-progress")
      const action = actionFor({
        actionId: run.actionId,
        payload,
        signal: run.controller.signal,
        onProgress: (message) => emit(run, "progress", message),
      })
      const resolved = await action
      outcome = resolved.outcome
      run.result = resolved.result
      if (run.goal === "foundation") await persistStep(run.goal, "in-progress")
      await persistStep(run.goal, outcome === "skipped" ? "skipped" : "done")
      if (outcome === "skipped") plans.get(run.planId)?.skipped.add(run.goal)

      if (run.cancelRequested) {
        run.status = "cancelled"
        run.error = {
          code: SETUP_ERROR.operationCancelled,
          message: "Cancellation took effect after the action's safe commit boundary.",
        }
        emit(run, "cancelled", "Setup action " + run.actionId + " stopped after its safe boundary.", run.error)
      } else {
        run.status = "completed"
        emit(
          run,
          "completed",
          outcome === "skipped"
            ? "Setup action " + run.actionId + " skipped."
            : "Setup action " + run.actionId + " completed.",
        )
      }
    } catch (error) {
      const partial = partialResultOf(error)
      if (partial) run.result = partial
      if (run.controller.signal.aborted || run.cancelRequested) {
        run.status = "cancelled"
        run.error = {
          code: SETUP_ERROR.operationCancelled,
          message: "Setup action " + run.actionId + " was cancelled.",
        }
        emit(run, "cancelled", run.error.message, run.error)
        if (!partial) {
          await persistStepSafe(run.goal, "failed", run.error.message)
        }
      } else {
        const publicError = setupPublicError(error, redactSecret)
        run.status = "failed"
        run.error = publicError
        emit(run, "failed", "Setup action " + run.actionId + " failed: " + publicError.message, publicError)
        await persistStepSafe(run.goal, "failed", publicError.message)
      }
    } finally {
      if (active === run) active = undefined
      await advancePlan(run)
      run.finish()
      for (const notify of run.waiters.splice(0)) notify()
    }
  }

  /**
   * Re-baseline the stored plan after its own action finished: a successful
   * action is consumed, and the fingerprint follows the facts the action just
   * produced. An external change after this point is still reported stale.
   */
  async function advancePlan(run: MutableRun): Promise<void> {
    const plan = plans.get(run.planId)
    if (!plan) return
    try {
      const live = await factsSource.read()
      plan.fingerprint = fingerprintOf(live)
      if (run.status === "completed") plan.actions = plan.actions.filter((entry) => entry.actionId !== run.actionId)
    } catch {
      // Keeping the previous fingerprint makes the next execute revalidate and
      // fail closed rather than silently trusting an unknown machine state.
    }
  }

  async function persistStepSafe(goal: SetupGoal, status: SetupStepStatus, error?: string): Promise<void> {
    try {
      await persistStep(goal, status, error)
    } catch {
      // The run already carries the failure; a second state failure must not
      // crash the driver or hide the original error.
    }
  }

  async function cancel(runId: string): Promise<SetupRunSnapshot> {
    const run = runs.get(runId)
    if (!run) {
      throw new SetupServiceError({
        code: SETUP_ERROR.runNotFound,
        message: "Setup run " + runId + " is not known to this host.",
      })
    }
    if (run.status !== "queued" && run.status !== "running") return snapshot(run)

    run.cancelRequested = true
    run.controller.abort()
    // DESIGN-wopalspace.md: cancel returns only after the action's atomic Git/file
    // commit boundary finished its commit or rollback, and then reports the real
    // cancelled/failed/completed state. A bounded wait that publishes a terminal
    // snapshot while the owned mutation is still in flight would let callers retry
    // against it, so this wait is result-driven and has no timeout of its own.
    await run.settled
    return snapshot(run)
  }

  async function complete(input: { planId: string }): Promise<SetupCompleteResult> {
    const plan = requirePlan(input.planId)
    const live = await factsSource.read()

    const unmet = plan.goals.filter((goal) => !goalSatisfied(goal, live) && !plan.skipped.has(goal))
    if (unmet.length > 0) {
      throw new SetupServiceError({
        code: SETUP_ERROR.incomplete,
        message: "Setup is not complete; pending goals: " + unmet.join(", ") + ".",
        suggestion: "Finish the remaining setup actions and retry.",
      })
    }
    const completedAt = timestamp()
    // Read, re-check the document and publish completion under one exclusive
    // lock; a step that finishes concurrently must not lose the completion bit
    // or be silently overwritten by it.
    const written = await state.update((read) => {
      if (read.status === "corrupt") {
        return { error: "The setup state file is unreadable; repair or remove it before completing." }
      }
      const current: SetupState =
        read.status === "ok"
          ? read.state
          : {
              version: 1,
              currentStep: "done",
              steps: {},
              errors: {},
              completed: false,
              startedAt: null,
              updatedAt: null,
            }
      return {
        ...current,
        completed: true,
        currentStep: "done",
        steps: { ...current.steps, done: "done" },
        startedAt: current.startedAt ?? completedAt,
        updatedAt: completedAt,
      }
    })
    if (!written.ok) {
      throw new SetupServiceError({
        code: SETUP_ERROR.stateWriteFailed,
        message: "Failed to persist setup completion: " + written.reason,
      })
    }
    return { completed: true, planId: plan.planId, completedAt }
  }

  return { inspect, plan, execute, progress, progressEvents, cancel, complete }
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? "space"
}

/** Carries a partial domain result through a failure without exposing it as data. */
class SetupPartialResult {
  readonly result: Readonly<Record<string, unknown>>
  constructor(result: Readonly<Record<string, unknown>>) {
    this.result = result
  }
}

function partialResultOf(error: unknown): Readonly<Record<string, unknown>> | undefined {
  return error instanceof SetupServiceError && error.cause instanceof SetupPartialResult
    ? error.cause.result
    : undefined
}

export { DEPENDENT_GOALS }
