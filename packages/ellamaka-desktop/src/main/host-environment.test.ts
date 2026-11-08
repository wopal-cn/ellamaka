import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveDesktopHostEnvironment } from "./shell-env"

describe("Desktop Host Environment", () => {
  test("selects the inherited root before reading global settings and filters only shell variables", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-env-"))
    try {
      const a = join(dir, "a")
      const b = join(dir, "b")
      for (const root of [a, b]) mkdirSync(join(root, "config"), { recursive: true })
      writeFileSync(
        join(a, "config", "settings.jsonc"),
        '{"wopal":{"execution":{"shellEnv":{"mode":"allowlist","list":["PATH","CUSTOM_*"]}}}}',
      )
      writeFileSync(
        join(b, "config", "settings.jsonc"),
        '{"wopal":{"execution":{"shellEnv":{"mode":"denylist","list":["PATH"]}}}}',
      )
      const result = await resolveDesktopHostEnvironment({
        inherited: { WOPAL_HOME: a, PATH: "/bin", KEEP: "inherited", CUSTOM_A: "old" },
        shell: { WOPAL_HOME: b, PATH: "/tools:/bin", CUSTOM_A: "new", CUSTOMX_A: "unmatched", KEEP: "shell" },
        homeDir: dir,
      })
      expect(result.home).toBe(a)
      expect(result.env).toEqual({ WOPAL_HOME: a, PATH: "/tools:/bin", KEEP: "inherited", CUSTOM_A: "new" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.each([
    [{ mode: "allowlist", list: [] }, "/bin", "inherited"],
    [{ mode: "denylist", list: [] }, "/tools", "shell"],
    [{ mode: "inherit", list: ["PATH"] }, "/tools", "shell"],
    [{ mode: "denylist", list: ["WOPAL_HOME"] }, "/tools", "shell"],
  ])("keeps the shell-selected root independently of policy %j", async (policy, path, keep) => {
    const dir = mkdtempSync(join(tmpdir(), "host-env-"))
    try {
      const root = join(dir, "root")
      mkdirSync(join(root, "config"), { recursive: true })
      writeFileSync(
        join(root, "config", "settings.jsonc"),
        JSON.stringify({ wopal: { execution: { shellEnv: policy } } }),
      )
      const result = await resolveDesktopHostEnvironment({
        inherited: { PATH: "/bin", KEEP: "inherited" },
        shell: { WOPAL_HOME: root, PATH: "/tools", KEEP: "shell", PWD: "/probe", DISABLE_AUTO_UPDATE: "true" },
        homeDir: dir,
      })
      expect(result.home).toBe(root)
      expect(result.env).toEqual({ WOPAL_HOME: root, PATH: path, KEEP: keep })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("uses the default root after total probe failure or on Windows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-env-"))
    try {
      for (const platform of ["linux", "win32"] as const) {
        const result = await resolveDesktopHostEnvironment({
          inherited: { PATH: "/bin" },
          shell: null,
          platform,
          homeDir: dir,
        })
        expect(result).toEqual({ home: join(dir, ".wopal"), env: { PATH: "/bin", WOPAL_HOME: join(dir, ".wopal") } })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("Windows never starts a shell probe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-env-"))
    try {
      let launched = false
      const result = await resolveDesktopHostEnvironment({
        platform: "win32",
        inherited: { PATH: "/bin" },
        homeDir: dir,
        candidates: ["/bin/sh"],
        onSpawn: () => {
          launched = true
        },
      })
      expect(launched).toBe(false)
      expect(result.env.WOPAL_HOME).toBe(join(dir, ".wopal"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("ignores an invalid inherited root and accepts the shell's absolute root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-env-"))
    try {
      const root = join(dir, "root")
      const result = await resolveDesktopHostEnvironment({
        inherited: { WOPAL_HOME: "relative/path", PATH: "/bin" },
        shell: { WOPAL_HOME: root, PATH: "/tools" },
        homeDir: dir,
      })
      expect(result).toEqual({ home: root, env: { WOPAL_HOME: root, PATH: "/tools" } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
