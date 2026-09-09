import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDshRuntimeApi, type DshRuntimeApi } from "./loader"

/**
 * Build a temporary mock dsh closure with the six official runtime packages,
 * each exposing a unique marker. The `installAnchor` passed to
 * `createDshRuntimeApi` is the mock `@deepseek-ai/dsh/package.json` path, so a
 * `createRequire(anchor)` rooted at it resolves all six siblings through the
 * shared `node_modules` ancestry — mirroring a real materialised closure.
 */
function makeMockClosure(): { anchor: string; markers: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "dsh-loader-"))
  const scoped = join(root, "node_modules", "@deepseek-ai")
  mkdirSync(scoped, { recursive: true })

  const specifiers: Record<string, string> = {
    cordis: "@deepseek-ai/cordis",
    "cordis-plugin-loader": "@deepseek-ai/cordis-plugin-loader",
    "dsh-app-boot": "@deepseek-ai/dsh-app-boot",
    "dsh-cmdline": "@deepseek-ai/dsh-cmdline",
    "dsh-launch-environment": "@deepseek-ai/dsh-launch-environment",
    "dsh-host-webserver": "@deepseek-ai/dsh-host-webserver",
  }

  const markers: Record<string, string> = {}
  for (const [dir, spec] of Object.entries(specifiers)) {
    const pkgDir = join(scoped, dir)
    mkdirSync(pkgDir, { recursive: true })
    const marker = `marker-${dir}`
    markers[spec] = marker
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: spec, main: "index.js" }))
    writeFileSync(join(pkgDir, "index.js"), `module.exports = { marker: ${JSON.stringify(marker)}, loaded: true }`)
  }

  // The install anchor is the @deepseek-ai/dsh package.json (present but not
  // itself in the resolved six).
  mkdirSync(join(scoped, "dsh"), { recursive: true })
  writeFileSync(join(scoped, "dsh", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", main: "index.js" }))
  const anchor = join(scoped, "dsh", "package.json")

  return { anchor, markers }
}

describe("createDshRuntimeApi", () => {
  test("resolves all six runtime modules from the closure and exposes their exports", () => {
    const { anchor, markers } = makeMockClosure()
    const api: DshRuntimeApi = createDshRuntimeApi(anchor)

    expect(api.cordis).toBeDefined()
    expect(api.pluginLoader).toBeDefined()
    expect(api.appBoot).toBeDefined()
    expect(api.cmdline).toBeDefined()
    expect(api.launchEnv).toBeDefined()
    expect(api.hostWebserver).toBeDefined()

    for (const [spec, marker] of Object.entries(markers)) {
      const mod = (() => {
        switch (spec) {
          case "@deepseek-ai/cordis": return api.cordis
          case "@deepseek-ai/cordis-plugin-loader": return api.pluginLoader
          case "@deepseek-ai/dsh-app-boot": return api.appBoot
          case "@deepseek-ai/dsh-cmdline": return api.cmdline
          case "@deepseek-ai/dsh-launch-environment": return api.launchEnv
          case "@deepseek-ai/dsh-host-webserver": return api.hostWebserver
        }
      })() as { marker: string; loaded: boolean }
      expect(mod.loaded).toBe(true)
      expect(mod.marker).toBe(marker)
    }
  })

  test("throws with the module name and anchor when a closure module is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-loader-missing-"))
    const scoped = join(root, "node_modules", "@deepseek-ai")
    mkdirSync(scoped, { recursive: true })
    // Only the anchor exists; cordis and friends are absent.
    mkdirSync(join(scoped, "dsh"), { recursive: true })
    writeFileSync(join(scoped, "dsh", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh" }))
    const anchor = join(scoped, "dsh", "package.json")

    expect(() => createDshRuntimeApi(anchor)).toThrow()
    expect(() => createDshRuntimeApi(anchor)).toThrow(/@deepseek-ai\/cordis/)
    expect(() => createDshRuntimeApi(anchor)).toThrow(anchor)
  })

  test("throws when the anchor itself is invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-loader-bad-anchor-"))
    expect(() => createDshRuntimeApi(join(root, "no-such", "package.json"))).toThrow(join(root, "no-such"))
  })
})
