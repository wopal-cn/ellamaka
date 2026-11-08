import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { runGateCheck } from "./check"
import { scanRepository, scanSource, validateHomePreloadSource, violationKey } from "./scan"

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

const VALID_PRELOAD_SOURCE = [
  'import os from "os"',
  'import path from "path"',
  'import fs from "fs/promises"',
  'import { afterAll } from "bun:test"',
  'const dir = path.join(os.tmpdir(), "pkg-test-home-" + process.pid)',
  "await fs.mkdir(dir, { recursive: true })",
  'process.env["WOPAL_HOME"] = dir',
  "afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }) })",
].join("\n")

test("TISO009 reports direct Global, Global.Path, and Home-bound layer (including direct/destructured defaultLayer imports) in a package without Home preload", () => {
  const result = scanRepository({
    files: new Map([
      ["packages/alpha/package.json", JSON.stringify({ name: "@wopal/alpha", scripts: { test: "bun test" } })],
      [
        "packages/alpha/test/direct.test.ts",
        [
          'import { Global } from "@wopal/ellamaka-core/global"',
          'import { AccountV2, defaultLayer as accountLayer } from "@wopal/ellamaka-core/account"',
          'import { Config } from "@wopal/ellamaka-core/config"',
          "const home = Global.Path.wopalHome",
          "void AccountV2.defaultLayer",
          "void accountLayer",
          "const { defaultLayer: cfgLayer } = Config",
          "void [home, cfgLayer]",
        ].join("\n"),
      ],
    ]),
  })
  const tiso009 = result.violations.filter((v) => v.rule === "TISO009")
  expect(tiso009.map((v) => v.detail)).toEqual([
    expect.stringContaining("Global.Path.wopalHome"),
    expect.stringContaining("AccountV2.defaultLayer"),
    expect.stringContaining("account.defaultLayer"),
    expect.stringContaining("Config.defaultLayer"),
  ])
})

test("TISO009 follows reachable test helpers across test/, src/, script/, e2e, .spec.ts, and nested fixture packages", () => {
  const result = scanRepository({
    files: new Map([
      ["packages/nested/subpkg/package.json", JSON.stringify({ name: "@wopal/subpkg", scripts: { test: "bun test" } })],
      [
        "packages/nested/subpkg/src/feature.spec.ts",
        'import { makeTestLayer } from "../script/helper"\nimport { makeLayer } from "./setup"\nmakeTestLayer()\nmakeLayer()',
      ],
      ["packages/nested/subpkg/src/setup.ts", 'export { makeLayer } from "./assembly"'],
      [
        "packages/nested/subpkg/src/assembly.ts",
        'import { AccountV2 } from "@wopal/ellamaka-core/account"\nexport const makeLayer = () => AccountV2.defaultLayer',
      ],
      [
        "packages/nested/subpkg/script/helper.ts",
        'import { Config } from "@wopal/ellamaka-core/config"\nexport const makeTestLayer = () => Config.defaultLayer',
      ],
      [
        "packages/nested/subpkg/e2e/smoke.test.ts",
        'import { Global } from "@wopal/ellamaka-core/global"\nvoid Global.ensure()',
      ],
      // Parent package has a valid preload, but nested child under test/fixtures/child has its own package.json without preload
      ["packages/isolated/package.json", JSON.stringify({ name: "@wopal/isolated", scripts: { test: "bun test" } })],
      ["packages/isolated/bunfig.toml", '[test]\npreload = ["./test/preload.ts"]\n'],
      ["packages/isolated/test/preload.ts", VALID_PRELOAD_SOURCE],
      [
        "packages/isolated/test/fixtures/child/package.json",
        JSON.stringify({ name: "@wopal/fixture-child", scripts: { test: "bun test" } }),
      ],
      [
        "packages/isolated/test/fixtures/child/test/child.test.ts",
        'import { AccountV2 } from "@wopal/ellamaka-core/account"\nvoid AccountV2.defaultLayer',
      ],
    ]),
  })
  const tiso009 = result.violations.filter((v) => v.rule === "TISO009")
  expect(tiso009.map((v) => ({ file: v.file, detail: v.detail }))).toEqual([
    {
      file: "packages/isolated/test/fixtures/child/test/child.test.ts",
      detail: expect.stringContaining(
        "@wopal/fixture-child (packages/isolated/test/fixtures/child): AccountV2.defaultLayer",
      ),
    },
    {
      file: "packages/nested/subpkg/e2e/smoke.test.ts",
      detail: expect.stringContaining("@wopal/subpkg (packages/nested/subpkg): Global.ensure"),
    },
    {
      file: "packages/nested/subpkg/script/helper.ts",
      detail: expect.stringContaining("@wopal/subpkg (packages/nested/subpkg): Config.defaultLayer"),
    },
    {
      file: "packages/nested/subpkg/src/assembly.ts",
      detail: expect.stringContaining("@wopal/subpkg (packages/nested/subpkg): AccountV2.defaultLayer"),
    },
  ])
})

