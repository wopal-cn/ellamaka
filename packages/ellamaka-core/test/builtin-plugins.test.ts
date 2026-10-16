import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { isBuiltinDshAdapter } from "../src/builtin-plugins"
import { collectPluginDependencies } from "../src/plugin-dependencies"

describe("built-in adapter takeover before dependency installation", () => {
  test("recognizes canonical and versioned names without import or installation", async () => {
    for (const spec of [
      "dsh-adapter",
      "dsh-adapter@0.1.0",
      "@wopal/dsh-adapter@1",
      "npm:dsh-adapter@1",
      "file:///missing/dsh-adapter/index.ts",
    ]) {
      expect(await isBuiltinDshAdapter(spec)).toBe(true)
    }
    expect(await isBuiltinDshAdapter("unrelated-dsh-adapter-helper")).toBe(false)
    expect(await isBuiltinDshAdapter("file:///parent/dsh-adapter/app/plugins/unrelated.ts")).toBe(false)
  })

  test("reads renamed package identity without executing its entry or collecting its dependencies", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ellamaka-builtin-"))
    const dir = path.join(root, "plugins", "renamed")
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "dsh-adapter", dependencies: { forbidden: "99.0.0" } }),
    )
    await writeFile(path.join(dir, "index.ts"), 'throw new Error("external adapter executed")')
    expect(await isBuiltinDshAdapter(pathToFileURL(path.join(dir, "index.ts")).href)).toBe(true)
    expect(await collectPluginDependencies(root)).toMatchObject({ deps: [], plugins: {} })
  })
})
