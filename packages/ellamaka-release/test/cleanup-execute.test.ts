import { describe, expect, test } from "bun:test"
import { executeRetention, sweepOrphanRegistries, type RetentionOps } from "../src/cleanup/execute"
import { PRODUCTS } from "../src/cleanup/products"

const cli = PRODUCTS["ellamaka-cli"]
const desktop = PRODUCTS["ellamaka-desktop"]

function makeOps(overrides: Partial<RetentionOps> = {}): {
  ops: RetentionOps
  calls: { deletedR2: string[]; deletedGh: string[]; deletedGitee: string[] }
} {
  const calls = { deletedR2: [] as string[], deletedGh: [] as string[], deletedGitee: [] as string[] }
  const ops: RetentionOps = {
    deleteR2: (path, dry) => {
      if (!dry) calls.deletedR2.push(path)
    },
    listGithub: () => ["ellamaka-cli-v1.16.0", "ellamaka-cli-v1.15.0"],
    deleteGithub: (_repo, tag, dry) => {
      if (!dry) calls.deletedGh.push(tag)
    },
    listGithubOntology: () => ["ellamaka-cli-v1.16.0", "ellamaka-v1.15.0"],
    listGitee: (_t, _r) => [{ id: 1, tag_name: "ellamaka-cli-v1.16.0" }],
    listGiteeOntology: (_t, _r) => [{ id: 2, tag_name: "ellamaka-cli-v1.16.0" }],
    deleteGitee: (_t, _r, release, dry) => {
      if (!dry) calls.deletedGitee.push(release.tag_name)
    },
    ...overrides,
  }
  return { ops, calls }
}

const GH = "wopal-cn/ellamaka"
const GH_ONT = "wopal-cn/wopal-space-ontology"

describe("cleanup execute — executeRetention (B-03, W-02)", () => {
  test("deletes R2 then lockstep GitHub/Gitee/ontology for deleted versions", () => {
    const { ops, calls } = makeOps()
    const kept = [
      { version: "1.16.0", path: "ellamaka/v1.16.0", protected: false },
      { version: "1.15.0", path: "ellamaka/v1.15.0", protected: false },
    ]
    const { deletedVersions, failures } = executeRetention({
      config: cli,
      kept,
      dryRun: false,
      giteeToken: "tok",
      ghRepo: GH,
      ghOntRepo: GH_ONT,
      ops,
    })

    expect([...deletedVersions].sort()).toEqual(["1.15.0", "1.16.0"])
    expect(failures).toEqual([])
    expect(calls.deletedR2.sort()).toEqual(["ellamaka/v1.15.0", "ellamaka/v1.16.0"])
    // GitHub main + ontology (both cli and bare ellamaka-v prefixes)
    expect(calls.deletedGh).toContain("ellamaka-cli-v1.16.0")
    expect(calls.deletedGh).toContain("ellamaka-cli-v1.15.0")
    expect(calls.deletedGh).toContain("ellamaka-v1.15.0")
    // Gitee main + ontology
    expect(calls.deletedGitee).toContain("ellamaka-cli-v1.16.0")
  })

  test("B-03: a failed R2 delete is NOT added to deletedVersions and its registry/tag is NOT touched", () => {
    const { ops, calls } = makeOps({
      deleteR2: (path, dry) => {
        if (dry) return
        if (path === "ellamaka/v1.16.0") throw new Error("aws failed")
      },
    })
    const kept = [
      { version: "1.16.0", path: "ellamaka/v1.16.0", protected: false },
      { version: "1.15.0", path: "ellamaka/v1.15.0", protected: false },
    ]
    const { deletedVersions, failures } = executeRetention({
      config: cli,
      kept,
      dryRun: false,
      giteeToken: "tok",
      ghRepo: GH,
      ghOntRepo: GH_ONT,
      ops,
    })

    // 1.16.0 R2 delete failed → not recorded, so no GitHub/Gitee tag delete.
    expect(deletedVersions.has("1.16.0")).toBe(false)
    expect(deletedVersions.has("1.15.0")).toBe(true)
    expect(failures).toEqual(["ellamaka/v1.16.0"])
    expect(calls.deletedGh).not.toContain("ellamaka-cli-v1.16.0")
    expect(calls.deletedGitee).not.toContain("ellamaka-cli-v1.16.0")
    // 1.15.0 still cleaned up lockstep.
    expect(calls.deletedGh).toContain("ellamaka-cli-v1.15.0")
    expect(calls.deletedGh).toContain("ellamaka-v1.15.0")
  })

  test("dry-run: no mutations, but every kept version planned for registry/tag cleanup", () => {
    const { ops, calls } = makeOps()
    const kept = [{ version: "1.16.0", path: "ellamaka/v1.16.0", protected: false }]
    const { deletedVersions, failures } = executeRetention({
      config: cli,
      kept,
      dryRun: true,
      ghRepo: GH,
      ghOntRepo: GH_ONT,
      ops,
    })

    expect(failures).toEqual([])
    // R2 + GitHub + Gitee all no-ops (nothing recorded).
    expect(calls.deletedR2).toEqual([])
    expect(calls.deletedGh).toEqual([])
    expect(calls.deletedGitee).toEqual([])
    // Version still planned.
    expect(deletedVersions.has("1.16.0")).toBe(true)
  })

  test("desktop: ontology mirror uses namespaced prefix only", () => {
    const { ops, calls } = makeOps({
      listGithubOntology: () => ["ellamaka-desktop-v1.16.0"],
      listGithub: () => ["ellamaka-desktop-v1.16.0"],
    })
    const kept = [{ version: "1.16.0", path: "ellamaka-desktop/v1.16.0", protected: false }]
    executeRetention({
      config: desktop,
      kept,
      dryRun: false,
      ghRepo: GH,
      ghOntRepo: GH_ONT,
      ops,
    })

    expect(calls.deletedGh).toContain("ellamaka-desktop-v1.16.0")
  })

  test("empty kept → no R2 deletes, no registry/tag deletes", () => {
    const { ops, calls } = makeOps()
    const { deletedVersions, failures } = executeRetention({
      config: cli,
      kept: [],
      dryRun: false,
      ghRepo: GH,
      ghOntRepo: GH_ONT,
      ops,
    })
    expect(deletedVersions.size).toBe(0)
    expect(failures).toEqual([])
    expect(calls.deletedR2).toEqual([])
    expect(calls.deletedGh).toEqual([])
  })
})

