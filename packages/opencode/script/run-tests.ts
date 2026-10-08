import { existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"

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
  "publish-smoke",
]

// e2e files follow the `*-e2e.test.ts` naming convention and are isolated from
// unit/integration runs via pathIgnorePatterns; they run only under the e2e mode.
// `**/` is required so the glob matches e2e files nested in subdirectories
// (a bare `*` does not cross the path separator).
export const E2E_PATTERN = "**/*-e2e.test.ts"

// bun does not split comma-separated --path-ignore-patterns values, so both
// conventions share one brace glob (a single flag, verified against bun 1.3.14).
export const LAYERED_IGNORE_PATTERN = "**/*-{e2e,integration}.test.ts"

// Explicit concurrency ceiling for the live-I/O layers. bun runs test *files*
// serially; this bounds the concurrent tests inside each file so integration
// runs do not stampede subprocess/HTTP/git resources.
export const INTEGRATION_MAX_CONCURRENCY = 4

// Recursively collects test files whose name ends with `suffix` under `root`,
// returning paths relative to the package root (prefixed with `prefix`).
function collectFilesBySuffix(root: string, prefix: string, suffix: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        out.push(`${prefix}/${full.slice(root.length + 1)}`)
      }
    }
  }
  walk(root)
  return out.sort()
}

// The runner's own tests live in `script/`, beside `test/`. Every layer scans
// that directory as well, so no test file can fall outside all three scans; the
// unit layer drops the other layers' naming conventions. A missing `script/` —
// a synthetic test root, for instance — yields none.
function collectScriptTests(testRoot: string, suffix: string): string[] {
  const dir = join(dirname(testRoot), "script")
  if (!existsSync(dir)) return []
  return collectFilesBySuffix(dir, "script", suffix)
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
      // Top-level files are passed explicitly, so the e2e/integration
      // conventions are filtered here as well as via pathIgnorePatterns.
      const topFiles = readdirSync(testRoot, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.endsWith(".test.ts") &&
            !entry.name.endsWith("-e2e.test.ts") &&
            !entry.name.endsWith("-integration.test.ts"),
        )
        .map((entry) => `test/${entry.name}`)
      // The runner's own tests sit outside `test/`, so they are collected
      // separately; passing them here also puts them under the unit pass and
      // therefore under the pre-commit gate.
      const scriptTests = collectScriptTests(testRoot, ".test.ts").filter(
        (file) => !file.endsWith("-e2e.test.ts") && !file.endsWith("-integration.test.ts"),
      )
      return [...dirs, ...topFiles, ...scriptTests].sort()
    }
    case "integration": {
      // Trailing slashes are required: bun filters positionals by path
      // substring, so `test/file` would also match the sibling `test/filesystem/`
      // and `test/plugin` would match `test/plugin-sdk-branding.test.ts`.
      const dirs = INTEGRATION_DIRS.map((name) => `test/${name}/`)
      // Live-I/O files that sit in unit directories are not covered by the
      // directory list, so scan for them recursively and run them explicitly
      // (bun de-duplicates a file passed both as a directory and directly).
      return [
        ...dirs,
        ...collectFilesBySuffix(testRoot, "test", "-integration.test.ts"),
        ...collectScriptTests(testRoot, "-integration.test.ts"),
      ]
    }
    case "e2e":
      return [
        ...collectFilesBySuffix(testRoot, "test", "-e2e.test.ts"),
        ...collectScriptTests(testRoot, "-e2e.test.ts"),
      ]
    case "all":
      return []
    default:
      throw new Error(`Invalid test mode: ${String(mode)}`)
  }
}

// Builds the full `bun test` command for a mode. unit and integration scan whole
// directories, so files carrying another layer's naming convention must be
// excluded via pathIgnorePatterns (CLI value overrides bunfig, not merged).
// The unit layer ignores both conventions; the integration layer ignores only
// e2e so `*-integration.test.ts` files still run. e2e/all pass no ignore pattern.
export function buildCommand(mode: RunMode, dirs: string[], bunArgs: string[] = []): string[] {
  const ignoreArgs =
    mode === "unit"
      ? [`--path-ignore-patterns=${LAYERED_IGNORE_PATTERN}`]
      : mode === "integration"
        ? [`--path-ignore-patterns=${E2E_PATTERN}`]
        : []
  const concurrencyArgs =
    mode === "integration" || mode === "all" ? [`--max-concurrency=${INTEGRATION_MAX_CONCURRENCY}`] : []
  return ["bun", "test", "--timeout", "30000", "--force-exit", ...concurrencyArgs, ...ignoreArgs, ...dirs, ...bunArgs]
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
