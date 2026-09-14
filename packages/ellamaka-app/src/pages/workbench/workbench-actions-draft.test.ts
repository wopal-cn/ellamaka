import { describe, expect, test } from "bun:test"
import {
  createWorkbenchActions,
  type WorkbenchActionPanel,
  type WorkbenchActionSession,
  type WorkbenchActionStorePort,
} from "./workbench-actions"
import { spaceScope } from "./workbench-scope"
import { draftSessionId, isDraftSessionId } from "@/utils/draft-session"

const scope = spaceScope("space-a", "/fixtures/workspaces/space-a")

const nextSession: WorkbenchActionSession = {
  id: "session-next",
  title: "Next",
  directory: "/fixtures/workspaces/space-a/project",
  type: "chat",
}

function createStorePort(options?: { withPty?: boolean; extraPanels?: number }) {
  const extraPanels: WorkbenchActionPanel[] = Array.from({ length: options?.extraPanels ?? 0 }, (_, i) => ({
    id: `panel-extra-${i}`,
    slotState: "empty" as const,
    directory: "/fixtures/workspaces/space-a",
    mode: "" as const,
    width: 1,
  }))
  const allPanels = (): WorkbenchActionPanel[] => [panel, ...extraPanels]
  const removedPanelIDs: string[] = []
  let panel: WorkbenchActionPanel = {
    id: "panel-space-a",
    slotState: "bound",
    boundSessionId: "session-old",
    directory: "/fixtures/workspaces/space-a",
    mode: "",
    width: 1,
    tuiPtyId: options?.withPty === false ? undefined : "pty-existing",
  }
  const commits: string[] = []
  const ptys: Array<string | undefined> = []
  const modes: string[] = []
  const store: WorkbenchActionStorePort = {
    panel: (_scope, panelID) => allPanels().find((p) => p.id === panelID),
    panels: allPanels,
    boundPanels: (sessionID) => (panel.boundSessionId === sessionID ? [{ scope, panelID: panel.id, panel }] : []),
    active: () => ({ scope, panelID: panel.id }),
    addPanel: () => undefined,
    setActivePanel: () => {},
    setActive: () => {},
    activePanelID: () => undefined,
    removePanel: (_scope, panelID) => {
      removedPanelIDs.push(panelID)
      return true
    },
    removeSpace: () => false,
    commitSessionBinding: (_scope, panelID, session) => {
      commits.push(session.id)
      panel = {
        ...panel,
        id: panelID,
        slotState: "bound",
        boundSessionId: session.id,
        directory: session.directory,
        tuiPtyId: undefined,
      }
    },
    commitSessionUnbinding: () => {
      if (panel.slotState === "empty") return false
      panel = {
        ...panel,
        slotState: "empty",
        boundSessionId: undefined,
        tuiPtyId: undefined,
        termPtyId: undefined,
        splitPtyId: undefined,
      }
      return true
    },
    commitPanelPty: (_scope, _panelID, kind, ptyID) => {
      ptys.push(ptyID)
      panel = { ...panel, [kind === "tui" ? "tuiPtyId" : kind === "term" ? "termPtyId" : "splitPtyId"]: ptyID }
    },
    commitPanelMode: (_scope, _panelID, mode) => {
      modes.push(mode)
      panel = { ...panel, viewMode: mode, mode: mode === "chat" || mode === "tui" ? mode : "" }
    },
    commitSplitTerminal: (_scope, _panelID, open) => {
      panel = { ...panel, splitTerminal: open }
    },
    spacePaths: () => [],
  }
  return { store, commits, ptys, modes, getPanel: () => panel, removedPanelIDs }
}

const unusedSessionPort = {
  create: async () => nextSession,
  get: async () => nextSession,
  project: () => {},
  rename: async () => {},
  remove: async () => {},
  discardProjection: () => {},
}

function createActions(state: ReturnType<typeof createStorePort>, options?: { canWrite?: boolean }) {
  return createWorkbenchActions({
    store: state.store,
    pty: {
      disposePanel: async () => {},
      ensure: async ({ create }) => create(),
      disposePty: async () => {},
    },
    session: unusedSessionPort,
    runtime: { canWrite: () => options?.canWrite ?? true },
  })
}