test("TISO009 does not false-positive on non-Home defaultLayer such as AppFileSystem.defaultLayer or EventV2.defaultLayer", () => {
  const result = scanRepository({
    files: new Map([
      ["packages/pure/package.json", JSON.stringify({ name: "@wopal/pure", scripts: { test: "bun test" } })],
      [
        "packages/pure/test/pure.test.ts",
        [
          'import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"',
          'import { EventV2 } from "@wopal/ellamaka-core/event"',
          'import { Policy } from "@wopal/ellamaka-core/policy"',
          "const layer = [AppFileSystem.defaultLayer, EventV2.defaultLayer, Policy.defaultLayer]",
          "void layer",
        ].join("\n"),
      ],
    ]),
  })
  expect(result.violations.filter((v) => v.rule === "TISO009")).toEqual([])
})

test("TISO009 accepts a package with a valid Home preload and rejects invalid preload variants", () => {
  // Valid preload passes
  const validRepo = scanRepository({
    files: new Map([
      ["packages/isolated/package.json", JSON.stringify({ name: "@wopal/isolated", scripts: { test: "bun test" } })],
      ["packages/isolated/bunfig.toml", '[test]\npreload = ["./test/preload.ts"]\n'],
      ["packages/isolated/test/preload.ts", VALID_PRELOAD_SOURCE],
      [
        "packages/isolated/test/account.test.ts",
        'import { AccountV2 } from "@wopal/ellamaka-core/account"\nvoid AccountV2.defaultLayer',
      ],
    ]),
  })
  expect(validRepo.violations.filter((v) => v.rule === "TISO009")).toEqual([])

  // 1. Self-assignment: process.env.WOPAL_HOME = process.env.WOPAL_HOME ?? ...
  expect(
    validateHomePreloadSource(
      "test/preload.ts",
      [
        'import os from "os"',
        'import path from "path"',
        'import { afterAll } from "bun:test"',
        'process.env.WOPAL_HOME = process.env.WOPAL_HOME || path.join(os.tmpdir(), "x")',
        "afterAll(() => {})",
      ].join("\n"),
    ).valid,
  ).toBe(false)

  // 2. Fixed literal path or real homedir
  expect(
    validateHomePreloadSource(
      "test/preload.ts",
      [
        'import { afterAll } from "bun:test"',
        'process.env.WOPAL_HOME = "/tmp/fixed-shared-home"',
        "afterAll(() => {})",
      ].join("\n"),
    ).valid,
  ).toBe(false)
  expect(
    validateHomePreloadSource(
      "test/preload.ts",
      [
        'import os from "os"',
        'import path from "path"',
        'import { afterAll } from "bun:test"',
        'process.env.WOPAL_HOME = path.join(os.homedir(), ".wopal")',
        "afterAll(() => {})",
      ].join("\n"),
    ).valid,
  ).toBe(false)

  // 3. Evaluated after Global import (both before-statement and hoisted static import after assignment)
  expect(
    validateHomePreloadSource(
      "test/preload.ts",
      [
        'import os from "os"',
        'import path from "path"',
        'import fs from "fs/promises"',
        'import { afterAll } from "bun:test"',
        'import { Global } from "@wopal/ellamaka-core/global"',
        'const dir = path.join(os.tmpdir(), "late-" + process.pid)',
        "process.env.WOPAL_HOME = dir",
        "void Global.Path.wopalHome",
        "afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }) })",
      ].join("\n"),
    ).valid,
  ).toBe(false)
  expect(
    validateHomePreloadSource(
      "test/preload.ts",
      [
        'import os from "os"',
        'import path from "path"',
        'import fs from "fs/promises"',
        'import { afterAll } from "bun:test"',
        'const dir = path.join(os.tmpdir(), "hoisted-" + process.pid)',
        "process.env.WOPAL_HOME = dir",
        'import { Global } from "@wopal/ellamaka-core/global"',
        "void Global.Path.wopalHome",
        "afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }) })",
      ].join("\n"),
    ).valid,
  ).toBe(false)

  // 3b. Shared non-unique tmpdir or empty afterAll without rm/rmSync
  expect(
    validateHomePreloadSource(
      "test/preload.ts",
      [
        'import os from "os"',
        'import path from "path"',
        'import fs from "fs/promises"',
        'import { afterAll } from "bun:test"',
        'const dir = path.join(os.tmpdir(), "shared-fixed-name")',
        "process.env.WOPAL_HOME = dir",
        "afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }) })",
      ].join("\n"),
    ).valid,
  ).toBe(false)
  expect(
    validateHomePreloadSource(
      "test/preload.ts",
      [
        'import os from "os"',
        'import path from "path"',
        'import { afterAll } from "bun:test"',
        'const dir = path.join(os.tmpdir(), "no-rm-" + process.pid)',
        "process.env.WOPAL_HOME = dir",
        "afterAll(() => {})",
      ].join("\n"),
    ).valid,
  ).toBe(false)

  // 4. Test script overrides preload with --config /dev/null, --config ./other.toml, bun --config /dev/null test, or another --preload
  for (const badScript of [
    "bun test --preload ./other-mock.ts",
    "bun test --config ./test/empty.toml",
    "bun --config /dev/null test",
  ]) {
    const overriddenRepo = scanRepository({
      files: new Map([
        [
          "packages/overridden/package.json",
          JSON.stringify({
            name: "@wopal/overridden",
            scripts: { test: badScript },
          }),
        ],
        ["packages/overridden/bunfig.toml", '[test]\npreload = ["./test/preload.ts"]\n'],
        ["packages/overridden/test/preload.ts", VALID_PRELOAD_SOURCE],
        [
          "packages/overridden/test/use-global.test.ts",
          'import { Global } from "@wopal/ellamaka-core/global"\nvoid Global.Path.data',
        ],
      ]),
    })
    expect(
      overriddenRepo.violations.filter((v) => v.rule === "TISO009"),
      badScript,
    ).toHaveLength(1)
  }
})

test("full gate entry (runGateCheck) catches violations in test/fixture/ and temporary package structures without directory exemption", async () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "ellamaka-gate-entry-"))
  try {
    mkdirSync(path.join(tmpRoot, "packages", "sample", "test", "fixture"), { recursive: true })
    writeFileSync(path.join(tmpRoot, "package.json"), JSON.stringify({ name: "sample-root", private: true }))
    writeFileSync(
      path.join(tmpRoot, "packages", "sample", "package.json"),
      JSON.stringify({ name: "@wopal/sample", scripts: { test: "bun test" } }),
    )
    // Put a violation inside test/fixture/ to verify no directory-wide exemption exists
    writeFileSync(
      path.join(tmpRoot, "packages", "sample", "test", "fixture", " sneaky.test.ts"),
      ['import { Global } from "@wopal/ellamaka-core/global"', "void Global.Path.wopalHome"].join("\n"),
    )

    const report = await runGateCheck(tmpRoot)
    expect(report.freshViolations.map((v) => v.rule)).toContain("TISO009")
    expect(report.freshViolations[0]?.file).toBe("packages/sample/test/fixture/ sneaky.test.ts")
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})
