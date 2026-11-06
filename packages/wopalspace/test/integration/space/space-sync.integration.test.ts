import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createCompatibilityFixture, type CompatibilityFixture } from "../../fixtures/compatibility/git-space"
import { createSpaceService } from "../../../src/space/service"
import { systemGit, type GitRunner } from "../../../src/space/git"
import { SpaceServiceError, spaceErrorCodes } from "../../../src/space/types"
import materializationPatterns from "../../fixtures/compatibility/materialization-patterns.json"

const fixtures: CompatibilityFixture[] = []
const fixture = () => {
  const value = createCompatibilityFixture(join(process.env.TMPDIR ?? "/tmp", "wopalspace-sync-"))
  fixtures.push(value)
  value.applySparse(materializationPatterns)
  return value
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose()
})

const service = (value: CompatibilityFixture) => createSpaceService({ host: { wopalHome: value.home }, git: systemGit })

/** Every fact a sync preview must leave exactly as it found it. */
function observe(value: CompatibilityFixture) {
  return value.snapshot()
}

function expectUnchanged(value: CompatibilityFixture, before: ReturnType<typeof observe>) {
  const after = observe(value)
  expect(after.refs).toBe(before.refs)
  expect(after.hostStatus).toBe(before.hostStatus)
  expect(after.spaceStatus).toBe(before.spaceStatus)
  expect(after.index).toBe(before.index)
  expect(after.sparse).toBe(before.sparse)
  expect(after.meta).toBe(before.meta)
  expect(after.registry).toBe(before.registry)
  expect(after.objects).toEqual(before.objects)
  expect(after.fetchHead).toBe(before.fetchHead)
  expect(after.files).toEqual(before.files)
}

describe("space sync preview", () => {
  it("reports a no-op plan and writes nothing", async () => {
    const value = fixture()
    const before = observe(value)
    const plan = await service(value).sync("demo-space", { confirm: false })
    expect(plan.confirm).toBe(false)
    expect(plan.contributions).toEqual([])
    expect(plan.mainAhead).toBe(0)
    expect(plan.conflicts).toEqual({ upstream: [], stray: [] })
    expect(plan.strayFiles).toEqual([])
    expect(plan.sparsePatterns.length).toBeGreaterThan(0)
    expectUnchanged(value, before)
  })

  it("reports contributions and stray protection without writing", async () => {
    const value = fixture()
    value.commit(value.worktree, "config/note.md", "# note\n", "feat: note")
    value.write(value.worktree, "rules/stray.md", "# stray\n")
    const before = observe(value)
    const plan = await service(value).sync("demo-space", { confirm: false })
    expect(plan.contributions.map((commit) => commit.subject)).toEqual(["feat: note"])
    expect(plan.strayFiles).toEqual(["rules/stray.md"])
    expect(plan.uncommittedChanges).toEqual([])
    expectUnchanged(value, before)
  })

  it("predicts a merge conflict with zero writes, including no Git objects", async () => {
    const value = fixture()
    value.commit(value.ontology, "rules/typescript.md", "# host\n", "feat: host")
    value.commit(value.worktree, "rules/typescript.md", "# space\n", "feat: space")
    const before = observe(value)
    const plan = await service(value).sync("demo-space", { confirm: false })
    expect(plan.conflicts.upstream).toContain("rules/typescript.md")
    // The previous owner's conflict probe wrote loose objects; the preview
    // now merges against a disposable object store.
    expectUnchanged(value, before)
    await expect(service(value).sync("demo-space", { confirm: true })).rejects.toThrow(/conflict/i)
    expectUnchanged(value, before)
  })

  it("refuses dirty changes that intersect the touch set before any write", async () => {
    const value = fixture()
    value.commit(value.ontology, "rules/typescript.md", "# incoming\n", "feat: incoming")
    value.write(value.worktree, "rules/typescript.md", "# user dirty\n")
    const before = observe(value)
    await expect(service(value).sync("demo-space", { confirm: false })).rejects.toThrow(/uncommitted changes/i)
    expectUnchanged(value, before)
  })

  it("refuses a legacy private hold instead of letting it ride into local main", async () => {
    const value = fixture()
    const statePath = join(value.space, ".wopal-space/space-meta.json")
    const state = JSON.parse(readFileSync(statePath, "utf8"))
    writeFileSync(
      statePath,
      JSON.stringify({ ...state, version: 2, private: ["rule:private-rule.md"] }, null, 2) + "\n",
    )
    value.commit(value.worktree, "rules/private-rule.md", "# private\n", "feat: private leak")
    const before = observe(value)
    await expect(service(value).sync("demo-space", { confirm: false })).rejects.toThrow(/retired private selection/i)
    expectUnchanged(value, before)
  })
})

