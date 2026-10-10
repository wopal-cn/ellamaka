import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readProfilePluginMeta } from "../src/plugins/plugin-metadata"

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dsh-package-meta-"))
  const dir = join(root, "profile")
  const packageDir = join(dir, "node_modules/meta-fixture")
  mkdirSync(join(packageDir, "locale"), { recursive: true })
  const anchor = join(root, "closure/node_modules/@deepseek-ai/dsh/package.json")
  mkdirSync(join(root, "closure/node_modules/@deepseek-ai/dsh"), { recursive: true })
  writeFileSync(anchor, "{}")
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: "meta-fixture",
      version: "1.0.0",
      description: "Fallback",
      icon: "icon.svg",
      exports: {
        ".": "./must-not-run.js",
        "./package.json": "./package.json",
        "./locale/*.json": "./locale/*.json",
        "./review/package.json": "./review/package.json",
        "./review/locale/*.json": "./review/locale/*.json",
      },
    }),
  )
  writeFileSync(join(packageDir, "must-not-run.js"), "throw new Error('plugin code must not be evaluated')")
  writeFileSync(join(packageDir, "icon.svg"), "<svg/>")
  writeFileSync(
    join(packageDir, "locale/en.json"),
    JSON.stringify({ meta: { title: "English", description: "Description" } }),
  )
  writeFileSync(join(packageDir, "locale/zh-CN.json"), JSON.stringify({ meta: { title: "中文", description: "说明" } }))
  return { root, packageDir, context: { dir, installAnchor: anchor } }
}

test("reads exported localized text and contained icon without importing plugin code", () => {
  const f = fixture()
  const meta = readProfilePluginMeta("meta-fixture", f.context)
  expect(meta).toEqual({
    title: { en: "English", "zh-cn": "中文" },
    description: { en: "Description", "zh-cn": "说明" },
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
  })
})
test("subpath metadata uses its own exports and manifest fallback", () => {
  const f = fixture()
  mkdirSync(join(f.packageDir, "review"))
  writeFileSync(
    join(f.packageDir, "review/package.json"),
    JSON.stringify({ name: "Review", description: "Subpath description" }),
  )
  expect(readProfilePluginMeta("meta-fixture/review", f.context)).toEqual({
    title: "Review",
    description: "Subpath description",
  })
  expect(readProfilePluginMeta("cordis:group", f.context)).toBeUndefined()
})
test("invalid metadata and icons retain real diagnostics instead of being silenced", () => {
  const f = fixture()
  const manifest = join(f.packageDir, "package.json")
  const data = JSON.parse(require("node:fs").readFileSync(manifest, "utf8"))
  writeFileSync(join(f.context.dir, "node_modules/outside.svg"), "<svg/>")
  data.icon = "../outside.svg"
  writeFileSync(manifest, JSON.stringify(data))
  const meta = readProfilePluginMeta("meta-fixture", f.context)
  expect(meta?.title).toEqual({ en: "English", "zh-cn": "中文" })
  expect(meta?.error).toContain("inside")
  writeFileSync(join(f.packageDir, "locale/zh-CN.json"), "{ malformed")
  expect(readProfilePluginMeta("meta-fixture", f.context)?.error).toContain("Plugin metadata")
})
