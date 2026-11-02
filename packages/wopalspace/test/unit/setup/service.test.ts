import { describe, expect, jest, test } from "bun:test"
import {
  SETUP_ERROR,
  SetupGoalError,
  assertGoals,
  createSetupService,
  type SetupEvent,
  type SetupFacts,
  type SetupRunSnapshot,
  type SetupService,
  type SetupSpaceInitResult,
} from "../../../src/setup"
import {
  deferred,
  facts,
  memoryCredentials,
  memoryFoundation,
  memoryGithub,
  memoryHomeSeed,
  memoryOntology,
  memorySpace,
  memoryState,
} from "./support"

interface Harness {
  readonly service: SetupService
  readonly state: ReturnType<typeof memoryState>
  readonly credentials: ReturnType<typeof memoryCredentials>
  readonly ontology: ReturnType<typeof memoryOntology>
  readonly space: ReturnType<typeof memorySpace>
  readonly foundation: ReturnType<typeof memoryFoundation>
  readonly homeSeed: ReturnType<typeof memoryHomeSeed>
  setFacts(next: SetupFacts): void
}

function harness(
  options: {
    initial?: SetupFacts
    readFacts?: () => Promise<SetupFacts>
    state?: ReturnType<typeof memoryState>
    credentials?: ReturnType<typeof memoryCredentials>
    space?: ReturnType<typeof memorySpace>
    ontology?: ReturnType<typeof memoryOntology>
    foundation?: ReturnType<typeof memoryFoundation>
    github?: ReturnType<typeof memoryGithub>
    homeSeed?: ReturnType<typeof memoryHomeSeed>
    verify?: (token: string) => Promise<{ valid: boolean; account: string | null }>
  } = {},
): Harness {
  const state = options.state ?? memoryState()
  const credentials = options.credentials ?? memoryCredentials()
  const ontology = options.ontology ?? memoryOntology()
  const space = options.space ?? memorySpace()
  const foundation = options.foundation ?? memoryFoundation()
  const github =
    options.github ??
    ({
      ...memoryGithub(),
      verify: options.verify ?? (async () => ({ valid: true, account: "octocat" })),
    } as ReturnType<typeof memoryGithub>)
  const homeSeed = options.homeSeed ?? memoryHomeSeed()
  let current = options.initial ?? facts()
  let counter = 0
  const service = createSetupService({
    host: { wopalHome: "/memory/home" },
    ontology,
    space,
    state,
    credentials,
    foundation,
    github,
    homeSeed,
    facts: { read: options.readFacts ?? (async () => current) },
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    newId: () => "id-" + String(++counter),
  })
  return {
    service,
    state,
    credentials,
    ontology,
    space,
    foundation,
    homeSeed,
    setFacts(next) {
      current = next
    },
  }
}

async function collect(service: SetupService, runId: string, after = 0): Promise<SetupEvent[]> {
  const events: SetupEvent[] = []
  for await (const event of service.progressEvents({ runId, after })) events.push(event)
  return events
}

async function settled(service: SetupService, runId: string): Promise<SetupRunSnapshot> {
  await collect(service, runId)
  return service.progress(runId)
}

describe("setup inspect and plan are read-only", () => {
  test("inspect reports a corrupt state file without writing or repairing it", async () => {
    const state = memoryState("corrupt")
    const h = harness({
      state,
      initial: facts({ state: { status: "corrupt", diagnostic: "Setup state is not valid JSON" } }),
    })
    const result = await h.service.inspect()
    expect(result.state.status).toBe("corrupt")
    expect(result.state.diagnostic).toContain("not valid JSON")
    expect(state.writes).toEqual([])
    expect(h.foundation.calls).toBe(0)
  })

  test("inspect reports live facts, satisfied goals and a fingerprint", async () => {
    const h = harness({
      initial: facts({
        ontology: { status: "ready", items: [{ name: "o", path: "/o", mode: "clone" }] },
        home: {
          settings: { present: true, valid: true, ellamaka: { present: true, valid: true } },
          capabilities: { ready: true, missing: [] },
        },
      }),
    })
    const result = await h.service.inspect()
    expect(result.goals).toEqual(["ontology"])
    expect(result.fingerprint).toHaveLength(16)
    expect(result.home.path).toBe("/memory/home")
    expect(h.state.writes).toEqual([])
  })

  test("plan only returns pending actions and copies no credentials", async () => {
    const h = harness()
    const plan = await h.service.plan({ goals: ["foundation", "github"] })
    expect(plan.actions.map((action) => action.actionId)).toEqual(["foundation", "github"])
    expect(plan.actions.find((action) => action.actionId === "github")?.requiresInput).toBe(true)
    expect(JSON.stringify(plan)).not.toContain("token")
    expect(h.state.writes).toEqual([])
    expect(h.foundation.calls).toBe(0)
  })

  test("an unknown goal is rejected by the shared goal guard", () => {
    expect(() => assertGoals(["nope"])).toThrow(SetupGoalError)
    expect(assertGoals(["space", "space", "github"])).toEqual(["space", "github"])
  })

  test("plan rejects an empty goal list", async () => {
    const h = harness()
    await expect(h.service.plan({ goals: [] })).rejects.toMatchObject({ code: SETUP_ERROR.goalInvalid })
  })
})

