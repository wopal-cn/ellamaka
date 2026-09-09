import { describe, expect, test } from "bun:test"
import { resolveThemeVariant } from "@wopal/ui/theme/resolve"
import type { DesktopTheme } from "@wopal/ui/theme/types"
import { resolveTerminalTheme } from "./terminal-colors"

const theme: DesktopTheme = {
  name: "Ellamaka",
  id: "ellamaka",
  light: {
    palette: {
      neutral: "#ECEFF4",
      ink: "#2E3440",
      primary: "#5E81AC",
      accent: "#8FBCBB",
      success: "#A3BE8C",
      warning: "#D08770",
      error: "#BF616A",
      info: "#5E81AC",
      interactive: "#81A1C1",
      diffAdd: "#A3BE8C",
      diffDelete: "#BF616A",
    },
  },
  dark: {
    palette: {
      neutral: "#2E3440",
      ink: "#D8DEE9",
      primary: "#5E81AC",
      accent: "#8FBCBB",
      success: "#A3BE8C",
      warning: "#D08770",
      error: "#BF616A",
      info: "#88C0D0",
      interactive: "#81A1C1",
      diffAdd: "#A3BE8C",
      diffDelete: "#BF616A",
    },
  },
}

describe("resolveTerminalTheme", () => {
  test("derives background and foreground from the active theme variant", () => {
    const resolved = resolveThemeVariant(theme.dark, true)
    const term = resolveTerminalTheme(resolved, true)
    expect(term.background).toBe(resolved["background-base"])
    expect(term.foreground).toBe(resolved["text-stronger"])
    expect(term.cursor).toBe(resolved["text-stronger"])
  })

  test("provides a full 16-color ANSI palette sourced from theme tokens", () => {
    const resolved = resolveThemeVariant(theme.dark, true)
    const term = resolveTerminalTheme(resolved, true)
    const ansiKeys = [
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
      "brightBlack",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
      "brightWhite",
    ] as const
    for (const key of ansiKeys) {
      const value = term[key]
      expect(typeof value, `expected ${key} to be a color`).toBe("string")
      expect(value as string, `expected ${key} to be a hex color`).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  test("maps semantic tokens to ANSI hues consistently with the theme", () => {
    const resolved = resolveThemeVariant(theme.dark, true)
    const term = resolveTerminalTheme(resolved, true)
    // Directories (blue) and executables (green) should follow the theme, not ghostty defaults.
    expect(term.blue).toBe(resolved["text-interactive-base"])
    expect(term.green).toBe(resolved["syntax-string"])
    expect(term.red).toBe(resolved["text-diff-delete-base"])
    expect(term.cyan).toBe(resolved["syntax-info"])
  })

  test("selection background is a translucent wash of the foreground", () => {
    const resolved = resolveThemeVariant(theme.dark, true)
    const term = resolveTerminalTheme(resolved, true)
    expect(term.selectionBackground).toMatch(/^rgba\(/)
  })
})
