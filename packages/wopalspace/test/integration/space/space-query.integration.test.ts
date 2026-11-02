import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createCompatibilityFixture, type CompatibilityFixture } from "../../fixtures/compatibility/git-space"
import { systemGit } from "../../../src/space/git"
import { isPathWithin, normalizeRelativePath } from "../../../src/space/confinement"
import { listSpaceFiles, readSpaceFile } from "../../../src/space/files"
import { listSpaces, resolveSpace, spaceByName } from "../../../src/space/lookup"
import { parseWorktreePorcelain, listSpaceProjects } from "../../../src/space/projects"
import { scanSpace } from "../../../src/space/scan"
import { searchSpace } from "../../../src/space/search"
import { readSpaceStatus } from "../../../src/space/status"
import { materializationPatterns, readArchetype } from "../../../src/space/assembly"
import { createSpaceService } from "../../../src/space/service"
import expectedPatterns from "../../fixtures/compatibility/materialization-patterns.json"

const fixtures: CompatibilityFixture[] = []
const fixture = (mode: "clone" | "fork" = "clone") => {
  const value = createCompatibilityFixture(join(process.env.TMPDIR ?? "/tmp", "wopalspace-space-batch1-"), mode)
  fixtures.push(value)
  return value
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose()
})

/** Every byte and Git-visible fact a passive query could disturb. */
function observe(value: CompatibilityFixture) {
  const spaceStatus = value.git(value.space, "status", "--porcelain=v1")
  const tree = value.git(value.worktree, "rev-parse", "space/demo-space")
  return {
    snapshot: value.snapshot(),
    spaceStatus,
    tree,
  }
}

