import { describe, expect, test } from "bun:test"
import { resolveThemeVariant } from "@wopal/ui/theme/resolve"
import { ellamakaTheme, ELLAMAKA_THEME_ID } from "./ellamaka-theme"

describe("ellamaka theme", () => {
  test("declares stable identity and display name", () => {
    expect(ELLAMAKA_THEME_ID).toBe("ellamaka")
    expect(ellamakaTheme.id).toBe("ellamaka")
    expect(ellamakaTheme.name).toBe("Ellamaka")
  })

  test("resolves light variant with core text and surface tokens", () => {
    const tokens = resolveThemeVariant(ellamakaTheme.light, false)
    expect(tokens["text-strong"]).toBe("#2E3440")
    expect(tokens["text-base"]).toBe("#3B4252")
    expect(tokens["markdown-heading"]).toBe("#5E81AC")
    expect(tokens["surface-diff-add-base"]).toBe("#E3EAE2")
  })

  test("resolves dark variant with core text and surface tokens", () => {
    const tokens = resolveThemeVariant(ellamakaTheme.dark, true)
    expect(tokens["text-strong"]).toBe("#C9D1DC")
    expect(tokens["text-base"]).toBe("#9AA5B4")
    expect(tokens["background-base"]).toBe("#2E3440")
    expect(tokens["surface-raised-stronger-non-alpha"]).toBe("#3B4252")
  })

  test("keeps dark text tokens at the pre-migration golden values", () => {
    const tokens = resolveThemeVariant(ellamakaTheme.dark, true)
    expect(tokens["text-stronger"]).toBe("#C9D1DC")
    expect(tokens["text-strong"]).toBe("#C9D1DC")
    expect(tokens["text-base"]).toBe("#9AA5B4")
    expect(tokens["text-weak"]).toBe("#8B95A7")
  })
})
