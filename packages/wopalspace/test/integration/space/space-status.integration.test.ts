import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createCompatibilityFixture, type CompatibilityFixture } from "../../fixtures/compatibility/git-space"
import { systemGit } from "../../../src/space/git"
import { spaceByName } from "../../../src/space/lookup"
import { readSpaceStatus } from "../../../src/space/status"
import { transactAssemblyState, readAssemblyState } from "../../../src/space/snapshot"
import { buildAssemblyState } from "../../../src/space/selection"
import { applySparsePatterns } from "../../../src/space/sparse"
import materializationPatterns from "../../fixtures/compatibility/materialization-patterns.json"

const fixtures: CompatibilityFixture[] = []
const fixture = (mode: "clone" | "fork" = "clone") => {
  const value = createCompatibilityFixture(join(process.env.TMPDIR ?? "/tmp", "wopalspace-space-status-"), mode)
  fixtures.push(value)
  return value
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose()
})

const status = (value: CompatibilityFixture, mode: "fork" | "clone" = "clone") =>
  readSpaceStatus(
    { space: spaceByName(value.home, "demo-space"), ontologyPath: value.ontology, ontologyMode: mode },
    systemGit,
  )

describe("space status", () => {
  it("reports the tracked assembly identity and an aligned branch", () => {
    const value = fixture()
    applySparsePatterns(systemGit, value.worktree, materializationPatterns)
    const result = status(value)
    expect(result.space).toEqual({
      name: "demo-space",
      path: value.space,
      branch: "space/demo-space",
      type: "coding",
    })
    expect(result.assembly.schema).toBe("coding-space-schema.yaml")
    expect(result.assembly.ontology).toBe("test-onto")
    expect(result.sync.contributions).toEqual([])
    expect(result.sync.behindCount).toBe(0)
    expect(result.selection).toEqual({ include: [], exclude: [] })
    expect(result.preparation).toEqual({ status: "unknown" })
    expect(result).not.toHaveProperty("localState")
  })

  it("reports contributions and behind commits with a merge prediction", () => {
    const value = fixture()
    applySparsePatterns(systemGit, value.worktree, materializationPatterns)
    value.commit(value.worktree, "config/note.md", "# note\n", "feat: space note")
    const ahead = status(value)
    expect(ahead.sync.contributions.map((commit) => commit.subject)).toEqual(["feat: space note"])
    expect(ahead.sync.behindCount).toBe(0)
    expect(ahead.sync.mergePrediction).toBe("clean")

    value.commit(value.ontology, "config/main-note.md", "# main\n", "feat: main note")
    const diverged = status(value)
    expect(diverged.sync.contributions).toHaveLength(1)
    expect(diverged.sync.behindCount).toBe(1)
    expect(diverged.sync.behindCommits[0]?.subject).toBe("feat: main note")
  })

  it("reports a conflict and its file without touching the worktree", () => {
    const value = fixture()
    applySparsePatterns(systemGit, value.worktree, materializationPatterns)
    value.commit(value.ontology, "rules/typescript.md", "# host content\n")
    value.commit(value.worktree, "rules/typescript.md", "# space content\n")
    const before = value.git(value.worktree, "status", "--porcelain=v1")
    const result = status(value)
    expect(result.sync.mergePrediction).toBe("conflict")
    expect(result.sync.conflictFiles).toContain("rules/typescript.md")
    expect(value.git(value.worktree, "status", "--porcelain=v1")).toBe(before)
    expect(value.git(value.worktree, "rev-parse", "HEAD")).toBe(
      value.git(value.worktree, "rev-parse", "space/demo-space"),
    )
  })

  it("lists complete unmanaged worktree assets as actionable candidates and nothing else", () => {
    const value = fixture()
    applySparsePatterns(systemGit, value.worktree, materializationPatterns)
    mkdirSync(join(value.worktree, "skills", "new-one"), { recursive: true })
    writeFileSync(join(value.worktree, "skills", "new-one", "SKILL.md"), "# new\n")
    // Incomplete: a directory without SKILL.md.
    mkdirSync(join(value.worktree, "skills", "partial"), { recursive: true })
    writeFileSync(join(value.worktree, "skills", "partial", "notes.txt"), "n\n")
    // Ignored entry inside an otherwise complete asset.
    mkdirSync(join(value.worktree, "skills", "secretive"), { recursive: true })
    writeFileSync(join(value.worktree, "skills", "secretive", "SKILL.md"), "# s\n")
    writeFileSync(join(value.worktree, "skills", "secretive", ".env"), "S=1\n")
    // Symlinked entry.
    mkdirSync(join(value.worktree, "skills", "linked"), { recursive: true })
    writeFileSync(join(value.worktree, "skills", "linked", "SKILL.md"), "# l\n")
    symlinkSync(
      join(value.worktree, "skills", "dev-flow", "SKILL.md"),
      join(value.worktree, "skills", "linked", "x.md"),
    )
    // Ordinary stray file outside the capability categories.
    value.write(value.worktree, "notes.md", "# stray\n")
    // A pool identity that exists but is not mounted is not a candidate.
    mkdirSync(join(value.ontology, "skills", "pool-only"), { recursive: true })
    writeFileSync(join(value.ontology, "skills", "pool-only", "SKILL.md"), "# p\n")
    value.git(value.ontology, "add", "-A")
    value.git(value.ontology, "commit", "-qm", "feat: pool only")

    const before = value.git(value.worktree, "status", "--porcelain=v1")
    const result = status(value)
    expect(result.candidates).toEqual([
      { reference: "skill:new-one", path: "skills/new-one", kind: "skill", source: "worktree" },
    ])
    expect(result.unregistered).toEqual(expect.arrayContaining(["notes.md", "skills/partial/notes.txt"]))
    expect(result.unregistered).not.toContain("skills/new-one/SKILL.md")
    // Incomplete / ignored / linked assets are not candidates; they stay read-only facts.
    expect(result.unregistered).toContain("skills/partial/notes.txt")
    expect(result.unregistered).toContain("skills/secretive/SKILL.md")
    expect(result.unregistered).toContain("skills/linked/x.md")
    expect(result.assembly.defaults).toContain("skill:dev-flow")
    expect(result.assembly.defaults).toContain("rule:typescript.md")
    expect(value.git(value.worktree, "status", "--porcelain=v1")).toBe(before)
  })

  it("reports selections, unregistered strays and the dirty count separately", () => {
    const value = fixture()
    applySparsePatterns(systemGit, value.worktree, materializationPatterns)
    value.write(value.worktree, "notes/stray.md", "# stray\n")
    const clean = status(value)
    expect(clean.unregistered).toContain("notes/stray.md")
    expect(clean.dirtyCount).toBe(0)

    writeFileSync(join(value.worktree, "rules/typescript.md"), "# edited\n")
    const dirty = status(value)
    expect(dirty.dirtyCount).toBe(1)
  })

  it("reports the root repository state commit situation", () => {
    const value = fixture()
    applySparsePatterns(systemGit, value.worktree, materializationPatterns)
    // The compatibility Space root is already a repository with an uncommitted snapshot.
    const before = status(value)
    expect(before.rootState?.tracked).toBe(false)
    expect(before.rootState?.pendingChanges).toBe(true)
    expect(before.rootState?.lastCommit).toBeUndefined()

    value.git(value.space, "add", ".wopal-space/space-meta.json")
    value.git(value.space, "commit", "-qm", "chore: state")
    const after = status(value)
    expect(after.rootState?.tracked).toBe(true)
    expect(after.rootState?.pendingChanges).toBe(false)
    expect(after.rootState?.lastCommit?.sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it("reports fork-mode remote delta and omits it in clone mode", () => {
    const value = fixture("fork")
    applySparsePatterns(systemGit, value.worktree, materializationPatterns)
    value.commit(value.worktree, "config/fork-note.md", "# fork\n", "feat: fork note")
    value.git(value.ontology, "push", "-q", "origin", "space/demo-space")
    const fork = status(value, "fork")
    expect(fork.remote).toBeDefined()
    expect(fork.remote?.ahead).toBe(0)
    expect(fork.remote?.behind).toBe(0)
    expect(status(value, "clone").remote).toBeUndefined()
  })

  it("refuses a missing or corrupt snapshot with a rebuild hint", () => {
    const value = fixture()
    const snapshotPath = join(value.space, ".wopal-space/space-meta.json")
    const original = readFileSync(snapshotPath, "utf8")
    writeFileSync(snapshotPath, "{ not json")
    expect(() => status(value)).toThrow(/invalid/)

    value.write(value.space, ".wopal-space/space-meta.json", original)
    value.git(value.space, "init", "-q", "-b", "main")
    const reading = readAssemblyState(value.space)
    expect(reading.status).toBe("ok")
  })

  it("keeps the snapshot transaction a fixed point when nothing changes", () => {
    const value = fixture()
    const initial = readAssemblyState(value.space)
    const same = buildAssemblyState({ type: "coding", schema: "coding-space-schema.yaml", ontology: "test-onto" })
    const first = transactAssemblyState(
      { spacePath: value.space, expectedRaw: initial.status === "ok" ? initial.raw : null, state: same },
      systemGit,
    )
    // The fixture snapshot already equals the canonical bytes: no write, no commit.
    expect(first.changed).toBe(false)
    expect(first.committed).toBe(false)

    const changedState = buildAssemblyState({
      type: "coding",
      schema: "coding-space-schema.yaml",
      ontology: "test-onto",
      include: ["rule:typescript.md"],
    })
    const current = readAssemblyState(value.space)
    const second = transactAssemblyState(
      { spacePath: value.space, expectedRaw: current.status === "ok" ? current.raw : null, state: changedState },
      systemGit,
    )
    expect(second.changed).toBe(true)
    const third = readAssemblyState(value.space)
    const repeat = transactAssemblyState(
      { spacePath: value.space, expectedRaw: third.status === "ok" ? third.raw : null, state: changedState },
      systemGit,
    )
    expect(repeat.changed).toBe(false)
    expect(repeat.committed).toBe(false)
  })
})