describe("cleanup execute — sweepOrphanRegistries", () => {
  test("sweeps registry entries whose version is absent from R2 (incl. Gitee orphans)", () => {
    // R2 still holds 1.15.0; 1.16.0 was deleted from R2 earlier but its
    // registry entries were left behind (e.g. GITEE_TOKEN was missing).
    const { ops, calls } = makeOps({
      listGithub: () => ["ellamaka-cli-v1.16.0", "ellamaka-cli-v1.15.0"],
      listGithubOntology: () => ["ellamaka-cli-v1.16.0", "ellamaka-v1.15.0"],
      listGitee: () => [{ id: 1, tag_name: "ellamaka-cli-v1.16.0" }, { id: 3, tag_name: "ellamaka-cli-v1.15.0" }],
      listGiteeOntology: () => [{ id: 2, tag_name: "ellamaka-cli-v1.16.0" }],
    })
    const { swept } = sweepOrphanRegistries({
      config: cli,
      r2Versions: new Set(["1.15.0"]),
      dryRun: false,
      giteeToken: "t",
      ghRepo: GH,
      ghOntRepo: GH_ONT,
      ops,
    })

    // 1.16.0 orphans swept everywhere; 1.15.0 (still on R2) untouched.
    expect(calls.deletedGh).toEqual(["ellamaka-cli-v1.16.0", "ellamaka-cli-v1.16.0"])
    expect(calls.deletedGitee).toEqual(["ellamaka-cli-v1.16.0", "ellamaka-cli-v1.16.0"])
    expect(swept).toHaveLength(4)
  })

  test("dry-run observes without deleting", () => {
    const { ops, calls } = makeOps({
      listGithub: () => ["ellamaka-cli-v1.16.0"],
      listGitee: () => [{ id: 1, tag_name: "ellamaka-cli-v1.16.0" }],
    })
    sweepOrphanRegistries({
      config: cli,
      r2Versions: new Set(),
      dryRun: true,
      giteeToken: "t",
      ghRepo: GH,
      ghOntRepo: GH_ONT,
      ops,
    })
    expect(calls.deletedGh).toEqual([])
    expect(calls.deletedGitee).toEqual([])
  })

  test("legacy-shaped entries are never swept (fail-closed retain)", () => {
    const { ops, calls } = makeOps({
      listGithub: () => ["ellamaka-cli-v1.15.13-4"],
      listGithubOntology: () => [],
      listGitee: () => [],
      listGiteeOntology: () => [],
    })
    sweepOrphanRegistries({
      config: cli,
      r2Versions: new Set(),
      dryRun: false,
      ghRepo: GH,
      ghOntRepo: GH_ONT,
      ops,
    })
    expect(calls.deletedGh).toEqual([])
  })

  test("desktop: beta orphan swept via namespaced prefix", () => {
    const { ops, calls } = makeOps({
      listGithub: () => ["ellamaka-desktop-v1.16.0", "ellamaka-desktop-v1.15.0"],
    })
    sweepOrphanRegistries({
      config: desktop,
      r2Versions: new Set(["1.15.0"]),
      dryRun: false,
      ghRepo: GH,
      ghOntRepo: GH_ONT,
      ops,
    })
    expect(calls.deletedGh).toEqual(["ellamaka-desktop-v1.16.0"])
  })
})
