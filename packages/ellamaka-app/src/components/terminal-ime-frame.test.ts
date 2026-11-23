import { describe, expect, test } from "bun:test"
import { getTerminalImeFrame } from "./terminal-ime-frame"

describe("getTerminalImeFrame", () => {
  test("anchors the IME textarea to the caret without padding", () => {
    expect(
      getTerminalImeFrame({
        cursorX: 3,
        cursorY: 2,
        cellWidth: 8,
        cellHeight: 18,
        paddingLeft: 0,
        paddingTop: 0,
      }),
    ).toEqual({
      left: "24px",
      top: "36px",
      width: "8px",
      height: "18px",
      opacity: "0.01",
    })
  })

  test("includes container padding for embedded terminal layouts", () => {
    expect(
      getTerminalImeFrame({
        cursorX: 4,
        cursorY: 1,
        cellWidth: 9,
        cellHeight: 20,
        paddingLeft: 24,
        paddingTop: 12,
      }),
    ).toEqual({
      left: "60px",
      top: "32px",
      width: "9px",
      height: "20px",
      opacity: "0.01",
    })
  })
})
