import { describe, expect, test } from "bun:test"
import {
  DRAFT_SESSION_PREFIX,
  draftSessionId,
  isDraftSessionId,
  parseDraftSessionId,
} from "./draft-session"

describe("draft-session", () => {
  test("draftSessionId is panel-scoped and tokenized", () => {
    const id = draftSessionId("panel-1")
    expect(id.startsWith(`${DRAFT_SESSION_PREFIX}panel-1.`)).toBe(true)
  })

  test("each draft id is unique so a second /new invalidates the first", () => {
    const first = draftSessionId("panel-1")
    const second = draftSessionId("panel-1")
    expect(second).not.toBe(first)
  })

  test("isDraftSessionId detects draft ids and rejects real ids", () => {
    expect(isDraftSessionId(draftSessionId("panel-1"))).toBe(true)
    expect(isDraftSessionId("ses_real123")).toBe(false)
    expect(isDraftSessionId(undefined)).toBe(false)
    expect(isDraftSessionId("")).toBe(false)
  })

  test("parseDraftSessionId extracts the panel id including token suffix", () => {
    const id = draftSessionId("panel-1")
    const parsed = parseDraftSessionId(id)
    expect(parsed?.startsWith("panel-1.")).toBe(true)
  })

  test("parseDraftSessionId rejects non-draft ids", () => {
    expect(parseDraftSessionId("ses_real123")).toBeUndefined()
    expect(parseDraftSessionId(undefined)).toBeUndefined()
  })
})
