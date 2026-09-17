import { describe, expect, test } from "bun:test"
import { probeWopalHomeFromShell } from "./onboarding-gate"

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