describe("setup execute", () => {
  test("an unknown plan or action is a stable request error", async () => {
    const h = harness()
    await expect(h.service.execute({ planId: "missing", actionId: "foundation" })).rejects.toMatchObject({
      code: SETUP_ERROR.planNotFound,
    })
    const plan = await h.service.plan({ goals: ["foundation"] })
    await expect(h.service.execute({ planId: plan.planId, actionId: "space" })).rejects.toMatchObject({
      code: SETUP_ERROR.actionNotFound,
    })
  })

  test("cannot execute an action while one of its planned dependencies is still pending", async () => {
    const h = harness()
    const plan = await h.service.plan({ goals: ["foundation", "github", "ontology"] })

    await expect(
      h.service.execute({ planId: plan.planId, actionId: "ontology", input: { mode: "clone" } }),
    ).rejects.toMatchObject({ code: SETUP_ERROR.dependencyPending })
    expect(h.ontology.installs).toEqual([])
    expect(h.state.writes).toEqual([])
  })

  test("a dependency omitted from the caller's goal set does not become an implicit action", async () => {
    const h = harness()
    const plan = await h.service.plan({ goals: ["ontology"] })
    const run = await h.service.execute({ planId: plan.planId, actionId: "ontology", input: { mode: "clone" } })

    expect((await settled(h.service, run.runId)).status).toBe("completed")
    expect(h.ontology.installs).toHaveLength(1)
  })

  test("a changed critical fact makes the stored plan stale before any write", async () => {
    const h = harness()
    const plan = await h.service.plan({ goals: ["ontology"] })
    h.setFacts(facts({ ontology: { status: "ready", items: [{ name: "o", path: "/o", mode: "clone" }] } }))

    await expect(
      h.service.execute({ planId: plan.planId, actionId: "ontology", input: { mode: "clone" } }),
    ).rejects.toMatchObject({ code: SETUP_ERROR.planStale })
    expect(h.ontology.installs).toEqual([])
    expect(h.state.writes).toEqual([])
  })

  test("executes the action, records the step and emits monotonic events", async () => {
    const h = harness()
    const plan = await h.service.plan({ goals: ["foundation"] })
    const run = await h.service.execute({ planId: plan.planId, actionId: "foundation" })
    expect(["running", "completed"]).toContain(run.status)

    const events = await collect(h.service, run.runId)
    expect(events.length).toBeGreaterThan(0)
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1))
    expect(events.map((event) => event.phase)).toContain("started")
    expect(events.at(-1)?.phase).toBe("completed")

    const final = await h.service.progress(run.runId)
    expect(final.status).toBe("completed")
    expect(final.sequence).toBe(events.at(-1)?.sequence ?? 0)
    expect(h.foundation.calls).toBe(1)
    expect(h.state.writes.at(-1)?.steps.foundation).toBe("done")
  })

  test("persists in-progress before entering the owned action boundary", async () => {
    const state = memoryState()
    const entered = deferred<void>()
    const gate = deferred<SetupSpaceInitResult>()
    let statusAtActionStart: string | undefined
    const space = memorySpace(async () => {
      statusAtActionStart = state.writes.at(-1)?.steps.space
      entered.resolve()
      return gate.promise
    })
    const h = harness({ state, space })
    const plan = await h.service.plan({ goals: ["space"] })
    const run = await h.service.execute({
      planId: plan.planId,
      actionId: "space",
      input: { path: "/memory/space", type: "coding" },
    })

    await entered.promise
    expect(statusAtActionStart).toBe("in-progress")
    expect(state.writes.at(-1)?.currentStep).toBe("space")

    gate.resolve({ name: "demo", path: "/memory/space", materialized: true, preparation: { status: "ok" } })
    expect((await settled(h.service, run.runId)).status).toBe("completed")
    expect(state.writes.at(-1)?.steps.space).toBe("done")
  })

  test("foundation owner failures use the stable Setup foundation error", async () => {
    const foundation = memoryFoundation()
    foundation.ensure = async () => {
      throw new Error("home is read-only")
    }
    const h = harness({ foundation })
    const plan = await h.service.plan({ goals: ["foundation"] })
    const run = await h.service.execute({ planId: plan.planId, actionId: "foundation" })
    const snapshot = await settled(h.service, run.runId)

    expect(snapshot.status).toBe("failed")
    expect(snapshot.error?.code).toBe(SETUP_ERROR.foundationFailed)
  })

  test("foundation establishes WOPAL_HOME before Setup persists its recovery state", async () => {
    const foundation = memoryFoundation()
    const state = memoryState()
    const update = state.update.bind(state)
    state.update = async (change) => {
      expect(foundation.calls).toBe(1)
      return update(change)
    }
    const h = harness({ foundation, state })
    const plan = await h.service.plan({ goals: ["foundation"] })
    const run = await h.service.execute({ planId: plan.planId, actionId: "foundation" })

    expect((await settled(h.service, run.runId)).status).toBe("completed")
    expect(state.writes.map((entry) => entry.steps.foundation)).toEqual(["in-progress", "done"])
  })

  test("reconnecting from a sequence only replays the missing events", async () => {
    const h = harness()
    const plan = await h.service.plan({ goals: ["foundation"] })
    const run = await h.service.execute({ planId: plan.planId, actionId: "foundation" })
    const all = await collect(h.service, run.runId)
    const tail = await collect(h.service, run.runId, all[0]?.sequence ?? 0)
    expect(tail.map((event) => event.sequence)).toEqual(all.slice(1).map((event) => event.sequence))
  })

  test("a second request for the running action reuses the same run", async () => {
    // The action stays inside its commit boundary: it only settles when the test
    // releases the gate, so a cancellation timer is the only way out.
    const gate = deferred<SetupSpaceInitResult>()
    const h = harness({ space: memorySpace(() => gate.promise) })
    const plan = await h.service.plan({ goals: ["space"] })
    const input = { path: "/memory/space", type: "coding" }

    const first = await h.service.execute({ planId: plan.planId, actionId: "space", input })
    expect(first.status).toBe("running")
    const again = await h.service.execute({ planId: plan.planId, actionId: "space", input })
    expect(again.runId).toBe(first.runId)
    expect(again.sequence).toBe(first.sequence)

    const other = await h.service.plan({ goals: ["foundation"] })
    await expect(h.service.execute({ planId: other.planId, actionId: "foundation" })).rejects.toMatchObject({
      code: SETUP_ERROR.busy,
    })
    expect(h.foundation.calls).toBe(0)

    gate.resolve({ name: "demo", path: "/memory/space", materialized: true, preparation: { status: "ok" } })
    expect((await settled(h.service, first.runId)).status).toBe("completed")
  })

  test("cancelling while a commit is in flight keeps the committed fact and reports cancelled", async () => {
    const gate = deferred<SetupSpaceInitResult>()
    const h = harness({ space: memorySpace(async () => gate.promise) })
    const plan = await h.service.plan({ goals: ["space"] })
    const run = await h.service.execute({
      planId: plan.planId,
      actionId: "space",
      input: { path: "/memory/space", type: "coding" },
    })

    const pending = h.service.cancel(run.runId)
    gate.resolve({ name: "demo", path: "/memory/space", materialized: true, preparation: { status: "ok" } })
    const snapshot = await pending

    expect(snapshot.status).toBe("cancelled")
    expect(snapshot.error?.code).toBe(SETUP_ERROR.operationCancelled)
    expect(snapshot.result?.materialized).toBe(true)
    // The Space commit already happened, so the step stays recorded as done.
    expect(h.state.writes.at(-1)?.steps.space).toBe("done")
    expect((await settled(h.service, run.runId)).status).toBe("cancelled")
  })

  test("cancel never publishes a terminal state before the owned action leaves its safe boundary", async () => {
    // The action blocks inside its commit boundary until the test releases the gate,
    // so a cancellation timer is the only way out of the wait.
    const gate = deferred<SetupSpaceInitResult>()
    const h = harness({ space: memorySpace(() => gate.promise) })
    const plan = await h.service.plan({ goals: ["space"] })
    const run = await h.service.execute({
      planId: plan.planId,
      actionId: "space",
      input: { path: "/memory/space", type: "coding" },
    })

    // Virtual timers must be installed BEFORE cancel schedules its wait, otherwise the
    // timer it arms is a real one and advancing virtual time proves nothing.
    jest.useFakeTimers()
    try {
      let cancelSettled = false
      const pending = h.service.cancel(run.runId).then((snapshot) => {
        cancelSettled = true
        return snapshot
      })

      jest.advanceTimersByTime(120_000)
      await Promise.resolve()
      await Promise.resolve()

      // The boundary has not ended, so cancel must still be waiting: no terminal
      // snapshot, no failed step, run still running.
      expect(cancelSettled).toBe(false)
      expect(h.state.writes.some((write) => write.steps.space === "failed")).toBe(false)
      const running = await h.service.progress(run.runId)
      expect(running.status).toBe("running")

      gate.resolve({ name: "demo", path: "/memory/space", materialized: true, preparation: { status: "ok" } })
      const snapshot = await pending
      expect(snapshot.status).toBe("cancelled")
      expect(snapshot.error?.code).toBe(SETUP_ERROR.operationCancelled)
      // The step records the real outcome of the boundary, not the cancel request.
      expect(h.state.writes.at(-1)?.steps.space).toBe("done")
    } finally {
      jest.useRealTimers()
    }
  })

  test("cancelling before the action starts performs no write", async () => {
    const gate = deferred<SetupFacts>()
    let reads = 0
    const h = harness({
      readFacts: () => {
        reads += 1
        return reads === 1 ? Promise.resolve(facts()) : gate.promise
      },
    })
    const plan = await h.service.plan({ goals: ["foundation"] })
    const controller = new AbortController()
    const pending = h.service.execute({ planId: plan.planId, actionId: "foundation", signal: controller.signal })
    controller.abort()
    gate.resolve(facts())

    const snapshot = await pending
    expect(snapshot.status).toBe("cancelled")
    expect(h.foundation.calls).toBe(0)
    expect(h.state.writes).toEqual([])
  })

  test("cancel rejects an unknown run and is idempotent on a finished run", async () => {
    const h = harness()
    await expect(h.service.cancel("missing")).rejects.toMatchObject({ code: SETUP_ERROR.runNotFound })
    const plan = await h.service.plan({ goals: ["foundation"] })
    const run = await h.service.execute({ planId: plan.planId, actionId: "foundation" })
    const done = await settled(h.service, run.runId)
    expect(await h.service.cancel(run.runId)).toEqual(done)
  })

  test("repeating a completed action rejects the consumed plan before running it again", async () => {
    const h = harness()
    const plan = await h.service.plan({ goals: ["foundation"] })
    const run = await h.service.execute({ planId: plan.planId, actionId: "foundation" })
    expect((await settled(h.service, run.runId)).status).toBe("completed")

    // The action was consumed by this plan, so asking for it again is a
    // request error rather than a second side effect.
    await expect(h.service.execute({ planId: plan.planId, actionId: "foundation" })).rejects.toMatchObject({
      code: SETUP_ERROR.actionNotFound,
    })
    expect(h.foundation.calls).toBe(1)

    h.setFacts(facts({ home: { foundation: { ready: true, missing: [] } } }))
    const replanned = await h.service.plan({ goals: ["foundation"] })
    expect(replanned.actions).toEqual([])
    await expect(h.service.execute({ planId: replanned.planId, actionId: "foundation" })).rejects.toMatchObject({
      code: SETUP_ERROR.actionNotFound,
    })
    expect(h.foundation.calls).toBe(1)
  })

  test("credentials never reach state, events or errors", async () => {
    const token = "placeholder"
    const h = harness({
      verify: async () => {
        throw new Error("github rejected token " + token)
      },
    })
    const plan = await h.service.plan({ goals: ["github"] })
    const run = await h.service.execute({ planId: plan.planId, actionId: "github", input: { token } })
    const events = await collect(h.service, run.runId)
    const snapshot = await h.service.progress(run.runId)

    expect(snapshot.status).toBe("failed")
    expect(snapshot.error?.code).toBe(SETUP_ERROR.githubFailed)
    expect(JSON.stringify(events)).not.toContain(token)
    expect(JSON.stringify(snapshot)).not.toContain(token)
    expect(JSON.stringify(h.state.writes)).not.toContain(token)
    expect(h.credentials.tokens).toEqual([])
  })

  test("a verified github token is written once and never echoed back", async () => {
    const token = "placeholder"
    const h = harness()
    const plan = await h.service.plan({ goals: ["github"] })
    const run = await h.service.execute({ planId: plan.planId, actionId: "github", input: { token } })
    const snapshot = await settled(h.service, run.runId)

    expect(snapshot.status).toBe("completed")
    expect(h.credentials.tokens).toEqual([token])
    expect(JSON.stringify(snapshot)).not.toContain(token)
    expect(JSON.stringify(h.state.writes)).not.toContain(token)
  })

  test("a persisted fork failure does not require replacing credentials while gh identity is still visible", async () => {
    const h = harness({
      initial: facts({
        github: { configured: true, source: "gh", account: "octocat" },
        state: {
          status: "ok",
          currentStep: "github",
          steps: { github: "failed", ontology: "failed" },
        },
      }),
      github: memoryGithub({ configured: true }),
    })
    const plan = await h.service.plan({ goals: ["github"] })
    expect(plan.actions.map((action) => action.actionId)).toEqual([])
    expect(h.credentials.tokens).toEqual([])
  })

  test("GitHub can be explicitly skipped for clone without pretending an identity exists", async () => {
    const h = harness({ github: memoryGithub() })
    const plan = await h.service.plan({ goals: ["github", "ontology"] })
    const run = await h.service.execute({ planId: plan.planId, actionId: "github", input: { skip: true } })
    const snapshot = await settled(h.service, run.runId)

    expect(snapshot.status).toBe("completed")
    expect(snapshot.result).toEqual({ mode: "clone" })
    expect(h.credentials.tokens).toEqual([])
    expect(h.state.writes.at(-1)?.steps.github).toBe("skipped")

    const inspected = await h.service.inspect()
    expect(inspected.credentials.github.configured).toBe(false)
    expect(inspected.goals).not.toContain("github")
  })

  test("a GitHub skip satisfies that goal for the current plan completion only", async () => {
    const h = harness({ github: memoryGithub() })
    const plan = await h.service.plan({ goals: ["github"] })
    const run = await h.service.execute({ planId: plan.planId, actionId: "github", input: { skip: true } })
    expect((await settled(h.service, run.runId)).status).toBe("completed")

    expect((await h.service.complete({ planId: plan.planId })).completed).toBe(true)
    expect((await h.service.inspect()).credentials.github.configured).toBe(false)

    const next = await h.service.plan({ goals: ["github"] })
    expect(next.actions.map((action) => action.actionId)).toEqual(["github"])
  })

  test("GitHub rejects ambiguous skip and token input before starting a run", async () => {
    const h = harness()
    const plan = await h.service.plan({ goals: ["github"] })

    await expect(
      h.service.execute({ planId: plan.planId, actionId: "github", input: { token: "placeholder", skip: true } }),
    ).rejects.toMatchObject({ code: SETUP_ERROR.inputInvalid })
    expect(h.credentials.tokens).toEqual([])
    expect(h.state.writes).toEqual([])
  })

  test("does not seed Home capability roots until Ontology install has completed", async () => {
    const entered = deferred<void>()
    const gate = deferred<{ name: string; path: string; status: "created" }>()
    const homeSeed = memoryHomeSeed()
    const ontology = memoryOntology(undefined, async () => {
      entered.resolve()
      return gate.promise
    })
    const h = harness({ ontology, homeSeed })
    const plan = await h.service.plan({ goals: ["ontology"] })
    const run = await h.service.execute({ planId: plan.planId, actionId: "ontology", input: { mode: "clone" } })

    await entered.promise
    expect(homeSeed.calls).toEqual([])
    gate.resolve({ name: "wopal-space-ontology", path: "/memory/ontology", status: "created" })
    expect((await settled(h.service, run.runId)).status).toBe("completed")
    expect(homeSeed.calls).toEqual(["/memory/ontology"])
  })

  test("Ontology defaults to fork with identity, clone without identity, and preserves explicit clone", async () => {
    const withIdentity = harness({ github: memoryGithub({ configured: true }) })
    const forkPlan = await withIdentity.service.plan({ goals: ["ontology"] })
    const forkRun = await withIdentity.service.execute({ planId: forkPlan.planId, actionId: "ontology", input: {} })
    expect((await settled(withIdentity.service, forkRun.runId)).status).toBe("completed")
    expect(withIdentity.ontology.installs.at(-1)?.mode).toBe("fork")
    expect(withIdentity.homeSeed.calls).toEqual(["/memory/ontology"])

    const withoutIdentity = harness({ github: memoryGithub() })
    const clonePlan = await withoutIdentity.service.plan({ goals: ["ontology"] })
    const cloneRun = await withoutIdentity.service.execute({
      planId: clonePlan.planId,
      actionId: "ontology",
      input: {},
    })
    expect((await settled(withoutIdentity.service, cloneRun.runId)).status).toBe("completed")
    expect(withoutIdentity.ontology.installs.at(-1)?.mode).toBe("clone")

    const explicitClone = harness({ github: memoryGithub({ configured: true }) })
    const explicitPlan = await explicitClone.service.plan({ goals: ["ontology"] })
    const explicitRun = await explicitClone.service.execute({
      planId: explicitPlan.planId,
      actionId: "ontology",
      input: { mode: "clone" },
    })
    expect((await settled(explicitClone.service, explicitRun.runId)).status).toBe("completed")
    expect(explicitClone.ontology.installs.at(-1)?.mode).toBe("clone")
  })

  test("an existing Ontology keeps its registered mode while repairing missing Home base artifacts", async () => {
    const ontology = memoryOntology({ mode: "clone" })
    const h = harness({ ontology, github: memoryGithub({ configured: true }) })
    const plan = await h.service.plan({ goals: ["ontology"] })
    const run = await h.service.execute({ planId: plan.planId, actionId: "ontology", input: {} })
    expect((await settled(h.service, run.runId)).status).toBe("completed")
    expect(ontology.installs).toEqual([{ name: "wopal-space-ontology", mode: "clone" }])
    expect(h.homeSeed.calls).toEqual(["/memory/ontology"])
  })

  test("explicit fork refuses to run when GitHub identity is unavailable", async () => {
    const h = harness({ github: memoryGithub() })
    const plan = await h.service.plan({ goals: ["ontology"] })
    const run = await h.service.execute({ planId: plan.planId, actionId: "ontology", input: { mode: "fork" } })
    const snapshot = await settled(h.service, run.runId)
    expect(snapshot.status).toBe("failed")
    expect(snapshot.error?.code).toBe(SETUP_ERROR.githubFailed)
    expect(h.ontology.installs).toEqual([])
  })

  test("a fork provisioning failure stays owned by Ontology when GitHub identity was already verified", async () => {
    const ontology = memoryOntology(undefined, async () => {
      throw {
        code: "ONTOLOGY_UPGRADE_FAILED",
        message: "Failed to create or verify the fork",
        cause: { code: "ONTOLOGY_FORK_UNAVAILABLE", message: "GitHub authentication expired" },
      }
    })
    const h = harness({ ontology, github: memoryGithub({ configured: true }) })
    const plan = await h.service.plan({ goals: ["ontology"] })
    const run = await h.service.execute({ planId: plan.planId, actionId: "ontology", input: { mode: "fork" } })
    const snapshot = await settled(h.service, run.runId)

    expect(snapshot.status).toBe("failed")
    expect(snapshot.error?.code).toBe(SETUP_ERROR.ontologyFailed)
    expect(snapshot.error?.suggestion).toContain("GitHub")
    expect(h.state.writes.at(-1)?.currentStep).toBe("ontology")
    expect(h.state.writes.at(-1)?.steps.ontology).toBe("failed")
    expect(h.state.writes.at(-1)?.steps.github).toBeUndefined()
  })

  test("a non-GitHub Ontology install error gets the stable Setup Ontology code", async () => {
    const ontology = memoryOntology(undefined, async () => {
      throw { code: "ONTOLOGY_SOURCE_CONFLICT", message: "registered source conflicts" }
    })
    const h = harness({ ontology, github: memoryGithub({ configured: true }) })
    const plan = await h.service.plan({ goals: ["ontology"] })
    const run = await h.service.execute({ planId: plan.planId, actionId: "ontology", input: { mode: "clone" } })
    const snapshot = await settled(h.service, run.runId)

    expect(snapshot.status).toBe("failed")
    expect(snapshot.error?.code).toBe(SETUP_ERROR.ontologyFailed)
  })

  test("a materialized Space with a failed preparation keeps the facts and reports the failure", async () => {
    const h = harness({
      space: memorySpace(async (input) => ({
        name: input.name,
        path: input.root,
        materialized: true,
        preparation: { status: "failed", error: { code: "SPACE_PREPARATION_FAILED", message: "bun install failed" } },
      })),
    })
    const plan = await h.service.plan({ goals: ["space"] })
    const run = await h.service.execute({
      planId: plan.planId,
      actionId: "space",
      input: { path: "/memory/space", type: "coding" },
    })
    const snapshot = await settled(h.service, run.runId)

    expect(snapshot.status).toBe("failed")
    expect(snapshot.error?.code).toBe(SETUP_ERROR.preparationFailed)
    expect(snapshot.result?.materialized).toBe(true)
    expect(h.state.writes.at(-1)?.steps.space).toBe("failed")
    expect(JSON.stringify(h.state.writes)).toContain("bun install failed")
  })

  test("a Space owner failure before materialization uses the stable Setup Space code", async () => {
    const h = harness({
      space: memorySpace(async () => {
        throw new Error("space type does not exist")
      }),
    })
    const plan = await h.service.plan({ goals: ["space"] })
    const run = await h.service.execute({
      planId: plan.planId,
      actionId: "space",
      input: { path: "/memory/space", type: "missing" },
    })
    const snapshot = await settled(h.service, run.runId)

    expect(snapshot.status).toBe("failed")
    expect(snapshot.error?.code).toBe(SETUP_ERROR.spaceFailed)
  })

  test("an optional provider can be explicitly skipped and the same plan can complete", async () => {
    const h = harness()
    const plan = await h.service.plan({ goals: ["provider"] })
    const run = await h.service.execute({ planId: plan.planId, actionId: "provider", input: { skip: true } })
    const snapshot = await settled(h.service, run.runId)

    expect(snapshot.status).toBe("completed")
    expect(snapshot.result).toEqual({ configured: false })
    expect(h.credentials.keys).toEqual([])
    expect(h.state.writes.at(-1)?.steps.provider).toBe("skipped")
    expect((await h.service.complete({ planId: plan.planId })).completed).toBe(true)
  })

  test("provider input rejects a skip mixed with credentials before reserving a run", async () => {
    const h = harness()
    const plan = await h.service.plan({ goals: ["provider"] })
    await expect(
      h.service.execute({
        planId: plan.planId,
        actionId: "provider",
        input: { providerId: "opencode", apiKey: "placeholder", skip: true },
      }),
    ).rejects.toMatchObject({ code: SETUP_ERROR.inputInvalid })
    expect(h.credentials.keys).toEqual([])
  })

  test("an action that requires input rejects a missing value before reserving a run", async () => {
    const h = harness()
    const plan = await h.service.plan({ goals: ["space"] })
    await expect(h.service.execute({ planId: plan.planId, actionId: "space", input: {} })).rejects.toMatchObject({
      code: SETUP_ERROR.inputRequired,
    })
    expect(h.space.inits).toEqual([])
  })
})

