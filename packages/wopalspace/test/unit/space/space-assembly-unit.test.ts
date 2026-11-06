import { describe, expect, it } from "bun:test"
import {
  findGenericPathsOverlap,
  findPluginSectionConflict,
  genericPathCollision,
  parseArchetypeDocument,
  parseCapabilityRefShape,
  parsePluginSections,
  parseSpaceSchemaDocument,
} from "../../../src/space/assembly"
import {
  buildAssemblyState,
  canonicalCapabilityRef,
  repositoryPathForCapabilityRef,
  serializeAssemblyState,
  validateAssemblyState,
  withSelection,
} from "../../../src/space/selection"
import { computeEffectivePatterns } from "../../../src/space/assembly-tree"
import { spaceBranchName, normalizeSpaceName } from "../../../src/space/registry"

describe("capability reference shapes", () => {
  it("decides the form from the ending and normalizes directory spellings", () => {
    expect(parseCapabilityRefShape("commands/init.md")).toMatchObject({ form: "file", target: "commands/init.md" })
    // Only the dotted ".noext" marker marks an extension-less file; a bare
    // trailing segment stays a directory reference.
    expect(parseCapabilityRefShape("skills/dev-flow/noext")).toMatchObject({ form: "directory" })
    expect(parseCapabilityRefShape("skills/dev-flow.noext")).toMatchObject({ form: "noext", target: "skills/dev-flow" })
    expect(parseCapabilityRefShape("commands/*.md")).toMatchObject({ form: "set", target: "commands", setSuffix: "md" })
    expect(parseCapabilityRefShape("skills/dev-flow/")).toMatchObject({ form: "directory", ref: "skills/dev-flow" })
    expect(parseCapabilityRefShape("skills/dev-flow/*")).toMatchObject({ form: "directory", ref: "skills/dev-flow" })
    expect(parseCapabilityRefShape("v1.2/")).toMatchObject({ form: "directory", ref: "v1.2/" })
  })

  it("refuses absolute, traversing, backslash and misplaced wildcard references", () => {
    for (const ref of ["/abs", "a/../b", "a\\b", "a//b", "", "*/x.md", "a/*.md/x"]) {
      expect(() => parseCapabilityRefShape(ref)).toThrow()
    }
  })
})

describe("archetype manifests", () => {
  it("parses a sectioned manifest and lists plugin names per section", () => {
    const outcome = parseArchetypeDocument(
      [
        "version: 1",
        "type: coding",
        "skills:",
        "  - dev-flow",
        "plugins:",
        "  ellamaka:",
        "    - my-plugin",
        "  tui:",
        "    - other",
      ].join("\n"),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.manifest.plugins).toEqual({ ellamaka: ["my-plugin"], tui: ["other"] })
    expect(outcome.manifest.skills).toEqual(["dev-flow"])
    expect(outcome.manifest.paths).toEqual([])
  })

  it("refuses a flat plugin list and a plugin declared under two sections", () => {
    expect(parseArchetypeDocument(["version: 1", "type: coding", "plugins:", "  - my-plugin"].join("\n")).ok).toBe(
      false,
    )
    expect(
      parseArchetypeDocument(
        ["version: 1", "type: coding", "plugins:", "  a:", "    - p", "  b:", "    - p"].join("\n"),
      ),
    ).toMatchObject({ ok: false, conflict: { name: "p", sections: ["a", "b"] } })
  })

  it("keeps open section names as ordinary own keys", () => {
    const sections = parsePluginSections(JSON.parse('{"__proto__": ["p"], "constructor": ["q"]}'))
    expect(sections).not.toBeNull()
    expect(Object.keys(sections ?? {})).toEqual(["__proto__", "constructor"])
    expect(findPluginSectionConflict({ __proto__: ["x"], constructor: ["y"] })).toBeNull()
  })

  it("refuses overlapping generic path declarations", () => {
    expect(findGenericPathsOverlap(["dsh", "dsh/nested"])).toEqual(["dsh", "dsh/nested"])
    expect(findGenericPathsOverlap(["dsh", "docs"])).toBeNull()
  })

  it("refuses generic paths inside reserved or capability directories", () => {
    expect(genericPathCollision("assembly/x", "directory")).toMatchObject({ kind: "reserved" })
    expect(genericPathCollision("skills/dev-flow", "directory")).toMatchObject({ kind: "category" })
    expect(genericPathCollision("README.md", "file")).toMatchObject({ kind: "root-file" })
    expect(genericPathCollision("dsh", "directory")).toBeNull()
  })
})

