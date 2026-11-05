import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCompatibilityFixture, type CompatibilityFixture } from "../../fixtures/compatibility/git-space"
import { ontologyGit, prepareOntologyScenario } from "../../fixtures/compatibility/ontology"
import { createOntologyService } from "../../../src/ontology"

let parent: string
let fixture: CompatibilityFixture
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "wopalspace-ontology-sync-"))
})
afterEach(() => {
  fixture?.dispose()
  rmSync(parent, { recursive: true, force: true })
})

function service() {
  return createOntologyService({
    host: { wopalHome: fixture.home },
    git: ontologyGit(fixture),
    pr: { query: async () => [] },
  })
}

function snapshot() {
  const state = fixture.snapshot()
  return { refs: state.refs, hostStatus: state.hostStatus, fetchHead: state.fetchHead, objects: state.objects }
}

function residue() {
  const dir = join(fixture.home, ".worktrees")
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("ontology-sync-")) : []
}

describe("Ontology sync preview", () => {
  test("preview performs zero writes and reports the single clone fast-forward", async () => {
    fixture = createCompatibilityFixture(parent)
    prepareOntologyScenario(fixture, "behind")
    fixture.git(fixture.ontology, "fetch", "origin")
    const before = snapshot()
    const preview = await service().sync("test-onto", { confirm: false })
    expect(preview).toMatchObject({ pushed: false })
    expect(preview.steps.map((step) => [step.step, step.action])).toEqual([["main", "fast-forwarded"]])
    expect(snapshot()).toEqual(before)
    expect(residue()).toEqual([])
  })

  test("fork preview projects both merges plus the push without writing", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    fixture.commit(fixture.ontology, "origin-only.md", "origin\n")
    fixture.git(fixture.ontology, "push", "origin", "main")
    fixture.git(fixture.ontology, "reset", "--hard", "HEAD~1")
    fixture.commit(fixture.ontology, "upstream-only.md", "upstream\n")
    fixture.git(fixture.ontology, "push", "upstream", "main")
    fixture.git(fixture.ontology, "reset", "--hard", "HEAD~1")
    fixture.commit(fixture.ontology, "local-only.md", "local\n")
    fixture.git(fixture.ontology, "fetch", "origin")
    fixture.git(fixture.ontology, "fetch", "upstream")
    const before = snapshot()
    const preview = await service().sync("test-onto", { confirm: false })
    expect(preview.steps.map((step) => [step.step, step.action])).toEqual([
      ["origin-merge", "merged"],
      ["upstream-merge", "merged"],
      ["origin-push", "pushed"],
    ])
    expect(snapshot()).toEqual(before)
    expect(residue()).toEqual([])
  })

  test("preview reports a conflict and stops before the push", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    prepareOntologyScenario(fixture, "conflict")
    fixture.git(fixture.ontology, "fetch", "origin")
    const preview = await service().sync("test-onto", { confirm: false })
    expect(preview.steps.at(-1)).toMatchObject({ action: "conflict" })
    expect(preview.steps.some((step) => step.step === "origin-push")).toBe(false)
    expect(preview.steps.at(-1)!.conflictFiles).toContain("rules/typescript.md")
  })

  test("preview and apply agree on an up-to-date repository", async () => {
    fixture = createCompatibilityFixture(parent)
    const api = service()
    const preview = await api.sync("test-onto", { confirm: false })
    expect(preview.steps).toEqual([{ step: "main", action: "skipped" }])
    const before = snapshot()
    expect(await api.sync("test-onto", { confirm: true })).toEqual({
      steps: [{ step: "main", action: "skipped" }],
      pushed: false,
    })
    expect(snapshot()).toEqual(before)
  })
})