describe("setup complete", () => {
  test("refuses SETUP_INCOMPLETE when a requested goal is unmet and writes nothing", async () => {
    const h = harness()
    const plan = await h.service.plan({ goals: ["ontology"] })
    await expect(h.service.complete({ planId: plan.planId })).rejects.toMatchObject({
      code: SETUP_ERROR.incomplete,
    })
    expect(h.state.writes).toEqual([])
  })

  test("revalidates live facts and persists completed", async () => {
    const h = harness()
    const plan = await h.service.plan({ goals: ["foundation"] })
    h.setFacts(facts({ home: { foundation: { ready: true, missing: [] } } }))

    const result = await h.service.complete({ planId: plan.planId })
    expect(result.completed).toBe(true)
    const persisted = h.state.writes.at(-1)
    expect(persisted?.completed).toBe(true)
    expect(persisted?.currentStep).toBe("done")
    expect(persisted?.steps.done).toBe("done")
  })

  test("a failed state write is reported as SETUP_STATE_WRITE_FAILED", async () => {
    const state = memoryState()
    const failing = {
      reads: 0,
      writes: [] as never[],
      deleted: [] as never[],
      read: () => state.read(),
      write: async () => ({ ok: false as const, reason: "disk full" }),
      update: async () => ({ ok: false as const, reason: "disk full" }),
    }
    const h = harness({ state: failing, initial: facts({ home: { foundation: { ready: true, missing: [] } } }) })
    const plan = await h.service.plan({ goals: ["foundation"] })
    await expect(h.service.complete({ planId: plan.planId })).rejects.toMatchObject({
      code: SETUP_ERROR.stateWriteFailed,
    })
  })

  test("an unknown plan is rejected", async () => {
    const h = harness()
    await expect(h.service.complete({ planId: "missing" })).rejects.toMatchObject({
      code: SETUP_ERROR.planNotFound,
    })
  })

  test("completion ignores Runtime readiness and product inventory", async () => {
    const h = harness({
      initial: facts({ home: { foundation: { ready: true, missing: [] } } }),
    })
    const plan = await h.service.plan({ goals: ["foundation"] })
    const result = await h.service.complete({ planId: plan.planId })
    expect(result.completed).toBe(true)
    expect(JSON.stringify(result)).not.toContain("verdict")
  })
})

