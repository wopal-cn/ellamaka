import { describe, expect, test } from "bun:test"
import {
  contextPercentage,
  contextTone,
  formatContextTooltip,
  type ContextMetricsSnapshot,
} from "./session-context-label"

const snapshot = (overrides: Partial<ContextMetricsSnapshot> = {}): ContextMetricsSnapshot => ({
  total: 249432,
  limit: 1048576,
  usage: 24,
  ...overrides,
})

describe("contextPercentage", () => {
  test("returns rounded usage", () => {
    expect(contextPercentage(snapshot())).toBe(24)
  })

  test("returns undefined when usage is null or missing", () => {
    expect(contextPercentage(snapshot({ usage: null }))).toBeUndefined()
    expect(contextPercentage({ total: 0, limit: 0, usage: null })).toBeUndefined()
  })
})

describe("contextTone", () => {
  test("normal below 80%", () => {
    expect(contextTone(24)).toBe("normal")
  })

  test("warning at 80% and above", () => {
    expect(contextTone(80)).toBe("warning")
    expect(contextTone(99)).toBe("warning")
  })

  test("critical at 100% and above", () => {
    expect(contextTone(100)).toBe("critical")
    expect(contextTone(120)).toBe("critical")
  })

  test("undefined usage stays normal", () => {
    expect(contextTone(undefined)).toBe("normal")
  })
})

describe("formatContextTooltip", () => {
  test("formats tokens with percentage when limit is known", () => {
    expect(formatContextTooltip(snapshot(), (n) => n.toLocaleString("en-US"))).toBe("249,432 tokens (24% of context)")
  })

  test("formats tokens without percentage when usage is unknown", () => {
    expect(formatContextTooltip(snapshot({ usage: null }), (n) => n.toLocaleString("en-US"))).toBe("249,432 tokens")
  })

  test("uses localized number formatting", () => {
    expect(formatContextTooltip(snapshot(), (n) => n.toLocaleString("de-DE"))).toBe("249.432 tokens (24% of context)")
  })
})
