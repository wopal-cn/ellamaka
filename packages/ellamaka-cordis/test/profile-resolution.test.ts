import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { resolveProfileModule } from "../src/plugins/profile-resolution"

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-profile-resolution-")))
  const anchor = join(root, "closure/node_modules/@deepseek-ai/dsh/package.json")
  const dir = join(root, "home/profiles/web")
  mkdirSync(join(root, "closure/node_modules/@deepseek-ai/dsh"), { recursive: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(anchor, "{}")
  return { root, anchor, dir }
}
function put(dir: string, name: string, manifest: object) {
  const root = join(dir, "node_modules", name)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, ...manifest }))
  for (const file of ["import.mjs", "require.cjs", "sub.mjs"]) writeFileSync(join(root, file), "")
  return root
}
describe("profile module resolution", () => {
  test("resolves import-only and subpath exports with import conditions", () => {
    const f = fixture()
    const root = put(f.dir, "fixture-plugin", {
      exports: { ".": { import: "./import.mjs", require: "./require.cjs" }, "./sub": { import: "./sub.mjs" } },
    })
    expect(resolveProfileModule("fixture-plugin", { installAnchor: f.anchor, dir: f.dir })).toBe(
      pathToFileURL(join(root, "import.mjs")).href,
    )
    expect(resolveProfileModule("fixture-plugin/sub", { installAnchor: f.anchor, dir: f.dir })).toBe(
      pathToFileURL(join(root, "sub.mjs")).href,
    )
  })
  test("keeps official modules in the closure and external modules in their profile", () => {
    const f = fixture()
    const official = put(join(f.root, "closure"), "@deepseek-ai/fixture", { main: "require.cjs" })
    put(f.dir, "@deepseek-ai/fixture", { main: "import.mjs" })
    expect(resolveProfileModule("@deepseek-ai/fixture", { installAnchor: f.anchor, dir: f.dir })).toBe(
      pathToFileURL(join(official, "require.cjs")).href,
    )
    put(join(f.root, "home/profiles/ellamaka-tools"), "foreign-plugin", { main: "require.cjs" })
    expect(() => resolveProfileModule("foreign-plugin", { installAnchor: f.anchor, dir: f.dir })).toThrow(
      "foreign-plugin",
    )
  })
  test("resolves relative modules against the declaration URL and preserves builtins", () => {
    const f = fixture()
    const options = { installAnchor: f.anchor, dir: f.dir }
    const origin = pathToFileURL(join(f.root, "bundle/presets/decl.yml")).href
    expect(resolveProfileModule("./local.mjs", options, origin)).toBe(
      pathToFileURL(join(f.root, "bundle/presets/local.mjs")).href,
    )
    expect(resolveProfileModule("cordis:group", options)).toBe("cordis:group")
    expect(resolveProfileModule("node:fs", options)).toBe("node:fs")
  })
})