describe("setup execute concurrency", () => {
  test("two parallel execute calls never start a second action", async () => {
    const gate = deferred<SetupSpaceInitResult>()
    const h = harness({ space: memorySpace(async () => gate.promise) })
    const plan = await h.service.plan({ goals: ["space"] })
    const input = { path: "/memory/space", type: "coding" }

    const results = await Promise.allSettled([
      h.service.execute({ planId: plan.planId, actionId: "space", input }),
      h.service.execute({ planId: plan.planId, actionId: "space", input }),
    ])

    const fulfilled = results.filter((entry) => entry.status === "fulfilled")
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)
    expect(h.space.inits).toHaveLength(1)
    for (const entry of results) {
      if (entry.status === "rejected") expect(entry.reason).toMatchObject({ code: SETUP_ERROR.busy })
    }
    gate.resolve({ name: "demo", path: "/memory/space", materialized: true, preparation: { status: "ok" } })
    const runId = fulfilled[0]?.status === "fulfilled" ? fulfilled[0].value.runId : ""
    expect((await settled(h.service, runId)).status).toBe("completed")
  })
})

describe("setup progress reconnect", () => {
  test("a reconnecting reader sees the terminal state even when events were missed", async () => {
    const h = harness()
    const plan = await h.service.plan({ goals: ["foundation"] })
    const run = await h.service.execute({ planId: plan.planId, actionId: "foundation" })
    const final = await settled(h.service, run.runId)
    const replay = await collect(h.service, run.runId, final.sequence)
    expect(replay).toEqual([])
    expect(final.status).toBe("completed")
    expect(final.sequence).toBeGreaterThan(0)
  })
})

