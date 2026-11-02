import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import materializationPatterns from "../../fixtures/compatibility/materialization-patterns.json"
import { createCompatibilityFixture } from "../../fixtures/compatibility/git-space"
import { prepareSpaceScenario } from "../../fixtures/compatibility/scenarios"

describe("WopalSpace compatibility fixtures", () => {
  test("reproduces isolated clone and fork topology with an assembly-backed Space", () => {
    const parent = mkdtempSync(join(tmpdir(), "wopalspace-compatibility-test-"))
    try {
      for (const mode of ["clone", "fork"] as const) {
        const fixture = createCompatibilityFixture(parent, mode)
        try {
          expect(fixture.home.startsWith(fixture.root)).toBe(true)
          expect(fixture.space.startsWith(fixture.root)).toBe(true)
          expect(fixture.git(fixture.ontology, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
          expect(fixture.git(fixture.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("space/demo-space")
          expect(fixture.git(fixture.ontology, "remote", "get-url", "origin")).toBe(fixture.origin)
          expect(fixture.git(fixture.ontology, "remote").split("\n")).toContain("origin")
          expect(fixture.git(fixture.ontology, "remote").split("\n").includes("upstream")).toBe(mode === "fork")

          const settings = JSON.parse(readFileSync(join(fixture.home, "config", "settings.jsonc"), "utf8"))
          expect(settings.ontologies["test-onto"]).toMatchObject({ path: fixture.ontology, fork: mode === "fork" })
          expect(settings.spaces["demo-space"]).toMatchObject({
            path: fixture.space,
            ontology: "test-onto",
            branch: "space/demo-space",
            type: "coding",
          })

          fixture.applySparse(materializationPatterns)
          expect(fixture.git(fixture.worktree, "ls-files", "AGENTS.md", "skills/dev-flow/SKILL.md")).toBe(
            "AGENTS.md\nskills/dev-flow/SKILL.md",
          )
          const scenario = createCompatibilityFixture(parent)
          try {
            expect(prepareSpaceScenario(scenario, "unique-and-stray")).toMatchObject({
              spaceName: "demo-space",
              spaceBranch: "space/demo-space",
            })
            expect(scenario.git(scenario.worktree, "log", "-1", "--format=%s")).toBe("feat: note")
            expect(scenario.git(scenario.worktree, "status", "--porcelain=v1")).toContain("?? rules/custom.md")
          } finally {
            scenario.dispose()
          }
        } finally {
          fixture.dispose()
        }
      }
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
