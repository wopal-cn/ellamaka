import { describe, expect, test } from "bun:test"
import fs from "fs/promises"

// Plugin dependency writes now live behind explicit preparation boundaries.
// Both the instance contributor and the non-Space compatibility preparation
// must pin the branded plugin contract package at the prerelease-stripped base
// version. Config/TUI readers must not carry their own install pin anymore.
const PIN_CONSUMERS = {
  instance: new URL("../../../ellamaka-core/src/plugin-dependencies.ts", import.meta.url),
  compatibility: new URL("../../src/core/plugin-dependency-preparation.ts", import.meta.url),
} as const

const READ_SURFACES = {
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
      expect(source).not.toMatch(/InstallationVersion(?!Base|Local)/)
      expect(source).toContain("InstallationVersionBase")
    }
  })

  test("has one pin per explicit preparation implementation and none in config readers", async () => {
    const instance = await readSource(PIN_CONSUMERS.instance)
    const compatibility = await readSource(PIN_CONSUMERS.compatibility)

    expect((instance.match(/const HOST_PLUGIN_CONTRACT = "@wopal\/ellamaka-plugin"/g) ?? []).length).toBe(1)
    expect((instance.match(/name: HOST_PLUGIN_CONTRACT/g) ?? []).length).toBe(1)
    expect((compatibility.match(/name: "@wopal\/ellamaka-plugin"/g) ?? []).length).toBe(1)

    for (const url of Object.values(READ_SURFACES)) {
      const source = await readSource(url)
      expect(source).not.toContain("name: HOST_PLUGIN_CONTRACT")
      expect(source).not.toContain('name: "@wopal/ellamaka-plugin"')
    }
  })
})
