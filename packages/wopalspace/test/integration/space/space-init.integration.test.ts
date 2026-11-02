import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createCompatibilityFixture, type CompatibilityFixture } from "../../fixtures/compatibility/git-space"
import { createSpaceService } from "../../../src/space/service"
import { systemGit } from "../../../src/space/git"
import type { SpacePreparationResult } from "../../../src/space/types"

const fixtures: CompatibilityFixture[] = []
const fixture = () => {
  const value = createCompatibilityFixture(join(process.env.TMPDIR ?? "/tmp", "wopalspace-space-init-"))
  fixtures.push(value)
  return value
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose()
})

function service(value: CompatibilityFixture, prepareInstance?: () => Promise<SpacePreparationResult>) {
  return createSpaceService({
    host: { wopalHome: value.home },
    git: systemGit,
    ...(prepareInstance ? { prepareInstance } : {}),
  })
}

/** A brand-new Space root in an isolated directory. */
function freshRoot(value: CompatibilityFixture, name: string): string {
  const root = join(value.root, name)
  mkdirSync(root, { recursive: true })
  return root
}

describe("space init create/reuse", () => {
  it("creates a Space from the ontology and registers it with the fixed type", async () => {
    const value = fixture()
    const root = freshRoot(value, "new-space")
    const result = await service(value).init({ name: "new-space", root: root, type: "coding" })

    expect(result.space.name).toBe("new-space")
    expect(result.space.path).toBe(root)
    expect(result.space.type).toBe("coding")
    expect(result.space.branch).toBe("space/new-space")
    expect(result.materialized.condition).toBe("create")
    expect(result.materialized.finalCondition).toBe("noop")
    expect(result.preparation.status).toBe("skipped")

    // Assembly content: the space branch, the sparse range and the snapshot.
    expect(existsSync(join(root, ".wopal", "AGENTS.md"))).toBe(true)
    expect(existsSync(join(root, ".wopal", ".git"))).toBe(true)
    const snapshot = JSON.parse(readFileSync(join(root, ".wopal-space", "space-meta.json"), "utf8"))
    expect(snapshot).toMatchObject({
      version: 2,
      type: "coding",
      schema: "coding-space-schema.yaml",
      source: { ontology: "test-onto" },
    })
    expect(value.git(value.ontology, "for-each-ref", "--format=%(refname:short)", "refs/heads/space/new-space")).toBe(
      "space/new-space",
    )

    const registry = JSON.parse(readFileSync(join(value.home, "config", "settings.jsonc"), "utf8"))
    expect(registry.spaces["new-space"]).toMatchObject({
      path: root,
      ontology: "test-onto",
      branch: "space/new-space",
      type: "coding",
    })
  })

  it("preserves user content across a repeated init and stays a fixed point", async () => {
    const value = fixture()
    const root = freshRoot(value, "reuse-space")
    const space = service(value)
    await space.init({ name: "reuse-space", root: root, type: "coding" })

    writeFileSync(join(root, ".wopal", "AGENTS.md"), "# my own agents\n")
    writeFileSync(join(root, ".wopal", "notes.md"), "user notes\n")
    writeFileSync(join(root, "docs", "plan.md"), "# plan\n")
    const snapshotBefore = readFileSync(join(root, ".wopal-space", "space-meta.json"), "utf8")
    const refsBefore = value.git(value.ontology, "show-ref")

    const again = await space.init({ name: "reuse-space", root: root, type: "coding" })
    expect(again.materialized.condition).not.toBe("create")
    expect(readFileSync(join(root, ".wopal", "AGENTS.md"), "utf8")).toBe("# my own agents\n")
    expect(readFileSync(join(root, ".wopal", "notes.md"), "utf8")).toBe("user notes\n")
    expect(readFileSync(join(root, "docs", "plan.md"), "utf8")).toBe("# plan\n")
    expect(readFileSync(join(root, ".wopal-space", "space-meta.json"), "utf8")).toBe(snapshotBefore)
    expect(value.git(value.ontology, "show-ref")).toBe(refsBefore)
  })

  it("relinks a Space whose worktree was removed without deleting user content", async () => {
    const value = fixture()
    const root = freshRoot(value, "relink-space")
    const space = service(value)
    await space.init({ name: "relink-space", root: root, type: "coding" })
    writeFileSync(join(root, "docs", "keep.md"), "# keep me\n")
    rmSync(join(root, ".wopal"), { recursive: true, force: true })

    const relinked = await space.init({ name: "relink-space", root: root })
    expect(relinked.materialized.condition).toBe("relink")
    expect(existsSync(join(root, ".wopal", "AGENTS.md"))).toBe(true)
    expect(readFileSync(join(root, "docs", "keep.md"), "utf8")).toBe("# keep me\n")
  })

  it("repairs a missing registry entry without touching the Space content", async () => {
    const value = fixture()
    const root = freshRoot(value, "repair-space")
    const space = service(value)
    await space.init({ name: "repair-space", root: root, type: "coding" })
    writeFileSync(join(root, "docs", "mine.md"), "# mine\n")

    const settingsPath = join(value.home, "config", "settings.jsonc")
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"))
    delete settings.spaces["repair-space"]
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n")

    const repaired = await space.init({ name: "repair-space", root: root })
    expect(repaired.materialized.condition).toBe("repair-registry")
    expect(readFileSync(join(root, "docs", "mine.md"), "utf8")).toBe("# mine\n")
    expect(Object.hasOwn(JSON.parse(readFileSync(settingsPath, "utf8")).spaces, "repair-space")).toBe(true)
  })

  it("rebuilds a stale worktree while keeping user files and backups", async () => {
    const value = fixture()
    const root = freshRoot(value, "stale-space")
    const space = service(value)
    await space.init({ name: "stale-space", root: root, type: "coding" })
    writeFileSync(join(root, ".wopal", "skills", "dev-flow", "SKILL.md"), "# locally edited\n")

    // Break the worktree pointer the way an interrupted rebuild does.
    writeFileSync(join(root, ".wopal", ".git"), "gitdir: /nonexistent/gitdir\n")
    const result = await space.init({ name: "stale-space", root: root })
    expect(["repair-worktree", "repair-both"]).toContain(result.materialized.condition)
    expect(readFileSync(join(root, ".wopal", "skills", "dev-flow", "SKILL.md"), "utf8")).toBe("# locally edited\n")
    expect(existsSync(join(root, ".wopal-space", "backup"))).toBe(true)
  })

  it("refuses a type change before touching the Space", async () => {
    const value = fixture()
    const root = freshRoot(value, "typed-space")
    const space = service(value)
    await space.init({ name: "typed-space", root: root, type: "coding" })
    const snapshotBefore = readFileSync(join(root, ".wopal-space", "space-meta.json"), "utf8")

    await expect(space.init({ name: "typed-space", root: root, type: "content" })).rejects.toThrow(/cannot change/)
    expect(readFileSync(join(root, ".wopal-space", "space-meta.json"), "utf8")).toBe(snapshotBefore)
  })

  it("refuses a new Space without a type and leaves no partial worktree", async () => {
    const value = fixture()
    const root = freshRoot(value, "untyped-space")
    await expect(service(value).init({ name: "untyped-space", root: root })).rejects.toThrow(/type is required/)
    expect(existsSync(join(root, ".wopal"))).toBe(false)
    expect(
      Object.hasOwn(
        JSON.parse(readFileSync(join(value.home, "config", "settings.jsonc"), "utf8")).spaces,
        "untyped-space",
      ),
    ).toBe(false)
  })

  it("refuses a Space whose .wopal exists without an assembly snapshot", async () => {
    const value = fixture()
    const root = freshRoot(value, "invalid-space")
    mkdirSync(join(root, ".wopal"), { recursive: true })
    writeFileSync(join(root, ".wopal", "AGENTS.md"), "orphan\n")
    await expect(service(value).init({ name: "invalid-space", root: root, type: "coding" })).rejects.toThrow(
      /Invalid state/,
    )
    expect(readFileSync(join(root, ".wopal", "AGENTS.md"), "utf8")).toBe("orphan\n")
  })

  it("refuses to adopt newer ontology main content on a repeated init", async () => {
    const value = fixture()
    const root = freshRoot(value, "pinned-space")
    const space = service(value)
    await space.init({ name: "pinned-space", root: root, type: "coding" })
    const branchHead = value.git(value.ontology, "rev-parse", "space/pinned-space")
    const snapshotBefore = readFileSync(join(root, ".wopal-space", "space-meta.json"), "utf8")
    const worktreeHead = value.git(join(root, ".wopal"), "rev-parse", "HEAD")
    const range = value.git(join(root, ".wopal"), "sparse-checkout", "list")

    value.commit(value.ontology, "config/newer.md", "# newer main\n", "feat: newer main")
    const mainHead = value.git(value.ontology, "rev-parse", "main")

    // The branch is behind local main: init refuses before any write and
    // points at space.sync. main's newer facts never enter the old Space.
    await expect(space.init({ name: "pinned-space", root: root })).rejects.toThrow(/has not received/)
    expect(existsSync(join(root, ".wopal", "config", "newer.md"))).toBe(false)
    expect(readFileSync(join(root, ".wopal-space", "space-meta.json"), "utf8")).toBe(snapshotBefore)
    expect(value.git(value.ontology, "rev-parse", "space/pinned-space")).toBe(branchHead)
    expect(value.git(value.ontology, "rev-parse", "main")).toBe(mainHead)
    expect(value.git(join(root, ".wopal"), "rev-parse", "HEAD")).toBe(worktreeHead)
    expect(value.git(join(root, ".wopal"), "sparse-checkout", "list")).toBe(range)
  })

  it("keeps the Space and retries only preparation after a preparation failure", async () => {
    const value = fixture()
    const root = freshRoot(value, "prepare-space")
    let attempts = 0
    const failing = createSpaceService({
      host: { wopalHome: value.home },
      git: systemGit,
      prepareInstance: async () => {
        attempts += 1
        return { status: "failed", error: { code: "PREPARE_FAILED", message: "plugin install failed" } }
      },
    })
    const first = await failing.init({ name: "prepare-space", root: root, type: "coding" })
    expect(first.materialized.condition).toBe("create")
    expect(first.preparation.status).toBe("failed")
    expect(existsSync(join(root, ".wopal"))).toBe(true)
    expect(existsSync(join(root, ".wopal-space", "space-meta.json"))).toBe(true)

    const snapshotBefore = readFileSync(join(root, ".wopal-space", "space-meta.json"), "utf8")
    const branchHead = value.git(value.ontology, "rev-parse", "space/prepare-space")
    const retry = await service(value, async () => ({ status: "ready", prepared: true })).init({
      name: "prepare-space",
      root: root,
      type: "coding",
    })
    expect(retry.materialized.condition).toBe("noop")
    expect(retry.preparation).toEqual({ status: "ready", prepared: true })
    expect(readFileSync(join(root, ".wopal-space", "space-meta.json"), "utf8")).toBe(snapshotBefore)
    expect(value.git(value.ontology, "rev-parse", "space/prepare-space")).toBe(branchHead)
    expect(attempts).toBe(1)
  })

  it("reports a cancelled preparation while keeping the materialized Space", async () => {
    const value = fixture()
    const root = freshRoot(value, "cancel-space")
    const result = await service(value, async () => ({ status: "cancelled" })).init({
      name: "cancel-space",
      root: root,
      type: "coding",
    })
    expect(result.preparation).toEqual({ status: "cancelled" })
    expect(existsSync(join(root, ".wopal", "AGENTS.md"))).toBe(true)
  })

  it("rolls back a failed materialization without registering the Space", async () => {
    const value = fixture()
    const root = freshRoot(value, "broken-space")
    rmSync(join(value.ontology, "assembly", "templates", "STRUCTURE.md"))
    value.git(value.ontology, "add", "-A")
    value.git(value.ontology, "commit", "-qm", "remove template")

    await expect(service(value).init({ name: "broken-space", root: root, type: "coding" })).rejects.toThrow(
      /templates missing/,
    )
    expect(existsSync(join(root, ".wopal"))).toBe(false)
    expect(
      Object.hasOwn(
        JSON.parse(readFileSync(join(value.home, "config", "settings.jsonc"), "utf8")).spaces,
        "broken-space",
      ),
    ).toBe(false)
  })

  it("leaves the local config untouched when the shared settings declare every manifest plugin", async () => {
    const value = fixture()
    const root = freshRoot(value, "plugins-space")
    await service(value).init({ name: "plugins-space", root: root, type: "coding" })

    // The fixture's shared config/settings.jsonc already declares the manifest
    // plugin in the ellamaka section, so the differential is empty: no local
    // entry is generated and the shared file is never rewritten.
    expect(existsSync(join(root, ".wopal", "config", "settings.local.jsonc"))).toBe(false)
    const shared = readFileSync(join(root, ".wopal", "config", "settings.jsonc"), "utf8")
    expect(shared).toContain("../plugins/wopal-plugin/index.ts")
    expect(shared).toBe(readFileSync(join(value.ontology, "config", "settings.jsonc"), "utf8"))
  })

  it("defaults a new Space root to the trusted host directory", async () => {
    const value = fixture()
    const result = await createSpaceService({
      host: { wopalHome: value.home, directory: value.root },
      git: systemGit,
    }).init({ name: "host-space", type: "coding" })
    expect(result.space.path).toBe(join(value.root, "host-space"))
    expect(existsSync(join(value.root, "host-space", ".wopal", "AGENTS.md"))).toBe(true)
  })

  it("requires an explicit path when the host supplies no directory", async () => {
    const value = fixture()
    await expect(service(value).init({ name: "nowhere", type: "coding" })).rejects.toThrow(/path is required/i)
  })

  it("refuses an unregistered ontology before touching the Space root", async () => {
    const value = fixture()
    const root = freshRoot(value, "unknown-ontology")
    await expect(
      service(value).init({ name: "unknown-ontology", root: root, type: "coding", ontology: "missing-onto" }),
    ).rejects.toThrow(/Ontology is not registered/)
    expect(existsSync(join(root, ".wopal"))).toBe(false)
  })
})
