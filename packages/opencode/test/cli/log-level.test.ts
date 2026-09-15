import { describe, expect, test } from "bun:test"
import { resolveLogLevel, resolveTrace } from "@/cli/log-level"

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

/**
 * TRACE must name its categories. The level alone is a configuration error,
 * not an implicit "everything": that default is what flooded the operator log.
 * `--trace` with no value is the discovery path, so the caller can learn the
 * available categories without reading the source.
 */
describe("forced trace selection", () => {
  test("rejects a bare TRACE level with no selector", () => {
    const result = resolveTrace({ requested: "TRACE" })
    expect(result.kind).toBe("error")
    if (result.kind === "error") {
      expect(result.message).toContain("--trace")
      // The error must teach the caller which categories exist.
      for (const category of ["bus", "permission", "session", "llm", "plugin", "io"]) {
        expect(result.message).toContain(category)
      }
    }
  })

  test("treats a value-less --trace as a discovery request", () => {
    expect(resolveTrace({ trace: true }).kind).toBe("list")
  })

  test("rejects a selector with no known category", () => {
    const result = resolveTrace({ trace: "not-a-category" })
    expect(result.kind).toBe("error")
    if (result.kind === "error") expect(result.message).toContain("not-a-category")
  })

  test("accepts a selector that names known categories", () => {
    const result = resolveTrace({ trace: "bus,permission" })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.level).toBe("TRACE")
      expect(result.categories).toBe("bus,permission")
    }
  })

  test("accepts an explicit all selector", () => {
    const result = resolveTrace({ trace: "all" })
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.categories).toBe("all")
  })

  test("does not require a selector when trace is not used", () => {
    expect(resolveTrace({ requested: "INFO" }).kind).toBe("ok")
    expect(resolveTrace({}).kind).toBe("ok")
  })
})
