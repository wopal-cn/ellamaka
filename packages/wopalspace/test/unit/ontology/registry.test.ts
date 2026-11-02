import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  normalizeOntologyName,
  normalizeOntologySource,
  ontologyInstallInputSchema,
  ontologyMode,
  parseOntologySettings,
} from "../../../src/ontology/registry"
import { OntologyServiceError, toPublicError } from "../../../src/ontology/types"

const decode = Schema.decodeUnknownSync

function errorCode(operation: () => unknown): string {
  try {
    operation()
  } catch (error) {
    if (error instanceof OntologyServiceError) return error.code
    throw error
  }
  throw new Error("expected an OntologyServiceError")
}

describe("Ontology registry contract", () => {
  test("uses clone by default, preserves fork, and rejects contradictory mode flags", () => {
    expect(ontologyMode({})).toBe("clone")
    expect(ontologyMode({ fork: true })).toBe("fork")
    expect(ontologyMode({ mode: "fork" })).toBe("fork")
    expect(ontologyMode({ mode: "fork", fork: true })).toBe("fork")
    expect(errorCode(() => ontologyMode({ mode: "clone", fork: true }))).toBe("ONTOLOGY_MODE_INVALID")
  })

  test("normalizes supported GitHub sources and rejects path-shaped or credential-bearing input", () => {
    for (const source of [
      "github.com/wopal-cn/wopal-space-ontology",
      "https://github.com/wopal-cn/wopal-space-ontology.git",
      "git@github.com:wopal-cn/wopal-space-ontology.git",
    ]) {
      expect(normalizeOntologySource(source)).toBe("https://github.com/wopal-cn/wopal-space-ontology")
    }
    expect(normalizeOntologySource(undefined)).toBe("https://github.com/wopal-cn/wopal-space-ontology")
    expect(normalizeOntologySource("default")).toBe("https://github.com/wopal-cn/wopal-space-ontology")
    expect(normalizeOntologySource("file:///tmp/onto.git")).toBe("file:///tmp/onto.git")
    for (const source of [
      "../local",
      "./local",
      "/tmp/ontology",
      "https://github.com/user/repo.git?token=x",
      "https://token@github.com/user/repo",
      "file://relative/path",
    ]) {
      expect(errorCode(() => normalizeOntologySource(source))).toBe("ONTOLOGY_SOURCE_INVALID")
    }
  })

  test("the install schema normalizes source at the boundary", () => {
    expect(
      decode(ontologyInstallInputSchema)({ name: "official", source: "github.com/wopal-cn/wopal-space-ontology" }),
    ).toEqual({
      name: "official",
      source: "https://github.com/wopal-cn/wopal-space-ontology",
    })
    expect(() => decode(ontologyInstallInputSchema)({ name: "official", source: "../local" })).toThrow()
  })

  test("ontology names address one child and never a path", () => {
    expect(normalizeOntologyName("wopal-space-ontology")).toBe("wopal-space-ontology")
    for (const name of ["", "../escape", "a/b", "a\\b", ".", "..", "-leading", " trailing", "name.lock"]) {
      expect(errorCode(() => normalizeOntologyName(name))).toBe("ONTOLOGY_NAME_INVALID")
    }
  })

  test("parses ontology and space entries while ignoring malformed ones", () => {
    const parsed = parseOntologySettings(
      [
        "{",
        "  // comment",
        '  "ontologies": { "official": { "path": "/home/ontologies/official", "upstream": "https://github.com/a/b", "custom": true } },',
        '  "spaces": { "demo": { "path": "/space", "ontology": "official", "branch": "space/demo", "type": "coding" } }',
        "}",
      ].join("\n"),
    )
    expect(parsed.entries.official).toEqual({ path: "/home/ontologies/official", upstream: "https://github.com/a/b" })
    expect(parsed.spaces.demo).toEqual({
      name: "demo",
      path: "/space",
      ontology: "official",
      branch: "space/demo",
      type: "coding",
    })
    expect(errorCode(() => parseOntologySettings("{"))).toBe("ONTOLOGY_REGISTRY_INVALID")
  })

  test("public errors are stable and never carry credentials", () => {
    expect(toPublicError(new Error("clone failed for https://user:secret@github.com/a/b"))).toEqual({
      code: "ONTOLOGY_OPERATION_FAILED",
      message: "clone failed for https://github.com/a/b",
    })
  })
})
