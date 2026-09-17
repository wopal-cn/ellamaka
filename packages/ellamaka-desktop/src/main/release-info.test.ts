import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readEmbeddedReleaseIdentity, createReleaseInfo, validateEmbeddedIdentity } from "./release-info"

const COMMIT_40 = "91a7db1f22a2007588ee2a62e5d738b7d8e80291"
const UPSTREAM_COMMIT_40 = "385cb694419f98103af0e8fc6187ddcbcbb6eecb"

function validReleaseIdentity(version = "1.16.2", channel = "stable") {
  return {
    schemaVersion: 2,
    kind: "release" as const,
    product: "ellamaka-desktop",
    version,
    channel,
    upstream: { name: "opencode", version: "1.15.13", gitCommit: UPSTREAM_COMMIT_40 },
    build: {
      sourceTag: `ellamaka-desktop-v${version}`,
      gitCommit: COMMIT_40,
      builtAt: "2026-08-03T08:30:00Z",
      workflowRunId: "123456789",
    },
  }
}

function validDevIdentity(version = "0.0.0-dev.385cb694") {
  return {
    schemaVersion: 2,
    kind: "development" as const,
    product: "ellamaka-desktop",
    version,
    channel: "local",
    build: { gitCommit: COMMIT_40, builtAt: "2026-08-03T08:30:00Z" },
  }
}

describe("release info (legacy createReleaseInfo)", () => {
  test("identifies a retagged build with its immutable commit", () => {
    expect(createReleaseInfo("1.15.13-beta.1", "91a7db1f22a2007588ee2a62e5d738b7d8e80291")).toEqual({
      version: "1.15.13-beta.1",
      build: "91a7db1f22a2007588ee2a62e5d738b7d8e80291",
      displayVersion: "1.15.13-beta.1 (91a7db1f22a2)",
    })
  })

  test("keeps local builds readable without a release commit", () => {
    expect(createReleaseInfo("1.15.13")).toEqual({
      version: "1.15.13",
      build: undefined,
      displayVersion: "1.15.13",
    })
  })
})

describe("embedded release identity", () => {
  test("reads a valid release identity from resources", () => {
    const dir = mkdtempSync(join(tmpdir(), "ellamaka-desktop-identity-"))
    try {
      writeFileSync(join(dir, "release-identity.json"), JSON.stringify(validReleaseIdentity()))
      const identity = readEmbeddedReleaseIdentity(dir)
      expect(identity.kind).toBe("release")
      expect(identity.product).toBe("ellamaka-desktop")
      expect(identity.version).toBe("1.16.2")
      expect(identity.build.sourceTag).toBe("ellamaka-desktop-v1.16.2")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("reads a valid development identity from resources", () => {
    const dir = mkdtempSync(join(tmpdir(), "ellamaka-desktop-identity-"))
    try {
      writeFileSync(join(dir, "release-identity.json"), JSON.stringify(validDevIdentity()))
      const identity = readEmbeddedReleaseIdentity(dir)
      expect(identity.kind).toBe("development")
      expect(identity.channel).toBe("local")
      expect(identity.build.sourceTag).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns null when identity file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ellamaka-desktop-identity-"))
    try {
      const identity = readEmbeddedReleaseIdentity(dir)
      expect(identity).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns null for corrupt identity JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "ellamaka-desktop-identity-"))
    try {
      writeFileSync(join(dir, "release-identity.json"), "{not valid json")
      const identity = readEmbeddedReleaseIdentity(dir)
      expect(identity).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("embedded identity validation against app metadata", () => {
  test("accepts release identity matching app version and channel", () => {
    const identity = validReleaseIdentity("1.16.2", "stable")
    expect(() => validateEmbeddedIdentity(identity, { version: "1.16.2", channel: "stable" })).not.toThrow()
  })

  test("accepts beta identity matching beta channel", () => {
    const identity = validReleaseIdentity("1.17.0-beta.1", "beta")
    expect(() => validateEmbeddedIdentity(identity, { version: "1.17.0-beta.1", channel: "beta" })).not.toThrow()
  })

  test("rejects identity version mismatch with app version", () => {
    const identity = validReleaseIdentity("1.16.2", "stable")
    expect(() => validateEmbeddedIdentity(identity, { version: "1.16.3", channel: "stable" })).toThrow(/version/)
  })

  test("rejects release identity with wrong product", () => {
    const identity = { ...validReleaseIdentity(), product: "ellamaka-cli" }
    expect(() => validateEmbeddedIdentity(identity, { version: "1.16.2", channel: "stable" })).toThrow(/product/)
  })

  test("rejects channel mismatch (stable identity on beta channel)", () => {
    const identity = validReleaseIdentity("1.16.2", "stable")
    expect(() => validateEmbeddedIdentity(identity, { version: "1.16.2", channel: "beta" })).toThrow(/channel/)
  })

  test("accepts development identity without strict version match", () => {
    const identity = validDevIdentity()
    // Development identity is allowed to have a dev version that differs
    // from app.getVersion(); only product must match.
    expect(() => validateEmbeddedIdentity(identity, { version: "1.15.13", channel: "main" })).not.toThrow()
  })
})

describe("feed to identity channel vocabulary", () => {
  test("stable feed validates a stable release identity", () => {
    const identity = validReleaseIdentity("1.16.2", "stable")
    expect(() => validateEmbeddedIdentity(identity, { version: "1.16.2", channel: "stable" })).not.toThrow()
  })

  test("beta feed validates a beta release identity", () => {
    const identity = validReleaseIdentity("1.17.0-beta.1", "beta")
    expect(() => validateEmbeddedIdentity(identity, { version: "1.17.0-beta.1", channel: "beta" })).not.toThrow()
  })

  test("main feed validates a local development identity", () => {
    const identity = validDevIdentity()
    expect(() => validateEmbeddedIdentity(identity, { version: "1.15.13", channel: "main" })).not.toThrow()
  })
})
