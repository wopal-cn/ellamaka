import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createCompatibilityFixture, type CompatibilityFixture } from "../../fixtures/compatibility/git-space"
import { createSpaceService } from "../../../src/space/service"
import { systemGit } from "../../../src/space/git"
import { SpaceServiceError, spaceErrorCodes } from "../../../src/space/types"
import materializationPatterns from "../../fixtures/compatibility/materialization-patterns.json"

const fixtures: CompatibilityFixture[] = []
const fixture = () => {
  const value = createCompatibilityFixture(join(process.env.TMPDIR ?? "/tmp", "wopalspace-cap-"))
  fixtures.push(value)
  value.applySparse(materializationPatterns)
  return value
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose()
})

const service = (value: CompatibilityFixture) => createSpaceService({ host: { wopalHome: value.home }, git: systemGit })
const snapshot = (value: CompatibilityFixture, path = ".wopal-space/space-meta.json") =>
  JSON.parse(readFileSync(join(value.space, path), "utf8"))

/** Is a path present in a ref? The fixture git helper throws on failure. */
function inRef(value: CompatibilityFixture, ref: string, path: string): boolean {
  try {
    value.git(value.ontology, "cat-file", "-e", ref + ":" + path)
    return true
  } catch {
    return false
  }
}

/** Does a ref carry a path? Unlike inRef this tolerates a missing ref. */
function inTree(value: CompatibilityFixture, ref: string, path: string): boolean {
  return value.git(value.ontology, "ls-tree", "-r", "--name-only", ref).split("\n").includes(path)
}

/** Observable repository state without the loose-object store (failed commits may create blobs). */
function observable(value: CompatibilityFixture) {
  const { objects: _objects, ...rest } = value.snapshot()
  return rest
}

/** Create a complete, untracked skill directly in the Space worktree. */
function createWorktreeSkill(value: CompatibilityFixture, name: string, content = "# " + name + "\n"): string {
  const directory = join(value.worktree, "skills", name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "SKILL.md"), content)
  return directory
}

/** Add a skill to the ontology pool and bring it into the space branch. */
async function withExtraSkill(value: CompatibilityFixture): Promise<void> {
  mkdirSync(join(value.ontology, "skills", "extra"), { recursive: true })
  writeFileSync(join(value.ontology, "skills", "extra", "SKILL.md"), "# extra\n")
  value.git(value.ontology, "add", "-A")
  value.git(value.ontology, "commit", "-qm", "feat: extra skill")
  await service(value).sync("demo-space", { confirm: true })
}

async function errorOf(run: () => Promise<unknown>): Promise<SpaceServiceError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof SpaceServiceError) return error
    throw error
  }
  throw new Error("expected the operation to fail")
}

describe("space capability preview", () => {
  it("previews adding a shared capability with zero writes", async () => {
    const value = fixture()
    await withExtraSkill(value)

    const plan = await service(value).capabilityAdd("demo-space", { references: ["skill:extra"], confirm: false })
    expect(plan.confirm).toBe(false)
    expect(plan.items[0]).toMatchObject({ reference: "skill:extra", capabilityPath: "skills/extra" })
    expect(plan.capabilities.skills).not.toContain("extra")
    expect(existsSync(join(value.worktree, "skills", "extra", "SKILL.md"))).toBe(false)
    expect(readFileSync(join(value.worktree, "assembly", "archetypes", "coding.yaml"), "utf8")).not.toContain("extra")
  })

  it("previews removing a declared capability with zero writes", async () => {
    const value = fixture()
    const manifestBefore = readFileSync(join(value.worktree, "assembly", "archetypes", "coding.yaml"), "utf8")
    const rangeBefore = value.git(value.worktree, "sparse-checkout", "list")

    const plan = await service(value).capabilityRemove("demo-space", { references: ["skill:dev-flow"], confirm: false })
    expect(plan.items[0]?.reference).toBe("skill:dev-flow")
    expect(readFileSync(join(value.worktree, "assembly", "archetypes", "coding.yaml"), "utf8")).toBe(manifestBefore)
    expect(value.git(value.worktree, "sparse-checkout", "list")).toBe(rangeBefore)
    expect(existsSync(join(value.worktree, "skills", "dev-flow", "SKILL.md"))).toBe(true)
  })

  it("previews adopting a new worktree asset with zero writes", async () => {
    const value = fixture()
    createWorktreeSkill(value, "new-skill")
    const before = value.snapshot()

    const plan = await service(value).capabilityAdd("demo-space", {
      references: ["skill:new-skill"],
      local: true,
      confirm: false,
    })

    expect(plan.items[0]).toMatchObject({ reference: "skill:new-skill", selection: "include" })
    expect(plan.syncPending).toBe(true)
    expect(value.snapshot()).toEqual(before)
  })
})

