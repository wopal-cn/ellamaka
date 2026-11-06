import { describe, expect, it } from "bun:test"
import { isPathInPatterns, patternCovers, protectedPatterns } from "../../../src/space/assembly-ops"
import { buildAssemblyState, withSelection } from "../../../src/space/selection"
import { mountPatternPaths, shadowedPaths } from "../../../src/space/selection"

describe("space range matching", () => {
  it("treats a trailing slash as a directory prefix and a bare path as exact", () => {
    expect(patternCovers("/skills/dev-flow/", "skills/dev-flow/SKILL.md")).toBe(true)
    expect(patternCovers("/skills/dev-flow/", "skills/dev-flow-extra/SKILL.md")).toBe(false)
    expect(patternCovers("/rules/typescript.md", "rules/typescript.md")).toBe(true)
    expect(patternCovers("/rules/typescript.md", "rules/typescript.md.bak")).toBe(false)
  })

  it("matches any pattern in a set", () => {
    expect(isPathInPatterns("assembly/templates/x.md", ["/config/"])).toBe(false)
    expect(isPathInPatterns("assembly/templates/x.md", protectedPatterns())).toBe(true)
  })
})

describe("space selection projections", () => {
  it("projects include into range inputs and exclude into shadows", () => {
    let state = buildAssemblyState({ type: "coding", schema: "s.yaml", ontology: "test-onto" })
    state = withSelection(state, "include", "skill:dev-flow")
    state = withSelection(state, "exclude", "rule:typescript.md")
    state = withSelection(state, "include", "path:dsh")

    expect(mountPatternPaths(state)).toEqual(["dsh/", "skills/dev-flow/"])
    expect(shadowedPaths(state)).toEqual(["rules/typescript.md"])
  })

  it("moves one asset between sets instead of duplicating it, and refuses nested overlaps", () => {
    const base = buildAssemblyState({ type: "coding", schema: "s.yaml", ontology: "test-onto" })
    const included = withSelection(base, "include", "skill:dev-flow")
    const excluded = withSelection(included, "exclude", "skill:dev-flow")
    expect(excluded.include).toEqual([])
    expect(excluded.exclude).toEqual(["skill:dev-flow"])
    expect(() => withSelection(excluded, "include", "path:skills/dev-flow/extra")).toThrow(/overlaps/)
  })
})
