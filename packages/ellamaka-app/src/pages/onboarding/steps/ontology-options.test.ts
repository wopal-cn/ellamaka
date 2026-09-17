import { describe, expect, test } from "bun:test"
import { ONTOLOGY_MODES, ONTOLOGY_SOURCES } from "./ontology-options"

describe("ontology onboarding options", () => {
  test("offers only remote official and custom sources", () => {
    expect(ONTOLOGY_SOURCES.map((source) => source.id)).toEqual(["official", "custom"])
    expect(ONTOLOGY_SOURCES.some((source) => source.id === "local")).toBe(false)
  })

  test("recommends fork and declares its GitHub requirement", () => {
    expect(ONTOLOGY_MODES).toHaveLength(2)
    expect(ONTOLOGY_MODES.find((mode) => mode.id === "fork")).toMatchObject({
      recommended: true,
      requiresGithubAuth: true,
    })
    expect(ONTOLOGY_MODES.find((mode) => mode.id === "clone")).toMatchObject({
      recommended: false,
      requiresGithubAuth: false,
    })
  })
})
