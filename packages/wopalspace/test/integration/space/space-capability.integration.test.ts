import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createCompatibilityFixture, type CompatibilityFixture } from "../../fixtures/compatibility/git-space"
import { createSpaceService } from "../../../src/space/service"
import { systemGit } from "../../../src/space/git"
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

/** Add a skill to the ontology pool and bring it into the space branch. */
async function withExtraSkill(value: CompatibilityFixture): Promise<void> {
  mkdirSync(join(value.ontology, "skills", "extra"), { recursive: true })
  writeFileSync(join(value.ontology, "skills", "extra", "SKILL.md"), "# extra\n")
  value.git(value.ontology, "add", "-A")
  value.git(value.ontology, "commit", "-qm", "feat: extra skill")
  await service(value).sync("demo-space", { confirm: true })
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

  it("registers a disk-only capability as private", async () => {
    const value = fixture()
    mkdirSync(join(value.worktree, "skills", "local-only"), { recursive: true })
    writeFileSync(join(value.worktree, "skills", "local-only", "SKILL.md"), "# local\n")
    mkdirSync(join(value.ontology, "skills", "local-only"), { recursive: true })
    writeFileSync(join(value.ontology, "skills", "local-only", "SKILL.md"), "# pool\n")
    value.git(value.ontology, "add", "-A")
    value.git(value.ontology, "commit", "-qm", "feat: pool skill")

    const applied = await service(value).capabilityAdd("demo-space", {
      references: ["skill:local-only"],
      local: true,
      confirm: true,
    })
    expect(applied.items[0]?.selection).toBe("private")
    expect(snapshot(value).private).toEqual(["skill:local-only"])
    expect(value.git(value.worktree, "sparse-checkout", "list")).toContain("/skills/local-only/")
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
