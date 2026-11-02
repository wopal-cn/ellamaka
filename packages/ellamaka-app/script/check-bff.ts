#!/usr/bin/env bun
import { $ } from "bun"
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import path from "path"

/**
 * Build-time gate for the Official App BFF boundary:
 * - the private BFF document contains only /workbench operations;
 * - the public Platform document contains no /workbench operation;
 * - the committed app-private client matches a fresh generation.
 */
const appDir = path.resolve(import.meta.dir, "..")
const packages = path.resolve(appDir, "..")
const opencode = path.resolve(packages, "opencode")

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

/** Read the generated document path keys without asserting the parsed shape. */
function documentPaths(json: string): string[] {
  const parsed: unknown = JSON.parse(json)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("OpenAPI document is not an object")
  const paths: unknown = "paths" in parsed ? parsed.paths : undefined
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) fail("OpenAPI document has no paths object")
  return Object.keys(paths)
}

const document = await $`${process.execPath} ${path.join(opencode, "script/generate-app-bff-openapi.ts")}`
  .cwd(opencode)
  .quiet()
const paths = documentPaths(document.stdout.toString())
const foreign = paths.filter((item) => !item.startsWith("/workbench/"))
if (foreign.length > 0) fail(`App BFF document contains non-BFF paths: ${foreign.join(", ")}`)

// Generated inside the package so prettier resolves the repository config.
const work = path.join(appDir, ".bff-cache", "check")
mkdirSync(work, { recursive: true })
function readTree(root: string): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!statSync(full).isFile() || !entry.name.endsWith(".ts")) continue
      files.set(path.relative(root, full), readFileSync(full, "utf8"))
    }
  }
  walk(root)
  return files
}

try {
  await $`${process.execPath} ${path.join(appDir, "script/generate-bff.ts")} --out ${path.join(work, "gen")}`.cwd(
    appDir,
  )
  const expected = readTree(path.join(work, "gen"))
  const actual = readTree(path.join(appDir, "src/bff/gen"))
  const drift = [...expected.keys()].filter((file) => expected.get(file) !== actual.get(file))
  const missing = [...expected.keys()].filter((file) => !actual.has(file))
  const extra = [...actual.keys()].filter((file) => !expected.has(file))
  if (drift.length > 0 || missing.length > 0 || extra.length > 0) {
    fail(
      [
        "App BFF client is out of date. Run: bun run generate:bff",
        drift.length > 0 ? `drifted: ${drift.join(", ")}` : "",
        missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
        extra.length > 0 ? `unexpected: ${extra.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }

  const publicSpec = await $`${process.execPath} ${path.join(opencode, "script/generate-openapi.ts")}`
    .cwd(opencode)
    .quiet()
  const publicPaths = documentPaths(publicSpec.stdout.toString())
  const leaked = publicPaths.filter((item) => item.startsWith("/workbench"))
  if (leaked.length > 0) fail(`Public OpenAPI must not contain App BFF operations: ${leaked.join(", ")}`)
  const missingPublic = ["/wopal-space/ontologies", "/wopal-space/spaces", "/wopal-space/spaces/{name}/files"].filter(
    (item) => !publicPaths.includes(item),
  )
  if (missingPublic.length > 0) fail(`Public OpenAPI is missing WopalSpace operations: ${missingPublic.join(", ")}`)
  console.log(`App BFF contract OK (${paths.length} app-private operations)`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
