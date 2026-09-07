import { describe, expect, test } from "bun:test"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import { mountDshTools } from "../src/dsh-web"
import { startDshPluginService } from "../src/plugins/runtime"
import { readProfileManifest, withProfileManifestWrite, appendBundle } from "../src/plugins/profile-manifest"
import {
  composeFullPatchStack,
  readUserPatchLayer,
  healPluginsModuleFallback,
  removePluginSymlink,
} from "../src/plugins/compose"

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "dsh-plugin-compose-"))
}

function profileDirOf(root: string, profile = "web"): string {
  return join(root, "home", "profiles", profile)
}

function installedPlugin(
  root: string,
  name: string,
  opts: { version?: string; bundle?: boolean | string; marker?: string; profile?: string } = {},
): string {
  const { version = "1.0.0", bundle = true, marker = "m", profile = "web" } = opts
  const dir = join(profileDirOf(root, profile), "node_modules", ...name.split("/"))
  mkdirSync(dir, { recursive: true })
  const manifest: Record<string, unknown> = { name, version, type: "module", main: "index.js" }
  if (bundle) {
    manifest.dsh = { bundle: { patch: typeof bundle === "string" ? bundle : "./cordis.patch.yml" } }
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest))
  writeFileSync(
    join(dir, "index.js"),
    `export const name = ${JSON.stringify(name)}\nexport function apply(ctx) { ctx.provide(${JSON.stringify(name + ".marker")}, ${JSON.stringify(marker)}) }\n`,
  )
  if (bundle) {
    writeFileSync(
      join(dir, typeof bundle === "string" ? bundle : "./cordis.patch.yml"),
      `- insert:\n    - id: dsh-plugin:${name}\n      name: ${JSON.stringify(name)}\n`,
    )
  }
  return dir
}

async function registerInstalled(root: string, name: string, profile = "web"): Promise<void> {
  await withProfileManifestWrite(profileDirOf(root, profile), (manifest) => {
    appendBundle(manifest, name)
  })
}

function seedManifest(root: string, manifest: Record<string, unknown>, profile = "web"): void {
  mkdirSync(profileDirOf(root, profile), { recursive: true })
  writeFileSync(join(profileDirOf(root, profile), "package.json"), JSON.stringify(manifest, null, 2) + "\n")
}

describe("composeFullPatchStack (official bundle semantics)", () => {
  test("keeps the official sandwich: profileLayers -> userPatches -> extraPatches -> homePatches", () => {
    const stack = composeFullPatchStack({
      profileLayers: [{ patches: [{ id: "bundle-row" }] }],
      userPatches: [{ id: "user-row" }],
      extraPatches: [{ id: "extra-row" }],
      homePatches: [{ id: "home-row" }],
    })
    expect(stack).toEqual([
      { id: "bundle-row" },
      { id: "user-row" },
      { id: "extra-row" },
      { id: "home-row" },
    ])
  })

  test("a closure callback for profileLayers is called and flattened", () => {
    const stack = composeFullPatchStack({
      profileLayers: () => [
        { packageName: "a", patches: [{ id: "a-row" }] },
        { packageName: "b", patches: [{ id: "b-row" }] },
      ],
      userPatches: [],
      extraPatches: [],
      homePatches: [],
    })
    expect(stack).toEqual([{ id: "a-row" }, { id: "b-row" }])
  })
})

describe("readUserPatchLayer (fresh user patch replay)", () => {
  test("rejects malformed YAML rather than replaying its recovered AST", () => {
    const root = tempRoot()
    const profileDir = profileDirOf(root)
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, "cordis.patch.yml"), "- id: dsh-plugin:x\n  disabled: [\n")

    expect(() => readUserPatchLayer(root, "web")).toThrow(/failed to parse/)
  })
})