describe("space capability shared channel", () => {
  it("adds a capability to the space manifest and widens the range", async () => {
    const value = fixture()
    await withExtraSkill(value)

    const applied = await service(value).capabilityAdd("demo-space", { references: ["skill:extra"], confirm: true })
    expect(applied.confirm).toBe(true)
    expect(applied.capabilities.skills).toContain("extra")
    expect(readFileSync(join(value.worktree, "assembly", "archetypes", "coding.yaml"), "utf8")).toContain("extra")
    expect(value.git(value.worktree, "sparse-checkout", "list")).toContain("/skills/extra/")
    expect(readFileSync(join(value.worktree, "skills", "extra", "SKILL.md"), "utf8")).toBe("# extra\n")
  })

  it("keeps the shared manifest comment-preserving on removal", async () => {
    const value = fixture()
    const path = join(value.worktree, "assembly", "archetypes", "coding.yaml")
    writeFileSync(path, readFileSync(path, "utf8").replace("skills:", "# keep this comment\nskills:"))

    const applied = await service(value).capabilityRemove("demo-space", {
      references: ["skill:dev-flow"],
      confirm: true,
    })
    expect(applied.capabilities.skills).not.toContain("dev-flow")
    const manifest = readFileSync(path, "utf8")
    expect(manifest).toContain("# keep this comment")
    expect(manifest).not.toContain("dev-flow")
    expect(value.git(value.worktree, "sparse-checkout", "list")).not.toContain("/skills/dev-flow/")
    expect(existsSync(join(value.worktree, "skills", "dev-flow", "SKILL.md"))).toBe(false)
    // The branch tree still carries the asset: removal is a Space decision.
    expect(value.git(value.ontology, "cat-file", "-e", "space/demo-space:skills/dev-flow/SKILL.md")).toBe("")
  })
})

describe("space capability multi-reference requests", () => {
  /** Add two pool skills and materialize them into the space in one sync. */
  async function withTwoSkills(value: CompatibilityFixture): Promise<void> {
    for (const name of ["extra-a", "extra-b"]) {
      mkdirSync(join(value.ontology, "skills", name), { recursive: true })
      writeFileSync(join(value.ontology, "skills", name, "SKILL.md"), "# " + name + "\n")
    }
    value.git(value.ontology, "add", "-A")
    value.git(value.ontology, "commit", "-qm", "feat: extra skills")
    await service(value).sync("demo-space", { confirm: true })
  }

  const manifestOf = (value: CompatibilityFixture) =>
    readFileSync(join(value.worktree, "assembly", "archetypes", "coding.yaml"), "utf8")

  it("previews every reference in one request with zero writes", async () => {
    const value = fixture()
    await withTwoSkills(value)
    const manifestBefore = manifestOf(value)
    const rangeBefore = value.git(value.worktree, "sparse-checkout", "list")

    const plan = await service(value).capabilityAdd("demo-space", {
      references: ["skill:extra-a", "skill:extra-b"],
      confirm: false,
    })
    expect(plan.items.map((item) => item.reference)).toEqual(["skill:extra-a", "skill:extra-b"])
    expect(manifestOf(value)).toBe(manifestBefore)
    expect(value.git(value.worktree, "sparse-checkout", "list")).toBe(rangeBefore)
    expect(existsSync(join(value.worktree, "skills", "extra-a", "SKILL.md"))).toBe(false)
  })

  it("persists every added shared reference instead of only the first", async () => {
    const value = fixture()
    await withTwoSkills(value)

    const applied = await service(value).capabilityAdd("demo-space", {
      references: ["skill:extra-a", "skill:extra-b"],
      confirm: true,
    })

    // Returned items, manifest, sparse range, capabilities and disk must agree on the full request.
    expect(applied.items.map((item) => item.reference)).toEqual(["skill:extra-a", "skill:extra-b"])
    const manifest = manifestOf(value)
    expect(manifest).toContain("extra-a")
    expect(manifest).toContain("extra-b")
    expect(applied.capabilities.skills).toEqual(expect.arrayContaining(["extra-a", "extra-b"]))
    const range = value.git(value.worktree, "sparse-checkout", "list")
    expect(range).toContain("/skills/extra-a/")
    expect(range).toContain("/skills/extra-b/")
    expect(readFileSync(join(value.worktree, "skills", "extra-a", "SKILL.md"), "utf8")).toBe("# extra-a\n")
    expect(readFileSync(join(value.worktree, "skills", "extra-b", "SKILL.md"), "utf8")).toBe("# extra-b\n")
  })

  it("removes every declared shared reference in one request", async () => {
    const value = fixture()
    await withTwoSkills(value)
    await service(value).capabilityAdd("demo-space", {
      references: ["skill:extra-a", "skill:extra-b"],
      confirm: true,
    })

    const removed = await service(value).capabilityRemove("demo-space", {
      references: ["skill:extra-a", "skill:extra-b"],
      confirm: true,
    })
    const manifest = manifestOf(value)
    expect(manifest).not.toContain("extra-a")
    expect(manifest).not.toContain("extra-b")
    expect(removed.capabilities.skills).not.toContain("extra-a")
    expect(removed.capabilities.skills).not.toContain("extra-b")
    const range = value.git(value.worktree, "sparse-checkout", "list")
    expect(range).not.toContain("/skills/extra-a/")
    expect(range).not.toContain("/skills/extra-b/")
  })

  it("applies a mixed capability-kind request to the same manifest", async () => {
    const value = fixture()

    const removed = await service(value).capabilityRemove("demo-space", {
      references: ["plugin:wopal-plugin", "skill:dev-flow"],
      confirm: true,
    })
    const manifest = manifestOf(value)
    expect(manifest).not.toContain("wopal-plugin")
    expect(manifest).not.toContain("dev-flow")
    expect(removed.capabilities.plugins).not.toContain("wopal-plugin")
    expect(removed.capabilities.skills).not.toContain("dev-flow")
  })
})

