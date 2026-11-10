import { expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { planning } from "../run-tests"
import { planLayer, type ConcretePackage } from "../run-tests-root"
import { loadRepositoryFiles } from "./check"
import { INTEGRATION_FILES, INTEGRATION_ROOTS } from "./rules"
import { scanRepository } from "./scan"

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..")

function read(relative: string) {
  return readFileSync(path.join(repoRoot, relative), "utf8")
}

/** The string entries of an exported array literal in a source file. */
function arrayItems(source: string, name: string): string[] {
  const start = source.indexOf("export const " + name)
  expect(start).toBeGreaterThan(-1)
  const open = source.indexOf("[", start)
  const close = source.indexOf("]", open)
  const body = source.slice(open + 1, close)
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "")
}

test("opencode integration directories still match the runner configuration", () => {
  const dirs = arrayItems(read("packages/opencode/script/run-tests.ts"), "INTEGRATION_DIRS")
  const prefix = "packages/opencode/test/"
  const declared = INTEGRATION_ROOTS.filter((root) => root.startsWith(prefix)).map((root) => root.slice(prefix.length))
  expect([...declared].sort()).toEqual([...dirs].sort())
})

test("cordis integration files still match its test:integration script", () => {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- The manifest is repository-owned and only scripts is read.
  const manifest = JSON.parse(read("packages/ellamaka-cordis/package.json")) as { scripts: Record<string, string> }
  const command = manifest.scripts["test:integration"] ?? ""
  const pattern = /test\/[A-Za-z0-9_.-]+[.]test[.]ts/g
  const files = [...command.matchAll(pattern)].map((match) => "packages/ellamaka-cordis/" + match[0])
  const declared = INTEGRATION_FILES.filter((file) => file.startsWith("packages/ellamaka-cordis/"))
  expect([...declared].sort()).toEqual([...new Set(files)].sort())
})

test("every listed integration file exists", () => {
  for (const file of INTEGRATION_FILES) {
    expect(statSync(path.join(repoRoot, file)).isFile()).toBe(true)
  }
})

test("cordis excludes every declared integration file from its unit command", () => {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Repository-owned manifest, only scripts is read.
  const manifest = JSON.parse(read("packages/ellamaka-cordis/package.json")) as { scripts: Record<string, string> }
  const command = manifest.scripts["test:unit"] ?? ""
  const pattern = /--path-ignore-patterns\s+['"]([^'"]+)['"]/.exec(command)?.[1]
  expect(pattern).toBeDefined()
  const ignored = new Bun.Glob(pattern!)
  const prefix = "packages/ellamaka-cordis/"
  for (const file of INTEGRATION_FILES.filter((file) => file.startsWith(prefix))) {
    expect(ignored.match(file.slice(prefix.length)), file).toBe(true)
  }
})

