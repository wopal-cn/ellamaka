import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import {
  buildCommand,
  E2E_PATTERN,
  INTEGRATION_DIRS,
  INTEGRATION_MAX_CONCURRENCY,
  LAYERED_IGNORE_PATTERN,
  planning,
} from "./run-tests"

const INTEGRATION = [
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
const FAST = ["acp", "config", "provider", "util"]

const roots: string[] = []

function makeTestRoot(dirs: string[], files: string[] = []): string {
  // Nest the synthetic `test/` root under a fresh base directory: `planning`
  // also looks for a sibling `script/`, so `dirname(root)` must be unique to
  // this fixture — otherwise it would resolve to the shared system temp
  // directory and pick up unrelated leftovers.
  const base = mkdtempSync(join(tmpdir(), "run-tests-"))
  roots.push(base)
  const root = join(base, "test")
  mkdirSync(root)
  for (const dir of dirs) {
    mkdirSync(join(root, dir))
    writeFileSync(join(root, dir, "sample.test.ts"), "test('x', () => {})")
  }
  for (const file of files) {
    writeFileSync(join(root, file), "test('x', () => {})")
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("planning mode expansion", () => {
  test("unit includes only fast directories, excludes all integration directories, sorted", () => {
    const root = makeTestRoot([...INTEGRATION, ...FAST])
    const dirs = planning("unit", root)
    expect(dirs).toEqual(FAST.map((name) => `test/${name}`))
    for (const slow of INTEGRATION) expect(dirs).not.toContain(`test/${slow}`)
  })

  test("unit handles an empty or all-integration test root without error", () => {
    const root = makeTestRoot([...INTEGRATION])
    expect(planning("unit", root)).toEqual([])
  })

  test("unit includes top-level *.test.ts files alongside fast directories", () => {
    const root = makeTestRoot([...INTEGRATION, ...FAST], ["permission-task.test.ts", "other.test.ts"])
    const dirs = planning("unit", root)
    expect(dirs).toContain("test/permission-task.test.ts")
    expect(dirs).toContain("test/other.test.ts")
    for (const slow of INTEGRATION) expect(dirs).not.toContain(`test/${slow}`)
    expect([...dirs]).toEqual([...dirs].sort())
  })

  test("unit excludes top-level *-e2e.test.ts and *-integration.test.ts files", () => {
    const root = makeTestRoot([...FAST], ["unit.test.ts", "flow-e2e.test.ts", "process-integration.test.ts"])
    const dirs = planning("unit", root)
    expect(dirs).toContain("test/unit.test.ts")
    expect(dirs).not.toContain("test/flow-e2e.test.ts")
    expect(dirs).not.toContain("test/process-integration.test.ts")
  })

  test("integration returns the integration directories with a trailing slash and no snapshot entry", () => {
    const root = makeTestRoot([...INTEGRATION, ...FAST])
    const dirs = planning("integration", root)
    expect(dirs).toEqual(INTEGRATION.map((name) => `test/${name}/`))
    expect(dirs.every((dir) => dir.endsWith("/"))).toBe(true)
    expect(INTEGRATION_DIRS).not.toContain("snapshot")
  })

  test("integration appends *-integration.test.ts files recursively, including unit directories", () => {
    const root = makeTestRoot([...INTEGRATION, ...FAST])
    writeFileSync(join(root, "util", "process-integration.test.ts"), "test('x', () => {})")
    writeFileSync(join(root, "provider", "header-timeout-integration.test.ts"), "test('x', () => {})")
    mkdirSync(join(root, "util", "nested"))
    writeFileSync(join(root, "util", "nested", "deep-integration.test.ts"), "test('x', () => {})")
    writeFileSync(join(root, "util", "plain.test.ts"), "test('x', () => {})")

    const files = planning("integration", root)
    expect(files).toContain("test/util/process-integration.test.ts")
    expect(files).toContain("test/provider/header-timeout-integration.test.ts")
    expect(files).toContain("test/util/nested/deep-integration.test.ts")
    expect(files).not.toContain("test/util/plain.test.ts")
    const collected = files.filter((path) => path.endsWith("-integration.test.ts"))
    expect([...collected]).toEqual([...collected].sort())
  })

  test("unit directories keep *-integration.test.ts files out of their plan output", () => {
    const root = makeTestRoot([...FAST])
    writeFileSync(join(root, "util", "process-integration.test.ts"), "test('x', () => {})")
    const dirs = planning("unit", root)
    expect(dirs).toContain("test/util")
    expect(dirs).not.toContain("test/util/process-integration.test.ts")
  })

  test("e2e returns only *-e2e.test.ts files, recursively", () => {
    const root = makeTestRoot([...FAST], ["flow-e2e.test.ts"])
    mkdirSync(join(root, "nested"))
    writeFileSync(join(root, "nested", "cf-ai-gateway-e2e.test.ts"), "test('x', () => {})")
    writeFileSync(join(root, "nested", "normal.test.ts"), "test('x', () => {})")
    const files = planning("e2e", root)
    expect(files).toContain("test/flow-e2e.test.ts")
    expect(files).toContain("test/nested/cf-ai-gateway-e2e.test.ts")
    expect(files).not.toContain("test/nested/normal.test.ts")
  })

  test("all returns an empty directory array (bun runs everything)", () => {
    const root = makeTestRoot([...INTEGRATION, ...FAST])
    expect(planning("all", root)).toEqual([])
  })

  test("invalid mode throws", () => {
    const root = makeTestRoot([...FAST])
    expect(() => planning("invalid" as never, root)).toThrow()
  })

  test("INTEGRATION_DIRS matches the documented integration directory list", () => {
    expect(INTEGRATION_DIRS).toEqual(INTEGRATION)
  })

  test("unit includes the runner's own tests under script/", () => {
    const realTestRoot = join(import.meta.dir, "..", "test")
    const dirs = planning("unit", realTestRoot)
    expect(dirs).toContain("script/run-modes.test.ts")
    expect(dirs).toContain("script/run-tests-root.test.ts")
    expect(dirs).toContain("script/model-catalog.test.ts")
    expect([...dirs]).toEqual([...dirs].sort())
  })
})

describe("buildCommand ignore pattern injection", () => {
  test("unit injects a single brace-glob ignore for e2e and integration files", () => {
    const cmd = buildCommand("unit", ["test/config"])
    expect(cmd).toContain(`--path-ignore-patterns=${LAYERED_IGNORE_PATTERN}`)
    expect(LAYERED_IGNORE_PATTERN).toBe("**/*-{e2e,integration}.test.ts")
    expect(E2E_PATTERN).toBe("**/*-e2e.test.ts")
    // bun does not split comma-separated patterns, so the ignore must stay one brace glob.
    expect(cmd.filter((arg) => arg.startsWith("--path-ignore-patterns"))).toHaveLength(1)
  })

  test("integration injects only the e2e ignore so *-integration.test.ts files still run", () => {
    const cmd = buildCommand("integration", ["test/server/"])
    expect(cmd).toContain(`--path-ignore-patterns=${E2E_PATTERN}`)
    expect(cmd).not.toContain(`--path-ignore-patterns=${LAYERED_IGNORE_PATTERN}`)
  })

  test("integration and all cap concurrency, unit and e2e do not", () => {
    const limited = `--max-concurrency=${INTEGRATION_MAX_CONCURRENCY}`
    expect(buildCommand("integration", ["test/server/"])).toContain(limited)
    expect(buildCommand("all", [])).toContain(limited)
    expect(buildCommand("unit", ["test/config"])).not.toContain(limited)
    expect(buildCommand("e2e", ["test/provider/cf-ai-gateway-e2e.test.ts"])).not.toContain(limited)
  })

  test("e2e does not inject an ignore pattern", () => {
    const cmd = buildCommand("e2e", ["test/provider/cf-ai-gateway-e2e.test.ts"])
    expect(cmd.some((arg) => arg.startsWith("--path-ignore-patterns"))).toBe(false)
  })

  test("all does not inject an ignore pattern", () => {
    const cmd = buildCommand("all", [])
    expect(cmd.some((arg) => arg.startsWith("--path-ignore-patterns"))).toBe(false)
  })

  test("command preserves base args and trailing bun args", () => {
    const cmd = buildCommand("unit", ["test/config"], ["--reporter=junit"])
    expect(cmd[0]).toBe("bun")
    expect(cmd).toContain("--timeout")
    expect(cmd).toContain("--force-exit")
    expect(cmd).toContain("test/config")
    expect(cmd).toContain("--reporter=junit")
  })
})
