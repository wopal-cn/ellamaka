import { describe, expect, test } from "bun:test"
import { RuleName } from "../../src/rule/name"

// Pure-function regression for the rule name identity: the external name is a
// POSIX-style relative path and must not change with the host OS.
describe("rule name", () => {
  test("keeps posix relative paths unchanged", () => {
    expect(RuleName.normalizeRulePath("fae/astro.md")).toBe("fae/astro.md")
    expect(RuleName.normalizeRulePath("typescript.md")).toBe("typescript.md")
  })

  test("normalizes Windows-style backslashes", () => {
    expect(RuleName.normalizeRulePath("fae\\astro.md")).toBe("fae/astro.md")
    expect(RuleName.normalizeRulePath("deep\\nested\\notes.md")).toBe("deep/nested/notes.md")
  })

  test("infers the agent scope from a single-level subdirectory", () => {
    expect(RuleName.inferAgentScope("fae/astro.md")).toBe("fae")
    expect(RuleName.inferAgentScope("fae\\astro.md")).toBe("fae")
  })

  test("has no agent scope for root-level and deeper paths", () => {
    expect(RuleName.inferAgentScope("typescript.md")).toBeUndefined()
    expect(RuleName.inferAgentScope("shared.mdc")).toBeUndefined()
    expect(RuleName.inferAgentScope("deep/nested/notes.md")).toBeUndefined()
    expect(RuleName.inferAgentScope("deep\\nested\\notes.md")).toBeUndefined()
  })
})
