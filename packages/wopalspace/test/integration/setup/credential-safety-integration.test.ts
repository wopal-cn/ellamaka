import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileCredentials } from "../../../src/setup"

const NL = String.fromCharCode(10)

function temporaryHome(prefix = "wopal-setup-credential-safety-"): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe("credential writes fail closed", () => {
  test("a malformed auth.json is preserved byte for byte and the write fails", async () => {
    const home = temporaryHome()
    try {
      const dataDir = join(home, "ellamaka", "data")
      mkdirSync(dataDir, { recursive: true })
      const authPath = join(dataDir, "auth.json")
      const broken = '{ "opencode-go": { "type": "api", "key": "kept" '
      writeFileSync(authPath, broken)

      const written = await fileCredentials(home).setProviderKey({
        providerId: "another",
        apiKey: "sk-new",
      })

      expect(written.ok).toBe(false)
      expect(readFileSync(authPath, "utf8")).toBe(broken)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("auth.json holding a non-object document is not overwritten", async () => {
    const home = temporaryHome()
    try {
      const dataDir = join(home, "ellamaka", "data")
      mkdirSync(dataDir, { recursive: true })
      const authPath = join(dataDir, "auth.json")
      const original = '["not", "an", "object"]'
      writeFileSync(authPath, original)

      const written = await fileCredentials(home).setProviderKey({ providerId: "p", apiKey: "sk-x" })

      expect(written.ok).toBe(false)
      expect(readFileSync(authPath, "utf8")).toBe(original)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("an unreadable .env is not replaced by a token-only file", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return
    const home = temporaryHome()
    try {
      const envPath = join(home, ".env")
      const original = "SECRET_KEEP=1" + NL
      writeFileSync(envPath, original)
      chmodSync(envPath, 0o000)

      const written = await fileCredentials(home).setGithubToken("placeholder")

      expect(written.ok).toBe(false)
      chmodSync(envPath, 0o600)
      expect(readFileSync(envPath, "utf8")).toBe(original)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("an unreadable auth.json is not replaced by a single-provider file", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return
    const home = temporaryHome()
    try {
      const dataDir = join(home, "ellamaka", "data")
      mkdirSync(dataDir, { recursive: true })
      const authPath = join(dataDir, "auth.json")
      const original = ["{", '  "other": { "type": "api", "key": "keep" }', "}", ""].join(NL)
      writeFileSync(authPath, original)
      chmodSync(authPath, 0o000)

      const written = await fileCredentials(home).setProviderKey({ providerId: "p", apiKey: "sk-x" })

      expect(written.ok).toBe(false)
      chmodSync(authPath, 0o600)
      expect(readFileSync(authPath, "utf8")).toBe(original)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("a valid auth.json with unknown fields still merges and keeps them", async () => {
    const home = temporaryHome()
    try {
      const dataDir = join(home, "ellamaka", "data")
      mkdirSync(dataDir, { recursive: true })
      const authPath = join(dataDir, "auth.json")
      writeFileSync(
        authPath,
        JSON.stringify({ unknownTopLevel: { keep: true }, existing: { type: "api", key: "keep" } }),
      )

      const written = await fileCredentials(home).setProviderKey({ providerId: "p", apiKey: "sk-x" })
      expect(written.ok).toBe(true)

      const parsed: unknown = JSON.parse(readFileSync(authPath, "utf8"))
      const record = Object.fromEntries(Object.entries(parsed && typeof parsed === "object" ? parsed : {}))
      expect(JSON.stringify(record.unknownTopLevel)).toContain("keep")
      expect(JSON.stringify(record.existing)).toContain("keep")
      expect(JSON.stringify(record.p)).toContain("sk-x")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
