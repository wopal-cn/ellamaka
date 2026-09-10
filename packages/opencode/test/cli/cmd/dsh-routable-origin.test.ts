import { describe, expect, test } from "bun:test"
import { routableDshOrigin } from "../../../src/cli/cmd/dsh-mount"

/**
 * `--hostname 0.0.0.0` (and `--mdns`, which defaults the hostname to
 * 0.0.0.0) is a WILDCARD bind, not a routable address: a browser handed
 * `http://0.0.0.0:port` either cannot connect or, worse, mints a dsh
 * cookie bound to a non-routable authority, so every LAN request fails the
 * fence and the Workbench Basic auth dialog loops. The dsh-url endpoint
 * must therefore answer with a ROUTABLE origin — the page the user is
 * actually on when one is known (the request's Host), else a concrete
 * loopback.
 */
describe("routableDshOrigin", () => {
  test("returns the request host origin when a Host header exists", () => {
    expect(routableDshOrigin("0.0.0.0", 4097, "192.168.1.101:4097")).toBe("http://192.168.1.101:4097")
  })

  test("drops the default port from the request host origin", () => {
    expect(routableDshOrigin("0.0.0.0", 80, "example.com")).toBe("http://example.com")
  })

  test("falls back to localhost when the bind is a wildcard and no Host exists", () => {
    expect(routableDshOrigin("0.0.0.0", 4097, undefined)).toBe("http://localhost:4097")
    expect(routableDshOrigin("::", 4097, undefined)).toBe("http://localhost:4097")
  })

  test("keeps a concrete bind hostname as-is", () => {
    expect(routableDshOrigin("127.0.0.1", 4097, undefined)).toBe("http://127.0.0.1:4097")
    expect(routableDshOrigin("192.168.1.101", 4097, undefined)).toBe("http://192.168.1.101:4097")
  })

  test("the request host wins even for a concrete bind (NAT/proxy views differ)", () => {
    expect(routableDshOrigin("127.0.0.1", 4097, "ellamaka.local:4097")).toBe("http://ellamaka.local:4097")
  })
})
