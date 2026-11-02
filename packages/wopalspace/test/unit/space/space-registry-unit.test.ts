import { describe, expect, it } from "bun:test"
import {
  normalizeSpaceName,
  registeredSpaces,
  requireRegisteredSpace,
  spaceBranchName,
} from "../../../src/space/registry"
import { resolveRegisteredSpace } from "../../../src/space/resolve"
import type { SpaceRegistryReading } from "../../../src/space/types"

/** A registry whose own keys are ordinary data, built without any filesystem. */
function reading(names: readonly string[]): SpaceRegistryReading {
  const spaces: Record<string, SpaceRegistryReading["spaces"][string]> = Object.create(null)
  for (const name of names) {
    spaces[name] = {
      name,
      displayName: name,
      path: "/spaces/" + name,
      branch: "space/" + name,
      type: "coding",
    }
  }
  return { path: "/home/config/settings.jsonc", raw: undefined, spaces, ontologies: Object.create(null) }
}

describe("space registry names", () => {
  it("accepts the stable name grammar and builds the space branch", () => {
    expect(normalizeSpaceName("my-space_1.2")).toBe("my-space_1.2")
    expect(spaceBranchName("my-space")).toBe("space/my-space")
  })

  it("rejects names that are not registry keys", () => {
    for (const name of ["", ".", "..", "-leading", "with space", "with/slash"]) {
      expect(() => normalizeSpaceName(name)).toThrow(/Invalid Space name/)
    }
  })

  it("lists registered spaces in name order", () => {
    expect(registeredSpaces(reading(["b", "a"])).map((space) => space.name)).toEqual(["a", "b"])
  })

  it("does not resolve inherited object names as registered spaces", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(() => requireRegisteredSpace(reading(["real"]), name)).toThrow(/not registered/)
      expect(() => resolveRegisteredSpace(registeredSpaces(reading(["real"])), { name })).toThrow(/not registered/)
    }
    // "__proto__" fails the stable-name grammar before any lookup happens.
    expect(() => requireRegisteredSpace(reading(["real"]), "__proto__")).toThrow(/Invalid Space name/)
  })

  it("still resolves an explicitly registered space named like an object member", () => {
    const registry = reading(["constructor"])
    expect(requireRegisteredSpace(registry, "constructor").path).toBe("/spaces/constructor")
  })
})
