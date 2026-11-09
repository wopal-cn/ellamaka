import { expect, test } from "bun:test"
import { normalizeGeneratedUnions } from "./normalize-unions"

test("normalizes redundant generated union members without changing narrower types", () => {
  const input = `
    type Numbers = number | "NaN" | "Infinity" | "NaN" | "Infinity"
    type Choice = "first" | ("second" | "third") | string
    type Options = unknown | string | undefined
    type Flag = boolean | true | false | boolean
    type Narrow = "first" | "second"
    type Nested = { value: number | "NaN" | "NaN" } | { value: string | "named" }
  `
  const result = normalizeGeneratedUnions(input)
  expect(result).toContain('type Numbers = number | "NaN" | "Infinity"')
  expect(result).toContain("type Choice = string")
  expect(result).toContain("type Options = unknown")
  expect(result).toContain("type Flag = boolean")
  expect(result).toContain('type Narrow = "first" | "second"')
  expect(result).toContain('{ value: number | "NaN" } | { value: string }')
  expect(normalizeGeneratedUnions(result)).toBe(result)
})