describe("space sync apply", () => {
  it("integrates contributions, fast-forwards the branch and keeps user changes", async () => {
    const value = fixture()
    value.commit(value.worktree, "config/note.md", "# note\n", "feat: note")
    writeFileSync(join(value.worktree, "rules/custom.md"), "# user file\n")

    const applied = await service(value).sync("demo-space", { confirm: true })
    expect(applied.confirm).toBe(true)
    expect(applied.contributions.map((commit) => commit.subject)).toEqual(["feat: note"])

    // main absorbed the Space commit and the branch fast-forwarded onto it.
    expect(value.git(value.ontology, "log", "--format=%s", "-1", "main")).toBe("feat: note")
    expect(value.git(value.ontology, "rev-parse", "space/demo-space")).toBe(
      value.git(value.ontology, "rev-parse", "main"),
    )
    expect(value.git(value.worktree, "rev-parse", "HEAD")).toBe(value.git(value.ontology, "rev-parse", "main"))
    // The user's out-of-range file survived.
    expect(readFileSync(join(value.worktree, "rules/custom.md"), "utf8")).toBe("# user file\n")
    expect(value.git(value.ontology, "status", "--porcelain")).toBe("")
    expect(
      value
        .git(value.ontology, "worktree", "list", "--porcelain")
        .split("\n")
        .filter((line) => line.startsWith("worktree ")),
    ).toHaveLength(2)
  })

  it("brings newer main content down and recomputes the sparse range", async () => {
    const value = fixture()
    value.commit(value.ontology, "rules/typescript.md", "# newer rule\n", "feat: main rule")
    const applied = await service(value).sync("demo-space", { confirm: true })
    expect(applied.mainAhead).toBe(1)
    expect(value.git(value.worktree, "rev-parse", "HEAD")).toBe(value.git(value.ontology, "rev-parse", "main"))
    expect(readFileSync(join(value.worktree, "rules/typescript.md"), "utf8")).toBe("# newer rule\n")
    expect(applied.sparsePatterns).toContain("/skills/dev-flow/")
  })

  it("restores main, branch, range and snapshot when the downstream fails", async () => {
    const value = fixture()
    value.commit(value.worktree, "config/note.md", "# note\n", "feat: note")
    // main drops a path the space still selects, so the post-merge prune has
    // a state change to persist.
    rmSync(join(value.ontology, "rules/typescript.md"))
    value.git(value.ontology, "add", "-A")
    value.git(value.ontology, "commit", "-qm", "feat: drop rule")
    const snapshotPath = join(value.space, ".wopal-space/space-meta.json")
    const state = JSON.parse(readFileSync(snapshotPath, "utf8"))
    writeFileSync(snapshotPath, JSON.stringify({ ...state, include: ["rule:typescript.md"] }, null, 2) + "\n")
    writeFileSync(snapshotPath, JSON.stringify({ ...state, include: ["rule:typescript.md"] }, null, 2) + "\n")

    const preMain = value.git(value.ontology, "rev-parse", "main")
    const preSpace = value.git(value.ontology, "rev-parse", "space/demo-space")
    const preRange = value.git(value.worktree, "sparse-checkout", "list")
    const preMeta = readFileSync(snapshotPath, "utf8")

    // An unfinished Git operation makes the state commit fail closed.
    const gitDir = value.git(value.space, "rev-parse", "--absolute-git-dir")
    writeFileSync(join(gitDir, "MERGE_HEAD"), preMain + "\n")

    await expect(service(value).sync("demo-space", { confirm: true })).rejects.toThrow()

    expect(value.git(value.ontology, "rev-parse", "main")).toBe(preMain)
    expect(value.git(value.ontology, "rev-parse", "space/demo-space")).toBe(preSpace)
    expect(value.git(value.worktree, "sparse-checkout", "list")).toBe(preRange)
    expect(readFileSync(snapshotPath, "utf8")).toBe(preMeta)
    expect(value.git(value.ontology, "status", "--porcelain")).toBe("")
  })

  it("reports incomplete rollback through the public sync error when ref recovery fails", async () => {
    const value = fixture()
    value.commit(value.worktree, "config/note.md", "# note\n", "feat: note")
    value.commit(value.ontology, "rules/extra.md", "# extra\n", "feat: add extra")
    rmSync(join(value.ontology, "rules/extra.md"))
    value.git(value.ontology, "add", "-A")
    value.git(value.ontology, "commit", "-qm", "feat: drop extra")
    const snapshotPath = join(value.space, ".wopal-space/space-meta.json")
    const state = JSON.parse(readFileSync(snapshotPath, "utf8"))
    writeFileSync(snapshotPath, JSON.stringify({ ...state, include: ["rule:extra.md"] }, null, 2) + "\n")

    const preMain = value.git(value.ontology, "rev-parse", "main")
    const preSpace = value.git(value.ontology, "rev-parse", "space/demo-space")
    const gitDir = value.git(value.space, "rev-parse", "--absolute-git-dir")
    writeFileSync(join(gitDir, "MERGE_HEAD"), preMain + "\n")

    const partiallyFailingRecoveryGit: GitRunner = (cwd, args) => {
      // Rollback restores preMain/preSpace by SHA after integrateIntoMain already advanced both.
      if (args[0] === "update-ref" && (args[2] === preMain || args[2] === preSpace)) {
        throw new Error("ref lock denied")
      }
      return systemGit(cwd, args)
    }

    const failingService = createSpaceService({
      host: { wopalHome: value.home },
      git: partiallyFailingRecoveryGit,
    })

    let thrown: unknown
    try {
      await failingService.sync("demo-space", { confirm: true })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(SpaceServiceError)
    if (!(thrown instanceof SpaceServiceError)) return
    expect(thrown.code).toBe(spaceErrorCodes.metaGitStateInvalid)
    expect(thrown.message).toContain("Rollback was incomplete")
    expect(thrown.message).toContain("ontology main ref")
    expect(thrown.message).toContain("space branch ref")
    expect(thrown.message).toContain("ref lock denied")
    expect(thrown.suggestion).toBe(
      "Recovery failed; inspect the Space refs, snapshot and sparse range before re-running sync.",
    )
  })
})
