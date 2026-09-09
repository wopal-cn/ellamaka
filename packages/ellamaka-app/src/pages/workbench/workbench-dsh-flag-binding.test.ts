import { describe, expect, test } from "bun:test"
import { isDshReady } from "./workbench-dsh-flag-binding"

describe("isDshReady", () => {
  test("accepts the ready runtime status and legacy boolean", () => {
    expect(isDshReady("ready")).toBe(true)
    expect(isDshReady(true)).toBe(true)
    expect(isDshReady("disabled")).toBe(false)
    expect(isDshReady("preparing")).toBe(false)
    expect(isDshReady("degraded")).toBe(false)
    expect(isDshReady(false)).toBe(false)
  })
})