describe("space capability local channel", () => {
  it("shadows a declared capability into exclude and commits only the snapshot", async () => {
    const value = fixture()
    const branchHead = value.git(value.ontology, "rev-parse", "space/demo-space")
    const applied = await service(value).capabilityRemove("demo-space", {
      references: ["skill:dev-flow"],
      local: true,
      confirm: true,
    })

    expect(applied.local).toBe(true)
    expect(applied.items[0]?.selection).toBe("exclude")
    expect(snapshot(value).exclude).toEqual(["skill:dev-flow"])
    expect(value.git(value.worktree, "sparse-checkout", "list")).not.toContain("/skills/dev-flow/")
    // No content commit: the branch is where it was and the tree still has the file.
    expect(value.git(value.ontology, "rev-parse", "space/demo-space")).toBe(branchHead)
    expect(value.git(value.ontology, "cat-file", "-e", "space/demo-space:skills/dev-flow/SKILL.md")).toBe("")
    // The state commit touched only the snapshot.
    expect(value.git(value.space, "show", "--name-only", "--format=", "HEAD")).toBe(".wopal-space/space-meta.json")
    expect(readFileSync(join(value.worktree, "assembly", "archetypes", "coding.yaml"), "utf8")).toContain("dev-flow")
  })

  it("recovers a shadowed capability by clearing the exclude", async () => {
    const value = fixture()
    const space = service(value)
    await space.capabilityRemove("demo-space", { references: ["skill:dev-flow"], local: true, confirm: true })
    expect(snapshot(value).exclude).toEqual(["skill:dev-flow"])

    const recovered = await space.capabilityAdd("demo-space", {
      references: ["skill:dev-flow"],
      local: true,
      confirm: true,
    })
    expect(recovered.items[0]?.selection).toBe("none")
    expect(snapshot(value).exclude).toEqual([])
    expect(value.git(value.worktree, "sparse-checkout", "list")).toContain("/skills/dev-flow/")
  })
})

