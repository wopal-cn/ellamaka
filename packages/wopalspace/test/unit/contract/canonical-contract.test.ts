import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  applicationDomains,
  hostContextSchema,
  publicErrorSchema,
  publicOperationCatalog,
  publicOperationNames,
  publicOperationSchema,
} from "../../../src"

describe("WopalSpace canonical contract", () => {
  test("publishes the complete DESIGN operation catalog without ontology.contribute", () => {
    expect(applicationDomains).toEqual(["setup", "ontology", "space", "product-settings"])
    expect(publicOperationCatalog.setup).toEqual([
      "setup.inspect",
      "setup.plan",
      "setup.execute",
      "setup.progress",
      "setup.progress.events",
      "setup.cancel",
      "setup.complete",
    ])
    expect(publicOperationCatalog.ontology).toEqual([
      "ontology.list",
      "ontology.install",
      "ontology.inspect",
      "ontology.refresh",
      "ontology.sync",
      "ontology.capability.list",
    ])
    expect(publicOperationCatalog.space).toEqual([
      "space.resolve",
      "space.list",
      "space.init",
      "space.projects.list",
      "space.files.list",
      "space.files.read",
      "space.search",
      "space.scan",
      "space.status",
      "space.sync",
      "space.capability.add",
      "space.capability.remove",
    ])
    expect(publicOperationCatalog["product-settings"]).toEqual([])
    expect(publicOperationNames).not.toContain("ontology.contribute")
  })

  test("decodes operation identifiers and rejects retired operations", () => {
    const decodeOperation = Schema.decodeUnknownSync(publicOperationSchema)
    expect(decodeOperation("space.files.read")).toBe("space.files.read")
    expect(() => decodeOperation("ontology.contribute")).toThrow()
  })

  test("host context and public errors share one schema shape across transports", () => {
    const decodeHost = Schema.decodeUnknownSync(hostContextSchema)
    const decodeError = Schema.decodeUnknownSync(publicErrorSchema)

    expect(decodeHost({ wopalHome: "/isolated/home", directory: "/isolated/space" })).toEqual({
      wopalHome: "/isolated/home",
      directory: "/isolated/space",
    })
    expect(decodeError({ code: "SPACE_NOT_FOUND", message: "missing", suggestion: "register it" })).toEqual({
      code: "SPACE_NOT_FOUND",
      message: "missing",
      suggestion: "register it",
    })
    expect(() => decodeHost({ wopalHome: 42 })).toThrow()
  })
})
