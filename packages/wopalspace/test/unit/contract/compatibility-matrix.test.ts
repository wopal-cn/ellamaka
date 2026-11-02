import { describe, expect, test } from "bun:test"
import { compatibilityBaseline } from "../../fixtures/compatibility/matrix"

describe("WopalSpace refactor compatibility matrix", () => {
  test("covers every migrated owner with unique, evidenced behavior", () => {
    const owners = new Set(compatibilityBaseline.cases.map((entry) => entry.owner))
    const ids = compatibilityBaseline.cases.map((entry) => entry.id)

    expect(compatibilityBaseline.baseCommit).toBe("c2de827fe3ae6741b99756dc4f716f735f6fb397")
    expect([...owners].sort()).toEqual(["ontology", "setup", "space", "workbench"])
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of compatibilityBaseline.cases) {
      expect(entry.evidence.length).toBeGreaterThan(0)
      for (const evidence of entry.evidence) {
        expect(evidence.endsWith(".test.ts") || evidence.endsWith(".json")).toBe(true)
      }
    }
  })

  test("names every intentional target delta instead of treating it as a regression", () => {
    const deltas = compatibilityBaseline.intentionalDeltas.map((entry) => entry.id)

    expect(deltas).toContain("ontology-contribute-removed")
    expect(deltas).toContain("setup-web-only")
    expect(deltas).toContain("public-platform-app-bff-split")
    expect(new Set(deltas).size).toBe(deltas.length)
    for (const entry of compatibilityBaseline.intentionalDeltas) {
      expect(entry.design).toContain("DESIGN-")
      expect(entry.owners.length).toBeGreaterThan(0)
    }
  })
})
