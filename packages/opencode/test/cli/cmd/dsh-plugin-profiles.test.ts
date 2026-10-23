import { describe, expect, test } from "bun:test"
import { BUILTIN_PROFILES, canonicalProfile, parseProfiles } from "@/cli/cmd/dsh-plugin-profiles"

describe("dsh plugin profiles", () => {
  test("omitted/blank --profile defaults to both built-in profiles", () => {
    expect(parseProfiles(undefined)).toEqual(["web", "ellamaka-tools"])
    expect(parseProfiles("")).toEqual(["web", "ellamaka-tools"])
    expect(parseProfiles("  ")).toEqual(["web", "ellamaka-tools"])
  })

  test("the Plan's `--profile web,tools` resolves through the tools alias (rook B-05)", () => {
    expect(parseProfiles("web,tools")).toEqual(["web", "ellamaka-tools"])
    expect(parseProfiles("tools")).toEqual(["ellamaka-tools"])
    expect(parseProfiles("tools,web")).toEqual(["ellamaka-tools", "web"])
    expect(canonicalProfile("tools")).toBe("ellamaka-tools")
    expect(canonicalProfile("web")).toBe("web")
  })

  test("canonical profile names pass through unchanged", () => {
    expect(parseProfiles("web,ellamaka-tools")).toEqual(["web", "ellamaka-tools"])
  })

  test("duplicate canonical names collapse in order", () => {
    expect(parseProfiles("web,tools,web")).toEqual(["web", "ellamaka-tools"])
  })

  test("unknown profile names throw naming the built-ins", () => {
    expect(() => parseProfiles("web,galaxy")).toThrow(/galaxy|unknown/i)
    try {
      parseProfiles("web,tui")
      throw new Error("expected parseProfiles to throw")
    } catch (error) {
      expect((error as Error).message).toContain("web")
      expect((error as Error).message).toContain("ellamaka-tools")
    }
  })

  test("BUILTIN_PROFILES are the canonical pair", () => {
    expect(BUILTIN_PROFILES).toEqual(["web", "ellamaka-tools"])
  })
})
