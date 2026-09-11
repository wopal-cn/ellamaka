import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { isNushell, mergeShellEnv, parseShellEnv, persistWopalHomeEnv, resolveUserShell } from "./shell-env"

describe("shell env", () => {
  test("parseShellEnv supports null-delimited pairs", () => {
    const env = parseShellEnv(Buffer.from("PATH=/usr/bin:/bin\0FOO=bar=baz\0\0"))

    expect(env.PATH).toBe("/usr/bin:/bin")
    expect(env.FOO).toBe("bar=baz")
  })

  test("parseShellEnv ignores invalid entries", () => {
    const env = parseShellEnv(Buffer.from("INVALID\0=empty\0OK=1\0"))

    expect(Object.keys(env).length).toBe(1)
    expect(env.OK).toBe("1")
  })

  test("mergeShellEnv keeps explicit overrides", () => {
    const env = mergeShellEnv(
      {
        PATH: "/shell/path",
        HOME: "/tmp/home",
      },
      {
        PATH: "/desktop/path",
        OPENCODE_CLIENT: "desktop",
      },
    )

    expect(env.PATH).toBe("/desktop/path")
    expect(env.HOME).toBe("/tmp/home")
    expect(env.OPENCODE_CLIENT).toBe("desktop")
  })

  test("resolveUserShell falls back to the login shell before /bin/sh", () => {
    expect(resolveUserShell("/custom/env-shell", "/bin/zsh")).toBe("/custom/env-shell")
    expect(resolveUserShell(undefined, "/bin/zsh")).toBe("/bin/zsh")
    expect(resolveUserShell(undefined, "unknown")).toBe("/bin/sh")
    expect(resolveUserShell(undefined, undefined)).toBe("/bin/sh")
  })

  test("isNushell handles path and binary name", () => {
    expect(isNushell("nu")).toBe(true)
    expect(isNushell("/opt/homebrew/bin/nu")).toBe(true)
    expect(isNushell("C:\\Program Files\\nu.exe")).toBe(true)
    expect(isNushell("/bin/zsh")).toBe(false)
  })
})

describe("persistWopalHomeEnv", () => {
  let home: string
  let profilePath: string
  let originalShell: string | undefined
  let originalDev: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wopal-shell-env-"))
    profilePath = join(home, ".zshrc")
    originalShell = process.env.SHELL
    originalDev = process.env.WOPAL_DEV
    process.env.SHELL = "/bin/zsh"
  })

  afterEach(() => {
    if (originalShell === undefined) delete process.env.SHELL
    else process.env.SHELL = originalShell
    if (originalDev === undefined) delete process.env.WOPAL_DEV
    else process.env.WOPAL_DEV = originalDev
    rmSync(home, { recursive: true, force: true })
  })

  test("skips shell profile update when WOPAL_DEV=1", () => {
    process.env.WOPAL_DEV = "1"

    const result = persistWopalHomeEnv(join(home, "dev-home"))

    expect(result.success).toBe(true)
    expect(result.message).toContain("dev")
    expect(existsSync(profilePath)).toBe(false)
  })

  test("still sets WOPAL_HOME in dev mode", () => {
    process.env.WOPAL_DEV = "1"
    const target = join(home, "dev-home")

    persistWopalHomeEnv(target)

    expect(process.env.WOPAL_HOME).toBe(target)
  })

  test("writes shell profile when not in dev mode", () => {
    delete process.env.WOPAL_DEV

    const result = persistWopalHomeEnv(join(home, "prod-home"), {
      homeDir: () => home,
      platform: "darwin",
    })

    expect(result.success).toBe(true)
    expect(existsSync(profilePath)).toBe(true)
    expect(readFileSync(profilePath, "utf-8")).toContain("WOPAL_HOME")
  })
})
