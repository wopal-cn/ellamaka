import { describe, expect, test } from "bun:test"
import { createAuthToastGate, isUnauthorizedError } from "./auth-error"

describe("isUnauthorizedError", () => {
  test("detects the SDK 401 wrap (cause.status)", () => {
    const error = new Error("ellamaka server GET /x → 401", { cause: { body: "", status: 401 } })
    expect(isUnauthorizedError(error)).toBe(true)
  })

  test("rejects other statuses and plain errors", () => {
    expect(isUnauthorizedError(new Error("boom", { cause: { status: 500 } }))).toBe(false)
    expect(isUnauthorizedError(new Error("boom"))).toBe(false)
    expect(isUnauthorizedError("401")).toBe(false)
    expect(isUnauthorizedError(undefined)).toBe(false)
  })
})

describe("createAuthToastGate", () => {
  test("shows the first 401 toast and swallows the rest until reset", () => {
    const gate = createAuthToastGate()
    let shown = 0
    gate.unauthorized(() => shown++)
    gate.unauthorized(() => shown++)
    gate.unauthorized(() => shown++)
    expect(shown).toBe(1)
    gate.reset()
    gate.unauthorized(() => shown++)
    expect(shown).toBe(2)
  })
})