describe("healPluginsModuleFallback (profile manifest source)", () => {
  test("symlinks every declared user plugin under profiles/node_modules", async () => {
    const root = tempRoot()
    const dir = installedPlugin(root, "link-me")
    await registerInstalled(root, "link-me")
    healPluginsModuleFallback(root)
    const link = join(root, "home", "profiles", "node_modules", "link-me")
    expect(existsSync(link)).toBe(true)
    expect(realpathSync(link)).toBe(realpathSync(dir))
  })

  test("re-points a stale link when the plugin is reinstalled (new entity dir)", async () => {
    const root = tempRoot()
    const dir = installedPlugin(root, "mover")
    const modulesDir = join(root, "home", "profiles", "node_modules")
    mkdirSync(modulesDir, { recursive: true })
    symlinkSync(join(root, "gone"), join(modulesDir, "mover"), "dir")
    await registerInstalled(root, "mover")
    healPluginsModuleFallback(root)
    expect(realpathSync(join(modulesDir, "mover"))).toBe(realpathSync(dir))
  })

  test("replaces a DANGLING self-owned link (rook B-06)", async () => {
    const root = tempRoot()
    const dir = installedPlugin(root, "resurrected")
    const modulesDir = join(root, "home", "profiles", "node_modules")
    mkdirSync(modulesDir, { recursive: true })
    symlinkSync(join(root, "gone-plugin-dir"), join(modulesDir, "resurrected"), "dir")
    await registerInstalled(root, "resurrected")
    healPluginsModuleFallback(root)
    expect(realpathSync(join(modulesDir, "resurrected"))).toBe(realpathSync(dir))
  })

  test("keeps non-plugin entries already present in profiles/node_modules", () => {
    const root = tempRoot()
    const modulesDir = join(root, "home", "profiles", "node_modules")
    mkdirSync(modulesDir, { recursive: true })
    const foreign = join(root, "elsewhere")
    mkdirSync(foreign)
    symlinkSync(foreign, join(modulesDir, "official-pkg"), "dir")
    seedManifest(root, { name: "web" })
    healPluginsModuleFallback(root)
    expect(realpathSync(join(modulesDir, "official-pkg"))).toBe(realpathSync(foreign))
  })

  test("damaged installs (no package.json) are skipped, not linked", async () => {
    const root = tempRoot()
    const dir = installedPlugin(root, "damaged")
    rmSync(join(dir, "package.json"))
    await registerInstalled(root, "damaged")
    healPluginsModuleFallback(root)
    expect(existsSync(join(root, "home", "profiles", "node_modules", "damaged"))).toBe(false)
  })

  test("removePluginSymlink clears our link and leaves foreign entries alone", async () => {
    const root = tempRoot()
    installedPlugin(root, "removeme")
    await registerInstalled(root, "removeme")
    healPluginsModuleFallback(root)
    const link = join(root, "home", "profiles", "node_modules", "removeme")
    expect(existsSync(link)).toBe(true)
    removePluginSymlink(root, "removeme")
    expect(existsSync(link)).toBe(false)
    removePluginSymlink(root, "removeme")
  })
})

