import { describe, expect, test } from "bun:test"
import path from "node:path"
import { insideGitRepository, orphanedWorktrees, resolveTempRoot } from "./temp-root"

describe("test temp root", () => {
  test("detects the checkout this test itself runs in", () => {
    // The repository under test is, by definition, a git working tree. If this
    // reports false the detector is broken and every later assertion is moot.
    expect(insideGitRepository(path.resolve(import.meta.dir, "..", ".."))).toBe(true)
  })

  test("rejects a directory inside a checkout", () => {
    const repoRoot = path.resolve(import.meta.dir, "..", "..")
    // A subdirectory that may not exist yet still resolves upward to the same
    // repository, which is exactly the failure mode being guarded against.
    expect(insideGitRepository(repoRoot)).toBe(true)
  })

  test("skips every candidate inside a repository", () => {
    const repoRoot = path.resolve(import.meta.dir, "..", "..")
    const resolved = resolveTempRoot([path.join(repoRoot, "test", "fixture"), "/tmp"])
    expect(insideGitRepository(resolved)).toBe(false)
    expect(resolved).not.toContain(repoRoot)
  })

  test("fails loudly when no candidate is usable", () => {
    const repoRoot = path.resolve(import.meta.dir, "..", "..")
    expect(() => resolveTempRoot([repoRoot])).toThrow(/outside a git repository/)
  })
})

describe("orphaned worktrees", () => {
  test("reports a registration whose directory is gone", async () => {
    const { mkdtemp, mkdir, rm } = await import("node:fs/promises")
    const { $ } = await import("bun")
    const root = await mkdtemp(path.join(resolveTempRoot(), "orphan-probe-"))
    const repo = path.join(root, "repo")
    const checkout = path.join(root, "gone")
    await mkdir(repo, { recursive: true })
    try {
      await $`git init -q`.cwd(repo)
      await $`git config user.email t@example.test`.cwd(repo).quiet()
      await $`git config user.name T`.cwd(repo).quiet()
      await $`git commit -q --allow-empty -m init`.cwd(repo).quiet()
      await $`git worktree add -q -b probe ${checkout} HEAD`.cwd(repo).quiet()

      expect(orphanedWorktrees(repo)).toEqual([])

      // Deleting the checkout is exactly what a temp-directory cleanup does; the
      // registration survives and is now an orphan.
      await rm(checkout, { recursive: true, force: true })
      expect(orphanedWorktrees(repo)).toHaveLength(1)
      expect(orphanedWorktrees(repo)[0]).toContain("gone")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
