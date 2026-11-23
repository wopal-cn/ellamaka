import { describe, expect, test } from "bun:test"
import {
  disableTerminalScrollbar,
  terminalColumnsWithoutScrollbar,
  terminalRowsForContainer,
} from "./terminal-scrollbar"

describe("terminal scrollbar removal", () => {
  test("uses the width that ghostty reserves for its scrollbar", () => {
    expect(
      terminalColumnsWithoutScrollbar({
        containerWidth: 357.5,
        paddingLeft: 0,
        paddingRight: 0,
        cellWidth: 9,
      }),
    ).toBe(39)
  })

  test("lets tui fill the character grid without a right or bottom gutter", () => {
    expect(
      terminalColumnsWithoutScrollbar({
        containerWidth: 357.5,
        paddingLeft: 0,
        paddingRight: 0,
        cellWidth: 9,
        fitMode: "full-bleed",
      }),
    ).toBe(40)

    expect(
      terminalRowsForContainer({
        containerHeight: 759,
        paddingTop: 0,
        paddingBottom: 0,
        cellHeight: 20,
        fitMode: "full-bleed",
      }),
    ).toBe(38)

    expect(
      terminalColumnsWithoutScrollbar({
        containerWidth: 354,
        paddingLeft: 0,
        paddingRight: 0,
        cellWidth: 9,
        fitMode: "full-bleed",
      }),
    ).toBe(40)
  })

  test("lets tui overflow by a row instead of leaving a small bottom gutter", () => {
    expect(
      terminalRowsForContainer({
        containerHeight: 745,
        paddingTop: 0,
        paddingBottom: 0,
        cellHeight: 20,
        fitMode: "full-bleed",
      }),
    ).toBe(38)
  })

  test("disables the canvas scrollbar renderer", () => {
    let calls = 0
    const renderer = {
      renderScrollbar: () => {
        calls += 1
      },
    }

    disableTerminalScrollbar(renderer)
    renderer.renderScrollbar()

    expect(calls).toBe(0)
  })
})
