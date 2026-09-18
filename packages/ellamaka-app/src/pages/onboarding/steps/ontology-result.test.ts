import { describe, expect, test } from "bun:test"
import { normalizeOntologyResult } from "./ontology-result"

describe("ontology result summary", () => {
  test("preserves remote locations and every available Space type", () => {
    const result = normalizeOntologyResult({
      ontologyPath: "/tmp/wopal/ontologies/wopal-space-ontology",
      remoteUrl: "https://github.com/samuel/wopal-space-ontology",
      upstreamUrl: "https://github.com/wopal-cn/wopal-space-ontology",
      availableTypes: [
        { type: "coding", description: "软件工程空间" },
        { type: "content", description: null },
        { type: "ops" },
      ],
    }, "fork", "official")

    expect(result.remoteUrl).toBe("https://github.com/samuel/wopal-space-ontology")
    expect(result.upstreamUrl).toBe("https://github.com/wopal-cn/wopal-space-ontology")
    expect(result.localPath).toBe("/tmp/wopal/ontologies/wopal-space-ontology")
    expect(result.availableTypes).toEqual([
      { type: "coding", description: "软件工程空间" },
      { type: "content", description: null },
      { type: "ops", description: null },
    ])
  })

  test("keeps available types that carry no branch field", () => {
    const result = normalizeOntologyResult({
      availableTypes: [{ type: "coding", description: "软件工程空间" }],
    }, "clone", "official")

    expect(result.availableTypes).toEqual([{ type: "coding", description: "软件工程空间" }])
  })

  test("drops malformed entries and tolerates a missing type list", () => {
    const malformed = normalizeOntologyResult({
      availableTypes: [{ description: "无类型" }, null, "coding", { type: 7 }],
    }, "clone", "official")

    expect(malformed.availableTypes).toEqual([])

    const missing = normalizeOntologyResult({}, "clone", "official")
    expect(missing.availableTypes).toEqual([])
    expect(missing.localPath).toBe("")
  })

  test("only reports an upstream URL for fork mode", () => {
    const clone = normalizeOntologyResult({
      remoteUrl: "https://github.com/example/ontology",
      upstreamUrl: "https://github.com/example/ontology",
    }, "clone", "official")

    expect(clone.upstreamUrl).toBeUndefined()
  })
})
