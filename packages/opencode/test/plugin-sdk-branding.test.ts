import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

// Contract test for the published plugin/SDK npm packages.
//
// `packages/plugin` and `packages/sdk/js` are the two fork contract packages
// published to npm under the `@wopal/` scope. They must carry the branded
// identity, a public publish config, and a dist-backed publish shape, while
// keeping the workspace's dev resolution intact (source `exports` so that
// `typecheck`/`test` work without a prior build — the publish step rewrites
// `exports` to `dist`). See `docs/DESIGN-distribution.md` -> "NPM 包发布机制".

// test/ -> packages/opencode -> packages -> repo root
const root = path.join(import.meta.dir, "../../..")

interface PackageJson {
  name: string
  version: string
  private?: boolean
  main?: string
  types?: string
  exports?: Record<string, string>
  files?: string[]
  publishConfig?: { access?: string }
  repository?: { type?: string; url?: string; directory?: string }
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  workspaces?: { packages?: string[] }
}

async function readPackage(rel: string): Promise<PackageJson> {
  return JSON.parse(await fs.readFile(path.join(root, rel), "utf8"))
}

// The publish step rewrites the dev `exports` (`./src/*.ts`) into the shipped
// dist entrypoints. Keep the mapping in one place so a wrong source path or a
// renamed subpath fails here instead of shipping a broken package.
function toDistTarget(source: string): string {
  return source.replace("./src/", "./dist/").replace(/\.ts$/, ".js")
}

const PLUGIN = "packages/plugin/package.json"
const SDK = "packages/sdk/js/package.json"

const PLUGIN_EXPORTS: Record<string, string> = {
  ".": "./src/index.ts",
  "./tool": "./src/tool.ts",
  "./tui": "./src/tui.ts",
}

const SDK_EXPORTS: Record<string, string> = {
  ".": "./src/index.ts",
  "./client": "./src/client.ts",
  "./server": "./src/server.ts",
  "./v2": "./src/v2/index.ts",
  "./v2/client": "./src/v2/client.ts",
  "./v2/gen/client": "./src/v2/gen/client/index.ts",
  "./v2/server": "./src/v2/server.ts",
}

function expectPublishShape(pkg: PackageJson, exports: Record<string, string>) {
  expect(pkg.publishConfig?.access).toBe("public")
  expect(pkg.private).not.toBe(true)
  expect(pkg.main).toBe("./dist/index.js")
  expect(pkg.types).toBe("./dist/index.d.ts")
  expect(pkg.files).toContain("dist")

  // Export surface is unchanged from the fork baseline; subpaths resolve to
  // source during development.
  expect(Object.keys(pkg.exports ?? {}).sort()).toEqual(Object.keys(exports).sort())
  for (const [subpath, source] of Object.entries(exports)) {
    expect(pkg.exports?.[subpath]).toBe(source)
  }
}

describe("published plugin package", () => {
  test("is branded @wopal/ellamaka-plugin at the product base version", async () => {
    const pkg = await readPackage(PLUGIN)
    expect(pkg.name).toBe("@wopal/ellamaka-plugin")
    expect(pkg.version).toBe("2.0.5")
  })

  test("is public and ships dist with types", async () => {
    const pkg = await readPackage(PLUGIN)
    expectPublishShape(pkg, PLUGIN_EXPORTS)
  })

  test("publishes every subpath from dist", async () => {
    for (const source of Object.values(PLUGIN_EXPORTS)) {
      expect(toDistTarget(source)).toMatch(/^\.\/dist\/.*\.js$/)
    }
  })

  test("depends on the branded SDK", async () => {
    const pkg = await readPackage(PLUGIN)
    expect(pkg.dependencies?.["@wopal/ellamaka-sdk"]).toBe("workspace:*")
  })

  test("declares the repository for trusted publishing", async () => {
    const pkg = await readPackage(PLUGIN)
    expect(pkg.repository?.url).toBe("https://github.com/wopal-cn/ellamaka")
    expect(pkg.repository?.directory).toBe("packages/plugin")
  })
})

