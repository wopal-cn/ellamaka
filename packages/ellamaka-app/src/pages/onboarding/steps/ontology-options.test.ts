import { describe, expect, test } from "bun:test"
import { ONTOLOGY_MODES, ONTOLOGY_SOURCES } from "./ontology-options"

describe("ontology onboarding options", () => {
  test("offers only remote official and custom sources", () => {
    expect(ONTOLOGY_SOURCES.map((source) => source.id)).toEqual(["official", "custom"])
    expect(ONTOLOGY_SOURCES.some((source) => source.id === "local")).toBe(false)
  })

  test("recommends clone and declares fork's GitHub requirement", () => {
    expect(ONTOLOGY_MODES).toHaveLength(2)
    expect(ONTOLOGY_MODES.find((mode) => mode.id === "clone")).toMatchObject({
      recommended: true,
      requiresGithubAuth: false,
    })
    expect(ONTOLOGY_MODES.find((mode) => mode.id === "fork")).toMatchObject({
      recommended: false,
      requiresGithubAuth: true,
    })
  })

  test("frames fork as the advanced, contribution-oriented choice", () => {
    const fork = ONTOLOGY_MODES.find((mode) => mode.id === "fork")
    const clone = ONTOLOGY_MODES.find((mode) => mode.id === "clone")

    expect(fork?.summary).toContain("进阶")
    expect(clone?.summary).not.toContain("进阶")
  })
})
