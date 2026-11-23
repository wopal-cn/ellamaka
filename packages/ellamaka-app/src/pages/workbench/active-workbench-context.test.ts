import { describe, expect, test } from "bun:test"
import { selectActiveWorkbenchContext, type ActiveWorkbenchSnapshot } from "./active-workbench-context"

const snapshot: ActiveWorkbenchSnapshot = {
  activeSpaceName: "Space A",
  tabs: [
    { id: "General", name: "General", path: "", type: "general" },
    { id: "space-a", name: "Space A", path: "/fixtures/workspaces/space-a" },
  ],
  spaces: {
    "": {
      activePanelID: "panel-general",
      panels: [{ id: "panel-general", slotState: "empty", mode: "", directory: "", width: 1 }],
    },
    "/fixtures/workspaces/space-a": {
      activePanelID: "panel-space-a",
      panels: [
        {
          id: "panel-space-a",
          slotState: "bound",
          boundSessionId: "session-space-a",
          mode: "chat",
          viewMode: "chat",
          directory: "/fixtures/workspaces/space-a/project",
          width: 1,
        },
      ],
    },
  },
}

describe("selectActiveWorkbenchContext", () => {
  test("selects scope, panel, session and directory from the active tab only", () => {
    const active = selectActiveWorkbenchContext(snapshot)

    expect(active?.scope).toEqual({
      kind: "space",
      name: "Space A",
      path: "/fixtures/workspaces/space-a",
    })
    expect(active?.panel.id).toBe("panel-space-a")
    expect(active?.sessionID).toBe("session-space-a")
    expect(active?.directory).toBe("/fixtures/workspaces/space-a/project")
  })

  test("preserves General as an explicit active scope", () => {
    const active = selectActiveWorkbenchContext({ ...snapshot, activeSpaceName: "General" })

    expect(active?.scope).toEqual({ kind: "general" })
    expect(active?.panel.id).toBe("panel-general")
    expect(active?.directory).toBe("")
  })
})
