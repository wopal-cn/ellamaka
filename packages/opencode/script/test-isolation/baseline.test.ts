import { expect, test } from "bun:test"
import { baselineSize, compareBaseline, entryKey, splitEntryKey, type Baseline, type RuleId } from "./baseline"

function baselineOf(entries: Array<{ rule: RuleId; file: string; detail: string; count?: number }>): Baseline {
  return { version: 1, entries: entries.map((entry) => ({ count: 1, ...entry })) }
}

test("a baseline that matches the source exactly reports nothing", () => {
  const baseline = baselineOf([{ rule: "TISO002", file: "a.test.ts", detail: "process.env.X" }])
  const comparison = compareBaseline(baseline, [
    entryKey({ rule: "TISO002", file: "a.test.ts", detail: "process.env.X" }),
  ])
  expect(comparison.fresh).toEqual([])
  expect(comparison.stale).toEqual([])
  expect(comparison.baselined).toBe(1)
})

test("a second identical violation in the same file is reported fresh", () => {
  const key = entryKey({ rule: "TISO002", file: "a.test.ts", detail: "process.env.X" })
  const comparison = compareBaseline(baselineOf([{ rule: "TISO002", file: "a.test.ts", detail: "process.env.X" }]), [
    key,
    key,
  ])
  expect(comparison.fresh).toEqual([key])
  expect(comparison.baselined).toBe(1)
})

test("a recorded count covers that many occurrences", () => {
  const key = entryKey({ rule: "TISO002", file: "a.test.ts", detail: "process.env.X" })
  const baseline = baselineOf([{ rule: "TISO002", file: "a.test.ts", detail: "process.env.X", count: 3 }])
  expect(compareBaseline(baseline, [key, key, key]).fresh).toEqual([])
  expect(compareBaseline(baseline, [key, key, key, key]).fresh).toEqual([key])
})

test("TISO007 reports a baseline entry whose target disappeared", () => {
  const baseline = baselineOf([{ rule: "TISO001", file: "gone.test.ts", detail: "mock.module(x)" }])
  const comparison = compareBaseline(baseline, [])
  expect(comparison.stale.map((entry) => entry.file)).toEqual(["gone.test.ts"])
  expect(comparison.fresh).toEqual([])
})

test("a partially fixed target must shrink its recorded allowance", () => {
  const key = entryKey({ rule: "TISO002", file: "a.test.ts", detail: "process.env.X" })
  const baseline = baselineOf([{ rule: "TISO002", file: "a.test.ts", detail: "process.env.X", count: 5 }])
  const comparison = compareBaseline(baseline, [key])
  expect(comparison.stale).toEqual([expect.objectContaining({ count: 4 })])
  expect(comparison.fresh).toEqual([])
})

test("removing old debt cannot pay for a new violation", () => {
  const baseline = baselineOf([{ rule: "TISO002", file: "a.test.ts", detail: "process.env.X", count: 2 }])
  const comparison = compareBaseline(baseline, [
    entryKey({ rule: "TISO002", file: "a.test.ts", detail: "process.env.Y" }),
  ])
  expect(comparison.fresh).toHaveLength(1)
  expect(comparison.stale).toEqual([expect.objectContaining({ detail: "process.env.X", count: 2 })])
})

test("an older baseline that repeats one key is read as a count", () => {
  const key = entryKey({ rule: "TISO002", file: "a.test.ts", detail: "process.env.X" })
  const baseline: Baseline = {
    version: 1,
    entries: [
      { rule: "TISO002", file: "a.test.ts", detail: "process.env.X", count: 1 },
      { rule: "TISO002", file: "a.test.ts", detail: "process.env.X", count: 1 },
    ],
  }
  expect(baselineSize(baseline)).toBe(2)
  expect(compareBaseline(baseline, [key, key]).fresh).toEqual([])
})

test("an entry key round-trips through a detail that contains the separator", () => {
  const key = entryKey({ rule: "TISO004", file: "a.test.ts", detail: "fetch(a|b)" })
  const parts = splitEntryKey(key)
  expect(parts.rule).toBe("TISO004")
  expect(parts.file).toBe("a.test.ts")
  expect(parts.detail).toBe("fetch(a|b)")
})
