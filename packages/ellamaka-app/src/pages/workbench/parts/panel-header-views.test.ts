import { describe, expect, test } from "bun:test"
import { getPanelHeaderViews } from "./panel-header-views"

const views = [
  { id: "tui", label: "TUI", requiresSession: true },
  { id: "chat", label: "Chat", requiresSession: true },
  { id: "context", label: "Context", requiresSession: true },
]

describe("getPanelHeaderViews", () => {
  test("hides all view buttons for empty slots", () => {
    expect(getPanelHeaderViews(views, "empty")).toEqual([])
  })

  test("keeps only session views for bound panels", () => {
    expect(getPanelHeaderViews(views, "bound").map((view) => view.id)).toEqual(["tui", "chat", "context"])
  })

  test("marks the TUI menu when the panel has an open TUI PTY", () => {
    expect(getPanelHeaderViews(views, "bound", "pty-tui-1").find((view) => view.id === "tui")?.hasOpenTui).toBe(true)
    expect(getPanelHeaderViews(views, "bound").find((view) => view.id === "tui")?.hasOpenTui).toBe(false)
  })

  test("disables TUI and Context for draft bindings; chat stays enabled", () => {
    const result = getPanelHeaderViews(views, "bound", undefined, "draft:panel-1.abc-1")
    expect(result.find((view) => view.id === "tui")?.disabled).toBe(true)
    expect(result.find((view) => view.id === "context")?.disabled).toBe(true)
    expect(result.find((view) => view.id === "chat")?.disabled).toBe(false)
  })

  test("keeps everything enabled for real sessions", () => {
    const result = getPanelHeaderViews(views, "bound", undefined, "ses_real")
    expect(result.every((view) => !view.disabled)).toBe(true)
  })
})
