import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { buildCommand, E2E_PATTERN, INTEGRATION_DIRS, planning } from "./run-tests"

const INTEGRATION = [
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
const FAST = ["acp", "config", "provider", "util"]

const roots: string[] = []

function makeTestRoot(dirs: string[], files: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "run-tests-"))
  roots.push(root)
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

  test("unit excludes top-level *-e2e.test.ts files", () => {
    const root = makeTestRoot([...FAST], ["unit.test.ts", "flow-e2e.test.ts"])
    const dirs = planning("unit", root)
    expect(dirs).toContain("test/unit.test.ts")
    expect(dirs).not.toContain("test/flow-e2e.test.ts")
  })

  test("integration returns exactly the integration directory list", () => {
    const root = makeTestRoot([...INTEGRATION, ...FAST])
    expect(planning("integration", root)).toEqual(INTEGRATION.map((name) => `test/${name}`))
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
})

describe("buildCommand ignore pattern injection", () => {
  test("unit injects --path-ignore-patterns with the recursive e2e pattern", () => {
    const cmd = buildCommand("unit", ["test/config"])
    expect(cmd).toContain(`--path-ignore-patterns=${E2E_PATTERN}`)
    expect(E2E_PATTERN).toBe("**/*-e2e.test.ts")
  })

  test("integration injects --path-ignore-patterns with the recursive e2e pattern", () => {
    const cmd = buildCommand("integration", ["test/server"])
    expect(cmd).toContain(`--path-ignore-patterns=${E2E_PATTERN}`)
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