describe("space capability adoption of a new worktree asset", () => {
  it("adopts a new skill into the space branch and records include locally", async () => {
    const value = fixture()
    createWorktreeSkill(value, "new-skill")
    const beforeBranch = value.git(value.ontology, "rev-parse", "space/demo-space")
    const beforeMeta = readFileSync(join(value.space, ".wopal-space/space-meta.json"), "utf8")

    const applied = await service(value).capabilityAdd("demo-space", {
      references: ["skill:new-skill"],
      local: true,
      confirm: true,
    })

    expect(applied.items[0]).toMatchObject({ reference: "skill:new-skill", selection: "include" })
    expect(applied.syncPending).toBe(true)
    expect(applied.ontologyCommit).toBe(value.git(value.ontology, "rev-parse", "space/demo-space"))
    expect(applied.ontologyCommit).not.toBe(beforeBranch)
    expect(applied.stateCommit).toBeDefined()

    // Content entered the space branch as shared content.
    expect(value.git(value.ontology, "show", "space/demo-space:skills/new-skill/SKILL.md")).toBe("# new-skill")
    // This space mounts it through include; the third selection set is gone.
    const state = snapshot(value)
    expect(state.version).toBe(3)
    expect(state.include).toEqual(["skill:new-skill"])
    expect(state).not.toHaveProperty("private")
    expect(state.exclude).toEqual([])
    // Sparse range still materializes the file after the recompute.
    expect(value.git(value.worktree, "sparse-checkout", "list")).toContain("/skills/new-skill/")
    expect(readFileSync(join(value.worktree, "skills", "new-skill", "SKILL.md"), "utf8")).toBe("# new-skill\n")
    // The state commit is confined to the snapshot; the asset commit confined to the asset.
    expect(value.git(value.space, "show", "--name-only", "--format=", "HEAD")).toBe(".wopal-space/space-meta.json")
    expect(value.git(value.ontology, "show", "--name-only", "--format=", "space/demo-space")).toBe(
      "skills/new-skill/SKILL.md",
    )
    expect(value.git(value.worktree, "status", "--porcelain")).toBe("")
    expect(beforeMeta).not.toBe(readFileSync(join(value.space, ".wopal-space/space-meta.json"), "utf8"))
  })

  it("adopts a new skill and its archetype entry in one branch commit", async () => {
    const value = fixture()
    createWorktreeSkill(value, "default-skill")
    const beforeBranch = value.git(value.ontology, "rev-parse", "space/demo-space")
    const beforeMeta = readFileSync(join(value.space, ".wopal-space/space-meta.json"), "utf8")

    const applied = await service(value).capabilityAdd("demo-space", {
      references: ["skill:default-skill"],
      confirm: true,
    })

    expect(applied.items[0]).toMatchObject({ reference: "skill:default-skill", selection: "none" })
    expect(applied.capabilities.skills).toContain("default-skill")
    expect(applied.ontologyCommit).toBe(value.git(value.ontology, "rev-parse", "space/demo-space"))
    expect(applied.ontologyCommit).not.toBe(beforeBranch)
    expect(applied.stateCommit).toBeUndefined()
    expect(value.git(value.ontology, "show", "space/demo-space:skills/default-skill/SKILL.md")).toBe("# default-skill")
    expect(value.git(value.ontology, "show", "space/demo-space:assembly/archetypes/coding.yaml")).toContain(
      "default-skill",
    )
    const touched = value.git(value.ontology, "show", "--name-only", "--format=", "space/demo-space").split("\n")
    expect(touched).toEqual(["assembly/archetypes/coding.yaml", "skills/default-skill/SKILL.md"])
    // No Space-root state write happened for a type default.
    expect(readFileSync(join(value.space, ".wopal-space/space-meta.json"), "utf8")).toBe(beforeMeta)
    expect(value.git(value.worktree, "status", "--porcelain")).toBe("")
  })

  it("adopts an already adopted asset without duplicating the content commit", async () => {
    const value = fixture()
    createWorktreeSkill(value, "new-skill")
    const space = service(value)
    await space.capabilityAdd("demo-space", { references: ["skill:new-skill"], local: true, confirm: true })
    const branch = value.git(value.ontology, "rev-parse", "space/demo-space")

    const again = await space.capabilityAdd("demo-space", {
      references: ["skill:new-skill"],
      local: true,
      confirm: true,
    })
    expect(again.items[0]?.selection).toBe("none")
    expect(again.ontologyCommit).toBeUndefined()
    expect(value.git(value.ontology, "rev-parse", "space/demo-space")).toBe(branch)
  })

  it("keeps later capability operations working before the adopted content is synced", async () => {
    const value = fixture()
    createWorktreeSkill(value, "new-skill")
    const space = service(value)
    await space.capabilityAdd("demo-space", { references: ["skill:new-skill"], confirm: true })

    // The worktree manifest declares an asset only the Space branch carries;
    // the next range computation must still resolve it.
    const removed = await space.capabilityRemove("demo-space", {
      references: ["skill:dev-flow"],
      local: true,
      confirm: true,
    })
    expect(removed.items[0]?.selection).toBe("exclude")
    expect(value.git(value.worktree, "sparse-checkout", "list")).not.toContain("/skills/dev-flow/")
    expect(value.git(value.worktree, "sparse-checkout", "list")).toContain("/skills/new-skill/")
  })

  it("restores a shadowed asset that only the Space branch carries, without a sync", async () => {
    const value = fixture()
    createWorktreeSkill(value, "branch-only-skill")
    const space = service(value)

    // Adopt as a type default first: the content is committed on the Space
    // branch, but local main still has no such asset.
    await space.capabilityAdd("demo-space", { references: ["skill:branch-only-skill"], confirm: true })
    expect(inTree(value, "main", "skills/branch-only-skill/SKILL.md")).toBe(false)

    // Shadow it locally: the sparse range drops the asset from disk, so the
    // only remaining copy is the Space branch tree.
    const shadowed = await space.capabilityRemove("demo-space", {
      references: ["skill:branch-only-skill"],
      local: true,
      confirm: true,
    })
    expect(shadowed.items[0]?.selection).toBe("exclude")
    expect(existsSync(join(value.worktree, "skills", "branch-only-skill"))).toBe(false)
    expect(inRef(value, "space/demo-space", "skills/branch-only-skill/SKILL.md")).toBe(true)

    // Restoring must resolve through the Space branch, not force a sync.
    const restored = await space.capabilityAdd("demo-space", {
      references: ["skill:branch-only-skill"],
      local: true,
      confirm: true,
    })
    expect(restored.items[0]?.selection).toBe("none")
    expect(restored.ontologyCommit).toBeUndefined()
    expect(snapshot(value).exclude).toEqual([])
    expect(value.git(value.worktree, "sparse-checkout", "list")).toContain("/skills/branch-only-skill/")
    expect(readFileSync(join(value.worktree, "skills", "branch-only-skill", "SKILL.md"), "utf8")).toBe(
      "# branch-only-skill\n",
    )
    // The branch content was never rewritten and local main never learned it.
    expect(inTree(value, "main", "skills/branch-only-skill/SKILL.md")).toBe(false)
  })

  it("keeps unrelated capability requests working while a branch-only exclude is pending", async () => {
    const value = fixture()
    createWorktreeSkill(value, "stuck-skill")
    const space = service(value)
    await space.capabilityAdd("demo-space", { references: ["skill:stuck-skill"], confirm: true })
    await space.capabilityRemove("demo-space", { references: ["skill:stuck-skill"], local: true, confirm: true })

    // A stale exclude must not poison every later request.
    const other = await space.capabilityRemove("demo-space", {
      references: ["skill:dev-flow"],
      local: true,
      confirm: true,
    })
    expect(other.items[0]).toMatchObject({ reference: "skill:dev-flow", selection: "exclude" })
  })

  it("refuses an incomplete new asset without writing anything", async () => {
    const value = fixture()
    mkdirSync(join(value.worktree, "skills", "partial"), { recursive: true })
    writeFileSync(join(value.worktree, "skills", "partial", "notes.txt"), "not a skill\n")
    const before = value.snapshot()

    const error = await errorOf(() =>
      service(value).capabilityAdd("demo-space", { references: ["skill:partial"], local: true, confirm: true }),
    )
    expect(error.code).toBe(spaceErrorCodes.capabilityUnresolved)
    expect(error.message).toContain("not a complete skills asset")
    expect(value.snapshot()).toEqual(before)
  })

  it("refuses a new asset whose ignored files would not enter Git", async () => {
    const value = fixture()
    createWorktreeSkill(value, "with-secret")
    writeFileSync(join(value.worktree, "skills", "with-secret", ".env"), "SECRET=1\n")
    const before = value.snapshot()

    const error = await errorOf(() =>
      service(value).capabilityAdd("demo-space", {
        references: ["skill:with-secret"],
        local: true,
        confirm: true,
      }),
    )
    expect(error.code).toBe(spaceErrorCodes.capabilityUnresolved)
    expect(error.message).toContain(".env")
    expect(value.snapshot()).toEqual(before)
  })

  it("refuses a single-file new asset shaped like a credential", async () => {
    const value = fixture()
    mkdirSync(join(value.worktree, "rules"), { recursive: true })
    writeFileSync(join(value.worktree, "rules", "deploy.pem"), "KEY\n")
    const before = value.snapshot()

    const error = await errorOf(() =>
      service(value).capabilityAdd("demo-space", { references: ["rule:deploy.pem"], local: true, confirm: true }),
    )
    expect(error.code).toBe(spaceErrorCodes.capabilityUnresolved)
    expect(error.message).toContain("credential file")
    expect(value.snapshot()).toEqual(before)
  })

  it("refuses a new asset that contains a symbolic link", async () => {
    const value = fixture()
    const directory = createWorktreeSkill(value, "linked")
    symlinkSync(join(value.worktree, "skills", "dev-flow", "SKILL.md"), join(directory, "escaped.md"))

    const error = await errorOf(() =>
      service(value).capabilityAdd("demo-space", { references: ["skill:linked"], local: true, confirm: true }),
    )
    expect(error.code).toBe(spaceErrorCodes.capabilityUnresolved)
    expect(error.message).toContain("symbolic link")
    expect(value.git(value.worktree, "status", "--porcelain")).toBe("?? skills/linked/")
  })

  it("keeps unrelated dirty and staged work out of the adoption commit", async () => {
    const value = fixture()
    createWorktreeSkill(value, "new-skill")
    writeFileSync(join(value.worktree, "config", "note.md"), "# dirty\n")
    mkdirSync(join(value.worktree, "docs"), { recursive: true })
    writeFileSync(join(value.worktree, "docs", "staged.md"), "# staged\n")
    value.git(value.worktree, "add", "--", "docs/staged.md")

    await service(value).capabilityAdd("demo-space", {
      references: ["skill:new-skill"],
      local: true,
      confirm: true,
    })

    const status = value.git(value.worktree, "status", "--porcelain").split("\n")
    expect(status).toContain("?? config/note.md")
    expect(status).toContain("A  docs/staged.md")
    expect(value.git(value.ontology, "show", "--name-only", "--format=", "space/demo-space")).toBe(
      "skills/new-skill/SKILL.md",
    )
  })

  it("removes an include without deleting the adopted shared content", async () => {
    const value = fixture()
    createWorktreeSkill(value, "new-skill")
    const space = service(value)
    await space.capabilityAdd("demo-space", { references: ["skill:new-skill"], local: true, confirm: true })
    expect(snapshot(value).include).toEqual(["skill:new-skill"])

    const removed = await space.capabilityRemove("demo-space", {
      references: ["skill:new-skill"],
      local: true,
      confirm: true,
    })
    expect(removed.items[0]?.selection).toBe("none")
    expect(snapshot(value).include).toEqual([])
    expect(value.git(value.ontology, "show", "space/demo-space:skills/new-skill/SKILL.md")).toBe("# new-skill")
    expect(existsSync(join(value.worktree, "skills", "new-skill", "SKILL.md"))).toBe(false)
  })
})

