import { describe, expect, test } from "bun:test"
import { SETUP_GOALS, fingerprintOf, planSetup, satisfiedGoals } from "../../../src/setup"
import { facts } from "./support"

describe("setup planner", () => {
  test("plans every pending goal in canonical order on a fresh machine", () => {
    const plan = planSetup({ goals: [...SETUP_GOALS], facts: facts() })
    expect(SETUP_GOALS).toEqual(["foundation", "github", "ontology", "space", "provider"])
    expect(plan.map((action) => action.actionId)).toEqual(["foundation", "github", "ontology", "space", "provider"])
    expect(plan.filter((action) => !action.requiresInput).map((action) => action.actionId)).toEqual([
      "foundation",
      "ontology",
    ])
  })

  test("only plans the goals the user asked for", () => {
    const plan = planSetup({ goals: ["space"], facts: facts() })
    expect(plan.map((action) => [action.actionId, action.goal])).toEqual([["space", "space"]])
  })

  test("leaves out goals whose facts are already satisfied", () => {
    const plan = planSetup({
      goals: [...SETUP_GOALS],
      facts: facts({
        ontology: {
          status: "ready",
          items: [{ name: "wopal-space-ontology", path: "/home/ontologies/o", mode: "clone" }],
        },
        space: { status: "ready", items: [{ name: "demo", path: "/home/space", verified: true }] },
        github: { configured: true, source: "gh" },
        providers: ["opencode-go"],
        state: { status: "ok", completed: false, currentStep: "done", steps: { provider: "done" } },
        home: {
          foundation: { ready: true, missing: [] },
          settings: { present: true, valid: true, ellamaka: { present: true, valid: true } },
          capabilities: { ready: true, missing: [] },
        },
      }),
    })
    expect(plan).toEqual([])
  })

  test("treats a registered but unverified Space as still pending", () => {
    const plan = planSetup({
      goals: ["space"],
      facts: facts({
        space: { status: "unprepared", items: [{ name: "demo", path: "/home/space", verified: false }] },
      }),
    })
    expect(plan.map((action) => action.actionId)).toEqual(["space"])
  })

  test("orders dependent actions after foundation", () => {
    const plan = planSetup({ goals: ["space", "ontology", "github", "foundation"], facts: facts() })
    expect(plan.map((action) => action.actionId)).toEqual(["foundation", "github", "ontology", "space"])
    expect(plan.find((action) => action.actionId === "ontology")?.dependsOn).toEqual(["foundation", "github"])
    expect(plan.find((action) => action.actionId === "space")?.dependsOn).toEqual(["ontology"])
  })

  test("foundation only describes the WOPAL_HOME root", () => {
    expect(
      satisfiedGoals(
        facts({
          home: {
            foundation: { ready: true, missing: [] },
            settings: { present: true, valid: false, ellamaka: { present: false, valid: false } },
            capabilities: { ready: false, missing: ["agents"] },
          },
        }),
      ),
    ).toContain("foundation")
  })

  test("ontology setup is not satisfied until its Home base artifacts are ready", () => {
    const ontology = { status: "ready" as const, items: [{ name: "o", path: "/o", mode: "clone" as const }] }
    expect(satisfiedGoals(facts({ ontology }))).not.toContain("ontology")
    expect(
      satisfiedGoals(
        facts({
          ontology,
          home: {
            settings: { present: true, valid: true, ellamaka: { present: true, valid: true } },
            capabilities: { ready: true, missing: [] },
          },
        }),
      ),
    ).toContain("ontology")
  })

  test("satisfiedGoals reports the facts that already meet their goal", () => {
    expect(satisfiedGoals(facts())).toEqual([])
    expect(
      satisfiedGoals(
        facts({
          home: {
            foundation: { ready: true, missing: [] },
            settings: { present: true, valid: true, ellamaka: { present: true, valid: true } },
            capabilities: { ready: true, missing: [] },
          },
          ontology: { status: "ready", items: [{ name: "o", path: "/o", mode: "clone" }] },
        }),
      ),
    ).toEqual(["foundation", "ontology"])
  })

  test("treats live GitHub identity as satisfied even when an old failure hint remains", () => {
    const live = facts({
      github: { configured: true, source: "gh", account: "octocat" },
      state: {
        status: "ok",
        currentStep: "github",
        steps: { github: "failed", ontology: "failed" },
      },
    })

    expect(satisfiedGoals(live)).toContain("github")
    expect(planSetup({ goals: ["github"], facts: live }).map((action) => action.actionId)).toEqual([])
  })

  test("an inherited token does not satisfy the GitHub onboarding goal until the user explicitly completes it", () => {
    const inherited = facts({ github: { configured: true, source: "process-env", account: "octocat" } })
    expect(satisfiedGoals(inherited)).not.toContain("github")
    expect(planSetup({ goals: ["github"], facts: inherited }).map((action) => action.actionId)).toEqual(["github"])

    const explicit = facts({
      github: { configured: true, source: "home-env", account: "octocat" },
      state: { status: "ok", currentStep: "github", steps: { github: "done" } },
    })
    expect(satisfiedGoals(explicit)).toContain("github")
    expect(planSetup({ goals: ["github"], facts: explicit }).map((action) => action.actionId)).toEqual([])
  })

  test("fingerprint is stable for equal facts and changes with critical facts", () => {
    const base = fingerprintOf(facts())
    expect(fingerprintOf(facts())).toBe(base)
    expect(
      fingerprintOf(facts({ ontology: { status: "ready", items: [{ name: "o", path: "/o", mode: "clone" }] } })),
    ).not.toBe(base)
    expect(
      fingerprintOf(facts({ space: { status: "ready", items: [{ name: "s", path: "/s", verified: true }] } })),
    ).not.toBe(base)
    expect(fingerprintOf(facts({ github: { configured: true, source: "env" } }))).not.toBe(base)
    expect(fingerprintOf(facts({ state: { status: "ok", completed: true, currentStep: "done", steps: {} } }))).not.toBe(
      base,
    )
  })
})
