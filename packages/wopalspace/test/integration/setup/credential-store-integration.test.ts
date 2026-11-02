import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileCredentials, mergeEnvVariable } from "../../../src/setup"

const NL = String.fromCharCode(10)

function temporaryHome(): string {
  return mkdtempSync(join(tmpdir(), "wopal-setup-credentials-"))
}

describe("setup credential files", () => {
  test("setGithubToken writes the token value through the protected credential store", async () => {
    const home = temporaryHome()
    try {
      const store = fileCredentials(home)
      const written = await store.setGithubToken("placeholder")
      expect(written.ok).toBe(true)
      expect(readFileSync(join(home, ".env"), "utf8")).toContain("GITHUB_TOKEN=placeholder")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("mergeEnvVariable replaces an active entry, revives a commented one and appends a missing one", () => {
    expect(mergeEnvVariable("A=1" + NL + "GITHUB_TOKEN=old" + NL, "GITHUB_TOKEN", "new")).toBe(
      "A=1" + NL + "GITHUB_TOKEN=new" + NL,
    )
    expect(mergeEnvVariable("# GITHUB_TOKEN=old" + NL, "GITHUB_TOKEN", "new")).toBe("GITHUB_TOKEN=new" + NL)
    expect(mergeEnvVariable("A=1" + NL, "GITHUB_TOKEN", "new")).toBe("A=1" + NL + "GITHUB_TOKEN=new" + NL)
    expect(mergeEnvVariable("", "GITHUB_TOKEN", "new")).toBe("GITHUB_TOKEN=new" + NL)
  })

  test("providerIds ignores unrelated auth.json content and keeps credential entries", async () => {
    const home = temporaryHome()
    try {
      mkdirSync(join(home, "ellamaka", "data"), { recursive: true })
      writeFileSync(
        join(home, "ellamaka", "data", "auth.json"),
        JSON.stringify({ note: "keep", "opencode-go": { type: "api", key: "sk-x" } }),
      )
      expect(await fileCredentials(home).providerIds()).toEqual(["opencode-go"])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