describe("space capability partial commit and retry", () => {
  it("reports the completed content commit when the Space state commit fails, then resumes on retry", async () => {
    const value = fixture()
    createWorktreeSkill(value, "new-skill")
    const space = service(value)
    const gitDir = value.git(value.space, "rev-parse", "--absolute-git-dir")
    writeFileSync(join(gitDir, "MERGE_HEAD"), value.git(value.ontology, "rev-parse", "main") + "\n")
    const beforeMeta = readFileSync(join(value.space, ".wopal-space/space-meta.json"), "utf8")

    const error = await errorOf(() =>
      space.capabilityAdd("demo-space", { references: ["skill:new-skill"], local: true, confirm: true }),
    )
    expect(error.code).toBe(spaceErrorCodes.capabilityPartialCommit)
    const contentCommit = value.git(value.ontology, "rev-parse", "space/demo-space")
    expect(error.message).toContain(contentCommit)
    expect(error.suggestion).toContain("space sync")
    // The content commit is real and durable; the snapshot was not rewritten.
    expect(value.git(value.ontology, "show", contentCommit + ":skills/new-skill/SKILL.md")).toBe("# new-skill")
    expect(value.git(value.ontology, "rev-parse", "main")).toBe(value.git(value.ontology, "rev-parse", "origin/main"))
    expect(readFileSync(join(value.space, ".wopal-space/space-meta.json"), "utf8")).toBe(beforeMeta)

    // Remove the blocker and retry: only the remaining state commit happens.
    rmSync(join(gitDir, "MERGE_HEAD"))
    const retried = await space.capabilityAdd("demo-space", {
      references: ["skill:new-skill"],
      local: true,
      confirm: true,
    })
    expect(retried.ontologyCommit).toBeUndefined()
    expect(retried.stateCommit).toBeDefined()
    expect(snapshot(value).include).toEqual(["skill:new-skill"])
    expect(value.git(value.ontology, "rev-parse", "space/demo-space")).toBe(contentCommit)
    expect(value.git(value.worktree, "status", "--porcelain")).toBe("")
  })
})