describe("space passive queries over the compatibility fixture", () => {
  it("lists selectable space types from the registered Ontology", () => {
    const value = fixture()
    const service = createSpaceService({ host: { wopalHome: value.home }, git: systemGit })
    expect(service.availableTypes()).toEqual([{ type: "coding", description: "Mock engineering workspace" }])
  })

  it("refuses a registered Ontology path that escapes WOPAL_HOME", () => {
    const value = fixture()
    const outside = join(value.root, "outside-ontology")
    mkdirSync(join(outside, "assembly", "archetypes"), { recursive: true })
    writeFileSync(
      join(outside, "assembly", "archetypes", "outside.yaml"),
      "version: 1\ntype: outside\ndescription: must not be readable\n",
    )
    const settingsPath = join(value.home, "config", "settings.jsonc")
    const settings = readFileSync(settingsPath, "utf8")
    writeFileSync(settingsPath, settings.replace(JSON.stringify(value.ontology), JSON.stringify(outside)))

    const service = createSpaceService({ host: { wopalHome: value.home }, git: systemGit })
    expect(() => service.availableTypes()).toThrow(/Ontology path.*WOPAL_HOME/)
  })

  it("lists registered spaces with registry identity and diagnostic facts", () => {
    const value = fixture()
    const result = listSpaces(value.home, systemGit)
    expect(result.total).toBe(1)
    const item = result.items[0]
    expect(item?.name).toBe("demo-space")
    expect(item?.displayName).toBe("demo-space")
    expect(item?.path).toBe(value.space)
    expect(item?.type).toBe("coding")
    expect(item?.facts.present).toBe(true)
    expect(item?.facts.snapshot).toBe("ok")
    expect(item?.facts.worktree).toBe(true)
    expect(item?.facts.mismatch).toEqual([])
  })

  it("reports a disk mismatch as a diagnostic without repairing it", () => {
    const value = fixture()
    const before = observe(value)
    value.git(value.worktree, "checkout", "--detach")
    const detached = observe(value)
    const broken = listSpaces(value.home, systemGit)
    expect(broken.items[0]?.facts.mismatch).toContain("worktree-not-attached")
    // Only the deliberate detach moved a ref; the query changed nothing else.
    expect(observe(value).spaceStatus).toBe(detached.spaceStatus)
    expect(observe(value).snapshot.registry).toBe(before.snapshot.registry)
    expect(observe(value).snapshot.meta).toBe(before.snapshot.meta)
    expect(readFileSync(join(value.space, ".wopal-space/space-meta.json"), "utf8")).toBe(before.snapshot.meta)
  })

  it("resolves by stable name and by trusted directory, leaving unknowns unregistered", () => {
    const value = fixture()
    expect(resolveSpace(value.home, { name: "demo-space" }).name).toBe("demo-space")
    expect(resolveSpace(value.home, { directory: join(value.space, "projects") }).name).toBe("demo-space")
    expect(() => resolveSpace(value.home, { name: "constructor" })).toThrow(/not registered/)
    expect(() => resolveSpace(value.home, { directory: "/tmp" })).toThrow(/No registered Space/)
    expect(listSpaces(value.home, systemGit).total).toBe(1)
  })

  it("writes nothing while listing, searching, scanning and reading status", () => {
    const value = fixture()
    const space = spaceByName(value.home, "demo-space")
    mkdirSync(join(value.space, "projects", "app"), { recursive: true })
    writeFileSync(join(value.space, "projects", "app", "README.md"), "# App\n")
    value.git(join(value.space, "projects", "app"), "init", "-q", "-b", "main")

    const before = observe(value)
    listSpaces(value.home, systemGit)
    listSpaceProjects(value.space, systemGit)
    listSpaceFiles(value.space)
    readSpaceFile(value.space, "projects/app/README.md")
    searchSpace(value.space, { type: "repo" })
    scanSpace(value.space, space.name, systemGit)
    try {
      readSpaceStatus({ space, ontologyPath: value.ontology, ontologyMode: "clone" }, systemGit)
    } catch (error) {
      // Snapshot parsing happens below; a refusal must also leave state intact.
      expect(error).toBeDefined()
    }
    const after = observe(value)
    expect(after.snapshot.refs).toBe(before.snapshot.refs)
    expect(after.snapshot.spaceStatus).toBe(before.snapshot.spaceStatus)
    expect(after.snapshot.index).toBe(before.snapshot.index)
    expect(after.snapshot.meta).toBe(before.snapshot.meta)
    expect(after.snapshot.registry).toBe(before.snapshot.registry)
    expect(after.snapshot.objects).toEqual(before.snapshot.objects)
    expect(after.snapshot.files).toEqual(before.snapshot.files)
    expect(after.snapshot.fetchHead).toBe(before.snapshot.fetchHead)
  })

  it("lists projects under projects/ with linked worktrees and ignores other roots", () => {
    const value = fixture()
    const app = join(value.space, "projects", "app")
    mkdirSync(app, { recursive: true })
    value.git(app, "init", "-q", "-b", "main")
    value.write(app, "README.md", "# app\n")
    value.git(app, "add", ".")
    value.git(app, "commit", "-qm", "init")
    const lab = join(value.space, "labs", "lab")
    mkdirSync(lab, { recursive: true })
    value.git(lab, "init", "-q", "-b", "main")
    mkdirSync(join(value.space, ".worktrees"), { recursive: true })
    value.git(app, "worktree", "add", join(value.space, ".worktrees", "app-wt"), "-b", "wt-branch")

    const result = listSpaceProjects(value.space, systemGit)
    expect(result.items.map((project) => project.path)).toEqual(["projects/app"])
    expect(result.items[0]?.worktrees).toHaveLength(1)
    expect(result.items[0]?.worktrees[0]?.path).toBe(".worktrees/app-wt")
    expect(result.items[0]?.worktrees[0]?.branch).toBe("wt-branch")
  })

  it("parses worktree porcelain output including detached and branch entries", () => {
    const parsed = parseWorktreePorcelain(
      ["worktree /a", "HEAD abc", "branch refs/heads/main", "", "worktree /b", "HEAD def", "detached", ""].join("\n"),
    )
    expect(parsed).toEqual([{ path: "/a", branch: "main" }, { path: "/b" }])
  })

  it("lists and reads files inside the registered root", () => {
    const value = fixture()
    mkdirSync(join(value.space, "docs"), { recursive: true })
    writeFileSync(join(value.space, "docs", "guide.md"), "# Guide\n")
    const listing = listSpaceFiles(value.space, "docs")
    expect(listing.items.map((item) => item.name)).toEqual(["guide.md"])
    expect(listing.items[0]?.path).toBe("docs/guide.md")
    expect(readSpaceFile(value.space, "docs/guide.md")).toEqual({ type: "text", content: "# Guide\n" })
  })

  it("refuses traversal, absolute paths and symlink escapes", () => {
    const value = fixture()
    const outside = join(value.root, "outside")
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, "secret.txt"), "secret")
    symlinkSync(outside, join(value.space, "linked"))

    expect(() => listSpaceFiles(value.space, "../outside")).toThrow(/relative/i)
    expect(() => listSpaceFiles(value.space, "/etc")).toThrow(/relative/i)
    expect(() => readSpaceFile(value.space, "linked/secret.txt")).toThrow(/escapes/i)
    const listing = listSpaceFiles(value.space)
    expect(listing.items.map((item) => item.name)).not.toContain("linked")
    expect(isPathWithin(value.space, outside)).toBe(false)
    expect(() => normalizeRelativePath("a/../../b")).toThrow(/parent traversal/)
  })

  it("searches and scans repositories, worktrees and module AGENTS files", () => {
    const value = fixture()
    const app = join(value.space, "projects", "App")
    mkdirSync(app, { recursive: true })
    value.git(app, "init", "-q", "-b", "main")
    writeFileSync(join(app, "AGENTS.md"), "---\ndescription: Demo app rules\n---\n")
    writeFileSync(join(app, "index.ts"), "export {}\n")
    mkdirSync(join(app, "src"), { recursive: true })
    writeFileSync(join(app, "src", "AGENTS.md"), "Module rules here.\n")

    const repos = searchSpace(value.space, { type: "repo" })
    expect(repos.items.map((item) => item.path)).toEqual(["projects/App"])
    expect(searchSpace(value.space, { type: "file", query: "index" }).items[0]?.name).toBe("index.ts")
    expect(() => searchSpace(value.space, { type: "file" })).toThrow(/Query is required/)
    expect(() => searchSpace(value.space, { type: "file", query: "../etc" })).toThrow(/traversal or absolute/)

    const scan = scanSpace(value.space, "demo-space", systemGit)
    // The Space worktree itself is a repository fact, exactly as the previous owner reported it.
    expect(scan.repositories.map((entry) => entry.path)).toEqual([".wopal", "projects/App"])
    expect(scan.repositories[0]?.type).toBe("worktree")
    expect(scan.repositories[1]?.description?.text).toBe("Demo app rules")
    expect(scan.repositories[1]?.agentsFile).toBe("projects/App/AGENTS.md")
    expect(scan.agentRules.map((entry) => entry.path)).toEqual(["projects/App/src"])
    expect(scan.agentRules[0]?.repo).toBe("projects/App")
  })

  it("derives exactly the compatibility sparse range for the coding type", () => {
    const value = fixture()
    const manifest = readArchetype(value.ontology, "coding")
    expect(materializationPatterns(value.ontology, manifest)).toEqual([...expectedPatterns].sort())
  })
})
