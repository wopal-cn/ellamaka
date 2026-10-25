import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  buildRuns,
  collectTestFiles,
  findUnrestoredMocks,
  parseExecutedOrder,
  runOrderedFiles,
} from "./check-test-order-isolation"
import { collectRestoredTargets, findUnrestoredMocksIn } from "./check-test-order-isolation.shared"

const BT = String.fromCharCode(96)

const files = [
  "src/a.test.ts",
  "src/context/global-sync/b.test.ts",
  "src/context/global-sync/c.test.ts",
  "src/d.test.tsx",
]

describe("test order isolation runs", () => {
  test("runs every test file forward in sorted order and then in reverse", () => {
    const runs = buildRuns(files)

    expect(runs[0]).toEqual({ label: "forward (4 files)", files })
    expect(runs[1]).toEqual({ label: "reverse (4 files)", files: [...files].reverse() })
  })

  test("covers both orders of every pair inside the shared-state directory", () => {
    const pairs = buildRuns(files).slice(2)

    expect(pairs.map((run) => run.files)).toEqual([
      ["src/context/global-sync/b.test.ts", "src/context/global-sync/c.test.ts"],
      ["src/context/global-sync/c.test.ts", "src/context/global-sync/b.test.ts"],
    ])
    expect(pairs.every((run) => run.files.every((file) => file.startsWith("src/context/global-sync/")))).toBeTrue()
  })

  test("only pairs files, never a file with itself", () => {
    const paired = files.filter((file) => file.startsWith("src/context/global-sync/"))
    const pairs = buildRuns(files).slice(2)

    expect(pairs).toHaveLength(paired.length * (paired.length - 1))
    expect(pairs.every((run) => run.files[0] !== run.files[1])).toBeTrue()
  })
})

describe("test file discovery", () => {
  const root = path.resolve(import.meta.dir, "..")

  test("finds every unit test file in sorted order and skips non-test sources", async () => {
    const found = await collectTestFiles(root)

    expect(found.length).toBeGreaterThan(0)
    expect(found).toEqual([...found].sort())
    expect(found.every((file) => file.endsWith(".test.ts") || file.endsWith(".test.tsx"))).toBeTrue()
    expect(found.some((file) => file.includes("node_modules"))).toBeFalse()
    expect(found.some((file) => file.includes(".artifacts"))).toBeFalse()
  })

  test("covers the whole app test tree, not just the paired directory", async () => {
    const found = await collectTestFiles(root)
    const paired = found.filter((file) => file.startsWith("src/context/global-sync/"))

    expect(paired.length).toBeGreaterThan(1)
    expect(found.length).toBeGreaterThan(paired.length)
  })
})

describe("real execution order", () => {
  const root = path.resolve(import.meta.dir, "..")

  test("observes the files Bun actually executed, in execution order", async () => {
    const forward = await runOrderedFiles(["src/utils/uuid.test.ts", "src/utils/refcount.test.ts"], root)
    const reverse = await runOrderedFiles(["src/utils/refcount.test.ts", "src/utils/uuid.test.ts"], root)

    expect(forward.ok).toBeTrue()
    expect(reverse.ok).toBeTrue()
  }, 120_000)

  test("rejects a run whose real order differs from the requested order", async () => {
    const parsed = parseExecutedOrder(
      ["src/utils/uuid.test.ts:", "  (pass) x", "src/utils/refcount.test.ts:", "  (pass) y"].join("\n"),
    )

    expect(parsed).toEqual(["src/utils/uuid.test.ts", "src/utils/refcount.test.ts"])
    expect(parsed).not.toEqual(["src/utils/refcount.test.ts", "src/utils/uuid.test.ts"])
  })
})

describe("restore audit boundaries", () => {
  test("counts only mocks restored inside afterAll callbacks", () => {
    const source = [
      "afterAll(() => {",
      '  mock.module("a", () => realA)',
      "})",
      'test("later", () => {',
      '  mock.module("b", () => fakeB)',
      "})",
    ].join("\n")

    expect([...collectRestoredTargets(source)]).toEqual(["a"])
    expect(findUnrestoredMocksIn("x.test.ts", source)).toEqual([{ file: "x.test.ts", module: "b" }])
  })

  test("fails closed on a mock whose id cannot be read statically", () => {
    const source = ['const id = "x"', "mock.module(id, () => fake)", "afterAll(() => {})"].join("\n")

    expect(findUnrestoredMocksIn("x.test.ts", source)).toEqual([{ file: "x.test.ts", module: "<dynamic>" }])
  })
  test("fails closed on a template id with interpolation", () => {
    const placeholder = ["$", "{name}"].join("")
    const source = [
      "mock.module(" + BT + "prefix-" + placeholder + BT + ", () => fake)",
      "afterAll(() => {",
      "  mock.module(" + BT + "prefix-" + placeholder + BT + ", () => real)",
      "})",
    ].join("\n")

    expect(findUnrestoredMocksIn("x.test.ts", source)).toEqual([{ file: "x.test.ts", module: "<dynamic>" }])
  })
})

describe("shared module mock audit", () => {
  const root = path.resolve(import.meta.dir, "..")

  test("every mocked module is restored in afterAll", async () => {
    expect(await findUnrestoredMocks(root)).toEqual([])
  })

  test("flags a mock that is never restored", async () => {
    const leaks = await findUnrestoredMocks(path.resolve(import.meta.dir, "fixtures"))
    expect(leaks.length).toBeGreaterThan(0)
  })
})
