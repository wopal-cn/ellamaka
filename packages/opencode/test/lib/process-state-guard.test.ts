import { expect, test } from "bun:test"
import {
  assertProcessStateClean,
  captureProcessState,
  diffProcessState,
  type ProcessStateTarget,
} from "./process-state-guard"

function target(input?: { cwd?: string; env?: Record<string, string | undefined> }): ProcessStateTarget {
  let cwd = input?.cwd ?? "/repo"
  return {
    env: { ...input?.env },
    cwd: () => cwd,
    chdir: (next) => {
      cwd = next
    },
  }
}

test("process state diff reports added, removed, changed env keys and cwd", () => {
  const expected = captureProcessState(target({ cwd: "/repo", env: { KEEP: "1", REMOVE: "old", CHANGE: "old" } }))
  const actual = captureProcessState(target({ cwd: "/tmp", env: { KEEP: "1", ADD: "new", CHANGE: "new" } }))

  expect(diffProcessState(expected, actual)).toEqual([
    "cwd: expected /repo, got /tmp",
    'env.ADD: expected <unset>, got "new"',
    'env.CHANGE: expected "old", got "new"',
    'env.REMOVE: expected "old", got <unset>',
  ])
})

test("runtime guard restores the baseline before reporting TISO101", () => {
  const fake = target({ cwd: "/repo", env: { KEEP: "1", CHANGE: "old" } })
  const baseline = captureProcessState(fake)
  fake.env.ADD = "new"
  fake.env.CHANGE = "new"
  fake.chdir("/tmp")

  expect(() => assertProcessStateClean(baseline, fake)).toThrow("TISO101")
  expect(captureProcessState(fake)).toEqual(baseline)
})

test("runtime guard accepts an exactly restored process", () => {
  const fake = target({ cwd: "/repo", env: { KEEP: "1", EMPTY: "" } })
  const baseline = captureProcessState(fake)
  expect(() => assertProcessStateClean(baseline, fake)).not.toThrow()
})
