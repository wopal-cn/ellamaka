import { describe, expect, test } from "bun:test"
import { applicationDomains } from "../src"

describe("WopalSpace application contract boundary", () => {
  test("owns Setup, Ontology, and Space without absorbing Runtime", () => {
    expect(applicationDomains).toEqual(["setup", "ontology", "space"])
    expect(applicationDomains.join(",")).not.toContain("runtime")
  })
})
