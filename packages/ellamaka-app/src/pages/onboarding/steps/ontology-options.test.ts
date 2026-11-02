import { describe, expect, test } from "bun:test"
import { defaultOntologyMode, ontologyModes, ONTOLOGY_MODES, ONTOLOGY_SOURCES } from "./ontology-options"

describe("ontology onboarding options", () => {
  test("offers only remote official and custom sources", () => {
    expect(ONTOLOGY_SOURCES.map((source) => source.id)).toEqual(["official", "custom"])
    expect(ONTOLOGY_SOURCES.some((source) => source.id === "local")).toBe(false)
  })

  test("gates fork on verified GitHub identity and chooses the matching default", () => {
    expect(ONTOLOGY_MODES).toHaveLength(2)
    expect(defaultOntologyMode(false)).toBe("clone")
    expect(ontologyModes(false).map((mode) => mode.id)).toEqual(["clone"])
    expect(ontologyModes(false)[0]?.recommended).toBe(true)

    expect(defaultOntologyMode(true)).toBe("fork")
    expect(ontologyModes(true).map((mode) => mode.id)).toEqual(["clone", "fork"])
    expect(ontologyModes(true).find((mode) => mode.id === "fork")).toMatchObject({
      recommended: true,
      requiresGithubAuth: true,
    })
  })

  test("frames fork as the advanced, contribution-oriented choice", () => {
    const fork = ONTOLOGY_MODES.find((mode) => mode.id === "fork")
    const clone = ONTOLOGY_MODES.find((mode) => mode.id === "clone")

    expect(fork?.summary).toContain("进阶")
    expect(clone?.summary).not.toContain("进阶")
  })

  test("an existing ontology mode is a repository fact, not recomputed from current identity", () => {
    expect(defaultOntologyMode(true)).toBe("fork")
    // Existing-mode preservation is consumed by the Ontology step; this
    // assertion keeps the fresh-install default separate from that fact.
    expect(defaultOntologyMode(false)).toBe("clone")
  })
})
