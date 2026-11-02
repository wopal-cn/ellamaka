import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recoverCapability } from "../../../src/space/capability"

describe("capability rollback", () => {
  test("reports a failed sparse restore while still restoring the manifest", () => {
    const space = mkdtempSync(join(tmpdir(), "cap-recovery-"))
    const worktree = join(space, ".wopal")
    mkdirSync(join(worktree, "assembly", "archetypes"), { recursive: true })
    const manifestPath = join(worktree, "assembly", "archetypes", "coding.yaml")
    writeFileSync(manifestPath, "mutated: true\n")

    const failures = recoverCapability({
      context: {
        git: () => {
          throw new Error("git is unavailable")
        },
        space: { path: space },
      },
      manifestPath,
      beforeRaw: "before: true\n",
      beforeState: { status: "missing", path: join(space, ".wopal-space", "space-meta.json") },
      beforeRange: ["/skills/dev-flow/"],
      worktree,
    })

    expect(readFileSync(manifestPath, "utf8")).toBe("before: true\n")
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain("sparse range")
    expect(failures[0]).toContain("git is unavailable")
    rmSync(space, { recursive: true, force: true })
  })
})