describe("B1 resolution: Bridge rows reach the Loader as file:// URLs", () => {
  test("Bridge-composed rows are rewritten to absolute file:// URLs; official bundle rows keep bare names", async () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-plugin-b1-"))
    const srcRoot = mkdtempSync(join(tmpdir(), "dsh-plugin-b1-src-"))
    const src = join(srcRoot, "fixture-dsh-plugin")
    mkdirSync(src, { recursive: true })
    writeFileSync(
      join(src, "package.json"),
      JSON.stringify({ name: "fixture-dsh-plugin", version: "1.0.0", type: "module", main: "index.js", dsh: { bundle: { patch: "./cordis.patch.yml" } } }),
    )
    writeFileSync(join(src, "cordis.patch.yml"), "- insert:\n    - id: dsh-plugin:fixture-dsh-plugin\n      name: fixture-dsh-plugin\n")
    writeFileSync(join(src, "index.js"), "export const name = \"fixture-dsh-plugin\"\nexport function apply(ctx) { ctx.provide(\"fixture-dsh-plugin.marker\", \"mounted\") }\n")
    const profileDir = profileDirOf(root, "ellamaka-tools")
    mkdirSync(join(profileDir, "node_modules"), { recursive: true })
    cpSync(src, join(profileDir, "node_modules", "fixture-dsh-plugin"), { recursive: true })
    await withProfileManifestWrite(profileDir, (manifest) => {
      const dsh = (manifest.dsh ??= {}) as Record<string, unknown>
      const profile = (dsh.profile ??= {}) as Record<string, unknown>
      profile.bundles = ["@deepseek-ai/dsh-base"]
      appendBundle(manifest, "fixture-dsh-plugin")
    })
    healPluginsModuleFallback(root)

    const ctx = new Context()
    const host = await mountDshTools(ctx, { home: root, port: 0 })
    try {
      const config = (host.includeEntry as unknown as {
        options?: { config?: { patches?: unknown[] } }
      }).options?.config
      const allPatches = config?.patches ?? []
      const insertRows = allPatches.flatMap((row) => (row as { insert?: { id?: string; name?: string }[] }).insert ?? [])
      const pluginRow = insertRows.find((row) => row.id === "dsh-plugin:fixture-dsh-plugin")
      expect(pluginRow).toBeDefined()
      expect(pluginRow!.name!.startsWith("file://")).toBe(true)
      expect(decodeURIComponent(pluginRow!.name!)).toContain(join("node_modules", "fixture-dsh-plugin", "index.js"))
      expect(ctx.get("fixture-dsh-plugin.marker", false)).toBe("mounted")

      const officialRows = insertRows.filter((row) => typeof row.name === "string" && row.name.startsWith("@deepseek-ai/"))
      expect(officialRows.length).toBeGreaterThan(0)
      expect(officialRows.every((row) => !row.name!.startsWith("file://"))).toBe(true)
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
      rmSync(srcRoot, { recursive: true, force: true })
    }
  }, 60_000)

  test("a fresh mount provides no loader.internal under bun (拆雷)", async () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-plugin-b1-fake-"))
    const ctx = new Context()
    const host = await mountDshTools(ctx, { home: root, port: 0 })
    try {
      const loader = ctx.get("loader") as { internal?: { import(name: string): Promise<unknown> } } | undefined
      expect(loader).toBeDefined()
      expect(loader!.internal).toBeUndefined()

      const includeConfig = (host.includeEntry as unknown as {
        options?: { config?: { patches?: Record<string, unknown>[] } }
      }).options?.config
      const hmrRows = (includeConfig?.patches ?? []).flatMap((row) => (row as { insert?: { id?: string; disabled?: boolean }[] }).insert ?? []).filter((row) => row.id === "hmr")
      expect(hmrRows.length).toBeGreaterThan(0)
      expect(hmrRows.every((row) => row.disabled === true)).toBe(true)
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("loader.internal.import profiles fallback (rook W-01, post-B1)", () => {
  test("an EXISTING internal import is wrapped so user plugins resolve via profiles", async () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-plugin-w01-"))
    const srcRoot = mkdtempSync(join(tmpdir(), "dsh-plugin-w01-src-"))
    const src = join(srcRoot, "fixture-dsh-plugin")
    mkdirSync(src, { recursive: true })
    writeFileSync(
      join(src, "package.json"),
      JSON.stringify({ name: "fixture-dsh-plugin", version: "1.0.0", type: "module", main: "index.js", dsh: { bundle: { patch: "./cordis.patch.yml" } } }),
    )
    writeFileSync(join(src, "cordis.patch.yml"), "- insert:\n    - id: dsh-plugin:fixture-dsh-plugin\n      name: fixture-dsh-plugin\n")
    writeFileSync(
      join(src, "index.js"),
      'export const name = "fixture-dsh-plugin"\nexport function apply(ctx) { ctx.provide("fixture-dsh-plugin.marker", "mounted") }\n',
    )
    const profileDir = profileDirOf(root, "ellamaka-tools")
    mkdirSync(join(profileDir, "node_modules"), { recursive: true })
    cpSync(src, join(profileDir, "node_modules", "fixture-dsh-plugin"), { recursive: true })
    await withProfileManifestWrite(profileDir, (manifest) => {
      const dsh = (manifest.dsh ??= {}) as Record<string, unknown>
      const profile = (dsh.profile ??= {}) as Record<string, unknown>
      profile.bundles = ["@deepseek-ai/dsh-base"]
      appendBundle(manifest, "fixture-dsh-plugin")
    })
    healPluginsModuleFallback(root)

    const ctx = new Context()
    const host = await mountDshTools(ctx, {
      home: root,
      port: 0,
      prepare: (bootCtx) => {
        const loader = bootCtx.get("loader") as { internal?: { import(name: string): Promise<unknown> } } | undefined
        if (loader && loader.internal === undefined) {
          loader.internal = {
            import: async (name: string) => {
              if (name.startsWith("file://")) {
                return import(/* @vite-ignore */ name)
              }
              throw new Error(`stub internal loader cannot resolve ${name}`)
            },
          }
        }
      },
    })
    try {
      expect(ctx.get("fixture-dsh-plugin.marker", false)).toBe("mounted")
      const loader = ctx.get("loader") as { internal?: { import(name: string): Promise<unknown> } }
      const viaProfiles = await loader.internal!.import("fixture-dsh-plugin")
      expect(viaProfiles).toBeDefined()
    } finally {
      await host.dispose()
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
      rmSync(srcRoot, { recursive: true, force: true })
    }
  }, 60_000)
})