describe("startDraftSession", () => {
  test("binds a draft session without touching the server or PTYs", async () => {
    const state = createStorePort()
    let serverCreates = 0
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {},
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: {
        ...unusedSessionPort,
        create: async () => {
          serverCreates += 1
          return nextSession
        },
      },
    })

    const result = await actions.startDraftSession({ scope, panelID: "panel-space-a" })

    expect(result).toEqual({ status: "committed", panelID: "panel-space-a" })
    expect(serverCreates).toBe(0)
    expect(state.commits.length).toBe(1)
    expect(isDraftSessionId(state.commits[0])).toBe(true)
    // The bound panel keeps its directory so the directory provider key
    // (panelID\ndirectory) is unchanged — no keyed remount, no flash.
    expect(state.getPanel().directory).toBe("/fixtures/workspaces/space-a")
    expect(state.getPanel().slotState).toBe("bound")
    expect(state.modes).toEqual(["chat"])
  })

  test("disposes existing PTYs so the old TUI does not leak", async () => {
    const state = createStorePort()
    const disposed: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async ({ panel }) => {
          disposed.push(panel.id)
        },
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: unusedSessionPort,
    })

    await actions.startDraftSession({ scope, panelID: "panel-space-a" })

    expect(disposed).toEqual(["panel-space-a"])
    expect(state.ptys).toContain(undefined)
  })

  test("reports offline when the runtime cannot write", async () => {
    const state = createStorePort()
    const actions = createActions(state, { canWrite: false })

    const result = await actions.startDraftSession({ scope, panelID: "panel-space-a" })

    expect(result).toEqual({ status: "offline", panelID: "panel-space-a" })
    expect(state.commits).toEqual([])
  })

  test("reports stale when the panel is gone", async () => {
    const state = createStorePort()
    const actions = createActions(state)

    const result = await actions.startDraftSession({ scope, panelID: "missing-panel" })

    expect(result).toEqual({ status: "stale", panelID: "missing-panel" })
  })
})

