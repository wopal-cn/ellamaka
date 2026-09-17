// Desktop e2e coverage for the retained onboarding state file contract.
// Startup mode resolution was removed from desktop (Plan #230); the sidecar's
// onboarding HTTP surface owns routing. This suite asserts the state file
// round-trip that bootstrap-installer and the wopal CLI still depend on.
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { createOnboardingTestEnv } from "./onboarding-harness"

describe("Onboarding state file (e2e)", () => {
  let env: ReturnType<typeof createOnboardingTestEnv>

  beforeEach(() => {
    env = createOnboardingTestEnv()
  })

  afterEach(() => {
    env.cleanup()
  })

  test("missing state file reads back as null", () => {
    expect(env.readState()).toBeNull()
  })

  test("completion persists with completed=true and currentStep=done", () => {
    expect(env.readState()).toBeNull()
    env.markOnboardingComplete()
    const state = env.readState()
    expect(state).not.toBeNull()
    expect(state?.completed).toBe(true)
    expect(state?.currentStep).toBe("done")
  })
})
