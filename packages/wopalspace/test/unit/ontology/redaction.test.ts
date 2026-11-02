import { describe, expect, test } from "bun:test"
import { sanitizeMessage, toPublicError } from "../../../src/ontology/types"

const FAKE_USER = "fake-unit-redaction-user"
const FAKE_PASSWORD = "fake-unit-redaction-password"
const FAKE_BEARER = "fake-unit-bearer-token"
const FAKE_TOKEN = "fake-unit-labeled-token"
const FAKE_KEY = "fake-unit-api-key"
const FAKE_CAUSE = "fake-unit-cause-secret"

describe("Ontology message redaction", () => {
  test("removes URL user-info while preserving the public host and path", () => {
    expect(
      sanitizeMessage("fatal: unable to access 'https://" + FAKE_USER + ":" + FAKE_PASSWORD + "@github.com/a/b.git'"),
    ).toBe("fatal: unable to access 'https://github.com/a/b.git'")
  })

  test("redacts Bearer and labeled token, key and password values", () => {
    const sanitized = sanitizeMessage(
      [
        "Authorization: Bearer " + FAKE_BEARER,
        "token=" + FAKE_TOKEN,
        "api key: " + FAKE_KEY,
        "password=" + FAKE_PASSWORD,
      ].join(" "),
    )
    expect(sanitized).toBe(
      ["Authorization: Bearer [REDACTED]", "token=[REDACTED]", "api key: [REDACTED]", "password=[REDACTED]"].join(" "),
    )
  })

  test("redacts quoted credential fields", () => {
    expect(sanitizeMessage(JSON.stringify({ token: FAKE_TOKEN, api_key: FAKE_KEY }))).toBe(
      JSON.stringify({ token: "[REDACTED]", api_key: "[REDACTED]" }),
    )
  })

  test("sanitization is idempotent and preserves an ordinary URL path", () => {
    const once = sanitizeMessage(
      "https://" + FAKE_USER + ":" + FAKE_PASSWORD + "@github.com/a/b.git token=" + FAKE_TOKEN,
    )
    expect(once).toBe("https://github.com/a/b.git token=[REDACTED]")
    expect(sanitizeMessage(once)).toBe(once)
  })

  test("public errors use only the sanitized message and never serialize the cause", () => {
    const cause = new Error("cause details: " + FAKE_CAUSE)
    const error = new Error("fetch failed with token=" + FAKE_TOKEN, { cause })
    const result = toPublicError(error)
    expect(result).toEqual({
      code: "ONTOLOGY_OPERATION_FAILED",
      message: "fetch failed with token=[REDACTED]",
    })
    expect(JSON.stringify(result)).not.toContain(FAKE_CAUSE)
  })
})
