import { describe, expect, test } from "bun:test"
import fs from "fs/promises"

// The engine pins the fork plugin contract package whenever it installs plugin
// dependencies. The pin must target the branded package at the prerelease-
// stripped base version — the upstream name belongs to OpenCode and the raw
// `InstallationVersion` may carry an rc/beta tag that does not exist on npm.
//
// The pin is literal code (no shared constant), so this guard reads the two
// consumer sources directly, mirroring the source-level assertions already used
// in `test/config/wopal-space-deps.test.ts`.
const PIN_CONSUMERS = {
  config: new URL("../../src/config/config.ts", import.meta.url),
  tui: new URL("../../src/cli/cmd/tui/config/tui.ts", import.meta.url),
} as const

// Assembled so the repository contains no literal reference to the upstream
// package name the fork must not depend on.
const LEGACY_SCOPE = "@opencode-ai/"

async function readSource(url: URL): Promise<string> {
  return fs.readFile(url, "utf8")
}

describe("plugin contract pin", () => {
  test("targets the branded package, never the upstream name", async () => {
    for (const url of Object.values(PIN_CONSUMERS)) {
      const source = await readSource(url)
      expect(source).not.toContain(`${LEGACY_SCOPE}plugin`)
      expect(source).toContain("@wopal/ellamaka-plugin")
    }
  })

  test("resolves the version from the prerelease-stripped base export", async () => {
    for (const url of Object.values(PIN_CONSUMERS)) {
      const source = await readSource(url)
      // A bare `InstallationVersion` reference would pin a prerelease tag such
      // as `2.0.5-rc.7`, which does not exist on npm.
      expect(source).not.toMatch(/InstallationVersion(?!Base)/)
      expect(source).toContain("InstallationVersionBase")
    }
  })

  test("has one pin per install site", async () => {
    const count = async (url: URL) => ((await readSource(url)).match(/name: "@wopal\/ellamaka-plugin"/g) ?? []).length
    // config.ts: wopal-space install, fingerprint install + manifest, global
    // install + manifest. tui.ts: TUI plugin dir install.
    expect(await count(PIN_CONSUMERS.config)).toBe(5)
    expect(await count(PIN_CONSUMERS.tui)).toBe(1)
  })
})
