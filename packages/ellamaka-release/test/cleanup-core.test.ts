import { describe, expect, test } from "bun:test"
import {
  applyRetentionWithRecheck,
  buildReferenceGraph,
  planRetention,
  planWithdraw,
} from "../src/cleanup/core"
import { PRODUCTS } from "../src/cleanup/products"

const cli = PRODUCTS["ellamaka-cli"]
const desktop = PRODUCTS["ellamaka-desktop"]

describe("cleanup core — buildReferenceGraph", () => {
  test("protects latest alias and classifies standard vs legacy (cli)", () => {
    const snapshot = {
      versionedPaths: ["ellamaka/v1.17.0", "ellamaka/v1.16.0", "ellamaka/v1.15.13-4", "ellamaka/vweird"],
      tags: [],
    }
    const aliases = { "ellamaka/latest/manifest.json": "1.17.0" }
    const graph = buildReferenceGraph(snapshot, aliases, cli)

    expect(graph.protected.has("ellamaka/v1.17.0")).toBe(true)
    expect(graph.protectedReason.get("ellamaka/v1.17.0")).toContain("latest alias")
    expect(graph.standard.has("ellamaka/v1.16.0")).toBe(true)
    // legacy stable-iteration retained (fail-closed)
    expect(graph.legacy.has("ellamaka/v1.15.13-4")).toBe(true)
    // unknown objects fail closed as legacy
    expect(graph.legacy.has("ellamaka/vweird")).toBe(true)
  })

  test("protects stable and beta latest aliases for desktop", () => {
    const snapshot = {
      versionedPaths: ["ellamaka-desktop/v1.17.0", "ellamaka-desktop/beta/v1.17.0-beta.1", "ellamaka-desktop/v1.16.0"],
      tags: [],
    }
    const aliases = {
      "ellamaka-desktop/latest/manifest.json": "1.17.0",
      "ellamaka-desktop/beta/latest/manifest.json": "1.17.0-beta.1",
    }
    const graph = buildReferenceGraph(snapshot, aliases, desktop)

    expect(graph.protected.has("ellamaka-desktop/v1.17.0")).toBe(true)
    expect(graph.protected.has("ellamaka-desktop/beta/v1.17.0-beta.1")).toBe(true)
    expect(graph.standard.has("ellamaka-desktop/v1.16.0")).toBe(true)
  })
})

