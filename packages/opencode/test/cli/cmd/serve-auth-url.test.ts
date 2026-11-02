import { describe, expect, test } from "bun:test"
import { applicationAuthUrl, workbenchAuthUrl } from "../../../src/cli/cmd/serve"

/**
 * With `ELLAMAKA_SERVER_PASSWORD` set, the browser cannot authenticate the
 * SPA on its own (fetch 401s never trigger the Basic dialog), so the server
 * must hand the user a ready-to-open `?auth_token=` URL — the Base64 of
 * `username:password` the Workbench decodes in `authFromToken`. Without a
 * password the URL stays clean (no token), matching the unsecured server.
 */
describe("workbenchAuthUrl", () => {
  test("appends the base64 token for the default username", () => {
    expect(workbenchAuthUrl("http://localhost:4097", "123")).toBe(
      `http://localhost:4097/workbench?auth_token=${btoa("ellamaka:123")}`,
    )
  })

  test("encodes a custom username", () => {
    expect(workbenchAuthUrl("http://localhost:4097", "123", "kit")).toBe(
      `http://localhost:4097/workbench?auth_token=${btoa("kit:123")}`,
    )
  })

  test("returns the bare workbench URL without a password", () => {
    expect(workbenchAuthUrl("http://localhost:4097", undefined)).toBe("http://localhost:4097/workbench")
    expect(workbenchAuthUrl("http://localhost:4097", "")).toBe("http://localhost:4097/workbench")
  })

  test("keeps an IPv6 origin intact", () => {
    expect(workbenchAuthUrl("http://[::1]:4097", "pw")).toBe(
      `http://[::1]:4097/workbench?auth_token=${btoa("ellamaka:pw")}`,
    )
  })
})

describe("applicationAuthUrl", () => {
  test("builds the onboarding entry with the same auth-token contract", () => {
    expect(applicationAuthUrl("http://localhost:4097", "onboarding", "123")).toBe(
      `http://localhost:4097/onboarding?auth_token=${btoa("ellamaka:123")}`,
    )
  })

  test("returns a clean onboarding URL for an unsecured server", () => {
    expect(applicationAuthUrl("http://localhost:4097/", "onboarding", undefined)).toBe(
      "http://localhost:4097/onboarding",
    )
  })
})