describe("space capability pre-commit failures", () => {
  it("rolls the worktree back when the ontology content commit itself fails", async () => {
    const value = fixture()
    createWorktreeSkill(value, "new-skill")
    const hook = join(value.ontology, ".git", "hooks", "pre-commit")
    mkdirSync(join(value.ontology, ".git", "hooks"), { recursive: true })
    writeFileSync(hook, "#!/bin/sh\nexit 1\n")
    chmodSync(hook, 0o755)
    const before = observable(value)

    const error = await errorOf(() =>
      service(value).capabilityAdd("demo-space", { references: ["skill:new-skill"], local: true, confirm: true }),
    )
    expect(error.code).toBe(spaceErrorCodes.capabilityFailed)
    expect(error.message).toContain("Failed to commit the adopted capability content")

    // Nothing was kept: no commit, no staged index entry, unchanged snapshot and range.
    expect(observable(value)).toEqual(before)
    expect(value.git(value.worktree, "status", "--porcelain")).toBe("?? skills/new-skill/")
    expect(value.git(value.worktree, "sparse-checkout", "list")).not.toContain("/skills/new-skill/")
    rmSync(hook, { force: true })
  })

  it("reports a partial commit when a step after the content commit fails", async () => {
    const value = fixture()
    const plugin = join(value.worktree, "plugins", "new-plugin")
    mkdirSync(plugin, { recursive: true })
    writeFileSync(join(plugin, "package.json"), '{"name":"new-plugin"}\n')
    const configDir = join(value.worktree, "config")
    chmodSync(configDir, 0o555)

    const error = await errorOf(() =>
      service(value).capabilityAdd("demo-space", { references: ["plugin:new-plugin"], confirm: true }),
    )
    chmodSync(configDir, 0o755)

    expect(error.code).toBe(spaceErrorCodes.capabilityPartialCommit)
    const contentCommit = value.git(value.ontology, "rev-parse", "space/demo-space")
    expect(error.message).toContain(contentCommit)
    // The content and its archetype entry are already durable branch facts.
    expect(value.git(value.ontology, "show", contentCommit + ":plugins/new-plugin/package.json")).toContain(
      "new-plugin",
    )
    expect(value.git(value.ontology, "show", contentCommit + ":assembly/archetypes/coding.yaml")).toContain(
      "new-plugin",
    )
  })
})

