import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "path"
import { GIT_LOCATOR_VARS, gitEnv, stripGitLocatorVars } from "./git-env"

// git documents these as the "repository location" variables it exports to hook
// processes. The module is the single source of truth for that list, so pin the
// critical names here rather than restating the whole literal.
const CRITICAL_LOCATORS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"] as const

const MARKER = "OPENCODE_TEST_GIT_ENV_MARKER"

/** Seed `process.env` for the duration of `fn`, then restore the previous state. */
function withProcessEnv(seed: Record<string, string>, fn: () => void) {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(seed)) {
    saved.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe("GIT_LOCATOR_VARS", () => {
  test("names every repository locator git hands to hook processes", () => {
    for (const key of CRITICAL_LOCATORS) expect(GIT_LOCATOR_VARS).toContain(key)
    expect(new Set(GIT_LOCATOR_VARS).size).toBe(GIT_LOCATOR_VARS.length)
  })
})

describe("stripGitLocatorVars", () => {
  test("removes every locator variable and keeps unrelated keys", () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin:/bin", [MARKER]: "keep-me" }
    for (const key of GIT_LOCATOR_VARS) env[key] = "leaked"

    stripGitLocatorVars(env)

    for (const key of GIT_LOCATOR_VARS) expect(env[key]).toBeUndefined()
    expect(env.PATH).toBe("/usr/bin:/bin")
    expect(env[MARKER]).toBe("keep-me")
  })

  test("an explicit env object leaves process.env untouched", () => {
    withProcessEnv({ GIT_DIR: "/leaked/.git" }, () => {
      const env: Record<string, string | undefined> = { GIT_DIR: "/other/.git" }

      stripGitLocatorVars(env)

      expect(env.GIT_DIR).toBeUndefined()
      expect(process.env.GIT_DIR).toBe("/leaked/.git")
    })
  })

  test("defaults to process.env and strips locators in place", () => {
    withProcessEnv({ GIT_DIR: "/leaked/.git", GIT_INDEX_FILE: "/leaked/.git/index", [MARKER]: "keep-me" }, () => {
      stripGitLocatorVars()

      expect(process.env.GIT_DIR).toBeUndefined()
      expect(process.env.GIT_INDEX_FILE).toBeUndefined()
      expect(process.env[MARKER]).toBe("keep-me")
    })
  })
})

describe("gitEnv", () => {
  test("pins GIT_DIR and GIT_WORK_TREE to the given directory", () => {
    const dir = path.join("/tmp", "opencode-test-git-env")

    const env = gitEnv(dir)

    expect(env).not.toBe(process.env)
    expect(env.GIT_DIR).toBe(path.join(dir, ".git"))
    expect(env.GIT_WORK_TREE).toBe(dir)
  })

  test("drops inherited locators and carries the rest of the environment", () => {
    const dir = path.join("/tmp", "opencode-test-git-env")
    const seed = Object.fromEntries([...GIT_LOCATOR_VARS.map((key) => [key, `/leaked/${key}`]), [MARKER, "keep-me"]])

    withProcessEnv(seed, () => {
      const env = gitEnv(dir)

      expect(env.GIT_DIR).toBe(path.join(dir, ".git"))
      expect(env.GIT_WORK_TREE).toBe(dir)
      for (const key of GIT_LOCATOR_VARS) {
        if (key === "GIT_DIR" || key === "GIT_WORK_TREE") continue
        expect(env[key]).toBeUndefined()
      }
      expect(env[MARKER]).toBe("keep-me")
      expect(env.PATH).toBe(process.env.PATH)
    })
  })
})

// The pre-commit hook is a shell script, so it cannot import this module: its
// `unset` line is a second, hand-written copy of the locator list. Pin the two
// together — a variable added on one side only would silently stop being cleared.
describe("pre-commit hook", () => {
  test("clears every repository locator variable this module knows", () => {
    const hook = path.join(import.meta.dir, "..", "..", "..", "..", ".husky", "pre-commit")
    if (!existsSync(hook)) throw new Error(`pre-commit hook not found at ${hook}`)

    const lines = readFileSync(hook, "utf8").split("\n")
    const unsetIndex = lines.findIndex((line) => line.trim().startsWith("unset") && line.includes("GIT_DIR"))
    if (unsetIndex === -1) throw new Error(`no "unset ... GIT_DIR ..." line found in ${hook}`)
    const runIndex = lines.findIndex((line) => line.includes("test:unit"))
    if (runIndex === -1) throw new Error(`no "test:unit" invocation found in ${hook}`)

    for (const key of GIT_LOCATOR_VARS) expect(lines[unsetIndex]).toContain(key)
    // Clearing only protects the tests if it happens first: an unset line below
    // the invocation would leave the suite exposed while this list still matches.
    expect(unsetIndex).toBeLessThan(runIndex)
  })
})
