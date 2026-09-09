import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { resolveRowSpecifier } from "../src/plugins/resolve-specifiers"

/**
 * B1 (拆雷) explicit specifier resolution: Bridge-composed rows must reach the
 * Loader as absolute `file://` URLs, resolution order closure -> profiles
 * (DESIGN-dsh-poc 「Bun 下不伪造 loader.internal（拆雷）」, Path 1 per the
 * spike record). The fixtures are self-contained under tmpdir — nothing under
 * the real home is read or written.
 */

/** A minimal fake closure: an anchor package plus one scoped plugin package. */
function fakeClosure(root: string): { anchor: string; timerMain: string } {
  const anchor = join(root, "node_modules", "@deepseek-ai", "dsh", "package.json")
  mkdirSync(join(root, "node_modules", "@deepseek-ai", "dsh"), { recursive: true })
  writeFileSync(anchor, JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.0.0-test" }))
  const timerDir = join(root, "node_modules", "@deepseek-ai", "cordis-plugin-timer")
  mkdirSync(join(timerDir, "lib"), { recursive: true })
  writeFileSync(join(timerDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/cordis-plugin-timer", version: "1.0.0", main: "./lib/index.js" }))
  writeFileSync(join(timerDir, "lib", "index.js"), "export const name = \"@deepseek-ai/cordis-plugin-timer\"\n")
  return { anchor, timerMain: join(timerDir, "lib", "index.js") }
}

describe("resolveRowSpecifier (B1 explicit resolution)", () => {
  test("a closure bare name resolves to its absolute file:// URL", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-resolve-closure-"))
    const { anchor, timerMain } = fakeClosure(root)
    const resolved = resolveRowSpecifier("@deepseek-ai/cordis-plugin-timer", { dshRoot: root, installAnchor: anchor })
    expect(resolved.startsWith("file://")).toBe(true)
    expect(resolved.endsWith("/node_modules/@deepseek-ai/cordis-plugin-timer/lib/index.js")).toBe(true)
    expect(decodeURIComponent(resolved)).toContain(timerMain)
  })

  test("a real closure package resolves through the workspace install anchor", () => {
    const req = createRequire(import.meta.url)
    const anchor = req.resolve("@deepseek-ai/dsh/package.json")
    const home = mkdtempSync(join(tmpdir(), "dsh-resolve-real-"))
    const resolved = resolveRowSpecifier("@deepseek-ai/cordis-plugin-timer", { dshRoot: home, installAnchor: anchor })
    expect(resolved.startsWith("file://")).toBe(true)
    expect(resolved).toContain("/node_modules/@deepseek-ai/cordis-plugin-timer/")
  })

  test("a profiles-only user plugin resolves via the profiles anchor", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-resolve-profiles-"))
    const anchor = fakeClosure(root).anchor
    const pluginDir = join(root, "home", "profiles", "node_modules", "fx-plugin")
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "fx-plugin", version: "1.0.0", main: "index.js" }))
    writeFileSync(join(pluginDir, "index.js"), "export const name = \"fx-plugin\"\n")
    const resolved = resolveRowSpecifier("fx-plugin", { dshRoot: root, installAnchor: anchor })
    expect(resolved.startsWith("file://")).toBe(true)
    expect(resolved.endsWith("/profiles/node_modules/fx-plugin/index.js")).toBe(true)
  })

  test("a scoped profiles-only user plugin resolves through the scoped directory", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-resolve-scoped-"))
    const anchor = fakeClosure(root).anchor
    const pluginDir = join(root, "home", "profiles", "node_modules", "@acme", "widget")
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "@acme/widget", version: "1.0.0", main: "lib/index.js" }))
    mkdirSync(join(pluginDir, "lib"), { recursive: true })
    writeFileSync(join(pluginDir, "lib", "index.js"), "export const name = \"@acme/widget\"\n")
    const resolved = resolveRowSpecifier("@acme/widget", { dshRoot: root, installAnchor: anchor })
    expect(resolved.endsWith("/profiles/node_modules/@acme/widget/lib/index.js")).toBe(true)
  })

  test("resolution order is closure first, profiles second", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-resolve-order-"))
    const { anchor, timerMain } = fakeClosure(root)
    // The same name also exists under profiles: the closure copy must win.
    const shadowDir = join(root, "home", "profiles", "node_modules", "@deepseek-ai", "cordis-plugin-timer")
    mkdirSync(shadowDir, { recursive: true })
    writeFileSync(join(shadowDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/cordis-plugin-timer", version: "9.9.9", main: "shadow.js" }))
    const resolved = resolveRowSpecifier("@deepseek-ai/cordis-plugin-timer", { dshRoot: root, installAnchor: anchor })
    // realpath: macOS /var is a symlink to /private/var (pathToFileURL resolves it).
    expect(decodeURIComponent(resolved)).toBe(pathToFileURL(realpathSync(timerMain)).href)
  })

  test("an absolute file:// URL passes through unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-resolve-passthrough-"))
    const anchor = fakeClosure(root).anchor
    const url = "file:///some/absolute/plugin/lib/index.js"
    expect(resolveRowSpecifier(url, { dshRoot: root, installAnchor: anchor })).toBe(url)
  })

  test("a relative specifier passes through unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-resolve-relative-"))
    const anchor = fakeClosure(root).anchor
    expect(resolveRowSpecifier("./index.js", { dshRoot: root, installAnchor: anchor })).toBe("./index.js")
  })

  test("an unresolvable name throws the original error", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-resolve-missing-"))
    const anchor = fakeClosure(root).anchor
    try {
      resolveRowSpecifier("ghost-plugin", { dshRoot: root, installAnchor: anchor })
      expect.unreachable()
    } catch (error) {
      // Preserve the resolver's own error semantics (bun phrases "Cannot find
      // package", Node "Cannot find module") — never a rewritten message.
      expect(String(error)).toContain("ghost-plugin")
      expect(String(error)).toMatch(/Cannot find (package|module)/)
    }
  })

  test("an unresolvable name still throws without an install anchor", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-resolve-noanchor-"))
    try {
      resolveRowSpecifier("ghost-plugin", { dshRoot: root })
      expect.unreachable()
    } catch (error) {
      expect(String(error)).toContain("ghost-plugin")
      expect(String(error)).toMatch(/Cannot find (package|module)/)
    }
  })
})
