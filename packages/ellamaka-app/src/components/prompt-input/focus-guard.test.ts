import { describe, expect, test } from "bun:test"
import { shouldSkipRestoreFocus } from "./focus-guard"

describe("shouldSkipRestoreFocus", () => {
  test("skips when focus is in a terminal input", () => {
    const editor = document.createElement("div")
    editor.contentEditable = "true"
    document.body.append(editor)

    const terminal = document.createElement("div")
    terminal.dataset.component = "terminal"
    const textarea = document.createElement("textarea")
    terminal.append(textarea)
    document.body.append(terminal)

    textarea.focus()
    expect(shouldSkipRestoreFocus(editor)).toBe(true)

    editor.remove()
    terminal.remove()
  })

  test("skips when focus is in another prompt editor", () => {
    const editor = document.createElement("div")
    editor.contentEditable = "true"
    document.body.append(editor)

    const other = document.createElement("div")
    other.dataset.component = "prompt-input"
    other.contentEditable = "true"
    document.body.append(other)

    other.focus()
    expect(shouldSkipRestoreFocus(editor)).toBe(true)

    editor.remove()
    other.remove()
  })

  test("does not skip when the prompt editor itself owns focus", () => {
    const editor = document.createElement("div")
    editor.contentEditable = "true"
    document.body.append(editor)

    editor.focus()
    expect(shouldSkipRestoreFocus(editor)).toBe(false)

    editor.remove()
  })

  test("does not skip when focus is on a plain container", () => {
    const editor = document.createElement("div")
    editor.contentEditable = "true"
    document.body.append(editor)

    const plain = document.createElement("div")
    plain.tabIndex = 0
    document.body.append(plain)

    plain.focus()
    expect(shouldSkipRestoreFocus(editor)).toBe(false)

    editor.remove()
    plain.remove()
  })

  test("does not skip when nothing has focus", () => {
    const editor = document.createElement("div")
    editor.contentEditable = "true"
    document.body.append(editor)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    expect(shouldSkipRestoreFocus(editor)).toBe(false)

    editor.remove()
  })
})
