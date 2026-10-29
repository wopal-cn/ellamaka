import { expect, test } from "bun:test"
import { scopedEnv } from "./process-env"

test("scopedEnv restores missing, empty and existing values after an exception", () => {
  const env: Record<string, string | undefined> = { empty: "", existing: "original" }
  expect(() => {
    using _scope = scopedEnv({ missing: "temporary", empty: "changed", existing: undefined }, env)
    expect(env).toEqual({ missing: "temporary", empty: "changed" })
    throw new Error("fixture failure")
  }).toThrow("fixture failure")
  expect(env).toEqual({ empty: "", existing: "original" })
})

test("nested environment scopes restore their immediate owner", () => {
  const env = { mode: "original" }
  {
    using _outer = scopedEnv({ mode: "outer" }, env)
    {
      using _inner = scopedEnv({ mode: "inner" }, env)
      expect(env.mode).toBe("inner")
    }
    expect(env.mode).toBe("outer")
  }
  expect(env.mode).toBe("original")
})
