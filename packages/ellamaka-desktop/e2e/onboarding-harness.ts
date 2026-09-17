// Desktop e2e harness for the onboarding state file. Desktop no longer
// resolves an onboarding mode at startup (the sidecar's onboarding HTTP
// surface owns routing); what remains desktop-relevant is that the state file
// written and read here round-trips correctly, matching what the app and the
// CLI consume.
import { mkdirSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  createDefaultOnboardingState,
  markCompleted,
  readOnboardingState,
  writeOnboardingState,
} from "../src/main/onboarding-state"

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
    readState: () => readOnboardingState(testHome),
  }
}
