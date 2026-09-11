import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  readOnboardingState,
  writeOnboardingState,
  updateStep,
  markStarted,
  markCompleted,
  createDefaultOnboardingState,
  rewindToStep,
  navigateToStep,
} from "./onboarding-state"

describe("onboarding-state", () => {
  let testHome: string

  beforeEach(() => {
    testHome = join(tmpdir(), `onboarding-state-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testHome, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testHome)) {
      rmSync(testHome, { recursive: true, force: true })
    }
  })

  test("readOnboardingState returns null when state file does not exist", () => {
    const state = readOnboardingState(testHome)
    expect(state).toBeNull()
  })

  test("readOnboardingState parses valid JSON state file", () => {
    const statePath = join(testHome, "ellamaka", "state", "onboarding.json")
    mkdirSync(join(testHome, "ellamaka", "state"), { recursive: true })
    const initial = createDefaultOnboardingState()
    writeFileSync(statePath, JSON.stringify(initial), "utf-8")

    const state = readOnboardingState(testHome)
    expect(state).not.toBeNull()
    expect(state?.version).toBe(1)
    expect(state?.currentStep).toBe("system-check")
    expect(state?.completed).toBe(false)
  })

  test("readOnboardingState restores the integrated GitHub step as ontology setup", () => {
    const statePath = join(testHome, "ellamaka", "state", "onboarding.json")
    mkdirSync(join(testHome, "ellamaka", "state"), { recursive: true })
    const initial = createDefaultOnboardingState()
    writeFileSync(statePath, JSON.stringify({ ...initial, currentStep: "github-auth" }), "utf-8")

    const state = readOnboardingState(testHome)

    expect(state?.currentStep).toBe("ontology-setup")
  })

  test("readOnboardingState backs up corrupted JSON file and returns null", () => {
    const stateDir = join(testHome, "ellamaka", "state")
    const statePath = join(stateDir, "onboarding.json")
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(statePath, "{ invalid json ...", "utf-8")

    const state = readOnboardingState(testHome)
    expect(state).toBeNull()
    expect(existsSync(statePath)).toBe(false)

    // Check backup file exists
    const files = readdirSync(stateDir)
    const backup = files.find((f) => f.startsWith("onboarding.json.bak."))
    expect(backup).toBeDefined()
  })

  test("writeOnboardingState performs atomic write", () => {
    const state = createDefaultOnboardingState()
    const success = writeOnboardingState(state, testHome)
    expect(success).toBe(true)

    const statePath = join(testHome, "ellamaka", "state", "onboarding.json")
    expect(existsSync(statePath)).toBe(true)
    const content = JSON.parse(readFileSync(statePath, "utf-8"))
    expect(content.version).toBe(1)
  })

  test("updateStep updates specific step status and timestamp", () => {
    const initial = createDefaultOnboardingState()
    const updated = updateStep(initial, "install-cli", "in-progress")

    expect(updated.steps["install-cli"]).toBe("in-progress")
    expect(updated.currentStep).toBe("install-cli")
    expect(updated.updatedAt).not.toBeNull()
    expect(updated.steps["system-check"]).toBe("pending")
  })

  test("updateStep with error records error message", () => {
    const initial = createDefaultOnboardingState()
    const updated = updateStep(initial, "install-cli", "failed", "Network error")

    expect(updated.steps["install-cli"]).toBe("failed")
    expect(updated.errors["install-cli"]).toBe("Network error")
  })

  test("markStarted sets startedAt if not set", () => {
    const initial = createDefaultOnboardingState()
    expect(initial.startedAt).toBeNull()

    const started = markStarted(initial)
    expect(started.startedAt).not.toBeNull()

    const previousStartedAt = started.startedAt
    const started2 = markStarted(started)
    expect(started2.startedAt).toBe(previousStartedAt)
  })

  test("markCompleted sets completed to true and currentStep to done", () => {
    const initial = createDefaultOnboardingState()
    const completed = markCompleted(initial)

    expect(completed.completed).toBe(true)
    expect(completed.currentStep).toBe("done")
    expect(completed.steps["done"]).toBe("done")
    expect(completed.updatedAt).not.toBeNull()
  })

  test("rewindToStep resets subsequent step statuses to pending and updates currentStep", () => {
    let state = createDefaultOnboardingState()
    state = updateStep(state, "system-check", "completed")
    state = updateStep(state, "install-cli", "completed")
    state = updateStep(state, "ontology-setup", "completed")

    expect(state.steps["install-cli"]).toBe("completed")
    expect(state.steps["ontology-setup"]).toBe("completed")

    const rewound = rewindToStep(state, "install-cli")
    expect(rewound.currentStep).toBe("install-cli")
    expect(rewound.completed).toBe(false)
    expect(rewound.steps["install-cli"]).toBe("pending")
    expect(rewound.steps["ontology-setup"]).toBe("pending")
  })

  test("navigateToStep advances currentStep and marks prior steps as done", () => {
    let state = createDefaultOnboardingState()
    state = navigateToStep(state, "ontology-setup")

    expect(state.currentStep).toBe("ontology-setup")
    expect(state.steps["system-check"]).toBe("done")
    expect(state.steps["install-cli"]).toBe("done")
    expect(state.steps["ontology-setup"]).toBe("pending")
    expect(state.steps["create-space"]).toBe("pending")
  })

  test("navigateToStep rewinds when targetStep is prior to currentStep", () => {
    let state = createDefaultOnboardingState()
    state = navigateToStep(state, "ontology-setup")

    const rewound = navigateToStep(state, "install-cli")
    expect(rewound.currentStep).toBe("install-cli")
    expect(rewound.steps["system-check"]).toBe("done")
    expect(rewound.steps["install-cli"]).toBe("pending")
    expect(rewound.steps["ontology-setup"]).toBe("pending")
  })
})

function readdirSync(dir: string): string[] {
  const { readdirSync } = require("node:fs")
  return readdirSync(dir)
}