describe("space capability legacy snapshot handling", () => {
  const legacySnapshot = (value: CompatibilityFixture, privateRefs: readonly string[]): string => {
    const path = join(value.space, ".wopal-space", "space-meta.json")
    const raw =
      JSON.stringify(
        {
          version: 2,
          type: "coding",
          schema: "coding-space-schema.yaml",
          source: { ontology: "test-onto" },
          include: [],
          exclude: [],
          private: privateRefs,
        },
        null,
        2,
      ) + "\n"
    writeFileSync(path, raw)
    return path
  }

  it("reads a version 2 snapshot with an empty private set without writing, then upgrades on the first write", async () => {
    const value = fixture()
    const path = legacySnapshot(value, [])
    const before = value.snapshot()
    const status = await service(value).status("demo-space")
    expect(status.selection).toEqual({ include: [], exclude: [] })
    expect(status.assembly.legacy).toEqual({ version: 2, privateCount: 0, writable: true })
    expect(value.snapshot()).toEqual(before)

    await service(value).capabilityRemove("demo-space", {
      references: ["skill:dev-flow"],
      local: true,
      confirm: true,
    })
    const upgraded = JSON.parse(readFileSync(path, "utf8"))
    expect(upgraded.version).toBe(3)
    expect(upgraded).not.toHaveProperty("private")
    expect(upgraded.type).toBe("coding")
    expect(upgraded.schema).toBe("coding-space-schema.yaml")
    expect(upgraded.source).toEqual({ ontology: "test-onto" })
    expect(upgraded.exclude).toEqual(["skill:dev-flow"])
  })

  it("refuses every write while a version 2 snapshot still holds private selections", async () => {
    const value = fixture()
    const path = legacySnapshot(value, ["rule:private-rule.md"])
    // The old hold refers to content that never entered shared Git.
    writeFileSync(join(value.worktree, "rules", "private-rule.md"), "# private\n")
    const before = value.snapshot()
    const metaBefore = readFileSync(path, "utf8")

    for (const run of [
      () => service(value).capabilityAdd("demo-space", { references: ["skill:dev-flow"], local: true, confirm: true }),
      () => service(value).capabilityAdd("demo-space", { references: ["skill:dev-flow"], local: true, confirm: false }),
      () =>
        service(value).capabilityRemove("demo-space", { references: ["skill:dev-flow"], local: true, confirm: true }),
      () => service(value).sync("demo-space", { confirm: false }),
      () => service(value).sync("demo-space", { confirm: true }),
      () => service(value).init({ name: "demo-space", root: value.space }),
    ]) {
      const error = await errorOf(run)
      expect(error.code).toBe(spaceErrorCodes.metaLegacyPrivate)
      expect(error.message).toContain("rule:private-rule.md")
      expect(error.message).toContain("rules/private-rule.md")
      expect(error.suggestion).toContain("Back up")
    }

    // Status is read-only: it reports the hold without exposing its refs.
    const status = await service(value).status("demo-space")
    expect(status.selection).toEqual({ include: [], exclude: [] })
    expect(status.assembly.legacy).toEqual({ version: 2, privateCount: 1, writable: false })

    // Nothing moved: snapshot bytes, refs, index, sparse range and files.
    expect(readFileSync(path, "utf8")).toBe(metaBefore)
    expect(value.snapshot()).toEqual(before)
    expect(readFileSync(join(value.worktree, "rules", "private-rule.md"), "utf8")).toBe("# private\n")
  })

  it("never lets retired private content reach local main once the old hold is cleared", async () => {
    const value = fixture()
    const path = legacySnapshot(value, ["rule:private-rule.md"])
    value.commit(value.worktree, "rules/private-rule.md", "# private\n", "feat: private leak")
    const mainBefore = value.git(value.ontology, "rev-parse", "main")

    // While the hold exists, sync is refused outright.
    const error = await errorOf(() => service(value).sync("demo-space", { confirm: true }))
    expect(error.code).toBe(spaceErrorCodes.metaLegacyPrivate)
    expect(value.git(value.ontology, "rev-parse", "main")).toBe(mainBefore)

    // Clearing the hold by hand converts the snapshot on the next authorized write.
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), private: [] }, null, 2) + "\n")
    await service(value).capabilityRemove("demo-space", {
      references: ["skill:dev-flow"],
      local: true,
      confirm: true,
    })
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(3)
  })
})