describe("setup plan progression", () => {
  test("a second action in the same plan still runs after the first changed facts", async () => {
    const h = harness()
    const plan = await h.service.plan({ goals: ["foundation", "ontology"] })
    expect(plan.actions.map((action) => action.actionId)).toEqual(["foundation", "ontology"])

    const first = await h.service.execute({ planId: plan.planId, actionId: "foundation" })
    h.setFacts(facts({ home: { foundation: { ready: true, missing: [] } } }))
    expect((await settled(h.service, first.runId)).status).toBe("completed")

    const second = await h.service.execute({ planId: plan.planId, actionId: "ontology", input: { mode: "clone" } })
    expect((await settled(h.service, second.runId)).status).toBe("completed")
    expect(h.ontology.installs).toHaveLength(1)
  })

  test("a consumed action cannot run twice inside one plan", async () => {
    const h = harness()
    const plan = await h.service.plan({ goals: ["foundation"] })
    const run = await h.service.execute({ planId: plan.planId, actionId: "foundation" })
    expect((await settled(h.service, run.runId)).status).toBe("completed")

    h.setFacts(facts({ home: { foundation: { ready: true, missing: [] } } }))
    await expect(h.service.execute({ planId: plan.planId, actionId: "foundation" })).rejects.toMatchObject({
      code: SETUP_ERROR.actionNotFound,
    })
    expect(h.foundation.calls).toBe(1)
  })
  test("a failed action stays retryable in the same plan against the new facts", async () => {
    let attempt = 0
    let materialize!: (verified: boolean) => void
    const space = memorySpace(async (input) => {
      attempt += 1
      // A real Space owner writes the materialized Space during the action.
      materialize(false)
      if (attempt === 1) {
        return {
          name: input.name,
          path: input.root,
          materialized: true,
          preparation: { status: "failed", error: { code: "PREPARE_FAILED", message: "bun install failed" } },
        }
      }
      materialize(true)
      return { name: input.name, path: input.root, materialized: true, preparation: { status: "ok" } }
    })
    const h = harness({ space })
    materialize = (verified) =>
      h.setFacts(
        facts({
          space: {
            status: verified ? "ready" : "unprepared",
            items: [{ name: "space", path: "/memory/space", verified }],
          },
        }),
      )
    const plan = await h.service.plan({ goals: ["space"] })
    const first = await h.service.execute({
      planId: plan.planId,
      actionId: "space",
      input: { path: "/memory/space", type: "coding" },
    })
    expect((await settled(h.service, first.runId)).status).toBe("failed")

    // The Space is now materialized, which is a real fact change caused by the
    // failed action itself; retrying must not be rejected as a stale plan.
    const retry = await h.service.execute({
      planId: plan.planId,
      actionId: "space",
      input: { path: "/memory/space", type: "coding" },
    })
    expect((await settled(h.service, retry.runId)).status).toBe("completed")
    expect(h.space.inits).toHaveLength(2)
  })
})
