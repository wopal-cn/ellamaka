import { expect, test } from "bun:test"
import { scanSource, violationKey } from "./scan"

const options = { root: "/repo", relative: (value: string) => value }

function scan(file: string, source: string) {
  return scanSource(file, source, options)
}

const rulesOf = (file: string, source: string) => scan(file, source).map((violation) => violation.rule)

test("TISO001 reports a module replacement in an ordinary test", () => {
  const violations = scan(
    "packages/ellamaka-app/src/example.test.ts",
    ['import { mock } from "bun:test"', 'void mock.module("@wopal/ui/context", () => ({}))'].join("\n"),
  )
  expect(violations.map((violation) => violation.rule)).toEqual(["TISO001"])
})

test("TISO001 accepts a fixture sample that a gate test consumes", () => {
  // Gate fixtures are data, not tests the suite runs: the file lives under
  // fixtures/ and a checker reads it, so it may replace modules on purpose.
  const violations = scan(
    "packages/ellamaka-app/script/fixtures/src/leaky.test.ts",
    ['void mock.module("./something", () => ({}))'].join("\n"),
  )
  expect(violations).toEqual([])
})

test("TISO001 does not exempt ordinary tests merely placed in a fixture directory", () => {
  expect(rulesOf("packages/opencode/test/fixture/leak.test.ts", 'mock.module("shared", () => ({}))')).toEqual([
    "TISO001",
  ])
})

test("TISO002 reports an environment mutation and names the key", () => {
  const violations = scan("packages/ellamaka-app/src/example.test.ts", ['process.env.OPENCODE_PURE = "1"'].join("\n"))
  expect(violations).toEqual([expect.objectContaining({ rule: "TISO002", detail: "process.env.OPENCODE_PURE" })])
})

test("TISO002 reports a deleted environment variable", () => {
  const violations = scan("packages/ellamaka-app/src/example.test.ts", ["delete process.env.OPENCODE_PURE"].join("\n"))
  expect(violations.map((violation) => violation.rule)).toEqual(["TISO002"])
})

test("TISO003 reports a fixed delay but not a zero delay", () => {
  const fixed = scan("packages/ellamaka-app/src/example.test.ts", ['Effect.sleep("100 millis")'].join("\n"))
  expect(fixed.map((violation) => violation.rule)).toEqual(["TISO003"])

  const zero = scan("packages/ellamaka-app/src/example.test.ts", ["Effect.sleep(0)"].join("\n"))
  expect(zero).toEqual([])
})

test("TISO003 reports a bare setTimeout and setInterval delay", () => {
  expect(rulesOf("packages/ellamaka-app/src/example.test.ts", ["setTimeout(() => {}, 50)"].join("\n"))).toEqual([
    "TISO003",
  ])
  expect(rulesOf("packages/ellamaka-app/src/example.test.ts", ["setInterval(() => {}, 50)"].join("\n"))).toEqual([
    "TISO003",
  ])
})

test("TISO004 reports live I/O in the unit layer but not in the integration layer", () => {
  expect(
    rulesOf("packages/ellamaka-app/src/example.test.ts", ['Bun.spawn(["bun", "run", "script.ts"])'].join("\n")),
  ).toEqual(["TISO004"])

  const integration = scan(
    "packages/opencode/test/server/example.test.ts",
    ['Bun.spawn(["bun", "run", "script.ts"])'].join("\n"),
  )
  expect(integration).toEqual([])
})

test("TISO004 follows a named child_process import, a namespace import and a bare fetch", () => {
  expect(
    rulesOf(
      "packages/ellamaka-app/src/example.test.ts",
      ['import { spawnSync } from "node:child_process"', 'spawnSync("git", ["status"])'].join("\n"),
    ),
  ).toEqual(["TISO004"])

  expect(
    rulesOf(
      "packages/ellamaka-app/src/example.test.ts",
      ['import * as cp from "node:child_process"', 'cp.execSync("git status")'].join("\n"),
    ),
  ).toEqual(["TISO004"])

  expect(
    rulesOf("packages/ellamaka-app/src/example.test.ts", ['await fetch("http://127.0.0.1:1/ping")'].join("\n")),
  ).toEqual(["TISO004"])
})

test("TISO004 ignores a local function that only shares the name", () => {
  const violations = scan(
    "packages/ellamaka-app/src/example.test.ts",
    ["function spawn(command: string) { return command }", 'spawn("not a process")'].join("\n"),
  )
  expect(violations).toEqual([])
})

test("TISO004 keeps a package test directory that the runner treats as unit", () => {
  // ellamaka-core runs test/ under test:unit, so a subprocess there is a
  // violation rather than an integration exemption.
  expect(
    rulesOf("packages/ellamaka-core/test/util/flock.test.ts", ['Bun.spawn(["bun", "worker.ts"])'].join("\n")),
  ).toEqual(["TISO004"])
})

test("TISO004 honors a file that the runner lists as integration", () => {
  const violations = scan(
    "packages/ellamaka-cordis/test/dsh-web.test.ts",
    ['Bun.spawn(["bun", "worker.ts"])'].join("\n"),
  )
  expect(violations).toEqual([])
})

