import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migratePluginStore } from "../src/plugins/migrate-store"
import { profileDirOf } from "../src/plugins/compose"
import { readProfileManifest } from "../src/plugins/profile-manifest"

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dsh-migrate-store-"))
}

/** Seed the legacy store document (`plugins/installed.json`). */
function seedStore(
  root: string,
  entries: { name: string; version: string; source: "registry" | "dir"; enabledIn: string[]; installedAt?: string }[],
): void {
  const dir = join(root, "plugins")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "installed.json"),
    JSON.stringify({
      schema: "ellamaka.dsh-plugins/v1",
      plugins: entries.map((e) => ({ ...e, installedAt: "2026-09-01T00:00:00.000Z" })),
    }, null, 2) + "\n",
  )
}

/** Seed a legacy install-area entity (`plugins/<name>/<version>/`). */
function seedLegacyEntity(root: string, name: string, version = "1.0.0"): string {
  const dir = join(root, "plugins", name, version)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version, type: "module", main: "index.js", dsh: { bundle: { patch: "./cordis.patch.yml" } } }),
  )
  writeFileSync(join(dir, "index.js"), `export const name = ${JSON.stringify(name)}\n`)
  writeFileSync(join(dir, "cordis.patch.yml"), `- insert:\n    - id: dsh-plugin:${name}\n      name: ${name}\n`)
  return dir
}

describe("migratePluginStore", () => {
  test("a missing store is a no-op", async () => {
    const root = tempRoot()
    await migratePluginStore(root)
    // No profile manifests were created.
    expect(existsSync(join(root, "home", "profiles", "web", "package.json"))).toBe(false)
  })

  test("an empty store retires the file without touching profiles", async () => {
    const root = tempRoot()
    seedStore(root, [])
    await migratePluginStore(root)
    const retired = readdirSync(join(root, "plugins")).find((f) => f.startsWith("installed.json.retired-"))
    expect(retired).toBeDefined()
    expect(existsSync(join(root, "plugins", "installed.json"))).toBe(false)
    expect(existsSync(join(root, "home", "profiles", "web", "package.json"))).toBe(false)
  })

  test("entries migrate into profile manifests and entities move to profile node_modules", async () => {
    const root = tempRoot()
    seedLegacyEntity(root, "dshmarket", "1.42.0")
    seedLegacyEntity(root, "hello-plugin", "0.1.0")
    seedStore(root, [
      { name: "dshmarket", version: "1.42.0", source: "registry", enabledIn: ["web"] },
      { name: "hello-plugin", version: "0.1.0", source: "dir", enabledIn: ["web", "ellamaka-tools"] },
    ])

    await migratePluginStore(root)

    // Profile manifests declare the migrated packages.
    const web = readProfileManifest(profileDirOf(root, "web"))
    expect(web.dependencies).toEqual({ dshmarket: "1.42.0", "hello-plugin": "0.1.0" })
    expect(web.bundles).toEqual(["dshmarket", "hello-plugin"])
    // ellamaka-tools only receives the plugin enabled there.
    const tools = readProfileManifest(profileDirOf(root, "ellamaka-tools"))
    expect(tools.dependencies).toEqual({ "hello-plugin": "0.1.0" })
    expect(tools.bundles).toEqual(["hello-plugin"])

    // Entities moved into the profiles' node_modules.
    expect(existsSync(join(profileDirOf(root, "web"), "node_modules", "dshmarket", "package.json"))).toBe(true)
    expect(existsSync(join(profileDirOf(root, "ellamaka-tools"), "node_modules", "hello-plugin", "package.json"))).toBe(true)
    // The legacy install area no longer holds the entities.
    expect(existsSync(join(root, "plugins", "dshmarket"))).toBe(false)
    expect(existsSync(join(root, "plugins", "hello-plugin"))).toBe(false)
  })

  test("the retired store file is kept for rollback (installed.json.retired-<date>)", async () => {
    const root = tempRoot()
    seedLegacyEntity(root, "dshmarket", "1.42.0")
    seedStore(root, [{ name: "dshmarket", version: "1.42.0", source: "registry", enabledIn: ["web"] }])
    await migratePluginStore(root)
    const retiredFiles = readdirSync(join(root, "plugins")).filter((f) => f.startsWith("installed.json.retired-"))
    expect(retiredFiles).toHaveLength(1)
    const retired = JSON.parse(readFileSync(join(root, "plugins", retiredFiles[0]), "utf-8"))
    expect(retired.schema).toBe("ellamaka.dsh-plugins/v1")
    expect(retired.plugins).toHaveLength(1)
  })

  test("a second run is a no-op (idempotent)", async () => {
    const root = tempRoot()
    seedLegacyEntity(root, "dshmarket", "1.42.0")
    seedStore(root, [{ name: "dshmarket", version: "1.42.0", source: "registry", enabledIn: ["web"] }])
    await migratePluginStore(root)
    const manifest = readProfileManifest(profileDirOf(root, "web"))
    // A second run must not duplicate or throw.
    await migratePluginStore(root)
    expect(readProfileManifest(profileDirOf(root, "web")).bundles).toEqual(["dshmarket"])
    expect(readProfileManifest(profileDirOf(root, "web")).dependencies).toEqual({ dshmarket: "1.42.0" })
    void manifest
  })

  test("a foreign schema store fails loud and writes nothing", async () => {
    const root = tempRoot()
    const dir = join(root, "plugins")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "installed.json"), JSON.stringify({ schema: "someone.else/v9", plugins: [] }))
    await expect(migratePluginStore(root)).rejects.toThrow(/schema/)
    expect(existsSync(join(dir, "installed.json"))).toBe(true)
    expect(readdirSync(dir).some((f) => f.startsWith("installed.json.retired-"))).toBe(false)
  })

  test("a corrupted store document fails loud", async () => {
    const root = tempRoot()
    const dir = join(root, "plugins")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "installed.json"), "{not json")
    await expect(migratePluginStore(root)).rejects.toThrow(/parse/)
  })
})
