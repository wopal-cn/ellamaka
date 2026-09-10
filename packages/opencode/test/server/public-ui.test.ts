import { describe, expect, test } from "bun:test"
import { isPublicUIPath } from "../../src/server/shared/public-ui"

/**
 * The Workbench HTML references its bundle with hashed `<script src>` /
 * `<link href>` tags. Those document-level requests cannot carry an
 * Authorization header, and a 401 with `www-authenticate: Basic` on them
 * makes the BROWSER pop its native login dialog — unreachable from the SPA,
 * so a token-protected page could never even boot. Static assets carry no
 * server state (the build hash is unknowable to a client), so they join the
 * manifest files in the public set; every API route stays authenticated.
 */
describe("isPublicUIPath — hashed UI assets", () => {
  test("hashed bundle assets are public GETs", () => {
    expect(isPublicUIPath("GET", "/assets/index-DLAvNuhk.js")).toBe(true)
    expect(isPublicUIPath("GET", "/assets/index-D6eg8tSS.css")).toBe(true)
    expect(isPublicUIPath("GET", "/assets/chunk-abc123.wasm")).toBe(true)
  })

  test("other root-level static files served by the UI route are public", () => {
    expect(isPublicUIPath("GET", "/favicon-96x96.png")).toBe(true)
    expect(isPublicUIPath("GET", "/favicon.svg")).toBe(true)
    expect(isPublicUIPath("GET", "/favicon.ico")).toBe(true)
    expect(isPublicUIPath("GET", "/apple-touch-icon.png")).toBe(true)
    expect(isPublicUIPath("GET", "/ellamaka-text-logo.png")).toBe(true)
    expect(isPublicUIPath("GET", "/oc-theme-preload.js")).toBe(true)
    expect(isPublicUIPath("GET", "/social-share-zen.png")).toBe(true)
  })

  test("existing manifest paths stay public", () => {
    expect(isPublicUIPath("GET", "/site.webmanifest")).toBe(true)
  })

  test("non-GET methods never pass", () => {
    expect(isPublicUIPath("POST", "/assets/index-DLAvNuhk.js")).toBe(false)
    expect(isPublicUIPath("PUT", "/favicon-96x96.png")).toBe(false)
  })

  test("API routes never pass", () => {
    expect(isPublicUIPath("GET", "/global/health")).toBe(false)
    expect(isPublicUIPath("GET", "/workbench/dsh-url")).toBe(false)
    expect(isPublicUIPath("GET", "/session")).toBe(false)
    expect(isPublicUIPath("GET", "/dsh/")).toBe(false)
    expect(isPublicUIPath("GET", "/global/event")).toBe(false)
  })
})
