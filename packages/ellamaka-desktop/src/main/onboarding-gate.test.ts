import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { resolveOnboardingMode, probeWopalHomeFromShell } from "./onboarding-gate"
import { createDefaultOnboardingState, markCompleted, writeOnboardingState } from "./onboarding-state"

describe("onboarding-gate", () => {
  let testHome: string

  beforeEach(() => {
    testHome = join(tmpdir(), `onboarding-gate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testHome, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testHome)) {
      rmSync(testHome, { recursive: true, force: true })
    }
  })

  test("resolveOnboardingMode returns 'onboarding' when state file does not exist", () => {
    const mode = resolveOnboardingMode(testHome, {})
    expect(mode).toBe("onboarding")
  })

  test("resolveOnboardingMode returns 'onboarding' when state is not completed", () => {
    const state = createDefaultOnboardingState()
    writeOnboardingState(state, testHome)

    const mode = resolveOnboardingMode(testHome, {})
    expect(mode).toBe("onboarding")
  })

  test("resolveOnboardingMode returns 'workbench' when state is completed", () => {
    const state = createDefaultOnboardingState()
    const completed = markCompleted(state)
    writeOnboardingState(completed, testHome)

    const mode = resolveOnboardingMode(testHome, {})
    expect(mode).toBe("workbench")
  })

  test("resolveOnboardingMode respects OPENCODE_TEST_ONBOARDING env flag", () => {
    const state = createDefaultOnboardingState()
    const completed = markCompleted(state)
    writeOnboardingState(completed, testHome)

    const mode = resolveOnboardingMode(testHome, { OPENCODE_TEST_ONBOARDING: "1" })
    expect(mode).toBe("onboarding")
  })
})

describe("probeWopalHomeFromShell", () => {
  test("returns a non-empty string when shell env has WOPAL_HOME, or null when absent", () => {
    // The probe spawns the real login shell. We can't deterministically set
    // WOPAL_HOME in the user's real rc for a test, so we only assert the
    // contract: either a trimmed non-empty string (probe found it) or null
    // (probe failed or var absent). Never undefined, never untrimmed.
    const result = probeWopalHomeFromShell()
    if (result !== null) {
      expect(typeof result).toBe("string")
      expect(result.length).toBeGreaterThan(0)
      expect(result).toBe(result.trim())
    } else {
      expect(result).toBeNull()
    }
  })

  test("does not throw when shell env probe fails", () => {
    // Setting SHELL to a nonexistent binary forces loadShellEnv to fail;
    // probeWopalHomeFromShell must swallow the error and return null.
    const origShell = process.env.SHELL
    process.env.SHELL = "/nonexistent/shell-for-test"
    try {
      expect(probeWopalHomeFromShell()).toBeNull()
    } finally {
      process.env.SHELL = origShell
    }
  })
})
