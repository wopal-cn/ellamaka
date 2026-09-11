import { mkdirSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { resolveOnboardingMode } from "../src/main/onboarding-gate"
import { createDefaultOnboardingState, markCompleted, writeOnboardingState } from "../src/main/onboarding-state"

export function createOnboardingTestEnv() {
  const testHome = join(tmpdir(), `onboarding-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(testHome, { recursive: true })

  return {
    testHome,
    cleanup: () => {
      if (existsSync(testHome)) {
        rmSync(testHome, { recursive: true, force: true })
      }
    },
    markOnboardingComplete: () => {
      const state = markCompleted(createDefaultOnboardingState())
      writeOnboardingState(state, testHome)
    },
    getMode: () => resolveOnboardingMode(testHome),
  }
}
