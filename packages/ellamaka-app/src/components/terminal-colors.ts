import { withAlpha } from "@wopal/ui/theme/color"
import type { ColorValue, HexColor, ResolvedTheme } from "@wopal/ui/theme/types"

export interface TerminalTheme {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export const FALLBACK_TERMINAL_COLORS = {
  light: { background: "#ffffff", foreground: "#211e1e" },
  dark: { background: "#131010", foreground: "#d4d4d4" },
} as const

function hex(value: ColorValue | undefined, fallback: string): string {
  return value?.startsWith("#") ? value : fallback
}

// Map the theme's semantic tokens onto the 16 ANSI slots so terminal output
// (ls colors, git status, prompt accents) shares the active theme's palette
// instead of ghostty-web's hardcoded defaults.
export function resolveTerminalTheme(resolved: ResolvedTheme, isDark: boolean): TerminalTheme {
  const fallback = isDark ? FALLBACK_TERMINAL_COLORS.dark : FALLBACK_TERMINAL_COLORS.light
  const foreground = hex(resolved["text-stronger"], fallback.foreground)
  // Match the chat prompt surface (v2 bg-base -> background-base) so the
  // terminal reads as part of the same surface in both light and dark themes.
  const background = hex(resolved["background-base"], fallback.background)
  const alpha = isDark ? 0.25 : 0.2
  const selectionBackground = withAlpha(foreground as HexColor, alpha)

  const surface = hex(resolved["surface-stronger-non-alpha"], background)
  const red = hex(resolved["text-diff-delete-base"], "#BF616A")
  const green = hex(resolved["syntax-string"], "#A3BE8C")
  const yellow = hex(resolved["syntax-type"], "#D08770")
  const blue = hex(resolved["text-interactive-base"], "#81A1C1")
  const magenta = hex(resolved["syntax-primitive"], "#B48EAD")
  const cyan = hex(resolved["syntax-info"], "#88C0D0")
  const faint = hex(resolved["text-weaker"], "#5E6A7D")

  return {
    background,
    foreground,
    cursor: foreground,
    selectionBackground,
    black: surface,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: foreground,
    brightBlack: faint,
    brightRed: red,
    brightGreen: green,
    brightYellow: yellow,
    brightBlue: blue,
    brightMagenta: magenta,
    brightCyan: cyan,
    brightWhite: foreground,
  }
}
