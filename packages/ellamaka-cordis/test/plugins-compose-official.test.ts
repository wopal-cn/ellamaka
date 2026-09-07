import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { composeFullPatchStack } from "../src/plugins/compose"

/**
 * Official-bundle-semantics fixtures: a user plugin declaring the FULL
 * official cordis.patch.yml grammar (disable rows, nested config, !!js
 * expressions) — the shape real third-party plugins ship (e.g.
 * dsh-sandbox-roots). The Bridge composes profile layers VERBATIM from the
 * official loadProfile output; the retired handwritten subset parser could
 * not express any of this.
 */

/** An official loadProfile-style bundle layer with full-grammar patches. */
function officialLayer(packageName: string, patches: unknown[]) {
  return { packageName, patches }
}

describe("full patch stack: official bundle semantics (no Bridge-owned plugin track)", () => {
  test("user plugin bundle layers pass through verbatim (disable rows, config, !!js)", () => {
    const pluginPatches = [
      { id: "sandbox-policy", disabled: true },
      { id: "sandbox", disabled: true },
      {
        insert: [
          {
            id: "sandbox-roots-policy",
            name: "dsh-sandbox-roots",
            config: {
              mode: { __js: "process.env.DSH_PERMISSION_MODE ?? 'workspace-write'" },
              workspaceRoot: { __js: "process.cwd()" },
            },
          },
          { id: "sandbox-roots-sandbox", name: "dsh-sandbox-roots/sandbox" },
        ],
      },
    ]
    const layers = composeFullPatchStack({
      profileLayers: [
        officialLayer("@deepseek-ai/dsh-base", [{ id: "timer", name: "@deepseek-ai/cordis-plugin-timer" }]),
        officialLayer("dsh-sandbox-roots", pluginPatches),
      ],
      userPatches: [{ id: "dsh-plugin:hello", disabled: true }],
      extraPatches: [],
      homePatches: [],
    })
    // The plugin layer is IN the official bundle track, verbatim: the
    // disable rows appear as top-level rows and the config-bearing insert
    // block survives untouched (flattening is the Loader's job).
    expect(layers).toContainEqual({ id: "sandbox-policy", disabled: true })
    expect(layers).toContainEqual({
      insert: [
        { id: "sandbox-roots-policy", name: "dsh-sandbox-roots", config: expect.anything() },
        { id: "sandbox-roots-sandbox", name: "dsh-sandbox-roots/sandbox" },
      ],
    })
    // Composition order: official bundle rows -> user -> (extra/home).
    expect(
      layers.indexOf(layers.find((l) => (l as { id?: string }).id === "timer")),
    ).toBeLessThan(layers.indexOf(layers.find((l) => (l as { id?: string }).id === "sandbox-policy")))
    expect(
      layers.indexOf(layers.find((l) => "insert" in (l as object))),
    ).toBeLessThan(layers.indexOf(layers.find((l) => (l as { id?: string }).id === "dsh-plugin:hello")))
  })

  test("composeFullPatchStack no longer accepts a pluginLayers dimension", () => {
    // The Bridge-owned plugin track is retired: the stack input carries only
    // official layers (TS types enforce this; the runtime shape must not
    // synthesize insert rows from it either).
    const layers = composeFullPatchStack({
      profileLayers: [officialLayer("dsh-sandbox-roots", [{ insert: [{ id: "x", name: "dsh-sandbox-roots" }] }])],
      userPatches: [],
      extraPatches: [],
      homePatches: [],
    } as Parameters<typeof composeFullPatchStack>[0])
    expect(layers).toEqual([{ insert: [{ id: "x", name: "dsh-sandbox-roots" }] }])
  })
})

describe("user bundle name resolution (B1 拆雷, official layers)", () => {
  test("bare package names inside official layers resolve to file:// URLs", async () => {
    const { resolveUserBundleNames } = await import("../src/plugins/compose")
    const home = mkdtempSync(join(tmpdir(), "dsh-compose-resolve-"))
    // A fake profile with an installed entity the bare name can resolve to.
    const profileDir = join(home, "home", "profiles", "web", "node_modules", "my-plugin")
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, "package.json"), JSON.stringify({ name: "my-plugin", version: "1.0.0", main: "index.js" }))
    writeFileSync(join(profileDir, "index.js"), "export default {}\n")

    const rows = [{ id: "entry", name: "my-plugin" }]
    const resolved = resolveUserBundleNames(
      [{ packageName: "my-plugin", patches: rows }],
      { dshRoot: home, profile: "web" },
    )
    expect(resolved[0].patches[0]).toMatchObject({ id: "entry" })
    expect((resolved[0].patches[0] as { name: string }).name).toMatch(/^file:\/\//)
    // Original layer objects are not mutated.
    expect(rows[0].name).toBe("my-plugin")
  })
})
