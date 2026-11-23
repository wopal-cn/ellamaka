import { describe, expect, test } from "bun:test"
import { shouldInsertPromptNewline } from "./enter-key"

describe("prompt enter newline shortcut", () => {
  test("uses Shift+Enter and Option+Enter for a newline", () => {
    expect(shouldInsertPromptNewline(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }))).toBe(true)
    expect(shouldInsertPromptNewline(new KeyboardEvent("keydown", { key: "Enter", altKey: true }))).toBe(true)
    expect(
      shouldInsertPromptNewline(new KeyboardEvent("keydown", { key: "Enter", altKey: true, shiftKey: true })),
    ).toBe(true)
  })

  test("keeps a plain Enter available for submission", () => {
    expect(shouldInsertPromptNewline(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(false)
    expect(shouldInsertPromptNewline(new KeyboardEvent("keydown", { key: "n", altKey: true }))).toBe(false)
  })
})
