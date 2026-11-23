import { describe, expect, test } from "bun:test"
import { parseWorkbenchSessionLink, workbenchSessionHref, WORKBENCH_SESSION_LINK_PARAM } from "./workbench-session-link"

describe("workbenchSessionHref", () => {
  test("encodes the session ID into a Workbench deep link", () => {
    expect(workbenchSessionHref("ses_123")).toBe("/workbench?session=ses_123")
  })

  test("URL-encodes unsafe characters so the contract stays stable", () => {
    expect(workbenchSessionHref("a b/c")).toBe(`/workbench?session=${encodeURIComponent("a b/c")}`)
    expect(workbenchSessionHref("a+b")).toBe(`/workbench?session=${encodeURIComponent("a+b")}`)
  })

  test("uses the canonical session query parameter", () => {
    expect(workbenchSessionHref("x").startsWith(`/workbench?${WORKBENCH_SESSION_LINK_PARAM}=`)).toBe(true)
  })
})

describe("parseWorkbenchSessionLink", () => {
  test("parses a plain query string", () => {
    expect(parseWorkbenchSessionLink("?session=ses_123")).toEqual({ sessionID: "ses_123" })
  })

  test("parses a bare param string without leading ?", () => {
    expect(parseWorkbenchSessionLink("session=ses_123")).toEqual({ sessionID: "ses_123" })
  })

  test("decodes URL-encoded session IDs back to the original value", () => {
    const encoded = encodeURIComponent("a b")
    expect(parseWorkbenchSessionLink(`?session=${encoded}`)).toEqual({ sessionID: "a b" })
  })

  test("rejects a Session value that decodes to a path-style value", () => {
    const encoded = encodeURIComponent("a/b")
    expect(parseWorkbenchSessionLink(`?session=${encoded}`)).toBeUndefined()
  })

  test("rejects an empty query string", () => {
    expect(parseWorkbenchSessionLink("")).toBeUndefined()
  })

  test("rejects a missing session parameter", () => {
    expect(parseWorkbenchSessionLink("?other=1")).toBeUndefined()
  })

  test("rejects an empty session value", () => {
    expect(parseWorkbenchSessionLink("?session=")).toBeUndefined()
  })

  test("rejects a duplicate session parameter", () => {
    expect(parseWorkbenchSessionLink("?session=a&session=b")).toBeUndefined()
  })

  test("rejects path-style session values containing a slash", () => {
    expect(parseWorkbenchSessionLink("?session=a/b")).toBeUndefined()
  })

  test("rejects path-style session values containing a backslash", () => {
    expect(parseWorkbenchSessionLink("?session=a\\b")).toBeUndefined()
  })

  test("rejects path-style session values that start with a dot", () => {
    expect(parseWorkbenchSessionLink("?session=.hidden")).toBeUndefined()
  })
})
