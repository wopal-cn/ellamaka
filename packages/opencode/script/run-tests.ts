import { readdirSync } from "node:fs"
import { join } from "node:path"

export type RunMode = "unit" | "integration" | "e2e" | "all"

// Directories that exercise real I/O (git/PTY/HTTP/subprocess/fs-watch) and are
// excluded from the default unit subset. Kept as a source constant so the list
// is explicit. A directory belongs here when its tests predominantly need live
// OS behavior (subprocess, git, fs watching, real HTTP) — those tests are slow
// and non-deterministic, so they run on demand via test:integration instead of
// on every unit pass.
export const INTEGRATION_DIRS = [
  "server",
  "session",
  "cli",
  "snapshot",
  "project",
  "tool",
  "control-plane",
  "plugin",
  "file",
  "pty",
  "skill",
  "reference",
  "share",
  "mcp",
  "lsp",
]

// e2e files follow the `*-e2e.test.ts` naming convention and are isolated from
// unit/integration runs via pathIgnorePatterns; they run only under the e2e mode.
// `**/` is required so the glob matches e2e files nested in subdirectories
// (a bare `*` does not cross the path separator).
export const E2E_PATTERN = "**/*-e2e.test.ts"

// Recursively collects `*-e2e.test.ts` files under testRoot, returning paths
// relative to the package root (prefixed with `test/`).
function collectE2eFiles(testRoot: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.endsWith("-e2e.test.ts")) {
        out.push(`test/${full.slice(testRoot.length + 1)}`)
      }
    }
  }
  walk(testRoot)
  return out.sort()
}

// Returns the directory arguments to pass to `bun test` for the given mode.
// testRoot is injected so tests can exercise the scan against a temp directory.
export function planning(mode: RunMode, testRoot: string): string[] {
  switch (mode) {
    case "unit": {
      const dirs = readdirSync(testRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => !INTEGRATION_DIRS.includes(name))
        .map((name) => `test/${name}`)
      const topFiles = readdirSync(testRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts") && !entry.name.endsWith("-e2e.test.ts"))
        .map((entry) => `test/${entry.name}`)
      return [...dirs, ...topFiles].sort()
    }
    case "integration":
      return INTEGRATION_DIRS.map((name) => `test/${name}`)
    case "e2e":
      return collectE2eFiles(testRoot)
    case "all":
      return []
    default:
      throw new Error(`Invalid test mode: ${String(mode)}`)
  }
}

// Builds the full `bun test` command for a mode. unit and integration scan whole
// directories, so e2e files nested inside them must be excluded via
// pathIgnorePatterns (CLI value overrides bunfig, not merged). e2e/all pass no
// ignore pattern.
export function buildCommand(mode: RunMode, dirs: string[], bunArgs: string[] = []): string[] {
  const ignoreArgs =
    mode === "unit" || mode === "integration" ? [`--path-ignore-patterns=${E2E_PATTERN}`] : []
  return ["bun", "test", "--timeout", "30000", "--force-exit", ...ignoreArgs, ...dirs, ...bunArgs]
}

async function main() {
  const args = process.argv.slice(2)
  let mode: RunMode = "unit"
  const bunArgs: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--mode") {
      const value = args[++index]
      if (value === "unit" || value === "integration" || value === "e2e" || value === "all") {
        mode = value
      } else {
        console.error(`Unknown mode: ${value}. Expected one of unit, integration, e2e, all.`)
        process.exit(1)
      }
    } else if (arg === "--") {
      bunArgs.push(...args.slice(index + 1))
      break
    } else {
      bunArgs.push(arg)
    }
  }

  const testRoot = join(import.meta.dir, "..", "test")
  const dirs = planning(mode, testRoot)

  // TEST_PLAN_OUTPUT=1 prints the planned directory list instead of running tests.
  if (Bun.env.TEST_PLAN_OUTPUT === "1") {
    console.log(JSON.stringify({ mode, dirs }, null, 2))
    return
  }

  const command = buildCommand(mode, dirs, bunArgs)
  const proc = Bun.spawn(command, {
    cwd: import.meta.dir + "/..",
    stdout: "inherit",
    stderr: "inherit",
    env: Bun.env,
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) process.exit(exitCode ?? 1)
}

if (import.meta.main) {
  main()
}
