import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rollback, syncFailure } from "../../../src/space/sync"
import { SpaceServiceError, spaceErrorCodes } from "../../../src/space/types"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("space sync rollback", () => {
  test("names every Git recovery leg that failed", () => {
    const root = mkdtempSync(join(tmpdir(), "sync-rollback-"))
    roots.push(root)
    const ontology = join(root, "onto")
    const worktree = join(root, "space", ".wopal")
    mkdirSync(ontology, { recursive: true })
    mkdirSync(join(root, "space", ".wopal-space"), { recursive: true })

    // update-ref and reset both fail: the forgiving helpers would swallow this.
    const failingGit = (_cwd: string, args: readonly string[]) => {
      if (args[0] === "update-ref") throw new Error("ref is locked")
      if (args[0] === "reset") throw new Error("worktree is unusable")
      throw new Error("unexpected git call: " + args.join(" "))
    }

    const failures = rollback(failingGit, {
      ontologyPath: ontology,
      worktree,
      spaceBranch: "space/demo",
      preMain: "0123456789abcdef",
      preSpace: "fedcba9876543210",
      preRange: [],
      preStateRaw: null,
    })

    const joined = failures.join(" | ")
    expect(joined).toContain("ontology main ref")
    expect(joined).toContain("space branch ref")
    expect(joined).toContain("ontology reset")
    expect(joined).toContain("worktree reset")
    expect(joined).toContain("ref is locked")
    expect(joined).toContain("worktree is unusable")
  })

  test("reports nothing when every recovery leg succeeds", () => {
    const root = mkdtempSync(join(tmpdir(), "sync-rollback-"))
    roots.push(root)
    const ontology = join(root, "onto")
    const worktree = join(root, "space", ".wopal")
    mkdirSync(ontology, { recursive: true })
    mkdirSync(join(root, "space", ".wopal-space"), { recursive: true })

    const okGit = (_cwd: string, args: readonly string[]) => {
      if (args[0] === "update-ref" || args[0] === "reset") return ""
      throw new Error("unexpected git call: " + args.join(" "))
    }

    const failures = rollback(okGit, {
      ontologyPath: ontology,
      worktree,
      spaceBranch: "space/demo",
      preMain: "0123456789abcdef",
      preSpace: "fedcba9876543210",
      preRange: [],
      preStateRaw: null,
    })

    expect(failures).toEqual([])
  })
})

describe("space sync public recovery diagnostic", () => {
  test("names the failed leg and refuses to claim nothing changed", () => {
    const error = syncFailure(new Error("state commit failed"), ["ontology main ref: ref is locked"]) 

    expect(error).toBeInstanceOf(SpaceServiceError)
    expect(error.code).toBe(spaceErrorCodes.syncFailed)
    expect(error.message).toContain("Rollback was incomplete")
    expect(error.message).toContain("ontology main ref: ref is locked")
    expect(error.suggestion).toContain("Recovery failed")
    expect(error.message).not.toContain("No changes were applied")
  })

  test("keeps the original code and suggestion when recovery was complete", () => {
    const original = new SpaceServiceError({
      code: spaceErrorCodes.syncConflict,
      message: "conflict",
      suggestion: "resolve it",
    })

    const error = syncFailure(original, [])

    expect(error.code).toBe(spaceErrorCodes.syncConflict)
    expect(error.message).toBe("conflict")
    expect(error.suggestion).toBe("resolve it")
    expect(error.message).not.toContain("incomplete")
  })
})
