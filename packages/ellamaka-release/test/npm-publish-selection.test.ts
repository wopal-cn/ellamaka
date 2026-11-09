import { describe, expect, test } from "bun:test"
import { runPublishCli, type PublishCliDeps } from "../src/cli/publish-npm"
import { createRegistryProbe } from "../src/npm/execute"

const sdk = "@wopal/ellamaka-sdk"
const plugin = "@wopal/ellamaka-plugin"

function fixture() {
  const probes: string[] = []
  const logs: string[] = []
  const deps: PublishCliDeps = {
    loadTargets: () => [
      { dir: "packages/sdk/js", manifest: { name: sdk, version: "3.0.0", exports: { ".": "./src/index.ts" } } },
      { dir: "packages/plugin", manifest: { name: plugin, version: "2.1.0", exports: { ".": "./src/index.ts" } } },
    ],
    readSdkVersion: () => "3.0.0",
    isPublished: (name, version) => {
      probes.push(`${name}@${version}`)
      return false
    },
    verifySkipped: () => {},
    assertRegistryAuth: () => {},
    publishPackage: () => {},
    log: (line) => logs.push(line),
    logError: (line) => logs.push(line),
  }
  return { deps, probes, logs }
}

describe("explicit npm package selection", () => {
  test("SDK-only checks its own version and never probes Plugin", () => {
    const f = fixture()
    expect(runPublishCli(["--dry-run", "--package", sdk], f.deps)).toBe(0)
    expect(f.probes).toEqual([`${sdk}@3.0.0`])
  })

  test("refuses an empty or unknown selection before probing the registry", () => {
    for (const args of [["--dry-run"], ["--dry-run", "--package", "@wopal/private"]]) {
      const f = fixture()
      expect(runPublishCli(args, f.deps)).not.toBe(0)
      expect(f.probes).toEqual([])
    }
  })

  test("Plugin-only refuses to publish if the owning SDK version is missing", () => {
    const f = fixture()
    expect(runPublishCli(["--check", "--package", plugin], f.deps)).toBe(1)
    expect(f.logs.join("\n")).toContain("@wopal/ellamaka-sdk@3.0.0")
  })

  test("two selected packages use their own versions in SDK-first order", () => {
    const f = fixture()
    expect(runPublishCli(["--dry-run", "--package", plugin, "--package", sdk], f.deps)).toBe(0)
    expect(f.probes).toEqual([`${sdk}@3.0.0`, `${plugin}@2.1.0`])
  })
})

test("registry errors fail closed instead of looking like an unpublished version", () => {
  const unavailable = createRegistryProbe("https://registry.invalid/", () => ({
    exitCode: 1,
    stderr: Buffer.from("ECONNREFUSED"),
  }))
  expect(() => unavailable(sdk, "3.0.0")).toThrow(/ECONNREFUSED/)
  const missing = createRegistryProbe("https://registry.invalid/", () => ({
    exitCode: 1,
    stderr: Buffer.from("npm error code E404"),
  }))
  expect(missing(sdk, "3.0.0")).toBe(false)
})
