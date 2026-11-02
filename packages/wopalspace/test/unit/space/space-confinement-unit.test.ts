import { describe, expect, it } from "bun:test"
import { isPathWithin, normalizeRelativePath } from "../../../src/space/confinement"
import { resolveRegisteredSpace } from "../../../src/space/resolve"
import type { RegisteredSpace } from "../../../src/space/types"

const space = (name: string, path: string): RegisteredSpace => ({
  name,
  displayName: name,
  path,
  branch: "space/" + name,
  type: "coding",
})

const registered: RegisteredSpace[] = [
  space("outer", "/spaces/outer"),
  space("nested", "/spaces/outer/nested"),
  space("other", "/spaces/other"),
]

describe("space path confinement", () => {
  it("accepts a plain relative path unchanged", () => {
    expect(normalizeRelativePath("projects/app")).toBe("projects/app")
  })

  it("treats absent and dot-only paths as the registered root", () => {
    expect(normalizeRelativePath(undefined)).toBe("")
    expect(normalizeRelativePath("")).toBe("")
    expect(normalizeRelativePath(".")).toBe("")
    expect(normalizeRelativePath("./")).toBe("")
  })

  it("rejects parent traversal in any segment", () => {
    expect(() => normalizeRelativePath("../secret")).toThrow(/relative/i)
    expect(() => normalizeRelativePath("projects/../../secret")).toThrow(/relative/i)
    expect(() => normalizeRelativePath("projects\\..\\secret")).toThrow(/relative/i)
  })

  it("rejects absolute posix and windows paths", () => {
    expect(() => normalizeRelativePath("/etc/passwd")).toThrow(/relative/i)
    expect(() => normalizeRelativePath("C:\\Windows")).toThrow(/relative/i)
  })

  it("contains a path only at the root or under it", () => {
    expect(isPathWithin("/spaces/outer", "/spaces/outer")).toBe(true)
    expect(isPathWithin("/spaces/outer", "/spaces/outer/projects")).toBe(true)
    expect(isPathWithin("/spaces/outer", "/spaces/outerish")).toBe(false)
    expect(isPathWithin("/spaces/outer", "/spaces")).toBe(false)
  })
})

describe("space resolution", () => {
  it("resolves a stable registry name", () => {
    expect(resolveRegisteredSpace(registered, { name: "outer" }).path).toBe("/spaces/outer")
  })

  it("prefers the stable name over a directory", () => {
    const resolved = resolveRegisteredSpace(registered, { name: "other", directory: "/spaces/outer" })
    expect(resolved.name).toBe("other")
  })

  it("resolves a trusted directory inside a registered root to the most specific space", () => {
    expect(resolveRegisteredSpace(registered, { directory: "/spaces/outer/projects/app" }).name).toBe("outer")
    expect(resolveRegisteredSpace(registered, { directory: "/spaces/outer/nested/projects/app" }).name).toBe("nested")
  })

  it("fails with a stable error when the name is not registered", () => {
    expect(() => resolveRegisteredSpace(registered, { name: "missing" })).toThrow(/not registered/)
  })

  it("fails with a stable error when the directory is outside every registered root", () => {
    expect(() => resolveRegisteredSpace(registered, { directory: "/elsewhere/app" })).toThrow(/no registered space/i)
  })

  it("fails when neither a name nor a directory is supplied", () => {
    expect(() => resolveRegisteredSpace(registered, {})).toThrow(/space name or a trusted directory/i)
  })
})