describe("adoptSession", () => {
  const realSession: WorkbenchActionSession = {
    id: "session-real",
    title: "New chat",
    directory: "/fixtures/workspaces/space-a",
    type: "chat",
  }

  test("swaps the draft binding for the real session and projects it", async () => {
    const state = createStorePort()
    const projected: string[] = []
    const removed: string[] = []
    const discarded: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {},
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: {
        ...unusedSessionPort,
        project: ({ session }) => {
          projected.push(session.id)
        },
        remove: async ({ session }) => {
          removed.push(session.id)
        },
        discardProjection: ({ sessionID }) => {
          discarded.push(sessionID)
        },
      },
    })

    // Start from a draft-bound panel and read the tokenized draft id the
    // action actually committed.
    await actions.startDraftSession({ scope, panelID: "panel-space-a" })
    const draftID = state.commits[0]
    expect(isDraftSessionId(draftID)).toBe(true)

    const result = actions.adoptSession({
      scope,
      panelID: "panel-space-a",
      draftSessionID: draftID,
      session: realSession,
    })

    expect(result).toEqual({ status: "committed", panelID: "panel-space-a" })
    // startDraftSession projected the draft so the panel can render it;
    // adoption drops the draft projection (local-only) and projects the
    // real session.
    expect(projected).toEqual([draftID, "session-real"])
    expect(discarded).toEqual([draftID])
    // Draft cleanup must NEVER route through the server-side remove port.
    expect(removed).toEqual([])
    expect(state.commits).toEqual([draftID, "session-real"])
    // The real session's directory wins over the draft's inherited one.
    expect(state.getPanel().directory).toBe("/fixtures/workspaces/space-a")
  })

  test("rejects adoption when the panel no longer holds the draft", async () => {
    const state = createStorePort()
    const removed: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {},
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: {
        ...unusedSessionPort,
        remove: async ({ session }) => {
          removed.push(session.id)
        },
      },
    })

    const result = actions.adoptSession({
      scope,
      panelID: "panel-space-a",
      draftSessionID: draftSessionId("panel-space-a"),
      session: realSession,
    })

    expect(result).toEqual({ status: "unchanged", panelID: "panel-space-a" })
    expect(state.commits).toEqual([])
    // No binding swap, no server-side cleanup triggered by the caller.
    expect(removed).toEqual([])
  })

  test("rejects adoption from a different panel id", async () => {
    const state = createStorePort()
    const actions = createActions(state)

    await actions.startDraftSession({ scope, panelID: "panel-space-a" })
    const draftID = state.commits[0]

    const result = actions.adoptSession({
      scope,
      panelID: "other-panel",
      draftSessionID: draftID,
      session: realSession,
    })

    expect(result).toEqual({ status: "unchanged", panelID: "other-panel" })
    expect(state.commits).toEqual([draftID])
  })

  test("a second /new invalidates the first draft's adoption", async () => {
    const state = createStorePort()
    const actions = createActions(state)

    await actions.startDraftSession({ scope, panelID: "panel-space-a" })
    const firstDraftID = state.commits[0]
    await actions.startDraftSession({ scope, panelID: "panel-space-a" })
    const secondDraftID = state.commits[1]

    expect(secondDraftID).not.toBe(firstDraftID)

    // The stale in-flight submit tries to adopt the first draft: refused.
    const result = actions.adoptSession({
      scope,
      panelID: "panel-space-a",
      draftSessionID: firstDraftID,
      session: realSession,
    })

    expect(result).toEqual({ status: "unchanged", panelID: "panel-space-a" })
    expect(state.getPanel().boundSessionId).toBe(secondDraftID)
  })

  test("consecutive /new discards the previous draft projection locally", async () => {
    const state = createStorePort()
    const serverDeletes: string[] = []
    const discarded: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {},
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: {
        ...unusedSessionPort,
        remove: async ({ session }) => {
          serverDeletes.push(session.id)
        },
        discardProjection: ({ sessionID }) => {
          discarded.push(sessionID)
        },
      },
    })

    await actions.startDraftSession({ scope, panelID: "panel-space-a" })
    const firstDraftID = state.commits[0]
    await actions.startDraftSession({ scope, panelID: "panel-space-a" })
    const secondDraftID = state.commits[1]

    // The stale draft projection must be dropped locally; no server call.
    expect(discarded).toEqual([firstDraftID])
    expect(serverDeletes).toEqual([])
    expect(secondDraftID).not.toBe(firstDraftID)
    expect(state.getPanel().boundSessionId).toBe(secondDraftID)
  })

  test("reports offline when the runtime cannot write", async () => {
    const state = createStorePort()
    const actions = createActions(state, { canWrite: false })

    const result = actions.adoptSession({
      scope,
      panelID: "panel-space-a",
      draftSessionID: draftSessionId("panel-space-a"),
      session: realSession,
    })

    expect(result).toEqual({ status: "offline", panelID: "panel-space-a" })
  })

  test("unbinding a draft discards the projection locally, never via server remove", async () => {
    const state = createStorePort()
    const serverDeletes: string[] = []
    const discarded: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {},
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: {
        ...unusedSessionPort,
        remove: async ({ session }) => {
          serverDeletes.push(session.id)
        },
        discardProjection: ({ sessionID }) => {
          discarded.push(sessionID)
        },
      },
    })

    await actions.startDraftSession({ scope, panelID: "panel-space-a" })
    const draftID = state.commits[0]

    await actions.unbindSession({ scope, panelID: "panel-space-a" })

    expect(discarded).toEqual([draftID])
    expect(serverDeletes).toEqual([])
    expect(state.getPanel().slotState).toBe("empty")
  })

  test("closing a draft panel discards its projection locally", async () => {
    const state = createStorePort()
    const serverDeletes: string[] = []
    const discarded: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {},
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: {
        ...unusedSessionPort,
        remove: async ({ session }) => {
          serverDeletes.push(session.id)
        },
        discardProjection: ({ sessionID }) => {
          discarded.push(sessionID)
        },
      },
    })

    await actions.startDraftSession({ scope, panelID: "panel-space-a" })
    const draftID = state.commits[0]

    await actions.closePanel({ scope, panelID: "panel-space-a" })

    expect(discarded).toEqual([draftID])
    expect(serverDeletes).toEqual([])
  })

  test("closing a draft panel with other panels present takes the remove-panel branch and still discards locally", async () => {
    const state = createStorePort({ extraPanels: 1 })
    const serverDeletes: string[] = []
    const discarded: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {},
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: {
        ...unusedSessionPort,
        remove: async ({ session }) => {
          serverDeletes.push(session.id)
        },
        discardProjection: ({ sessionID }) => {
          discarded.push(sessionID)
        },
      },
    })

    await actions.startDraftSession({ scope, panelID: "panel-space-a" })
    const draftID = state.commits[0]

    await actions.closePanel({ scope, panelID: "panel-space-a" })

    // The single-panel guard must not have diverted this close into
    // unbindPanel: the panel itself is gone.
    expect(state.removedPanelIDs).toEqual(["panel-space-a"])
    expect(discarded).toEqual([draftID])
    expect(serverDeletes).toEqual([])
  })
})