test("package discovery covers every package with executable Bun tests across test/, src/, script/, and nested sdk/js", async () => {
  const fs = await loadRepositoryFiles(repoRoot)
  const { packages } = scanRepository(fs, repoRoot)
  const discoveredDirs = packages.map((p) => p.packageDir)

  expect(discoveredDirs).toContain("packages/opencode")
  expect(discoveredDirs).toContain("packages/ellamaka-core")
  expect(discoveredDirs).toContain("packages/ellamaka-app")
  expect(discoveredDirs).toContain("packages/ellamaka-desktop")
  expect(discoveredDirs).toContain("packages/ellamaka-cordis")
  expect(discoveredDirs).toContain("packages/ui")
  expect(discoveredDirs).toContain("packages/sdk/js")
  expect(discoveredDirs).toContain("packages/wopalspace")

  const opencodePkg = packages.find((p) => p.packageDir === "packages/opencode")!
  expect(opencodePkg.preloadValid).toBe(true)
  expect(opencodePkg.testFiles.some((f) => f.startsWith("packages/opencode/script/"))).toBe(true)
  expect(opencodePkg.testFiles.some((f) => f.startsWith("packages/opencode/src/"))).toBe(true)

  const corePkg = packages.find((p) => p.packageDir === "packages/ellamaka-core")!
  expect(corePkg.preloadValid).toBe(true)
  expect(corePkg.homeBindings.length).toBeGreaterThan(0)

  // Every package configured in run-tests-root.ts must be present in the scanner discovery list
  const rootPlanned = new Set<ConcretePackage>([
    ...planLayer("unit", "all").map((c) => c.pkg),
    ...planLayer("integration", "all").map((c) => c.pkg),
    ...planLayer("e2e", "all").map((c) => c.pkg),
  ])
  for (const pkg of rootPlanned) {
    expect(discoveredDirs).toContain(`packages/${pkg}`)
  }

  // Every non-preload package must have zero Home bindings (no-global-paths)
  for (const pkg of packages) {
    if (!pkg.preloadValid) {
      expect(pkg.homeBindings, `${pkg.packageDir} has Home bindings without valid preload`).toEqual([])
    }
  }

  // File-level coverage check against opencode's actual runner planning (unit + integration + e2e)
  const opencodeTestRoot = path.join(repoRoot, "packages/opencode/test")
  const runnerEntries = [
    ...planning("unit", opencodeTestRoot),
    ...planning("integration", opencodeTestRoot),
    ...planning("e2e", opencodeTestRoot),
  ]
  const scannedOpencodeFiles = new Set(opencodePkg.testFiles)
  const scannedOpencodeHelpers = new Set(opencodePkg.reachableHelpers)
  for (const entry of runnerEntries) {
    const normalized = `packages/opencode/${entry.replace(/\/$/, "")}`
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) {
      expect(scannedOpencodeFiles.has(normalized), `missing runner file ${normalized}`).toBe(true)
    } else {
      const existingCodeFiles = [...fs.files.keys()].filter(
        (f) => f.startsWith(normalized + "/") && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(f),
      )
      for (const file of existingCodeFiles) {
        expect(
          scannedOpencodeFiles.has(file) || scannedOpencodeHelpers.has(file),
          `runner dir ${normalized} code file ${file} not covered by scan`,
        ).toBe(true)
      }
    }
  }
  expect(scannedOpencodeHelpers.size).toBeGreaterThan(0)

  // File-level coverage check against ellamaka-cordis test:contracts and test:integration
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const cordisManifest = JSON.parse(read("packages/ellamaka-cordis/package.json")) as {
    scripts: Record<string, string>
  }
  const cordisPkg = packages.find((p) => p.packageDir === "packages/ellamaka-cordis")!
  const scannedCordisFiles = new Set(cordisPkg.testFiles)
  for (const scriptKey of ["test:contracts", "test:integration", "test:tools"]) {
    const cmd = cordisManifest.scripts[scriptKey] ?? ""
    for (const match of cmd.matchAll(/(?:src|script|test)\/[A-Za-z0-9_./-]+\.test\.ts/g)) {
      const rel = `packages/ellamaka-cordis/${match[0]}`
      expect(scannedCordisFiles.has(rel), `cordis ${scriptKey} file ${rel} missing from scan`).toBe(true)
    }
  }

  // Verify Playwright .spec.ts e2e entries under packages/ellamaka-app/e2e are also in the scanned file set
  const appPkg = packages.find((p) => p.packageDir === "packages/ellamaka-app")!
  expect(appPkg.testFiles.some((f) => f.startsWith("packages/ellamaka-app/e2e/") && f.endsWith(".spec.ts"))).toBe(true)
})

// Tests must never turn a package directory into scratch space. A probe written
// under `<package>/.tmp` survives its test run as an empty directory, is not
// gitignored, and silently pollutes every later scan of the repository.
test("no package directory contains a stray temporary directory", () => {
  const strays: string[] = []
  const packagesDir = path.join(repoRoot, "packages")
  if (existsSync(path.join(repoRoot, ".tmp"))) strays.push(".tmp")
  for (const entry of readdirSync(packagesDir)) {
    const candidate = path.join(packagesDir, entry, ".tmp")
    if (existsSync(candidate)) strays.push(`packages/${entry}/.tmp`)
  }
  expect(
    strays,
    "test probes belong in .wopal-space/.tmp or the owning package's scoped temp fixture, never in a package directory",
  ).toEqual([])
})

// A fixture that creates a git worktree inside a checkout registers it in that
// checkout's .git/worktrees. Deleting the temp directory removes the files but
// not the registration, so the real repo keeps a phantom entry forever and the
// leak survives in a place no test cleanup reaches.
test("the test preload keeps temp directories outside every git checkout", () => {
  const preload = read("packages/opencode/test/preload.ts")
  expect(preload).toContain("resolveTempRoot")
  // The redirect has to happen before the first fixture reads os.tmpdir(), or a
  // TMPDIR inside the workspace still reaches the fixtures.
  const redirect = preload.indexOf('process.env["TMPDIR"] = tempRoot')
  const firstDir = preload.indexOf('path.join(os.tmpdir(), "opencode-test-data-"')
  expect(redirect).toBeGreaterThan(-1)
  expect(firstDir).toBeGreaterThan(redirect)
})
