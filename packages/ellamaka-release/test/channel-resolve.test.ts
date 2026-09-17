import { describe, expect, test } from "bun:test"
import { resolveBuildChannel } from "../src/channel-resolve"

const IN_VOCABULARY = ["stable", "beta", "main", "local"] as const
const OUT_OF_VOCABULARY = ["prod", "latest", "dev", "release", "canary", ""] as const

describe("resolveBuildChannel: strict mode (no fallback)", () => {
  for (const channel of IN_VOCABULARY) {
    test(`accepts in-vocabulary channel "${channel}"`, () => {
      expect(resolveBuildChannel(channel)).toBe(channel)
    })
  }

  for (const raw of OUT_OF_VOCABULARY) {
    test(`throws on out-of-vocabulary value ${JSON.stringify(raw)}`, () => {
      expect(() => resolveBuildChannel(raw)).toThrow()
    })
  }

  test("throws on undefined input", () => {
    expect(() => resolveBuildChannel(undefined)).toThrow()
  })
})

describe("resolveBuildChannel: fallback mode (fallback: local)", () => {
  for (const channel of IN_VOCABULARY) {
    test(`passes through in-vocabulary channel "${channel}"`, () => {
      expect(resolveBuildChannel(channel, "local")).toBe(channel)
    })
  }

  for (const raw of OUT_OF_VOCABULARY) {
    test(`falls back to "local" for out-of-vocabulary value ${JSON.stringify(raw)}`, () => {
      expect(resolveBuildChannel(raw, "local")).toBe("local")
    })
  }

  test('falls back to "local" for undefined input', () => {
    expect(resolveBuildChannel(undefined, "local")).toBe("local")
  })
})
