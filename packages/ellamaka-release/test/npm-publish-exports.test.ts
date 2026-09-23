import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join, resolve } from "path"
import { distExportTarget, rewriteExports, toDistTarget } from "../src/npm/exports"

const root = resolve(import.meta.dir, "..", "..", "..")

// The dev `exports` of both contract packages point at raw TypeScript
// (`./src/*.ts`) so that typecheck/test run without a prior build. `files`
// only ships `dist`, so the publish step must rewrite every subpath to its
// dist counterpart before packing — otherwise the published package resolves
// to files that are not in the tarball.
//
// The mapping is pinned by the fork contract test
// `packages/opencode/test/plugin-sdk-branding.test.ts` (`toDistTarget`). The
// two must stay in lockstep; `keeps the mapping in lockstep with the contract
// test` below fails loudly when either side drifts.

interface DistTarget {
  import: string
  types: string
}

const PLUGIN_DIST: Record<string, DistTarget> = {
  ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
  "./tool": { import: "./dist/tool.js", types: "./dist/tool.d.ts" },
  "./tui": { import: "./dist/tui.js", types: "./dist/tui.d.ts" },
}

const SDK_DIST: Record<string, DistTarget> = {
  ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
  "./client": { import: "./dist/client.js", types: "./dist/client.d.ts" },
  "./server": { import: "./dist/server.js", types: "./dist/server.d.ts" },
  "./v2": { import: "./dist/v2/index.js", types: "./dist/v2/index.d.ts" },
  "./v2/client": { import: "./dist/v2/client.js", types: "./dist/v2/client.d.ts" },
  "./v2/gen/client": { import: "./dist/v2/gen/client/index.js", types: "./dist/v2/gen/client/index.d.ts" },
  "./v2/server": { import: "./dist/v2/server.js", types: "./dist/v2/server.d.ts" },
}

function readExports(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, rel), "utf8")).exports
}

describe("dist export rewrite", () => {
  test("maps a dev src target to its shipped js + d.ts pair", () => {
    expect(toDistTarget("./src/index.ts")).toBe("./dist/index.js")
    expect(distExportTarget("./src/v2/gen/client/index.ts")).toEqual({
      import: "./dist/v2/gen/client/index.js",
      types: "./dist/v2/gen/client/index.d.ts",
    })
  })

  test("rejects a target that is not a ./src/*.ts path instead of shipping a broken entry", () => {
    // Fail closed: a rewritten target outside ./dist would be absent from the
    // tarball (`files: ["dist"]`) and break every consumer import.
    expect(() => distExportTarget("./lib/index.ts")).toThrow(/\.\/src\//)
    expect(() => distExportTarget("./src/index.js")).toThrow(/\.ts/)
  })

  test("rejects a non-string export target instead of half-rewriting the map", () => {
    // Conditional exports are not used by the contract packages. Rewriting one
    // would ship a subpath still pointing at ./src, so fail closed instead.
    expect(() => rewriteExports({ ".": { default: "./src/index.ts" } })).toThrow(/string target/)
    expect(() => rewriteExports({ ".": null })).toThrow(/string target/)
  })

  test("fails closed when the export map is missing, empty or not an object", () => {
    // Publishing without an export map would silently drop the package's whole
    // public contract — including the SDK's /v2 subpaths — while the tarball
    // still ships. A malformed manifest must abort the release, not ship.
    expect(() => rewriteExports(undefined)).toThrow(/exports/)
    expect(() => rewriteExports({})).toThrow(/empty/)
    expect(() => rewriteExports([])).toThrow(/exports/)
    expect(() => rewriteExports(".")).toThrow(/exports/)
  })

  test("keeps the mapping in lockstep with the contract test", () => {
    // Drift alarm: the contract test owns the canonical `toDistTarget`. If its
    // rule changes, this publish step must change with it.
    const contract = readFileSync(join(root, "packages/opencode/test/plugin-sdk-branding.test.ts"), "utf8")
    expect(contract).toContain('source.replace("./src/", "./dist/").replace(/\\.ts$/, ".js")')
  })
})

describe("real package exports rewrite to the pinned dist map", () => {
  test("plugin", () => {
    expect(rewriteExports(readExports("packages/plugin/package.json"))).toEqual(PLUGIN_DIST)
  })

  test("sdk (including the /v2 subpaths)", () => {
    expect(rewriteExports(readExports("packages/sdk/js/package.json"))).toEqual(SDK_DIST)
  })

  test("every rewritten entry resolves inside dist as a .js + .d.ts pair", () => {
    for (const map of [PLUGIN_DIST, SDK_DIST]) {
      for (const target of Object.values(map)) {
        expect(target.import).toMatch(/^\.\/dist\/.*\.js$/)
        expect(target.types).toBe(target.import.replace(/\.js$/, ".d.ts"))
      }
    }
  })
})