describe("published sdk package", () => {
  test("is branded @wopal/ellamaka-sdk at the product base version", async () => {
    const pkg = await readPackage(SDK)
    expect(pkg.name).toBe("@wopal/ellamaka-sdk")
    expect(pkg.version).toBe("2.0.5")
  })

  test("is public and ships dist with types", async () => {
    const pkg = await readPackage(SDK)
    expectPublishShape(pkg, SDK_EXPORTS)
  })

  test("publishes every subpath including /v2 from dist", async () => {
    for (const source of Object.values(SDK_EXPORTS)) {
      expect(toDistTarget(source)).toMatch(/^\.\/dist\/.*\.js$/)
    }
    expect(Object.keys(SDK_EXPORTS)).toContain("./v2")
  })

  test("declares the repository for trusted publishing", async () => {
    const pkg = await readPackage(SDK)
    expect(pkg.repository?.url).toBe("https://github.com/wopal-cn/ellamaka")
    expect(pkg.repository?.directory).toBe("packages/sdk/js")
  })
})

describe("workspace consumers reference the branded packages", () => {
  // The fork no longer ships the upstream package names, so no workspace
  // package.json may still depend on them.
  const LEGACY_SCOPE = "@opencode-ai/"

  const consumers: Array<{ rel: string; expected: string[] }> = [
    { rel: "package.json", expected: ["@wopal/ellamaka-plugin", "@wopal/ellamaka-sdk"] },
    { rel: "packages/opencode/package.json", expected: ["@wopal/ellamaka-plugin", "@wopal/ellamaka-sdk"] },
    { rel: "packages/ui/package.json", expected: ["@wopal/ellamaka-sdk"] },
    { rel: "packages/ellamaka-app/package.json", expected: ["@wopal/ellamaka-sdk"] },
  ]

  for (const { rel, expected } of consumers) {
    test(`${rel} declares the branded packages`, async () => {
      const pkg = await readPackage(rel)
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }
      for (const name of expected) expect(deps[name]).toBe("workspace:*")
      expect(Object.keys(deps).filter((name) => name.startsWith(LEGACY_SCOPE))).toEqual([])
    })
  }
})

// A published package must be installable from the public registry, so its
// runtime dependencies may only reference packages that are themselves
// publishable. Shipping a runtime import of a private workspace package (the
// sdk imported the private `@wopal/ellamaka-brand`) makes the published
// tarball impossible to install.
async function workspaceManifests(): Promise<Map<string, PackageJson>> {
  const rootPkg = await readPackage("package.json")
  const patterns = rootPkg.workspaces?.packages ?? []
  const dirs: string[] = []
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) {
      dirs.push(pattern)
      continue
    }
    const base = pattern.slice(0, -2)
    for (const entry of await fs.readdir(path.join(root, base), { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(`${base}/${entry.name}`)
    }
  }
  const manifests = new Map<string, PackageJson>()
  for (const dir of dirs) {
    try {
      const manifest = await readPackage(`${dir}/package.json`)
      manifests.set(manifest.name, manifest)
    } catch {
      // a workspace glob can match a directory without a manifest (packages/sdk)
    }
  }
  return manifests
}

function isPublishable(manifest: PackageJson): boolean {
  return manifest.private !== true && manifest.publishConfig?.access === "public"
}

describe("published packages have no private runtime dependencies", () => {
  test("no runtime dependency resolves to an unpublished workspace package", async () => {
    const manifests = await workspaceManifests()
    for (const rel of [SDK, PLUGIN]) {
      const pkg = await readPackage(rel)
      const runtime = {
        ...pkg.dependencies,
        ...pkg.optionalDependencies,
        ...pkg.peerDependencies,
      }
      const offenders = Object.keys(runtime).filter((name) => {
        const dep = manifests.get(name)
        return dep !== undefined && !isPublishable(dep)
      })
      expect(offenders).toEqual([])
    }
  })

  test("sdk runtime dependencies are self-contained", async () => {
    const pkg = await readPackage(SDK)
    expect(Object.values(pkg.dependencies ?? {}).filter((spec) => spec.startsWith("workspace:"))).toEqual([])
  })
})

describe("sdk binary name stays in sync with the brand package", () => {
  test("the inlined BINARY_NAME equals @wopal/ellamaka-brand's", async () => {
    // The sdk must not depend on the private brand package at runtime, so it
    // inlines the single constant it needs. Keep the two from drifting.
    const sdk = await import("../../sdk/js/src/brand")
    const brand = await import("@wopal/ellamaka-brand/branding")
    expect(sdk.BINARY_NAME).toBe(brand.BINARY_NAME)
  })
})
