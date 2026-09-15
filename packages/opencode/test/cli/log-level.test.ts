import { describe, expect, test } from "bun:test"
import { resolveLogLevel } from "@/cli/log-level"

describe("default CLI log level", () => {
  test("keeps local TUI diagnostics at DEBUG", () => {
    expect(resolveLogLevel({ isLocal: true, role: "tui" })).toBe("DEBUG")
  })

  test("keeps local serve logs at INFO unless explicitly overridden", () => {
    expect(resolveLogLevel({ isLocal: true, role: "serve" })).toBe("INFO")
    expect(resolveLogLevel({ isLocal: true, role: "serve", requested: "DEBUG" })).toBe("DEBUG")
  })

  test("keeps release logs at INFO", () => {
    expect(resolveLogLevel({ isLocal: false, role: "serve" })).toBe("INFO")
    expect(resolveLogLevel({ isLocal: false, role: "tui" })).toBe("INFO")
  })
})

/**
 * `--trace permission,bus` is the operator escape hatch for the bounded
 * diagnostics removed from normal operation. It promotes the effective level
 * to TRACE so the selected categories actually emit, but an explicit
 * `--log-level` always wins: a caller who asked for INFO must not be silently
 * upgraded to TRACE by a leftover trace selector.
 */
describe("trace selector resolution", () => {
  test("promotes the effective level to TRACE when a selector is present", () => {
    expect(resolveLogLevel({ isLocal: true, role: "serve", trace: "permission,bus" })).toBe("TRACE")
    expect(resolveLogLevel({ isLocal: false, role: "serve", trace: "bus" })).toBe("TRACE")
  })

  test("leaves the default level untouched when no selector is present", () => {
    expect(resolveLogLevel({ isLocal: true, role: "serve" })).toBe("INFO")
    expect(resolveLogLevel({ isLocal: true, role: "serve", trace: "" })).toBe("INFO")
  })

  test("lets an explicit requested level win over trace promotion", () => {
    expect(resolveLogLevel({ isLocal: true, role: "serve", requested: "INFO", trace: "permission" })).toBe("INFO")
    expect(resolveLogLevel({ isLocal: true, role: "serve", requested: "DEBUG", trace: "bus" })).toBe("DEBUG")
    expect(resolveLogLevel({ isLocal: true, role: "serve", requested: "TRACE", trace: "bus" })).toBe("TRACE")
  })

  test("accepts TRACE as an explicit requested level", () => {
    expect(resolveLogLevel({ isLocal: false, role: "serve", requested: "TRACE" })).toBe("TRACE")
  })
})