test("TISO005 reports only, skip and todo", () => {
  expect(rulesOf("packages/ellamaka-app/src/example.test.ts", ['test.only("works", () => {})'].join("\n"))).toEqual([
    "TISO005",
  ])
  expect(rulesOf("packages/ellamaka-app/src/example.test.ts", ['test.skip("later", () => {})'].join("\n"))).toEqual([
    "TISO005",
  ])
  expect(rulesOf("packages/ellamaka-app/src/example.test.ts", ['test.todo("later")'].join("\n"))).toEqual(["TISO005"])
})

test("TISO005 ignores a product method that happens to be called skip or todo", () => {
  expect(rulesOf("packages/ellamaka-app/src/example.test.ts", ["controller.skip()"].join("\n"))).toEqual([])
  expect(rulesOf("packages/ellamaka-app/src/example.test.ts", ['sdk.session.todo({ title: "x" })'].join("\n"))).toEqual(
    [],
  )
})

test("TISO008 reports in-process concurrent test controls", () => {
  expect(rulesOf("packages/opencode/test/example.test.ts", 'test.concurrent("race", () => {})')).toEqual(["TISO008"])
  expect(rulesOf("packages/opencode/test/example.test.ts", 'describe.concurrent("race", () => {})')).toEqual([
    "TISO008",
  ])
})

test("TISO008 follows bun:test aliases and namespace imports", () => {
  expect(
    rulesOf(
      "packages/opencode/test/example.test.ts",
      ['import { test as bunTest } from "bun:test"', 'bunTest.concurrent("race", () => {})'].join("\n"),
    ),
  ).toEqual(["TISO008"])

  expect(
    rulesOf(
      "packages/opencode/test/example.test.ts",
      ['import * as bt from "bun:test"', 'bt.describe.concurrent("race", () => {})'].join("\n"),
    ),
  ).toEqual(["TISO008"])
})

test("TISO008 reports chained concurrent controls", () => {
  expect(rulesOf("packages/opencode/test/example.test.ts", 'test.concurrent.each([[1]])("race", () => {})')).toEqual([
    "TISO008",
  ])
})

test("TISO008 ignores a local object that only shares a test-control name", () => {
  expect(
    rulesOf(
      "packages/opencode/test/example.test.ts",
      ["const test = { concurrent: (name: string) => name }", 'test.concurrent("product operation")'].join("\n"),
    ),
  ).toEqual([])
})

test("TISO008 keeps canonical controls outside a nested shadow", () => {
  const violations = scan(
    "packages/opencode/test/example.test.ts",
    [
      "function helper() { const test = { concurrent: () => {} }; test.concurrent() }",
      'test.concurrent("real test", () => {})',
    ].join("\n"),
  )
  expect(violations.filter((violation) => violation.rule === "TISO008")).toHaveLength(1)
  expect(violations.find((violation) => violation.rule === "TISO008")?.line).toBe(2)
})

test("TISO008 ignores a nested shadow of a bun:test alias", () => {
  expect(
    rulesOf(
      "packages/opencode/test/example.test.ts",
      [
        'import { test as bunTest } from "bun:test"',
        "function helper() { const bunTest = { concurrent: () => {} }; bunTest.concurrent() }",
      ].join("\n"),
    ),
  ).toEqual([])
})

test("TISO008 ignores explicit concurrency created inside one ordinary test", () => {
  expect(
    rulesOf(
      "packages/opencode/test/example.test.ts",
      'test("race", async () => { await Promise.all([runOne(), runTwo()]) })',
    ),
  ).not.toContain("TISO008")
})

test("TISO008 leaves documented owner-aware package concurrency helpers to their fixture contract", () => {
  expect(
    rulesOf(
      "packages/opencode/test/example.test.ts",
      ['import { cliIt } from "./lib/cli-process"', 'cliIt.concurrent("isolated cli process", () => runCli())'].join(
        "\n",
      ),
    ),
  ).not.toContain("TISO008")
})

test("TISO006 reports a write to a shared global path", () => {
  expect(
    rulesOf(
      "packages/ellamaka-app/src/example.test.ts",
      ['await fs.writeFile(Global.Path.config + "/settings.jsonc", "{}")'].join("\n"),
    ),
  ).toEqual(["TISO006"])

  expect(
    rulesOf(
      "packages/ellamaka-app/src/example.test.ts",
      ['await Bun.write(path.join(Global.Path.data, "state.json"), "{}")'].join("\n"),
    ),
  ).toEqual(["TISO006"])
})

test("files that are not tests are never scanned", () => {
  const violations = scan(
    "packages/ellamaka-app/src/example.ts",
    ['void mock.module("@wopal/ui/context", () => ({}))'].join("\n"),
  )
  expect(violations).toEqual([])
})

test("the violation key identifies one violation precisely", () => {
  const first = scan(
    "packages/ellamaka-app/src/example.test.ts",
    ['void mock.module("@wopal/ui/context", () => ({}))'].join("\n"),
  )[0]
  const second = scan(
    "packages/ellamaka-app/src/example.test.ts",
    ['void mock.module("@wopal/ui/toast", () => ({}))'].join("\n"),
  )[0]
  expect(violationKey(first)).not.toBe(violationKey(second))
})
