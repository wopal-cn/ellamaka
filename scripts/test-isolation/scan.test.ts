import { expect, test } from "bun:test"
import { scanSource, violationKey } from "./scan"

const options = { root: "/repo", relative: (value: string) => value }

function scan(file: string, source: string) {
  return scanSource(file, source, options)
}

test("TISO001 reports a module replacement in an ordinary test", () => {
  const violations = scan(
    "packages/ellamaka-app/src/example.test.ts",
    ['import { mock } from "bun:test"', 'void mock.module("@wopal/ui/context", () => ({}))'].join("\n"),
  )
  expect(violations.map((violation) => violation.rule)).toEqual(["TISO001"])
})

test("TISO001 accepts an approved process preload", () => {
  const violations = scan(
    "packages/ellamaka-desktop/electron-mock.ts",
    ['void mock.module("electron", () => ({}))'].join("\n"),
  )
  expect(violations).toEqual([])
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

test("TISO004 reports live I/O in the unit layer but not in the integration layer", () => {
  const unit = scan("packages/ellamaka-app/src/example.test.ts", ['Bun.spawn(["bun", "run", "script.ts"])'].join("\n"))
  expect(unit.map((violation) => violation.rule)).toEqual(["TISO004"])

  const integration = scan(
    "packages/opencode/test/server/example.test.ts",
    ['Bun.spawn(["bun", "run", "script.ts"])'].join("\n"),
  )
  expect(integration).toEqual([])
})

test("TISO005 reports only, skip and todo", () => {
  const only = scan("packages/ellamaka-app/src/example.test.ts", ['test.only("works", () => {})'].join("\n"))
  expect(only.map((violation) => violation.rule)).toEqual(["TISO005"])

  const skip = scan("packages/ellamaka-app/src/example.test.ts", ['test.skip("later", () => {})'].join("\n"))
  expect(skip.map((violation) => violation.rule)).toEqual(["TISO005"])
})

test("TISO006 reports a write to a shared global path", () => {
  const violations = scan(
    "packages/ellamaka-app/src/example.test.ts",
    ['await fs.writeFile(Global.Path.config + "/settings.jsonc", "{}")'].join("\n"),
  )
  expect(violations.map((violation) => violation.rule)).toEqual(["TISO006"])
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
