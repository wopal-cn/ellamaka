import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PACKAGE_ROOT = join(import.meta.dir, "..")

describe("WopalSpace package import boundary", () => {
  test("importing the package does not create WOPAL_HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "wopalspace-contract-"))
    try {
      const wopalHome = join(home, "wophome")
      const proc = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          'const mod = await import("./src/index.ts"); console.log(mod.applicationDomains.join(","))',
        ],
        cwd: PACKAGE_ROOT,
        env: { ...process.env, WOPAL_HOME: wopalHome },
        stdout: "pipe",
        stderr: "pipe",
      })

      expect(proc.exitCode).toBe(0)
      expect(proc.stdout.toString()).toContain("setup,ontology,space")
      expect(existsSync(wopalHome)).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
