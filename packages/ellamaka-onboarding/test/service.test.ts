import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

import { extractJsonEnvelope, resolveWopalCliEntry, runSetupOperation } from "../src/machine-runner"
import { OnboardingBusyError, OnboardingService, getOnboardingStatePath, getWopalHome } from "../src/service"
import {
  ONBOARDING_HEALTH_GATE_FAILED,
  ONBOARDING_OPERATION_BUSY,
  ONBOARDING_STEPS,
  type OnboardingCompleteResult,
  type OnboardingStepExecutor,
  type OnboardingStepResult,
} from "../src/types"

function tempHome(): string {
  return join(tmpdir(), `ellamaka-onboarding-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

function writeStateFile(home: string, state: unknown): void {
  const path = getOnboardingStatePath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof state === "string" ? state : JSON.stringify(state, null, 2), "utf-8")
}

function readStateFile(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(getOnboardingStatePath(home), "utf-8"))
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function expectBusy(promise: Promise<unknown>): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(OnboardingBusyError)
  expect((caught as OnboardingBusyError).code).toBe(ONBOARDING_OPERATION_BUSY)
}

/** Narrow a `POST /complete` response to its refusal branch for assertions. */
function refusal(result: OnboardingCompleteResult): { code?: string; message?: string } {
  if ("completed" in result) throw new Error("expected the completion gate to refuse, but it completed")
  return result.error
}

let testHome: string

beforeEach(() => {
  testHome = tempHome()
  mkdirSync(testHome, { recursive: true })
})

afterEach(() => {
  if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true })
})

describe("onboarding state persistence", () => {
  test("getState returns the default view when no state file exists", () => {
    const service = new OnboardingService({ home: testHome })
    expect(service.getState()).toEqual({ completed: false, currentStep: "system-check", completedSteps: [] })
  })

  test("getState reads persisted step statuses into the view", () => {
    writeStateFile(testHome, {
      version: 1,
      currentStep: "create-space",
      steps: { "system-check": "done", "install-cli": "done", "ontology-setup": "skipped" },
      errors: {},
      completed: false,
      startedAt: null,
      updatedAt: null,
    })
    const service = new OnboardingService({ home: testHome })
    const view = service.getState()
    expect(view.completed).toBe(false)
    expect(view.currentStep).toBe("create-space")
    expect(view.completedSteps).toEqual(["system-check", "install-cli"])
  })

  test("getState reports completed when the state file is completed", () => {
    writeStateFile(testHome, {
      version: 1,
      currentStep: "done",
      steps: Object.fromEntries(ONBOARDING_STEPS.map((step) => [step, "done"])),
      errors: {},
      completed: true,
      startedAt: null,
      updatedAt: null,
    })
    const service = new OnboardingService({ home: testHome })
    expect(service.getState().completed).toBe(true)
    expect(service.getState().completedSteps).toEqual([...ONBOARDING_STEPS])
  })

  test("a corrupted state file is moved to a timestamped .bak backup", () => {
    writeStateFile(testHome, "{ not valid json")
    const service = new OnboardingService({ home: testHome })
    expect(service.getState()).toEqual({ completed: false, currentStep: "system-check", completedSteps: [] })
    expect(existsSync(getOnboardingStatePath(testHome))).toBe(false)

    const dir = dirname(getOnboardingStatePath(testHome))
    const backups = readdirSync(dir).filter((name) => name.startsWith("onboarding.json.bak."))
    expect(backups.length).toBe(1)
  })

  test("legacy step names are migrated on read", () => {
    writeStateFile(testHome, {
      version: 1,
      currentStep: "github-auth",
      steps: { "install-ellamaka-cli": "done" },
      errors: {},
      completed: false,
      startedAt: null,
      updatedAt: null,
    })
    const service = new OnboardingService({ home: testHome })
    expect(service.getState().currentStep).toBe("ontology-setup")
  })

  test("a legacy state file that still records memory-config reads normally", () => {
    writeStateFile(testHome, {
      version: 1,
      currentStep: "done",
      steps: {
        "system-check": "done",
        "install-cli": "done",
        "ontology-setup": "done",
        "create-space": "done",
        "ai-provider": "skipped",
        "memory-config": "done",
        done: "done",
      },
      errors: {},
      completed: true,
      startedAt: null,
      updatedAt: null,
    })
    const service = new OnboardingService({ home: testHome })
    const view = service.getState()
    expect(view.completed).toBe(true)
    expect(view.currentStep).toBe("done")
    // The removed step is simply not part of the canonical step list.
    expect(view.completedSteps).toEqual(["system-check", "install-cli", "ontology-setup", "create-space", "done"])
  })

  test("the canonical step list no longer carries memory-config", () => {
    expect(ONBOARDING_STEPS).not.toContain("memory-config")
    expect(ONBOARDING_STEPS).toEqual([
      "system-check",
      "install-cli",
      "ontology-setup",
      "create-space",
      "ai-provider",
      "done",
    ])
  })

  test("getWopalHome expands ~ and honors WOPAL_HOME", () => {
    expect(getWopalHome("/tmp/custom")).toBe("/tmp/custom")
    expect(getWopalHome("~/custom")).not.toContain("~")
    expect(getOnboardingStatePath("/tmp/custom")).toBe("/tmp/custom/ellamaka/state/onboarding.json")
  })
})

describe("OnboardingService step scheduling", () => {
  test("executeStep runs the injected executor and persists the step as done", async () => {
    const calls: Array<{ step: string; input: unknown }> = []
    const service = new OnboardingService({
      home: testHome,
      executeStep: async (step, input) => {
        calls.push({ step, input })
        return { status: "completed", result: { ok: true } }
      },
    })

    const result = await service.executeStep("system-check", { customHomePath: testHome })
    expect(result).toEqual({ status: "completed", result: { ok: true } })
    expect(calls).toEqual([{ step: "system-check", input: { customHomePath: testHome } }])

    const persisted = readStateFile(testHome)
    expect((persisted.steps as Record<string, string>)["system-check"]).toBe("done")
    expect(persisted.startedAt).not.toBeNull()
    expect(service.getState().completedSteps).toEqual(["system-check"])
  })

  test("a reused result also marks the step done", async () => {
    const service = new OnboardingService({
      home: testHome,
      executeStep: async () => ({ status: "reused", result: { version: "1.0.0" } }),
    })
    await service.executeStep("install-cli")
    expect(service.getState().completedSteps).toEqual(["install-cli"])
  })

  test("a skipped result marks the step skipped without adding an error", async () => {
    const service = new OnboardingService({ home: testHome, executeStep: async () => ({ status: "skipped" }) })
    await service.executeStep("ai-provider")
    const persisted = readStateFile(testHome)
    expect((persisted.steps as Record<string, string>)["ai-provider"]).toBe("skipped")
    expect(persisted.errors).toEqual({})
  })

  test("a failed result records the step failure and its error message", async () => {
    const service = new OnboardingService({
      home: testHome,
      executeStep: async () => ({ status: "failed", error: { code: "BOOM", message: "boom" } }),
    })
    const result = await service.executeStep("create-space")
    expect(result.status).toBe("failed")
    const persisted = readStateFile(testHome)
    expect((persisted.steps as Record<string, string>)["create-space"]).toBe("failed")
    expect((persisted.errors as Record<string, string>)["create-space"]).toBe("boom")
  })

  test("an unknown step name fails with ONBOARDING_STEP_INVALID and never runs the executor", async () => {
    let ran = false
    const service = new OnboardingService({
      home: testHome,
      executeStep: async () => {
        ran = true
        return { status: "completed" }
      },
    })
    const result = await service.executeStep("nope" as never)
    expect(result.status).toBe("failed")
    expect(result.error?.code).toBe("ONBOARDING_STEP_INVALID")
    expect(ran).toBe(false)
  })

  test("the removed memory-config step is rejected with ONBOARDING_STEP_INVALID", async () => {
    let ran = false
    const service = new OnboardingService({
      home: testHome,
      executeStep: async () => {
        ran = true
        return { status: "completed" }
      },
    })
    // The removed step is no longer part of the executable union; passing it
    // is a deliberate contract violation, so the call is expected to be a type
    // error as well as a runtime rejection.
    // @ts-expect-error memory-config is not an executable step any more
    const result = await service.executeStep("memory-config", { enabled: true })
    expect(result.status).toBe("failed")
    expect(result.error?.code).toBe("ONBOARDING_STEP_INVALID")
    expect(ran).toBe(false)
    expect(service.getState().completedSteps).toEqual([])
  })

  test("the github-auth pseudo step does not pollute the wizard step map", async () => {
    const service = new OnboardingService({
      home: testHome,
      executeStep: async () => ({ status: "completed", result: { account: "octocat" } }),
    })
    const result = await service.executeStep("github-auth", { token: "ghp_x" })
    expect(result.status).toBe("completed")
    const view = service.getState()
    expect(view.completedSteps).toEqual([])
    expect(view.currentStep).toBe("system-check")
  })

  test("an executor that throws is normalized into a failed StepResult", async () => {
    const service = new OnboardingService({
      home: testHome,
      executeStep: async () => {
        throw new Error("kaboom")
      },
    })
    const result = await service.executeStep("ontology-setup")
    expect(result.status).toBe("failed")
    expect(result.error?.code).toBe("STEP_EXECUTION_ERROR")
    expect(result.error?.message).toContain("kaboom")
  })
})

describe("OnboardingService inspect snapshot invalidation", () => {
  /** An executor that reports a different machine fact on every inspect. */
  function progressiveInspectExecutor(): { executor: OnboardingStepExecutor; inspectCalls: () => number } {
    let inspects = 0
    const executor: OnboardingStepExecutor = async (step) => {
      if (step !== "inspect") return { status: "completed", result: {} }
      inspects += 1
      if (inspects === 1) {
        return { status: "completed", result: { ontologyInstalled: false, ontologyMode: null, availableTypes: [] } }
      }
      return {
        status: "completed",
        result: {
          ontologyInstalled: true,
          ontologyMode: "clone",
          availableTypes: [{ type: "coding", description: "代码开发" }],
        },
      }
    }
    return { executor, inspectCalls: () => inspects }
  }

  test("a successful wizard step invalidates the snapshot so the next probe re-inspects", async () => {
    const { executor, inspectCalls } = progressiveInspectExecutor()
    const service = new OnboardingService({ home: testHome, executeStep: executor })

    const before = (await service.probe("ontology-setup")) as Record<string, unknown>
    expect(before.status).toBe("missing")
    expect(before.availableTypes).toEqual([])

    const step = await service.executeStep("ontology-setup", { mode: "clone" })
    expect(step.status).toBe("completed")

    const after = (await service.probe("ontology-setup")) as Record<string, unknown>
    expect(after.status).toBe("ready")
    expect(after.ontologyInstalled).toBe(true)
    expect(after.availableTypes).toEqual([{ type: "coding", description: "代码开发" }])
    expect(inspectCalls()).toBe(2)
  })

  test("a successful step outside ontology-setup also invalidates the snapshot", async () => {
    const { executor, inspectCalls } = progressiveInspectExecutor()
    const service = new OnboardingService({ home: testHome, executeStep: executor })

    await service.probe("environment")
    await service.executeStep("create-space", { path: join(testHome, "space") })

    const after = (await service.probe("environment")) as Record<string, unknown>
    expect(after.ontologyInstalled).toBe(true)
    expect(inspectCalls()).toBe(2)
  })

  test("a failed step keeps the snapshot, so the next probe reuses it", async () => {
    let inspects = 0
    const service = new OnboardingService({
      home: testHome,
      executeStep: async (step) => {
        if (step === "inspect") {
          inspects += 1
          return { status: "completed", result: { ontologyInstalled: false, ontologyMode: null, availableTypes: [] } }
        }
        return { status: "failed", error: { code: "BOOM", message: "boom" } }
      },
    })

    await service.probe("ontology-setup")
    const failed = await service.executeStep("ontology-setup", { mode: "clone" })
    expect(failed.status).toBe("failed")

    await service.probe("ontology-setup")
    expect(inspects).toBe(1)
  })

  test("a reused result also invalidates the snapshot", async () => {
    const { executor, inspectCalls } = progressiveInspectExecutor()
    const service = new OnboardingService({
      home: testHome,
      executeStep: async (step, input, onProgress, abortSignal) => {
        if (step === "install-cli") return { status: "reused", result: { version: "1.0.0" } }
        return executor(step, input, onProgress, abortSignal)
      },
    })

    await service.probe("ontology-setup")
    await service.executeStep("install-cli")
    await service.probe("ontology-setup")
    expect(inspectCalls()).toBe(2)
  })
})

describe("OnboardingService single-flight lock", () => {
  test("a second executeStep while one is running throws ONBOARDING_OPERATION_BUSY", async () => {
    const gate = deferred<OnboardingStepResult>()
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const service = new OnboardingService({
      home: testHome,
      executeStep: async () => {
        started()
        return gate.promise
      },
    })

    const first = service.executeStep("system-check")
    await startedPromise
    await expectBusy(service.executeStep("install-cli"))

    gate.resolve({ status: "completed" })
    expect((await first).status).toBe("completed")
  })

  test("probe while an operation is running throws ONBOARDING_OPERATION_BUSY", async () => {
    const gate = deferred<OnboardingStepResult>()
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const service = new OnboardingService({
      home: testHome,
      executeStep: async () => {
        started()
        return gate.promise
      },
    })

    const first = service.executeStep("system-check")
    await startedPromise
    await expectBusy(service.probe("home"))

    gate.resolve({ status: "completed" })
    await first
  })

  test("probe does not take the lock for itself", async () => {
    const service = new OnboardingService({ home: testHome })
    await service.probe("home")
    await service.probe("home")
  })

  test("the lock is released after a failure and after a throw", async () => {
    const service = new OnboardingService({
      home: testHome,
      executeStep: async () => ({ status: "failed", error: { code: "X", message: "x" } }),
    })
    await service.executeStep("system-check")
    const again = await service.executeStep("install-cli")
    expect(again.status).toBe("failed")

    const throwing = new OnboardingService({
      home: tempHome(),
      executeStep: async () => {
        throw new Error("nope")
      },
    })
    await throwing.executeStep("system-check")
    expect((await throwing.executeStep("install-cli")).status).toBe("failed")
  })

  test("cancel aborts the in-flight operation and the abort signal reaches the executor", async () => {
    const gate = deferred<OnboardingStepResult>()
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    let aborted = false
    const service = new OnboardingService({
      home: testHome,
      executeStep: async (_step, _input, _onProgress, abortSignal) => {
        started()
        abortSignal?.addEventListener("abort", () => {
          aborted = true
          gate.resolve({ status: "failed", error: { code: "SETUP_OPERATION_ABORTED", message: "aborted" } })
        })
        return gate.promise
      },
    })

    const first = service.executeStep("install-cli")
    await startedPromise
    expect(service.cancel()).toEqual({ ok: true })

    const result = await first
    expect(aborted).toBe(true)
    expect(result.status).toBe("failed")
    expect(result.error?.code).toBe("ONBOARDING_OPERATION_CANCELLED")
  })

  test("cancel with no running operation is a no-op", () => {
    const service = new OnboardingService({ home: testHome })
    expect(service.cancel()).toEqual({ ok: true })
  })

  test("an operation that exceeds timeoutMs is aborted and fails with a timeout error", async () => {
    const service = new OnboardingService({
      home: testHome,
      timeoutMs: 30,
      executeStep: () => new Promise<OnboardingStepResult>(() => {}),
    })
    const result = await service.executeStep("ontology-setup")
    expect(result.status).toBe("failed")
    expect(result.error?.code).toBe("ONBOARDING_OPERATION_TIMEOUT")
  })
})

describe("OnboardingService events", () => {
  test("executeStep emits progress events for start and completion", async () => {
    const progress: any[] = []
    const service = new OnboardingService({
      home: testHome,
      executeStep: async (step, _input, onProgress) => {
        onProgress?.({ message: "halfway" })
        return { status: "completed", result: {} }
      },
    })
    service.events.on("progress", (event) => progress.push(event))

    await service.executeStep("system-check")
    expect(progress.map((event) => event.phase)).toContain("starting")
    expect(progress.map((event) => event.phase)).toContain("completed")
    expect(progress.every((event) => event.step === "system-check")).toBe(true)
    expect(progress.some((event) => event.message === "halfway")).toBe(true)
  })

  test("a failed step emits a failed progress event and an error event", async () => {
    const progress: any[] = []
    const errors: any[] = []
    const service = new OnboardingService({
      home: testHome,
      executeStep: async () => ({ status: "failed", error: { code: "BOOM", message: "boom" } }),
    })
    service.events.on("progress", (event) => progress.push(event))
    service.events.on("error", (event) => errors.push(event))

    await service.executeStep("create-space")
    expect(progress.some((event) => event.phase === "failed")).toBe(true)
    expect(errors.length).toBe(1)
    expect(errors[0].code).toBe("BOOM")
  })

  test("executeStep emits log events", async () => {
    const logs: any[] = []
    const service = new OnboardingService({
      home: testHome,
      executeStep: async () => ({ status: "completed", result: {} }),
    })
    service.events.on("log", (event) => logs.push(event))

    await service.executeStep("system-check")
    expect(logs.length).toBeGreaterThan(0)
    expect(typeof logs[0].message).toBe("string")
  })
})

describe("OnboardingService complete", () => {
  /** The completion gate runs one `inspect`; only `healthy` may complete. */
  const healthyExecutor =
    (inspects?: () => void): OnboardingStepExecutor =>
    async (step) => {
      if (step === "inspect") {
        inspects?.()
        return { status: "completed", result: { verdict: "healthy", verdictReason: "All components are ready." } }
      }
      return { status: "completed", result: {} }
    }

  test("complete writes completed:true, invokes onComplete and emits complete", async () => {
    let callbacks = 0
    const completeEvents: any[] = []
    const service = new OnboardingService({
      home: testHome,
      executeStep: healthyExecutor(),
      onComplete: () => {
        callbacks += 1
      },
    })
    service.events.on("complete", (event) => completeEvents.push(event))

    expect(await service.complete()).toEqual({ completed: true })
    expect(callbacks).toBe(1)
    expect(completeEvents.length).toBe(1)
    expect(service.getState().completed).toBe(true)
    expect(readStateFile(testHome).completed).toBe(true)
  })

  test("complete emits the SSE-complete envelope and advances currentStep to done", async () => {
    const completeEvents: unknown[] = []
    const service = new OnboardingService({ home: testHome, executeStep: healthyExecutor() })
    service.events.on("complete", (event) => completeEvents.push(event))

    await service.complete()

    expect(completeEvents).toEqual([{ type: "complete", completed: true }])
    // `markCompleted` lands the done step and points currentStep at it; the
    // completed flag — not the per-step map — is what the launch gate reads.
    const persisted = readStateFile(testHome)
    expect(persisted.currentStep).toBe("done")
    expect(persisted.steps).toMatchObject({ done: "done" })
    expect(service.getState().completedSteps).toEqual(["done"])
  })

  test("complete persists before invoking onComplete and emitting", async () => {
    const order: string[] = []
    const service = new OnboardingService({
      home: testHome,
      executeStep: healthyExecutor(),
      onComplete: () => {
        // The callback observes the finished state file, not a pending one.
        order.push(readStateFile(testHome).completed ? "callback:persisted" : "callback:missing")
      },
    })
    service.events.on("complete", () => order.push("emitted"))

    await service.complete()

    expect(order).toEqual(["callback:persisted", "emitted"])
  })

  test("complete works without an onComplete callback", async () => {
    const completeEvents: unknown[] = []
    const service = new OnboardingService({ home: testHome, executeStep: healthyExecutor() })
    service.events.on("complete", (event) => completeEvents.push(event))

    expect(await service.complete()).toEqual({ completed: true })
    expect(completeEvents.length).toBe(1)
    expect(service.getState().completed).toBe(true)
  })

  test("complete stays green when called again after finishing", async () => {
    const service = new OnboardingService({ home: testHome, executeStep: healthyExecutor() })

    await service.complete()
    expect(await service.complete()).toEqual({ completed: true })

    expect(service.getState().completed).toBe(true)
    expect(readStateFile(testHome).completed).toBe(true)
  })

  test("complete awaits an async onComplete callback", async () => {
    const gate = deferred<void>()
    let finished = false
    const service = new OnboardingService({
      home: testHome,
      executeStep: healthyExecutor(),
      onComplete: async () => {
        await gate.promise
        finished = true
      },
    })
    const pending = service.complete()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(finished).toBe(false)
    gate.resolve()
    await pending
    expect(finished).toBe(true)
  })

  test("complete refuses with ONBOARDING_HEALTH_GATE_FAILED when the verdict is not healthy", async () => {
    writeStateFile(testHome, {
      version: 1,
      currentStep: "ai-provider",
      steps: { "system-check": "done", "install-cli": "done", "ontology-setup": "done" },
      errors: {},
      completed: false,
      startedAt: null,
      updatedAt: null,
    })
    const completeEvents: unknown[] = []
    let callbacks = 0
    const service = new OnboardingService({
      home: testHome,
      executeStep: async (step) =>
        step === "inspect"
          ? {
              status: "completed",
              result: { verdict: "partial", verdictReason: "Ontology directory is missing." },
            }
          : { status: "completed", result: {} },
      onComplete: () => {
        callbacks += 1
      },
    })
    service.events.on("complete", (event) => completeEvents.push(event))

    const result = await service.complete()

    const error = refusal(result)
    expect(error.code).toBe(ONBOARDING_HEALTH_GATE_FAILED)
    expect(error.message).toContain("partial")
    expect(error.message).toContain("Ontology directory is missing.")

    expect(callbacks).toBe(0)
    expect(completeEvents.length).toBe(0)
    expect(service.getState().completed).toBe(false)
    expect(readStateFile(testHome).completed).toBe(false)
  })

  test("complete refuses for broken, fresh and a failed inspect alike", async () => {
    for (const scenario of [
      { verdict: "broken", verdictReason: "Wopal CLI is not installed." },
      { verdict: "fresh", verdictReason: "Nothing has been configured yet." },
    ]) {
      const home = tempHome()
      mkdirSync(home, { recursive: true })
      const service = new OnboardingService({
        home,
        executeStep: async (step) =>
          step === "inspect" ? { status: "completed", result: scenario } : { status: "completed", result: {} },
      })
      const result = await service.complete()
      const error = refusal(result)
      expect(error.code).toBe(ONBOARDING_HEALTH_GATE_FAILED)
      expect(error.message).toContain(scenario.verdict)
      expect(service.getState().completed).toBe(false)
      // A refusal must not even create the state file.
      expect(existsSync(getOnboardingStatePath(home))).toBe(false)
      rmSync(home, { recursive: true, force: true })
    }

    const failedInspect = new OnboardingService({
      home: testHome,
      executeStep: async (step) =>
        step === "inspect"
          ? { status: "failed", error: { code: "WOPAL_BINARY_NOT_FOUND", message: "wopal binary missing" } }
          : { status: "completed", result: {} },
    })
    const refused = refusal(await failedInspect.complete())
    expect(refused.code).toBe(ONBOARDING_HEALTH_GATE_FAILED)
    expect(refused.message).toContain("wopal binary missing")
    expect(existsSync(getOnboardingStatePath(testHome))).toBe(false)
  })

  test("the gate inspect does not write the snapshot back", async () => {
    let inspects = 0
    const service = new OnboardingService({
      home: testHome,
      executeStep: async (step) => {
        if (step !== "inspect") return { status: "completed", result: {} }
        inspects += 1
        return { status: "completed", result: { verdict: "healthy", verdictReason: "ok" } }
      },
    })

    await service.complete()
    expect(inspects).toBe(1)

    // A later probe must run its own inspect rather than reuse the gate result.
    await service.probe("ontology-setup")
    expect(inspects).toBe(2)
  })
})

describe("OnboardingService probe", () => {
  test("probe('home') reports the resolved home", async () => {
    const service = new OnboardingService({ home: testHome })
    expect(await service.probe("home")).toEqual({ homePath: testHome, wopalHome: testHome })
  })

  test("probe('system-info') reports platform facts without writing state", async () => {
    const service = new OnboardingService({ home: testHome })
    const info = (await service.probe("system-info")) as Record<string, unknown>
    expect(info.platform).toBe(process.platform)
    expect(info.arch).toBe(process.arch)
    expect(info.nodeVersion).toBe(process.version)
    expect(existsSync(getOnboardingStatePath(testHome))).toBe(false)
  })

  test("probe('wopal-cli') reports a missing binary for an empty home", async () => {
    const service = new OnboardingService({ home: testHome })
    const info = (await service.probe("wopal-cli")) as Record<string, unknown>
    expect(info.installed).toBe(false)
    expect(String(info.binaryPath)).toContain("wopal")
  })

  test("an unknown probe kind returns an error payload", async () => {
    const service = new OnboardingService({ home: testHome })
    expect(await service.probe("nonsense")).toEqual({ error: "Unknown probe kind" })
  })

  test("probe('environment') returns no available types instead of the common fallback", async () => {
    const service = new OnboardingService({
      home: testHome,
      executeStep: async (step) =>
        step === "inspect"
          ? { status: "completed", result: { ontologyInstalled: true, ontologyMode: "clone", spaces: [] } }
          : { status: "completed", result: {} },
    })
    const env = (await service.probe("environment")) as Record<string, unknown>
    // An empty list is strictly stronger than "no `common` entry".
    expect(env.availableTypes).toEqual([])
  })

  test("probe('environment') passes through inspection availableTypes", async () => {
    const service = new OnboardingService({
      home: testHome,
      executeStep: async (step) =>
        step === "inspect"
          ? {
              status: "completed",
              result: {
                ontologyInstalled: true,
                ontologyMode: "clone",
                availableTypes: [{ type: "coding", description: "代码开发" }],
              },
            }
          : { status: "completed", result: {} },
    })
    const env = (await service.probe("environment")) as Record<string, unknown>
    expect(env.availableTypes).toEqual([{ type: "coding", description: "代码开发" }])
  })

  test("probe('environment') falls back to an empty type list when inspect fails", async () => {
    const service = new OnboardingService({
      home: testHome,
      executeStep: async (step) =>
        step === "inspect"
          ? { status: "failed", error: { code: "WOPAL_BINARY_NOT_FOUND", message: "wopal binary missing" } }
          : { status: "completed", result: {} },
    })
    const env = (await service.probe("environment")) as Record<string, unknown>
    expect(env.availableTypes).toEqual([])
    expect(env.errorCode).toBe("WOPAL_BINARY_NOT_FOUND")
  })

  test("probe('memory') still returns a read-only summary", async () => {
    const service = new OnboardingService({
      home: testHome,
      executeStep: async (step) =>
        step === "inspect"
          ? {
              status: "completed",
              result: {
                memory: { state: "ready", enabled: true, llmModel: "gpt-4o" },
                spaces: [{ name: "demo", path: join(testHome, "demo") }],
              },
            }
          : { status: "completed", result: {} },
    })
    const memory = (await service.probe("memory")) as Record<string, unknown>
    expect(memory.state).toBe("ready")
    expect(memory.enabled).toBe(true)
    // The probe never writes a config file.
    expect(existsSync(join(testHome, ".env"))).toBe(false)
  })
})

describe("machine-runner", () => {
  test("extractJsonEnvelope parses the last valid envelope and strips ANSI noise", () => {
    const stdout =
      '\u001b[32mprogress line\u001b[0m\n{"ok":true,"capability":"setup.operation","data":{"operation":"inspect","status":"created","result":{"verdict":"ready"}}}\n'
    const envelope = extractJsonEnvelope(stdout, "")
    expect(envelope?.ok).toBe(true)
    expect(envelope?.data.result).toEqual({ verdict: "ready" })
  })

  test("extractJsonEnvelope returns null when no envelope is present", () => {
    expect(extractJsonEnvelope("plain output", "stderr text")).toBeNull()
  })

  test("resolveWopalCliEntry returns null when the binary is missing", () => {
    expect(resolveWopalCliEntry(join(testHome, "bin", "wopal"))).toBeNull()
  })

  test("runSetupOperation fails with WOPAL_BINARY_NOT_FOUND without a spawn function", async () => {
    const result = await runSetupOperation({ binaryPath: join(testHome, "bin", "wopal"), operation: "inspect" })
    expect(result.status).toBe("failed")
    expect(result.error?.code).toBe("WOPAL_BINARY_NOT_FOUND")
  })

  test("runSetupOperation maps a created envelope to completed and unpacks data.result", async () => {
    const binaryPath = join(testHome, "bin", "wopal")
    mkdirSync(dirname(binaryPath), { recursive: true })
    writeFileSync(binaryPath, "#!/bin/sh\necho test", { mode: 0o755 })

    const envelope = {
      apiVersion: "wopal.capability/v1",
      capability: "setup.operation",
      ok: true,
      data: { operation: "inspect", status: "created", result: { verdict: "ready" } },
    }
    const fakeSpawn = () =>
      ({
        stdin: { write: () => {}, end: () => {} },
        stdout: {
          on: (event: string, cb: (chunk: string) => void) => {
            if (event === "data") cb(JSON.stringify(envelope))
          },
        },
        stderr: { on: () => {} },
        on: (event: string, cb: (code: number) => void) => {
          if (event === "exit") cb(0)
        },
      }) as any

    const progress: any[] = []
    const result = await runSetupOperation({
      binaryPath,
      operation: "inspect",
      spawnFn: fakeSpawn,
      onProgress: (event) => progress.push(event),
    })
    expect(result.status).toBe("completed")
    expect(result.result).toEqual({ verdict: "ready" })
  })

  test("runSetupOperation surfaces a failed CLI envelope", async () => {
    const binaryPath = join(testHome, "bin", "wopal")
    mkdirSync(dirname(binaryPath), { recursive: true })
    writeFileSync(binaryPath, "#!/bin/sh\necho test", { mode: 0o755 })

    const envelope = {
      apiVersion: "wopal.capability/v1",
      capability: "setup.operation",
      ok: false,
      error: { code: "ENGINE_DOWNLOAD_FAILED", message: "download failed", suggestion: "retry" },
    }
    const fakeSpawn = () =>
      ({
        stdin: { write: () => {}, end: () => {} },
        stdout: {
          on: (event: string, cb: (chunk: string) => void) => {
            if (event === "data") cb(JSON.stringify(envelope))
          },
        },
        stderr: { on: () => {} },
        on: (event: string, cb: (code: number) => void) => {
          if (event === "exit") cb(1)
        },
      }) as any

    const result = await runSetupOperation({ binaryPath, operation: "install-engine", spawnFn: fakeSpawn })
    expect(result.status).toBe("failed")
    expect(result.error?.code).toBe("ENGINE_DOWNLOAD_FAILED")
    expect(result.error?.suggestion).toBe("retry")
  })

  test("runSetupOperation rejects an unexpected capability", async () => {
    const binaryPath = join(testHome, "bin", "wopal")
    mkdirSync(dirname(binaryPath), { recursive: true })
    writeFileSync(binaryPath, "#!/bin/sh\necho test", { mode: 0o755 })

    const fakeSpawn = () =>
      ({
        stdin: { write: () => {}, end: () => {} },
        stdout: {
          on: (event: string, cb: (chunk: string) => void) => {
            if (event === "data")
              cb(JSON.stringify({ ok: true, capability: "something.else", data: { operation: "inspect" } }))
          },
        },
        stderr: { on: () => {} },
        on: (event: string, cb: (code: number) => void) => {
          if (event === "exit") cb(0)
        },
      }) as any

    const result = await runSetupOperation({ binaryPath, operation: "inspect", spawnFn: fakeSpawn })
    expect(result.status).toBe("failed")
    expect(result.error?.code).toBe("SETUP_RESPONSE_INVALID")
  })
})
