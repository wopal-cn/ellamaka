import { describe, expect, test } from "bun:test"
import { normalizeOntologyResult } from "./ontology-result"

describe("ontology result summary", () => {
  test("preserves remote locations and every available Space type", () => {
    const result = normalizeOntologyResult({
      ontologyPath: "/tmp/wopal/ontologies/wopal-space-ontology",
      remoteUrl: "https://github.com/samuel/wopal-space-ontology",
      upstreamUrl: "https://github.com/wopal-cn/wopal-space-ontology",
      availableTypes: [
        { type: "common", branch: "main" },
        { type: "coding", branch: "type/coding" },
        { type: "content", branch: "type/content" },
      ],
    }, "fork", "official")

    expect(result.remoteUrl).toBe("https://github.com/samuel/wopal-space-ontology")
    expect(result.upstreamUrl).toBe("https://github.com/wopal-cn/wopal-space-ontology")
    expect(result.localPath).toBe("/tmp/wopal/ontologies/wopal-space-ontology")
    expect(result.availableTypes).toEqual([
      { type: "common", branch: "main" },
      { type: "coding", branch: "type/coding" },
      { type: "content", branch: "type/content" },
    ])
  })
})
