import { describe, expect, test } from "bun:test"
import { trustedHostsFromCors, trustedDshAuthorities } from "../../../src/cli/cmd/dsh-mount"

/**
 * The DSH connection fence accepts `host:port` authorities, while the user
 * facing CORS surface speaks full Origins (`server.cors` in settings.jsonc or
 * `--cors` flags). One trust decision, one configuration surface: the fence
 * list is DERIVED from the merged CORS list, never configured separately.
 */
describe("trustedHostsFromCors", () => {
  test("derives host:port authorities from http origins", () => {
    expect(trustedHostsFromCors(["http://192.168.1.5:3000"])).toEqual(["192.168.1.5:3000"])
  })

  test("derives bare-host authorities from port-less origins", () => {
    expect(trustedHostsFromCors(["https://app.example.com"])).toEqual(["app.example.com"])
  })

  test("passes through strings that are already authorities", () => {
    expect(trustedHostsFromCors(["192.168.1.10:4096", "app.internal"])).toEqual([
      "192.168.1.10:4096",
      "app.internal",
    ])
  })

  test("skips invalid entries and deduplicates the result", () => {
    expect(trustedHostsFromCors([":::not a url:::", "http://10.0.0.2:8080", "http://10.0.0.2:8080"])).toEqual([
      "10.0.0.2:8080",
    ])
  })

  test("returns the empty default for an empty list", () => {
    expect(trustedHostsFromCors([])).toEqual([])
  })
})

describe("trustedDshAuthorities", () => {
  test("merges cors-derived and self authorities with dedupe", () => {
    const authorities = trustedDshAuthorities(
      { hostname: "0.0.0.0", port: 9999 },
      ["http://192.168.1.101:3000", "http://192.168.1.101:9999"],
      ["192.168.1.101", "192.168.1.111"],
    )
    expect(authorities).toEqual(["192.168.1.101:3000", "192.168.1.101:9999", "192.168.1.111:9999"])
  })

  test("keeps cors authorities when self list is empty", () => {
    expect(trustedDshAuthorities({ hostname: "127.0.0.1", port: 9999 }, ["http://192.168.1.5:3000"], [])).toEqual([
      "192.168.1.5:3000",
    ])
  })
})