describe("Ontology sync apply", () => {
  test("clone fast-forwards origin main into local main without pushing", async () => {
    fixture = createCompatibilityFixture(parent)
    prepareOntologyScenario(fixture, "behind")
    const originHead = fixture.git(fixture.origin, "rev-parse", "main")
    const result = await service().sync("test-onto", { confirm: true })
    expect(result).toMatchObject({ pushed: false })
    expect(result.steps.map((step) => [step.step, step.action])).toEqual([["main", "fast-forwarded"]])
    expect(fixture.git(fixture.ontology, "rev-parse", "main")).toBe(originHead)
    expect(fixture.git(fixture.ontology, "show", "main:rules/typescript.md")).toContain("incoming")
  })

  test("clone fast-forwards through a temporary worktree when the host is on another branch", async () => {
    fixture = createCompatibilityFixture(parent)
    prepareOntologyScenario(fixture, "behind")
    fixture.git(fixture.ontology, "switch", "-c", "space/demo-space-other", "main")
    const beforeBranch = fixture.git(fixture.ontology, "rev-parse", "--abbrev-ref", "HEAD")
    const originHead = fixture.git(fixture.origin, "rev-parse", "main")
    const result = await service().sync("test-onto", { confirm: true })
    expect(result.steps[0]?.action).toBe("fast-forwarded")
    expect(fixture.git(fixture.ontology, "rev-parse", "--abbrev-ref", "HEAD")).toBe(beforeBranch)
    expect(fixture.git(fixture.ontology, "rev-parse", "main")).toBe(originHead)
    expect(residue()).toEqual([])
  })

  test("fork merges origin then upstream and pushes local main back to origin", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    fixture.commit(fixture.ontology, "origin-only.md", "origin\n")
    fixture.git(fixture.ontology, "push", "origin", "main")
    fixture.git(fixture.ontology, "reset", "--hard", "HEAD~1")
    fixture.commit(fixture.ontology, "upstream-only.md", "upstream\n")
    fixture.git(fixture.ontology, "push", "upstream", "main")
    fixture.git(fixture.ontology, "reset", "--hard", "HEAD~1")
    const result = await service().sync("test-onto", { confirm: true })
    expect(result).toMatchObject({ pushed: true })
    expect(result.steps.map((step) => [step.step, step.action])).toEqual([
      ["origin-merge", "fast-forwarded"],
      ["upstream-merge", "merged"],
      ["origin-push", "pushed"],
    ])
    const local = fixture.git(fixture.ontology, "rev-parse", "main")
    expect(fixture.git(fixture.origin, "rev-parse", "main")).toBe(local)
    expect(fixture.git(fixture.ontology, "merge-base", "--is-ancestor", "upstream/main", "main")).toBe("")
    // Content merge uses the formal subject, not the generated merge text.
    const mergeSubject = fixture.git(fixture.ontology, "log", "--format=%s", "--merges", "-1", "main")
    expect(mergeSubject).toBe("sync(ontology): integrate upstream/main")
    expect(existsSync(join(fixture.ontology, "origin-only.md"))).toBe(true)
    expect(existsSync(join(fixture.ontology, "upstream-only.md"))).toBe(true)
    expect(residue()).toEqual([])
  })

  test("fork rolls an origin merge back when the upstream merge conflicts", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    fixture.commit(fixture.ontology, "origin-only.md", "origin\n")
    fixture.git(fixture.ontology, "push", "origin", "main")
    fixture.git(fixture.ontology, "reset", "--hard", "HEAD~1")
    fixture.commit(fixture.ontology, "rules/typescript.md", "# local\n")
    const upstreamClone = join(fixture.root, "upstream-clone")
    fixture.git(fixture.root, "clone", fixture.upstream, upstreamClone)
    fixture.commit(upstreamClone, "rules/typescript.md", "# upstream\n")
    fixture.git(upstreamClone, "push", "origin", "main")
    const localBefore = fixture.git(fixture.ontology, "rev-parse", "main")
    const originBefore = fixture.git(fixture.origin, "rev-parse", "main")
    const result = await service().sync("test-onto", { confirm: true })
    expect(result).toMatchObject({ pushed: false })
    expect(result.steps.map((step) => [step.step, step.action])).toEqual([
      ["origin-merge", "merged"],
      ["upstream-merge", "conflict"],
    ])
    expect(result.steps[1]?.conflictFiles).toContain("rules/typescript.md")
    expect(fixture.git(fixture.ontology, "rev-parse", "main")).toBe(localBefore)
    expect(fixture.git(fixture.origin, "rev-parse", "main")).toBe(originBefore)
    expect(existsSync(join(fixture.ontology, "origin-only.md"))).toBe(false)
    expect(residue()).toEqual([])
  })

  test("keeps local success when the push fails, then retries only the remote half", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    fixture.commit(fixture.ontology, "local-work.md", "local\n")
    // Fetch keeps reading the real origin; only the push transport is broken.
    fixture.git(fixture.ontology, "remote", "set-url", "--push", "origin", join(fixture.root, "missing.git"))
    const first = await service().sync("test-onto", { confirm: true })
    const localAfterFirst = fixture.git(fixture.ontology, "rev-parse", "main")
    expect(first.pushed).toBe(false)
    expect(first.pushErrors?.length).toBe(1)
    expect(first.steps.at(-1)).toMatchObject({ step: "origin-push", action: "failed" })
    expect(fixture.git(fixture.origin, "rev-parse", "main")).not.toBe(localAfterFirst)
    fixture.git(fixture.ontology, "remote", "set-url", "--push", "origin", fixture.origin)
    const retry = await service().sync("test-onto", { confirm: true })
    expect(retry.pushErrors).toBeUndefined()
    expect(retry.steps.map((step) => [step.step, step.action])).toEqual([
      ["origin-merge", "skipped"],
      ["upstream-merge", "skipped"],
      ["origin-push", "pushed"],
    ])
    expect(fixture.git(fixture.ontology, "rev-parse", "main")).toBe(localAfterFirst)
    expect(fixture.git(fixture.origin, "rev-parse", "main")).toBe(localAfterFirst)
  })

  test("squash-landed upstream content produces one tree-preserving reconciliation merge", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    // The change lands upstream via squash; local has the identical content
    // from an unrelated commit, so trees are aligned but ancestry diverged.
    fixture.commit(fixture.ontology, "rules/typescript.md", "# squashed content\n", "feat: squashed upstream")
    fixture.git(fixture.ontology, "push", "upstream", "main")
    fixture.git(fixture.ontology, "reset", "--hard", "HEAD~1")
    fixture.commit(fixture.ontology, "rules/typescript.md", "# squashed content\n", "chore: same content locally")
    fixture.git(fixture.ontology, "fetch", "upstream")
    const localBefore = fixture.git(fixture.ontology, "rev-parse", "main")
    const treeBefore = fixture.git(fixture.ontology, "rev-parse", "main^{tree}")
    const result = await service().sync("test-onto", { confirm: true })
    expect(result.steps.map((step) => [step.step, step.action])).toEqual([
      ["origin-merge", "skipped"],
      ["upstream-merge", "reconciled"],
      ["origin-push", "pushed"],
    ])
    expect(result.steps[1]?.fileDiffs).toEqual([])
    // The upstream landing commit is now inside local ancestry.
    expect(fixture.git(fixture.ontology, "merge-base", "--is-ancestor", "upstream/main", "main")).toBe("")
    // First-parent tree is unchanged: reconciliation never rewrites files.
    expect(fixture.git(fixture.ontology, "rev-parse", "main^{tree}")).toBe(treeBefore)
    const subject = fixture.git(fixture.ontology, "log", "--format=%s", "-1", "main")
    expect(subject).toBe("sync(ontology): reconcile upstream/main history")
    // No temporary identity leaks into the formal history.
    const body = fixture.git(fixture.ontology, "log", "--format=%B", "-1", "main")
    expect(body).not.toContain("ontology-sync-")
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/)
    expect(fixture.git(fixture.ontology, "log", "--format=%P", "-1", "main").split(" ")).toHaveLength(2)
    expect(fixture.git(fixture.ontology, "rev-parse", "main^1")).toBe(localBefore)
    expect(fixture.git(fixture.ontology, "rev-parse", "main^2")).toBe(
      fixture.git(fixture.ontology, "rev-parse", "upstream/main"),
    )
    // Once the baseline is closed, the contribution view is authoritative and
    // has nothing pending: landed content is no longer reported as local-only.
    const after = await service().inspect("test-onto")
    expect(after.upstream[1]).toMatchObject({
      kind: "contribute",
      historyState: "target-ancestor",
      contentState: "aligned",
      requiredAction: "none",
    })
    expect(after.upstream[1]?.fileDiffs).toEqual([])
  })

  test("content-changing divergence creates a merged step and target-ancestor fast-forwards", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    // Upstream lands an unrelated new file; local has nothing of it. The
    // commit goes through a real clone because a bare repo has no worktree.
    const upstreamClone = join(fixture.root, "upstream-author")
    fixture.git(fixture.root, "clone", fixture.upstream, upstreamClone)
    fixture.commit(upstreamClone, "upstream-feature.md", "upstream\n", "feat: upstream feature")
    fixture.git(upstreamClone, "push", "origin", "main")
    fixture.git(fixture.ontology, "fetch", "upstream")
    const result = await service().sync("test-onto", { confirm: true })
    expect(result.steps.map((step) => [step.step, step.action])).toEqual([
      ["origin-merge", "skipped"],
      ["upstream-merge", "fast-forwarded"],
      ["origin-push", "pushed"],
    ])
    expect(existsSync(join(fixture.ontology, "upstream-feature.md"))).toBe(true)
    const mergeCommits = fixture
      .git(fixture.ontology, "log", "--format=%P", "-3", "main")
      .split("\n")
      .filter((parents) => parents.includes(" "))
    expect(mergeCommits).toEqual([])
  })

  test("repeating sync on unchanged refs is idempotent with zero commits", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    // Origin lands a file that local has not consumed yet: the first sync
    // fast-forwards to it and needs no push because local then equals origin.
    // The second sync must find nothing to do at all.
    fixture.commit(fixture.ontology, "origin-work.md", "origin\n", "feat: origin work")
    fixture.git(fixture.ontology, "push", "origin", "main")
    fixture.git(fixture.ontology, "reset", "--hard", "HEAD~1")
    const first = await service().sync("test-onto", { confirm: true })
    expect(first.steps.map((step) => [step.step, step.action])).toEqual([
      ["origin-merge", "fast-forwarded"],
      ["upstream-merge", "skipped"],
      ["origin-push", "skipped"],
    ])
    const afterFirst = fixture.git(fixture.ontology, "rev-parse", "main")
    const second = await service().sync("test-onto", { confirm: true })
    expect(second.pushed).toBe(false)
    expect(second.steps.map((step) => step.action)).toEqual(["skipped", "skipped", "skipped"])
    expect(fixture.git(fixture.ontology, "rev-parse", "main")).toBe(afterFirst)
  })

  test("apply rechecks the registration after excluding the dirty check and refuses a replaced repository", async () => {
    fixture = createCompatibilityFixture(parent)
    prepareOntologyScenario(fixture, "behind")
    const before = snapshot()
    let replacements = 0
    const api = createOntologyService({
      host: { wopalHome: fixture.home },
      git: (cwd, args, env) => {
        // The in-progress recheck runs after the dirty check; simulate the
        // registration being repointed before the first persistent write.
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel" && replacements === 0) {
          replacements += 1
          fixture.write(
            fixture.home,
            "config/settings.jsonc",
            JSON.stringify({
              ontologies: { "test-onto": { path: join(fixture.root, "elsewhere"), upstream: fixture.upstream } },
            }),
          )
        }
        return ontologyGit(fixture)(cwd, args, env)
      },
      pr: { query: async () => [] },
    })
    await expect(api.sync("test-onto", { confirm: true })).rejects.toMatchObject({ code: "ONTOLOGY_REGISTRY_CHANGED" })
    expect(snapshot()).toEqual(before)
  })

  test("refuses a dirty host repository before any write", async () => {
    fixture = createCompatibilityFixture(parent)
    prepareOntologyScenario(fixture, "behind")
    fixture.write(fixture.ontology, "rules/typescript.md", "# uncommitted\n")
    const before = snapshot()
    await expect(service().sync("test-onto", { confirm: true })).rejects.toMatchObject({ code: "ONTOLOGY_SYNC_DIRTY" })
    expect(snapshot()).toEqual(before)
  })

  test("refuses an in-progress merge before any write", async () => {
    fixture = createCompatibilityFixture(parent)
    prepareOntologyScenario(fixture, "behind")
    const localBefore = fixture.git(fixture.ontology, "rev-parse", "main")
    const originBefore = fixture.git(fixture.ontology, "rev-parse", "origin/main")
    expect(localBefore).not.toBe(originBefore)
    fixture.write(fixture.ontology, ".git/MERGE_HEAD", localBefore + "\n")
    await expect(service().sync("test-onto", { confirm: true })).rejects.toMatchObject({
      code: "ONTOLOGY_SYNC_IN_PROGRESS",
    })
    expect(fixture.git(fixture.ontology, "rev-parse", "main")).toBe(localBefore)
    expect(fixture.git(fixture.ontology, "rev-parse", "origin/main")).toBe(originBefore)
  })

  test("preserves contribution branches and worktrees during sync", async () => {
    fixture = createCompatibilityFixture(parent, "fork")
    fixture.git(fixture.ontology, "branch", "contribute/merged", "main")
    const worktree = join(fixture.root, "contribution-worktree")
    fixture.git(fixture.ontology, "worktree", "add", worktree, "contribute/merged")
    prepareOntologyScenario(fixture, "behind")
    const contributionRefs = () =>
      fixture
        .git(fixture.ontology, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/contribute/")
        .split("\n")
        .filter(Boolean)
    const worktreeListing = () =>
      fixture
        .git(fixture.ontology, "worktree", "list", "--porcelain")
        .split("\n\n")
        .filter(
          (block) => block.includes("branch refs/heads/contribute/") || block.includes("branch refs/heads/space/"),
        )
        .join("\n\n")
    const before = [contributionRefs(), worktreeListing()]
    await service().sync("test-onto", { confirm: true })
    expect([contributionRefs(), worktreeListing()]).toEqual(before)
    expect(existsSync(worktree)).toBe(true)
  })
})
