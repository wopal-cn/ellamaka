import { expect, test } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { INTEGRATION_FILES, INTEGRATION_ROOTS } from "./rules"

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