describe("cleanup core — planRetention", () => {
  test("keeps N newest stable and deletes older (cli)", () => {
    const snapshot = {
      versionedPaths: [
        "ellamaka/v1.17.0",
        "ellamaka/v1.16.0",
        "ellamaka/v1.15.0",
        "ellamaka/v1.14.0",
        "ellamaka/v1.13.0",
        "ellamaka/v1.12.0",
      ],
      tags: [],
    }
    const aliases = { "ellamaka/latest/manifest.json": "1.17.0" }
    const plan = planRetention({ config: cli, channel: "stable", snapshot, aliases, keepStable: 3, dryRun: false })

    // keepStable=3 counts the newest 3 total (1.17.0 protected + 1.16.0 +
    // 1.15.0); 1.14.0 and older are deleted.
    expect(plan.deleteCandidates.map((c) => c.version)).toEqual(["1.14.0", "1.13.0", "1.12.0"])
  })

  test("plans retention separately per channel for desktop", () => {
    const snapshot = {
      versionedPaths: [
        "ellamaka-desktop/v1.17.0",
        "ellamaka-desktop/v1.16.0",
        "ellamaka-desktop/v1.15.0",
        "ellamaka-desktop/beta/v1.16.0-beta.1",
        "ellamaka-desktop/beta/v1.15.0-beta.2",
      ],
      tags: [],
    }
    const aliases = {
      "ellamaka-desktop/latest/manifest.json": "1.17.0",
      "ellamaka-desktop/beta/latest/manifest.json": "1.16.0-beta.1",
    }
    const stable = planRetention({ config: desktop, channel: "stable", snapshot, aliases, keepStable: 2, dryRun: false })
    // keepStable=2 counts the newest 2 total (1.17.0 protected + 1.16.0);
    // 1.15.0 is deleted.
    expect(stable.deleteCandidates.map((c) => c.version)).toEqual(["1.15.0"])

    const beta = planRetention({ config: desktop, channel: "beta", snapshot, aliases, keepStable: 1, dryRun: false })
    // keepStable=1 counts the newest 1 total (1.16.0-beta.1 protected);
    // 1.15.0-beta.2 is deleted.
    expect(beta.deleteCandidates.map((c) => c.version)).toEqual(["1.15.0-beta.2"])
  })

  test("retains legacy and unknown objects (fail-closed)", () => {
    const snapshot = {
      versionedPaths: ["ellamaka/v1.16.0", "ellamaka/v1.15.13-4", "ellamaka/vweird"],
      tags: [],
    }
    const plan = planRetention({ config: cli, channel: "stable", snapshot, aliases: {}, keepStable: 1, dryRun: false })

    expect(plan.deleteCandidates).toEqual([])
    expect(plan.legacyRetained).toContain("1.15.13-4")
    expect(plan.legacyRetained).toContain("weird")
  })

  test("W-05: beta channel releases above keepPrerelease become candidates", () => {
    const betaSnapshot = {
      versionedPaths: [
        "ellamaka/v1.17.0-beta.1",
        "ellamaka/v1.17.0-beta.2",
        "ellamaka/v1.17.0-beta.3",
        "ellamaka/v1.17.0-beta.4",
      ],
      tags: [],
    }
    const betaAliases = { "ellamaka/latest/manifest.json": "1.16.0" }
    const plan = planRetention({
      config: cli,
      channel: "beta",
      snapshot: betaSnapshot,
      aliases: betaAliases,
      keepStable: 1,
      dryRun: false,
    })
    // Descending: beta.4, beta.3, beta.2, beta.1. Keep 1 → delete beta.3/2/1.
    expect(plan.deleteCandidates.map((c) => c.version).sort()).toEqual([
      "1.17.0-beta.1",
      "1.17.0-beta.2",
      "1.17.0-beta.3",
    ])
  })

  test("CLI rc releases form an independent retention bucket", () => {
    const snapshot = {
      versionedPaths: [
        "ellamaka/v1.17.0",
        "ellamaka/v1.16.0",
        "ellamaka/v1.15.0",
        "ellamaka/v1.17.0-rc.2",
        "ellamaka/v1.17.0-rc.1",
        "ellamaka/v1.16.0-rc.1",
      ],
      tags: [],
    }
    const aliases = { "ellamaka/latest/manifest.json": "1.17.0-rc.2" }
    const plan = planRetention({
      config: cli,
      channel: "stable",
      snapshot,
      aliases,
      keepStable: 2,
      keepRc: 1,
      dryRun: false,
    })
    // stable bucket: 1.17.0, 1.16.0, 1.15.0 → keep 2 → delete 1.15.0
    // rc bucket: 1.17.0-rc.2 (protected, consumes the 1 rc slot), 1.17.0-rc.1,
    // 1.16.0-rc.1 → delete both older rc
    expect(plan.deleteCandidates.map((c) => c.version).sort()).toEqual([
      "1.15.0",
      "1.16.0-rc.1",
      "1.17.0-rc.1",
    ])
  })

  test("B-02: a NaN keep throws instead of deleting every unprotected release", () => {
    const snapshot = {
      versionedPaths: ["ellamaka/v1.17.0", "ellamaka/v1.16.0", "ellamaka/v1.15.0"],
      tags: [],
    }
    expect(() =>
      planRetention({ config: cli, channel: "stable", snapshot, aliases: {}, keepStable: NaN, dryRun: false }),
    ).toThrow("finite non-negative integer")
    expect(() =>
      planRetention({ config: cli, channel: "stable", snapshot, aliases: {}, keepStable: -1, dryRun: false }),
    ).toThrow("finite non-negative integer")
  })
})

