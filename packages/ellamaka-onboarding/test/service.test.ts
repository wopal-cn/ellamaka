import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

import { extractJsonEnvelope, resolveWopalCliEntry, runSetupOperation } from "../src/machine-runner"
import { OnboardingBusyError, OnboardingService, getOnboardingStatePath, getWopalHome } from "../src/service"
import { ONBOARDING_OPERATION_BUSY, ONBOARDING_STEPS, type OnboardingStepResult } from "../src/types"

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
  test("complete writes completed:true, invokes onComplete and emits complete", async () => {
    let callbacks = 0
    const completeEvents: any[] = []
    const service = new OnboardingService({
      home: testHome,
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
    const service = new OnboardingService({ home: testHome })
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
    const service = new OnboardingService({ home: testHome })
    service.events.on("complete", (event) => completeEvents.push(event))

    expect(await service.complete()).toEqual({ completed: true })
    expect(completeEvents.length).toBe(1)
    expect(service.getState().completed).toBe(true)
  })

  test("complete stays green when called again after finishing", async () => {
    const service = new OnboardingService({ home: testHome })

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
      onComplete: async () => {
        await gate.promise
        finished = true
      },
    })
    const pending = service.complete()
    expect(finished).toBe(false)
    gate.resolve()
    await pending
    expect(finished).toBe(true)
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
