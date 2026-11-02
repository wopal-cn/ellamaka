import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const packageRoot = join(import.meta.dir, "..", "..", "..")

describe("space domain import boundary", () => {
  it("importing the Space entry creates no directory and no Home state", () => {
    const root = mkdtempSync(join(tmpdir(), "wopalspace-space-purity-"))
    try {
      const wopalHome = join(root, "wophome")
      const proc = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          'const space = await import("./src/space/index.ts");' +
            "const service = space.createSpaceService({ host: { wopalHome: process.env.WOPAL_HOME } });" +
            'console.log([service.list().total, typeof space.SpaceServiceError].join(","))',
        ],
        cwd: packageRoot,
        env: { ...process.env, WOPAL_HOME: wopalHome },
        stdout: "pipe",
        stderr: "pipe",
      })
      // An empty Home is zero registered Spaces; nothing is created on import or list.
      expect(proc.stderr.toString()).toBe("")
      expect(proc.exitCode).toBe(0)
      expect(proc.stdout.toString().trim()).toBe("0,function")
      expect(existsSync(wopalHome)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
