import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isWopalHomeLockedAtStartup, persistWopalHomeEnv } from "../src/wopal-home-env"
import { scopedEnv } from "./fixture/process-env"

describe("persistWopalHomeEnv", () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ellamaka-wopal-home-env-"))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  test("normal mode persists WOPAL_HOME to the user shell profile and current process", () => {
    using _environment = scopedEnv({ SHELL: "/bin/zsh", WOPAL_DEV: undefined, WOPAL_HOME: undefined })
    const selected = join(home, "normal-home")

    const result = persistWopalHomeEnv(selected, { homeDir: () => home, platform: "darwin" })

    expect(result.success).toBe(true)
    expect(process.env.WOPAL_HOME).toBe(selected)
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toContain(`export WOPAL_HOME="${selected}"`)
  })

  test("development mode applies WOPAL_HOME only to the current process", () => {
    using _environment = scopedEnv({ SHELL: "/bin/zsh", WOPAL_DEV: "1", WOPAL_HOME: undefined })
    const selected = join(home, "dev-home")

    const result = persistWopalHomeEnv(selected, { homeDir: () => home, platform: "darwin" })

    expect(result.success).toBe(true)
    expect(process.env.WOPAL_HOME).toBe(selected)
    expect(existsSync(join(home, ".zshrc"))).toBe(false)
  })
})

describe("isWopalHomeLockedAtStartup", () => {
  test("only an explicit normal-mode WOPAL_HOME starts locked", () => {
    expect(isWopalHomeLockedAtStartup({ WOPAL_HOME: "/tmp/home" })).toBe(true)
    expect(isWopalHomeLockedAtStartup({ WOPAL_HOME: "" })).toBe(false)
    expect(isWopalHomeLockedAtStartup({})).toBe(false)
    expect(isWopalHomeLockedAtStartup({ WOPAL_HOME: "/tmp/home", WOPAL_DEV: "1" })).toBe(false)
  })
})