describe("space capability plugin sections", () => {
  it("writes a sectioned plugin reference into the local settings file", async () => {
    const value = fixture()
    const applied = await service(value).capabilityRemove("demo-space", {
      references: ["plugin:wopal-plugin"],
      section: "ellamaka",
      confirm: true,
    })
    expect(applied.capabilities.plugins).not.toContain("wopal-plugin")

    const added = await service(value).capabilityAdd("demo-space", {
      references: ["plugin:wopal-plugin"],
      section: "tui",
      confirm: true,
    })
    expect(added.capabilities.plugins).toContain("wopal-plugin")
    const manifest = readFileSync(join(value.worktree, "assembly", "archetypes", "coding.yaml"), "utf8")
    expect(manifest).toContain("tui:")
  })

  it("rejects a section on a non-plugin reference", async () => {
    const value = fixture()
    await expect(
      service(value).capabilityAdd("demo-space", { references: ["skill:dev-flow"], section: "tui", confirm: false }),
    ).rejects.toThrow(/section only applies to plugin/)
  })

  it("rejects a plugin already assembled under another section", async () => {
    const value = fixture()
    await expect(
      service(value).capabilityAdd("demo-space", {
        references: ["plugin:wopal-plugin"],
        section: "tui",
        confirm: false,
      }),
    ).rejects.toThrow(/already assembled to type/)
  })
})

describe("space capability adoption then sync", () => {
  it("publishes adopted content to local main through an explicit sync", async () => {
    const value = fixture()
    createWorktreeSkill(value, "synced-skill")
    const space = service(value)
    const applied = await space.capabilityAdd("demo-space", {
      references: ["skill:synced-skill"],
      local: true,
      confirm: true,
    })
    expect(applied.syncPending).toBe(true)
    expect(inRef(value, "main", "skills/synced-skill/SKILL.md")).toBe(false)

    const synced = await space.sync("demo-space", { confirm: true })
    expect(synced.confirm).toBe(true)
    expect(value.git(value.ontology, "show", "main:skills/synced-skill/SKILL.md")).toBe("# synced-skill")
    expect(snapshot(value).include).toEqual(["skill:synced-skill"])
    expect(value.git(value.worktree, "status", "--porcelain")).toBe("")
  })
})