describe("cleanup core — applyRetentionWithRecheck", () => {
  test("skips candidates that became protected since the plan", () => {
    const plan = {
      deleteCandidates: [
        { version: "1.14.0", path: "ellamaka/v1.14.0", protected: false },
        { version: "1.13.0", path: "ellamaka/v1.13.0", protected: false },
      ],
    }
    const freshGraph = buildReferenceGraph(
      { versionedPaths: ["ellamaka/v1.14.0", "ellamaka/v1.13.0"], tags: [] },
      { "ellamaka/latest/manifest.json": "1.14.0" },
      cli,
    )
    const { kept, skipped } = applyRetentionWithRecheck(plan, freshGraph)

    expect(kept.map((c) => c.version)).toEqual(["1.13.0"])
    expect(skipped.map((s) => s.version)).toEqual(["1.14.0"])
    expect(skipped[0]!.reason).toContain("latest alias")
  })
})

describe("cleanup core — planWithdraw", () => {
  test("denies version not recorded in withdrawn-versions.json", () => {
    const plan = planWithdraw({
      config: cli,
      version: "1.15.0",
      snapshot: { versionedPaths: ["ellamaka/v1.15.0"], tags: [] },
      aliases: {},
      withdrawn: { products: { "ellamaka-cli": [] } },
      fallbackVersion: "1.14.0",
    })
    expect(plan.allowed).toBe(false)
    expect(plan.reason).toContain("not in withdrawn-versions.json")
  })

  test("requires a healthy fallback when restoring latest (cli manifest-only)", () => {
    const snapshot = { versionedPaths: ["ellamaka/v1.16.0", "ellamaka/v1.15.0"], tags: [] }
    const aliases = { "ellamaka/latest/manifest.json": "1.16.0" }
    const withdrawn = { products: { "ellamaka-cli": ["1.16.0"] } }

    const ok = planWithdraw({ config: cli, version: "1.16.0", snapshot, aliases, withdrawn, fallbackVersion: "1.15.0" })
    expect(ok.allowed).toBe(true)
    expect(ok.steps).toContainEqual({ action: "restore-alias", target: "ellamaka/latest/manifest.json" })
    expect(ok.steps).toContainEqual({ action: "delete-versioned-path", target: "ellamaka/v1.16.0" })
    expect(ok.steps).toContainEqual({ action: "delete-tag", target: "ellamaka-cli-v1.16.0" })

    const missing = planWithdraw({ config: cli, version: "1.16.0", snapshot, aliases, withdrawn, fallbackVersion: "1.99.0" })
    expect(missing.allowed).toBe(false)
    expect(missing.reason).toContain("not found in versioned paths")
  })

  test("rejects a fallback that is itself withdrawn", () => {
    const snapshot = { versionedPaths: ["ellamaka/v1.16.0", "ellamaka/v1.15.0"], tags: [] }
    const aliases = { "ellamaka/latest/manifest.json": "1.16.0" }
    const withdrawn = { products: { "ellamaka-cli": ["1.16.0", "1.15.0"] } }
    const plan = planWithdraw({ config: cli, version: "1.16.0", snapshot, aliases, withdrawn, fallbackVersion: "1.15.0" })

    expect(plan.allowed).toBe(false)
    expect(plan.reason).toContain("itself withdrawn")
  })

  test("desktop uses restore-latest-channel for a beta withdrawal", () => {
    const snapshot = {
      versionedPaths: ["ellamaka-desktop/beta/v1.16.0-beta.1", "ellamaka-desktop/beta/v1.15.0-beta.2"],
      tags: [],
    }
    const aliases = { "ellamaka-desktop/beta/latest/manifest.json": "1.16.0-beta.1" }
    const withdrawn = { products: { "ellamaka-desktop": ["1.16.0-beta.1"] } }
    const plan = planWithdraw({
      config: desktop,
      version: "1.16.0-beta.1",
      snapshot,
      aliases,
      withdrawn,
      fallbackVersion: "1.15.0-beta.2",
    })

    expect(plan.allowed).toBe(true)
    expect(plan.steps).toContainEqual({ action: "restore-latest-channel", target: "ellamaka-desktop/beta/latest" })
    expect(plan.steps).toContainEqual({ action: "delete-versioned-path", target: "ellamaka-desktop/beta/v1.16.0-beta.1" })
    expect(plan.steps).toContainEqual({ action: "delete-tag", target: "ellamaka-desktop-v1.16.0-beta.1" })
  })
})