describe("space schemas", () => {
  it("validates the runtime/space structure and refuses file entries without targets", () => {
    const valid = parseSpaceSchemaDocument(
      [
        "version: 1",
        "runtime:",
        "  path: .wopal-space",
        "  files: []",
        "  dirs: []",
        "space:",
        "  files: []",
        "  dirs: []",
      ].join("\n"),
      "test",
    )
    expect(valid.runtime.path).toBe(".wopal-space")
    expect(() =>
      parseSpaceSchemaDocument(
        [
          "version: 1",
          "runtime:",
          "  path: .wopal",
          "  files:",
          "    - template: x",
          "  dirs: []",
          "space:",
          "  files: []",
          "  dirs: []",
        ].join("\n"),
        "test",
      ),
    ).toThrow(/file entry without template\/target/)
  })
})

describe("selection references", () => {
  it("canonicalizes kind and target, and maps to repository paths", () => {
    expect(canonicalCapabilityRef("skill:dev-flow/")).toBe("skill:dev-flow")
    expect(repositoryPathForCapabilityRef("skill:dev-flow")).toBe("skills/dev-flow")
    expect(repositoryPathForCapabilityRef("path:dsh")).toBe("dsh")
    expect(() => canonicalCapabilityRef("dev-flow")).toThrow(/kind/)
    expect(() => canonicalCapabilityRef("unknown:x")).toThrow(/unknown kind/)
  })

  it("keeps the two sets mutually exclusive and refuses overlapping assets", () => {
    const state = buildAssemblyState({ type: "coding", schema: "coding-space-schema.yaml", ontology: "test-onto" })
    const withInclude = withSelection(state, "include", "skill:dev-flow")
    expect(withInclude.include).toEqual(["skill:dev-flow"])
    expect(() => withSelection(withInclude, "exclude", "skill:dev-flow/noext")).toThrow(/overlaps/)
    expect(withSelection(withInclude, "include", "skill:dev-flow", { remove: true }).include).toEqual([])
  })

  it("validates a snapshot strictly and round-trips canonical bytes", () => {
    const state = buildAssemblyState({
      type: "coding",
      schema: "coding-space-schema.yaml",
      ontology: "test-onto",
      include: ["rule:typescript.md", "command:wopal/memo.md"],
    })
    const raw = serializeAssemblyState(state)
    expect(raw.endsWith("\n")).toBe(true)
    expect(JSON.parse(raw).include).toEqual(["command:wopal/memo.md", "rule:typescript.md"])
    expect(validateAssemblyState(JSON.parse(raw))).toMatchObject({ ok: true })

    expect(validateAssemblyState({ version: 1, type: "coding", schema: "s", source: { ontology: "o" } })).toMatchObject(
      { ok: false },
    )
    expect(validateAssemblyState(JSON.parse(raw.replace('"skill', '"Skill')))).toBeDefined()
    const duplicated = { ...JSON.parse(raw), include: ["rule:typescript.md"], exclude: ["rule:typescript.md"] }
    expect(validateAssemblyState(duplicated)).toMatchObject({ ok: false })
  })
})

describe("effective sparse range", () => {
  const always = ["/assembly/templates/", "/config/"]

  it("adds mount paths and removes shadows while keeping always-assembled members", () => {
    const patterns = computeEffectivePatterns(
      ["/config/", "/assembly/templates/", "/skills/dev-flow/", "/rules/typescript.md"],
      always,
      ["skills/extra/"],
      ["rules/typescript.md"],
    )
    expect(patterns).toContain("/skills/extra/")
    expect(patterns).toContain("/skills/dev-flow/")
    expect(patterns).not.toContain("/rules/typescript.md")
    expect(patterns).toContain("/config/")
  })

  it("never shadows an always-assembled member", () => {
    const patterns = computeEffectivePatterns(["/config/", "/assembly/templates/"], always, [], ["config"])
    expect(patterns).toEqual(["/assembly/templates/", "/config/"])
  })
})

describe("space names", () => {
  it("derives the branch from the stable registry name", () => {
    expect(spaceBranchName("My-Space_1")).toBe("space/My-Space_1")
    expect(() => normalizeSpaceName("constructor/../x")).toThrow(/Invalid Space name/)
  })
})
