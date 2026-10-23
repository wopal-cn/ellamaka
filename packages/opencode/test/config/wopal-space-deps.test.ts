import { describe, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import { collectPluginDependencies } from "@wopal/ellamaka-core/plugin-dependencies"

async function makeTmpPluginDir(
  base: string,
  parent: "plugin" | "plugins",
  name: string,
  deps?: Record<string, string>,
) {
  const pkgDir = path.join(base, parent, name)
  await fs.mkdir(pkgDir, { recursive: true })
  await fs.writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name, version: "1.0.0", ...(deps ? { dependencies: deps } : {}) }),
  )
  return pkgDir
}

describe("core plugin dependency declaration reader", () => {
  test("flattens both plugin directories and deduplicates dependency names", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-deps-read-"))
    try {
      await makeTmpPluginDir(root, "plugin", "alpha", { openai: "^6.0.0", yaml: "^2.0.0" })
      await makeTmpPluginDir(root, "plugins", "beta", { lodash: "^4.0.0", yaml: "^2.1.0" })

      const result = await collectPluginDependencies(root)
      expect(result.deps.map((item) => item.name).sort()).toEqual(["lodash", "openai", "yaml"])
      expect(result.deps.find((item) => item.name === "yaml")?.version).toBe("^2.1.0")
      expect(Object.keys(result.plugins).sort()).toEqual(["alpha", "beta"])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("ignores package manifests without a package name", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-deps-read-"))
    try {
      const dir = path.join(root, "plugins", "anonymous")
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { hidden: "1.0.0" } }))

      const result = await collectPluginDependencies(root)
      expect(result.deps).toEqual([])
      expect(result.plugins).toEqual({})
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("keeps the fingerprint stable for the same declarations and changes it when declarations change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-deps-read-"))
    try {
      const dir = await makeTmpPluginDir(root, "plugins", "alpha", { openai: "^6.0.0" })
      const first = await collectPluginDependencies(root)
      const second = await collectPluginDependencies(root)
      expect(second.fingerprint).toBe(first.fingerprint)

      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "alpha", version: "1.0.0", dependencies: { openai: "^7.0.0" } }),
      )
      const changed = await collectPluginDependencies(root)
      expect(changed.fingerprint).not.toBe(first.fingerprint)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
