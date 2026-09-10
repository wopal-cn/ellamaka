import { describe, expect, test } from "bun:test"
import { wrapClientError } from "../src/error-interceptor"

/**
 * The wrapped message is user-visible in toasts and error pages, so the
 * server name must carry the product brand, never the upstream name.
 */
describe("wrapClientError", () => {
  test("brands the empty-body error with the product server name", () => {
    const response = new Response(null, { status: 401 })
    const request = new Request("http://localhost:4097/session")
    const error = wrapClientError(undefined, response, request, { throwOnError: true }) as Error
    expect(error.message).toMatch(/^ellamaka server GET/)
    expect(error.message).not.toContain("opencode")
    expect(error.message).toContain("(empty response body)")
    expect((error.cause as { status?: number }).status).toBe(401)
  })

  test("passes through an existing Error untouched", () => {
    const original = new Error("already wrapped")
    expect(wrapClientError(original, undefined, undefined, { throwOnError: true })).toBe(original)
  })

  test("returns the raw error when throwOnError is off", () => {
    const raw = { name: "Unauthorized" }
    expect(wrapClientError(raw, undefined, undefined, {})).toBe(raw)
  })
})
