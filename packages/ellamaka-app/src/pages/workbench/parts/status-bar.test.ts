import { describe, expect, test } from "bun:test"
import { getStatusBarSegments } from "./status-bar-segments"

describe("getStatusBarSegments", () => {
  test("returns empty array when activePanelID is undefined", () => {
    const segments = getStatusBarSegments({
      spaceName: "main",
      activePanelID: undefined,
      panels: [],
      getSessionTitle: () => undefined,
    })
    expect(segments).toEqual([])
  })

  test("returns empty array when active panel is not found in panels list", () => {
    const segments = getStatusBarSegments({
      spaceName: "main",
      activePanelID: "p-missing",
      panels: [{ id: "p-1", slotState: "empty", directory: "/workspace/main" }],
      getSessionTitle: () => undefined,
    })
    expect(segments).toEqual([])
  })

  test("returns panel index segment for empty slot panel", () => {
    const segments = getStatusBarSegments({
      spaceName: "main",
      activePanelID: "p-2",
      panels: [
        { id: "p-1", slotState: "empty", directory: "/workspace/main" },
        { id: "p-2", slotState: "empty", directory: "/workspace/main/sub" },
      ],
      getSessionTitle: () => undefined,
    })
    expect(segments).toEqual([{ type: "panel", text: "P2/2" }])
  })

  test("returns panel and session title segments if bound and session title exists", () => {
    const getSessionTitle = (id: string) => {
      if (id === "ses-1") return "Fix CSS Bug"
      return undefined
    }

    const segments = getStatusBarSegments({
      spaceName: "General",
      activePanelID: "p-1",
      panels: [{ id: "p-1", slotState: "bound", boundSessionId: "ses-1", directory: "/workspace/general" }],
      getSessionTitle,
    })
    expect(segments).toEqual([
      { type: "panel", text: "P1/1" },
      { type: "session", text: "Fix CSS Bug" },
    ])
  })

  test("returns panel segment if bound but session title is missing", () => {
    const segments = getStatusBarSegments({
      spaceName: "General",
      activePanelID: "p-1",
      panels: [{ id: "p-1", slotState: "bound", boundSessionId: "ses-2", directory: "/workspace/general" }],
      getSessionTitle: () => undefined,
    })
    expect(segments).toEqual([{ type: "panel", text: "P1/1" }])
  })
})
