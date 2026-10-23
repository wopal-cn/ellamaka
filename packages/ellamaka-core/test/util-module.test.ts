import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveInstalledModule } from "../src/util/module"

function packageAt(root: string, name: string, manifest: object, files: string[]): string {
  const dir = join(root, "node_modules", ...name.split("/"))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, ...manifest }))
  for (const file of files) writeFileSync(join(dir, file), "export {}\n")
  return dir
}

describe("resolveInstalledModule", () => {
  test("resolves an import-only export that require.resolve rejects", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "module-esm-")))
    const dir = packageAt(root, "@scope/import-only", { exports: { ".": { import: "./index.js" } } }, ["index.js"])
    expect(resolveInstalledModule("@scope/import-only", root)).toBe(join(dir, "index.js"))
  })
  test("resolves a subpath export", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "module-subpath-")))
    const dir = packageAt(root, "plugin", { exports: { ".": "./index.js", "./tool": "./tool.js" } }, [
      "index.js",
      "tool.js",
    ])
    expect(resolveInstalledModule("plugin/tool", root)).toBe(join(dir, "tool.js"))
  })
  test("falls back to main then index.js", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "module-main-")))
    const main = packageAt(root, "main-plugin", { main: "lib/main.js" }, [])
    mkdirSync(join(main, "lib"), { recursive: true })
    writeFileSync(join(main, "lib/main.js"), "export {}\n")
    expect(resolveInstalledModule("main-plugin", root)).toBe(join(main, "lib/main.js"))
    const index = packageAt(root, "index-plugin", {}, ["index.js"])
    expect(resolveInstalledModule("index-plugin", root)).toBe(join(index, "index.js"))
  })
  test("searches ancestor node_modules like the host resolver", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "module-ancestor-")))
    const dir = packageAt(root, "eslint", { main: "lib/api.js" }, [])
    mkdirSync(join(dir, "lib"), { recursive: true })
    writeFileSync(join(dir, "lib/api.js"), "export {}\n")
    const nested = join(root, "apps/web")
    mkdirSync(nested, { recursive: true })
    expect(resolveInstalledModule("eslint", nested)).toBe(join(dir, "lib/api.js"))
  })

  test("rejects a missing or escaping target", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "module-invalid-")))
    packageAt(root, "missing", { exports: { ".": "./absent.js" } }, [])
    packageAt(root, "escape", { exports: { ".": "../outside.js" } }, [])
    expect(resolveInstalledModule("missing", root)).toBeUndefined()
    expect(resolveInstalledModule("escape", root)).toBeUndefined()
  })
})
