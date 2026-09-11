import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import {
  createWorkbenchActions,
  type WorkbenchActionPanel,
  type WorkbenchActionSession,
  type WorkbenchActionStorePort,
} from "./workbench-actions"
import { scopePath, spaceScope } from "./workbench-scope"

function deferred<T>() {
  let resolveValue: (value: T) => void = () => {}
  let rejectValue: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve
    rejectValue = reject
  })
  return { promise, resolve: resolveValue, reject: rejectValue }
}

function createStorePort(options?: { withPty?: boolean }) {
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
  const transitions: string[] = []
  const store: WorkbenchActionStorePort = {
    panel: (_scope, panelID) => (panel.id === panelID ? panel : undefined),
    panels: () => [panel],
    boundPanels: (sessionID) => (panel.boundSessionId === sessionID ? [{ scope, panelID: panel.id, panel }] : []),
    active: () => ({ scope, panelID: panel.id }),
    addPanel: () => undefined,
    setActivePanel: () => {},
    setActive: () => {},
    activePanelID: () => undefined,
    removePanel: () => false,
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
      transitions.push(`pty:${kind}:${ptyID ?? "cleared"}`)
      ptys.push(ptyID)
      panel = {
        ...panel,
        tuiPtyId: kind === "tui" ? ptyID : panel.tuiPtyId,
        termPtyId: kind === "term" ? ptyID : panel.termPtyId,
        splitPtyId: kind === "split" ? ptyID : panel.splitPtyId,
      }
    },
    commitPanelMode: (_scope, _panelID, mode) => {
      transitions.push(`mode:${mode}`)
      panel = { ...panel, viewMode: mode }
    },
    commitSplitTerminal: (_scope, _panelID, splitTerminal) => {
      transitions.push(`split:${splitTerminal}`)
      panel = { ...panel, splitTerminal }
    },
    spacePaths: () => [],
  }
  return { store, commits, ptys, transitions, panel: () => panel }
}

const scope = spaceScope("Space A", "/fixtures/workspaces/space-a")
const nextSession = {
  id: "session-next",
  title: "Next",
  directory: "/fixtures/workspaces/space-a/project-next",
  type: "chat" as const,
}

const unusedSessionPort = {
  create: async () => nextSession,
  get: async () => nextSession,
  project: () => {},
  rename: async () => {},
  remove: async () => {},
}

describe("WorkbenchActions", () => {
  test("reports how many Panel bindings an external Session removal affected", async () => {
    const state = createStorePort({ withPty: false })
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {},
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: unusedSessionPort,
    })

    expect(await actions.unbindSessionEverywhere("session-old")).toEqual({
      status: "committed",
      affectedPanelCount: 1,
    })
    expect(await actions.unbindSessionEverywhere("session-missing")).toEqual({
      status: "unchanged",
      affectedPanelCount: 0,
    })
  })

  test("creates a General session through an explicit scope and commits it", async () => {
    const state = createStorePort()
    const scopes: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {},
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: {
        create: async ({ scope: requestedScope }) => {
          scopes.push(requestedScope.kind)
          return { ...nextSession, id: "session-general", directory: "" }
        },
        get: async () => nextSession,
        project: () => {},
        rename: async () => {},
        remove: async () => {},
      },
    })

    expect(await actions.createSession({ scope: { kind: "general" }, panelID: state.panel().id })).toEqual({
      status: "committed",
      panelID: "panel-space-a",
    })
    expect(scopes).toEqual(["general"])
    expect(state.commits).toEqual(["session-general"])
  })

  test("blocks session creation while the Workbench runtime is offline", async () => {
    const state = createStorePort()
    let creates = 0
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
          creates += 1
          return nextSession
        },
      },
      runtime: { canWrite: () => false },
    })

    expect(await actions.createSession({ scope, panelID: state.panel().id })).toEqual({
      status: "offline",
      panelID: state.panel().id,
    })
    expect(creates).toBe(0)
    expect(state.commits).toEqual([])
  })

  test("removes a newly-created Session when its generation becomes stale", async () => {
    const state = createStorePort()
    const created = deferred<typeof nextSession>()
    const removed: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {},
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: {
        create: () => created.promise,
        get: async () => nextSession,
        project: () => {},
        rename: async () => {},
        remove: async ({ session }) => {
          removed.push(session.id)
        },
      },
    })

    const pending = actions.createSession({ scope, panelID: state.panel().id })
    actions.cancelPanel(scope, state.panel().id)
    created.resolve(nextSession)

    expect(await pending).toEqual({ status: "stale", panelID: "panel-space-a" })
    expect(removed).toEqual(["session-next"])
    expect(state.commits).toEqual([])
  })

  test("clears PTY memory through the action boundary", () => {
    const state = createStorePort()
    let clears = 0
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {},
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
        clearMemory: () => {
          clears += 1
        },
      },
      session: unusedSessionPort,
    })

    actions.clearPtyMemory()

    expect(clears).toBe(1)
  })

  test("does not project a Session response that arrives after its Panel is cancelled", async () => {
    const state = createStorePort()
    const fetched = deferred<typeof nextSession>()
    const projected: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {},
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: {
        ...unusedSessionPort,
        get: () => fetched.promise,
        project: ({ session }) => {
          projected.push(session.id)
        },
      },
    })

    const pending = actions.loadSessionIntoPanel({
      scope,
      panelID: state.panel().id,
      sessionID: nextSession.id,
      directory: nextSession.directory,
    })
    actions.cancelPanel(scope, state.panel().id)
    fetched.resolve(nextSession)

    expect(await pending).toEqual({ status: "stale", panelID: "panel-space-a" })
    expect(projected).toEqual([])
    expect(state.commits).toEqual([])
  })

  test("releases a restored Panel when the server Session is archived", async () => {
    const state = createStorePort()
    const disposed: string[] = []
    const projected: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async ({ panel }) => {
          disposed.push(panel.id)
        },
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: {
        ...unusedSessionPort,
        get: async () => ({ ...nextSession, id: "session-old", timeArchived: 1 }),
        project: ({ session }) => {
          projected.push(session.id)
        },
      },
    })

    expect(
      await actions.refreshSession({
        scope,
        panelID: state.panel().id,
        sessionID: "session-old",
        directory: state.panel().directory,
      }),
    ).toEqual({ status: "committed", panelID: "panel-space-a", unavailableReason: "archived" })
    expect(disposed).toEqual(["panel-space-a"])
    expect(projected).toEqual([])
    expect(state.panel().slotState).toBe("empty")
  })

  test("releases a restored Panel when it points to a child Session", async () => {
    const state = createStorePort()
    const disposed: string[] = []
    const projected: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async ({ panel }) => {
          disposed.push(panel.id)
        },
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: {
        ...unusedSessionPort,
        get: async () => ({ ...nextSession, id: "session-old", parentID: "session-parent" }),
        project: ({ session }) => {
          projected.push(session.id)
        },
      },
    })

    expect(
      await actions.refreshSession({
        scope,
        panelID: state.panel().id,
        sessionID: "session-old",
        directory: state.panel().directory,
      }),
    ).toEqual({ status: "committed", panelID: "panel-space-a", unavailableReason: "child" })
    expect(disposed).toEqual(["panel-space-a"])
    expect(projected).toEqual([])
    expect(state.panel().slotState).toBe("empty")
  })

  test("disposes resources before committing a replacement once", async () => {
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

    expect(await actions.replaceSession({ scope, panelID: state.panel().id, session: nextSession })).toEqual({
      status: "committed",
      panelID: "panel-space-a",
    })
    expect(disposed).toEqual(["panel-space-a"])
    expect(state.commits).toEqual(["session-next"])
  })

  test("disposes the last bound panel before turning it into an empty slot", async () => {
    const state = createStorePort()
    const events: string[] = []
    const originalUnbind = state.store.commitSessionUnbinding
    state.store.commitSessionUnbinding = (requestedScope, panelID) => {
      events.push(`unbind:${panelID}`)
      return originalUnbind(requestedScope, panelID)
    }
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async ({ panel }) => {
          events.push(`dispose:${panel.id}`)
        },
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: unusedSessionPort,
    })

    expect(await actions.closePanel({ scope, panelID: state.panel().id })).toEqual({
      status: "committed",
      panelID: "panel-space-a",
    })
    expect(events).toEqual(["dispose:panel-space-a", "unbind:panel-space-a"])
    expect(state.panel().slotState).toBe("empty")
    expect(await actions.closePanel({ scope, panelID: state.panel().id })).toEqual({
      status: "unchanged",
      panelID: "panel-space-a",
    })
  })

  test("finishes closing when an intentional TUI disposal reports onClose", async () => {
    const state = createStorePort()
    const disposed = deferred<void>()
    let recovery: Promise<unknown> | undefined
    let actions: ReturnType<typeof createWorkbenchActions>
    actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: () => {
          recovery = actions.recoverPanelPty({
            scope,
            panelID: state.panel().id,
            kind: "tui",
            ptyID: "pty-existing",
          })
          return disposed.promise
        },
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
        probe: async () => "dead",
        forgetPty: () => {},
      },
      session: unusedSessionPort,
    })

    const closing = actions.closePanel({ scope, panelID: state.panel().id })
    await recovery
    disposed.resolve()

    expect(await closing).toEqual({ status: "committed", panelID: "panel-space-a" })
    expect(state.panel().slotState).toBe("empty")
  })

  test("disposes a removable panel before deleting its layout entry", async () => {
    const panels: WorkbenchActionPanel[] = [
      {
        id: "panel-a",
        slotState: "bound",
        boundSessionId: "session-a",
        directory: scopePath(scope),
        mode: "",
        width: 1,
      },
      { id: "panel-b", slotState: "empty", directory: scopePath(scope), mode: "", width: 1 },
    ]
    const events: string[] = []
    const store: WorkbenchActionStorePort = {
      panel: (_scope, panelID) => panels.find((panel) => panel.id === panelID),
      panels: () => panels,
      boundPanels: () => [],
      active: () => ({ scope, panelID: "panel-a" }),
      addPanel: () => undefined,
      setActivePanel: () => {},
      setActive: () => {},
      activePanelID: () => undefined,
      removePanel: (_scope, panelID) => {
        events.push(`remove:${panelID}`)
        const index = panels.findIndex((panel) => panel.id === panelID)
        if (index === -1) return false
        panels.splice(index, 1)
        return true
      },
      removeSpace: () => false,
      commitSessionBinding: () => {},
      commitSessionUnbinding: () => false,
      commitPanelPty: () => {},
      spacePaths: () => [],
    }
    const actions = createWorkbenchActions({
      store,
      pty: {
        disposePanel: async ({ panel }) => {
          events.push(`dispose:${panel.id}`)
        },
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: unusedSessionPort,
    })

    expect(await actions.closePanel({ scope, panelID: "panel-a" })).toEqual({
      status: "committed",
      panelID: "panel-a",
    })
    expect(events).toEqual(["dispose:panel-a", "remove:panel-a"])
    expect(panels.map((panel) => panel.id)).toEqual(["panel-b"])
  })

  test("disposes every panel before removing a Space and keeps General immutable", async () => {
    const panels: WorkbenchActionPanel[] = [
      { id: "panel-a", slotState: "bound", directory: scopePath(scope), mode: "", width: 1 },
      { id: "panel-b", slotState: "bound", directory: scopePath(scope), mode: "", width: 1 },
    ]
    const events: string[] = []
    let removed = false
    const store: WorkbenchActionStorePort = {
      panel: (_scope, panelID) => panels.find((panel) => panel.id === panelID),
      panels: (requestedScope) => (requestedScope.kind === "general" || removed ? [] : panels),
      boundPanels: () => [],
      active: () => ({ scope, panelID: "panel-a" }),
      addPanel: () => undefined,
      setActivePanel: () => {},
      setActive: () => {},
      activePanelID: () => undefined,
      removePanel: () => false,
      removeSpace: () => {
        events.push("remove-space")
        removed = true
        return true
      },
      commitSessionBinding: () => {},
      commitSessionUnbinding: () => false,
      commitPanelPty: () => {},
      spacePaths: () => [],
    }
    const actions = createWorkbenchActions({
      store,
      pty: {
        disposePanel: async ({ panel }) => {
          events.push(`dispose:${panel.id}`)
        },
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: unusedSessionPort,
    })

    expect(await actions.closeSpace(scope)).toEqual({ status: "committed" })
    expect(events).toEqual(["dispose:panel-a", "dispose:panel-b", "remove-space"])
    expect(await actions.closeSpace(scope)).toEqual({ status: "unchanged" })
    expect(await actions.closeSpace({ kind: "general" })).toEqual({ status: "unchanged" })
  })

  test("does not commit when resource disposal fails", async () => {
    const state = createStorePort()
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {
          throw new Error("dispose failed")
        },
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: unusedSessionPort,
    })

    expect(actions.replaceSession({ scope, panelID: state.panel().id, session: nextSession })).rejects.toThrow(
      "dispose failed",
    )
    expect(state.commits).toEqual([])
  })

  test("treats a repeated binding as an idempotent no-op", async () => {
    const state = createStorePort()
    state.store.commitSessionBinding(scope, state.panel().id, nextSession)
    state.commits.length = 0
    let disposals = 0
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {
          disposals += 1
        },
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: unusedSessionPort,
    })

    expect(await actions.replaceSession({ scope, panelID: state.panel().id, session: nextSession })).toEqual({
      status: "unchanged",
      panelID: "panel-space-a",
    })
    expect(disposals).toBe(0)
    expect(state.commits).toEqual([])
  })

  test("ignores an older replacement that finishes after a newer generation", async () => {
    const state = createStorePort()
    const firstDisposal = deferred<void>()
    let disposalCount = 0
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: () => {
          disposalCount += 1
          return disposalCount === 1 ? firstDisposal.promise : Promise.resolve()
        },
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: unusedSessionPort,
    })

    const first = actions.replaceSession({ scope, panelID: state.panel().id, session: nextSession })
    const second = actions.replaceSession({
      scope,
      panelID: state.panel().id,
      session: { ...nextSession, id: "session-latest" },
    })

    expect(await second).toEqual({ status: "committed", panelID: "panel-space-a" })
    firstDisposal.resolve()
    expect(await first).toEqual({ status: "stale", panelID: "panel-space-a" })
    expect(state.commits).toEqual(["session-latest"])
  })

  test("disposes a PTY that arrives after its panel generation is cancelled", async () => {
    const state = createStorePort({ withPty: false })
    const created = deferred<string>()
    const disposed: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {},
        ensure: () => created.promise,
        disposePty: async ({ knownPtyID }) => {
          disposed.push(knownPtyID)
        },
      },
      session: unusedSessionPort,
    })

    const pending = actions.ensurePanelPty({
      scope,
      panelID: state.panel().id,
      kind: "tui",
      create: async () => "unused",
    })
    actions.cancelPanel(scope, state.panel().id)
    created.resolve("pty-late")

    expect(await pending).toEqual({ status: "stale", panelID: "panel-space-a" })
    expect(disposed).toEqual(["pty-late"])
    expect(state.ptys).toEqual([])
  })

  test("keeps a live PTY after a terminal transport disconnect", async () => {
    const state = createStorePort()
    const forgotten: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {},
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
        probe: async () => "alive",
        forgetPty: ({ kind }) => {
          forgotten.push(kind)
        },
      },
      session: unusedSessionPort,
    })

    expect(
      await actions.recoverPanelPty({
        scope,
        panelID: state.panel().id,
        kind: "tui",
        ptyID: "pty-existing",
      }),
    ).toEqual({ status: "unchanged", panelID: "panel-space-a" })
    expect(forgotten).toEqual([])
    expect(state.panel().tuiPtyId).toBe("pty-existing")
  })

  test("preserves a split PTY while its liveness is unknown during a transport outage", async () => {
    const state = createStorePort()
    state.store.commitPanelPty(scope, state.panel().id, "split", "pty-split")
    state.store.commitSplitTerminal?.(scope, state.panel().id, true)
    state.transitions.length = 0
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {},
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
        probe: async () => "unknown",
        forgetPty: () => {
          throw new Error("an unknown PTY must not be forgotten")
        },
      },
      session: unusedSessionPort,
    })

    expect(
      await actions.recoverPanelPty({
        scope,
        panelID: state.panel().id,
        kind: "split",
        ptyID: "pty-split",
      }),
    ).toEqual({ status: "unchanged", panelID: "panel-space-a" })
    expect(state.transitions).toEqual([])
    expect(state.panel().splitPtyId).toBe("pty-split")
    expect(state.panel().splitTerminal).toBeTrue()
  })

  test("clears an exited split PTY and its layout through one Action", async () => {
    const state = createStorePort()
    state.store.commitPanelPty(scope, state.panel().id, "split", "pty-split")
    state.store.commitSplitTerminal?.(scope, state.panel().id, true)
    state.transitions.length = 0
    const forgotten: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {},
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
        probe: async () => "dead",
        forgetPty: ({ kind }) => {
          forgotten.push(kind)
        },
      },
      session: unusedSessionPort,
    })

    expect(
      await actions.recoverPanelPty({
        scope,
        panelID: state.panel().id,
        kind: "split",
        ptyID: "pty-split",
      }),
    ).toEqual({ status: "committed", panelID: "panel-space-a" })
    expect(forgotten).toEqual(["split"])
    expect(state.panel().splitPtyId).toBeUndefined()
    expect(state.panel().splitTerminal).toBeFalse()
    expect(state.transitions).toEqual(["split:false", "pty:split:cleared"])
  })
})

// ── Task 4 (O10): Store port delegation ──────────────────────────────────
// Verify that createWorkbenchActions delegates to each port method
// correctly, without duplicating logic. Each test constructs a spy-based
// store port and asserts the exact delegation call.

describe("WorkbenchActions store port delegation", () => {
  const scope = spaceScope("Space A", "/fixtures/workspaces/space-a")

  function spyStore() {
    const calls: string[] = []
    const panel: WorkbenchActionPanel = {
      id: "panel-1",
      slotState: "empty",
      directory: scopePath(scope),
      mode: "",
      width: 1,
    }
    const store: WorkbenchActionStorePort = {
      panel: (_s, id) => {
        calls.push(`panel:${id}`)
        return id === panel.id ? panel : undefined
      },
      panels: (s) => {
        calls.push(`panels:${s.kind}`)
        return [panel]
      },
      boundPanels: (sid) => {
        calls.push(`boundPanels:${sid}`)
        return []
      },
      active: () => {
        calls.push("active")
        return { scope, panelID: panel.id }
      },
      addPanel: (s) => {
        calls.push(`addPanel:${s.kind}`)
        return "panel-new"
      },
      setActivePanel: (_s, id) => {
        calls.push(`setActivePanel:${id}`)
      },
      setActive: (_name) => {
        calls.push(`setActive:${_name}`)
      },
      activePanelID: () => panel.id,
      removePanel: (_s, id) => {
        calls.push(`removePanel:${id}`)
        return true
      },
      removeSpace: (s) => {
        calls.push(`removeSpace:${s.kind}`)
        return true
      },
      commitSessionBinding: (_s, id, sess) => {
        calls.push(`commitSessionBinding:${id}:${sess.id}`)
      },
      commitSessionUnbinding: (_s, id) => {
        calls.push(`commitSessionUnbinding:${id}`)
        return true
      },
      commitPanelPty: (_s, id, kind, ptyID) => {
        calls.push(`commitPanelPty:${id}:${kind}:${ptyID ?? "undefined"}`)
      },
      commitPanelMode: (_s, id, mode) => {
        calls.push(`commitPanelMode:${id}:${mode}`)
      },
      commitSplitTerminal: (_s, id, open) => {
        calls.push(`commitSplitTerminal:${id}:${open}`)
      },
      spacePaths: () => [],
    }
    return { store, calls, panel }
  }

  const noopPty = {
    disposePanel: async () => {},
    ensure: async ({ create }: { create: () => Promise<string> }) => create(),
    disposePty: async () => {},
  }

  const noopSession = {
    create: async ({ panel: p }: { panel: WorkbenchActionPanel }) => ({
      id: "s-new",
      title: "New",
      directory: p.directory,
      type: "chat" as const,
    }),
    get: async () => ({ id: "s-1", title: "S1", directory: "/d", type: "chat" as const }),
    project: () => {},
    rename: async () => {},
    remove: async () => {},
  }

  test("activeTarget delegates to store.active()", () => {
    const { store, calls } = spyStore()
    const actions = createWorkbenchActions({ store, pty: noopPty, session: noopSession })
    const target = actions.activeTarget()
    expect(target).toEqual({ scope, panelID: "panel-1" })
    expect(calls).toContain("active")
  })

  test("addPanel delegates to store.addPanel()", () => {
    const { store, calls } = spyStore()
    const actions = createWorkbenchActions({ store, pty: noopPty, session: noopSession })
    expect(actions.addPanel(scope)).toBe("panel-new")
    expect(calls).toContain("addPanel:space")
  })

  test("registerPanelAction and executeActivePanelAction route to the active panel", () => {
    const { store } = spyStore()
    const actions = createWorkbenchActions({ store, pty: noopPty, session: noopSession })
    const executed: string[] = []
    actions.registerPanelAction(scope, "panel-1", { id: "test.act", execute: () => executed.push("fired") })
    expect(actions.canExecuteActivePanelAction("test.act")).toBe(true)
    actions.executeActivePanelAction("test.act")
    expect(executed).toEqual(["fired"])
  })

  test("canExecuteActivePanelAction returns false for unregistered action", () => {
    const { store } = spyStore()
    const actions = createWorkbenchActions({ store, pty: noopPty, session: noopSession })
    expect(actions.canExecuteActivePanelAction("nonexistent")).toBe(false)
  })

  test("canExecuteActivePanelAction returns false when no active panel", () => {
    const { store } = spyStore()
    store.active = () => undefined
    const actions = createWorkbenchActions({ store, pty: noopPty, session: noopSession })
    expect(actions.canExecuteActivePanelAction("test.act")).toBe(false)
  })

  test("canExecuteActivePanelAction respects disabled callback", () => {
    const { store } = spyStore()
    const actions = createWorkbenchActions({ store, pty: noopPty, session: noopSession })
    let disabled = true
    actions.registerPanelAction(scope, "panel-1", {
      id: "test.act",
      execute: () => {},
      disabled: () => disabled,
    })
    expect(actions.canExecuteActivePanelAction("test.act")).toBe(false)
    disabled = false
    expect(actions.canExecuteActivePanelAction("test.act")).toBe(true)
  })

  test("unregisterPanelAction removes the action", () => {
    const { store } = spyStore()
    const actions = createWorkbenchActions({ store, pty: noopPty, session: noopSession })
    actions.registerPanelAction(scope, "panel-1", { id: "test.act", execute: () => {} })
    expect(actions.canExecuteActivePanelAction("test.act")).toBe(true)
    actions.unregisterPanelAction(scope, "panel-1", "test.act")
    expect(actions.canExecuteActivePanelAction("test.act")).toBe(false)
  })

  test("canExecuteActivePanelAction is reactive: a memo depending on it re-runs after registerPanelAction", () => {
    const { store } = spyStore()
    const actions = createWorkbenchActions({ store, pty: noopPty, session: noopSession })
    const captured: boolean[] = []
    createRoot((dispose) => {
      const memo = createMemo(() => actions.canExecuteActivePanelAction("test.act"))
      captured.push(memo())
      expect(captured).toEqual([false])
      actions.registerPanelAction(scope, "panel-1", { id: "test.act", execute: () => {} })
      expect(actions.canExecuteActivePanelAction("test.act")).toBe(true)
      actions.unregisterPanelAction(scope, "panel-1", "test.act")
      expect(actions.canExecuteActivePanelAction("test.act")).toBe(false)
      dispose()
    })
  })

  test("cancelPanel increments generation so subsequent operations become stale", async () => {
    const { store } = spyStore()
    const created = deferred<{ id: string; title: string; directory: string; type: "chat" }>()
    const removed: string[] = []
    const actions = createWorkbenchActions({
      store,
      pty: noopPty,
      session: {
        ...noopSession,
        create: () => created.promise,
        remove: async ({ session }) => {
          removed.push(session.id)
        },
      },
    })
    const pending = actions.createSession({ scope, panelID: "panel-1" })
    actions.cancelPanel(scope, "panel-1")
    created.resolve({ id: "s-stale", title: "Stale", directory: "/d", type: "chat" })
    expect(await pending).toEqual({ status: "stale", panelID: "panel-1" })
    expect(removed).toEqual(["s-stale"])
  })
})

// ── Task 4 (O10): General vs Space scope ────────────────────────────────
// Verify that createWorkbenchActions correctly distinguishes General
// (empty path) from Space scopes in session creation, space closure,
// and directory derivation.

describe("WorkbenchActions General vs Space scope", () => {
  const general: { kind: "general" } = { kind: "general" }
  const spaceA = spaceScope("Space A", "/fixtures/workspaces/space-a")

  function createScopeStore() {
    const panels: WorkbenchActionPanel[] = [
      { id: "panel-g", slotState: "empty", directory: "", mode: "", width: 1 },
      { id: "panel-s", slotState: "empty", directory: "/fixtures/workspaces/space-a", mode: "", width: 1 },
    ]
    const store: WorkbenchActionStorePort = {
      panel: (_s, id) => panels.find((p) => p.id === id),
      panels: (s) => (s.kind === "general" ? [panels[0]] : [panels[1]]),
      boundPanels: () => [],
      active: () => ({ scope: spaceA, panelID: "panel-s" }),
      addPanel: () => undefined,
      setActivePanel: () => {},
      setActive: () => {},
      activePanelID: () => undefined,
      removePanel: () => false,
      removeSpace: () => true,
      commitSessionBinding: () => {},
      commitSessionUnbinding: () => false,
      commitPanelPty: () => {},
      spacePaths: () => [],
    }
    return { store, panels }
  }

  test("createSession passes kind=general to session.create for General scope", async () => {
    const { store } = createScopeStore()
    const scopes: string[] = []
    const actions = createWorkbenchActions({
      store,
      pty: { disposePanel: async () => {}, ensure: async ({ create }) => create(), disposePty: async () => {} },
      session: {
        create: async ({ scope: s }) => {
          scopes.push(s.kind)
          return { id: "s-g", title: "G", directory: "", type: "chat" }
        },
        get: async () => ({ id: "s-g", title: "G", directory: "", type: "chat" }),
        project: () => {},
        rename: async () => {},
        remove: async () => {},
      },
    })
    await actions.createSession({ scope: general, panelID: "panel-g" })
    expect(scopes).toEqual(["general"])
  })

  test("createSession passes kind=space with name to session.create for Space scope", async () => {
    const { store } = createScopeStore()
    const scopes: Array<{ kind: string; name?: string }> = []
    const actions = createWorkbenchActions({
      store,
      pty: { disposePanel: async () => {}, ensure: async ({ create }) => create(), disposePty: async () => {} },
      session: {
        create: async ({ scope: s }) => {
          scopes.push({ kind: s.kind, name: s.kind === "space" ? s.name : undefined })
          return { id: "s-s", title: "S", directory: "/fixtures/workspaces/space-a", type: "chat" }
        },
        get: async () => ({ id: "s-s", title: "S", directory: "/fixtures/workspaces/space-a", type: "chat" }),
        project: () => {},
        rename: async () => {},
        remove: async () => {},
      },
    })
    await actions.createSession({ scope: spaceA, panelID: "panel-s" })
    expect(scopes).toEqual([{ kind: "space", name: "Space A" }])
  })

  test("createSession disposes old panel resources before committing new session", async () => {
    const { store } = createScopeStore()
    const disposed: string[] = []
    const actions = createWorkbenchActions({
      store,
      pty: {
        disposePanel: async ({ panel }) => {
          disposed.push(panel.id)
        },
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: {
        create: async () => ({ id: "s-new", title: "New", directory: "", type: "chat" }),
        get: async () => ({ id: "s-new", title: "New", directory: "", type: "chat" }),
        project: () => {},
        rename: async () => {},
        remove: async () => {},
      },
    })
    await actions.createSession({ scope: general, panelID: "panel-g" })
    expect(disposed).toEqual(["panel-g"])
  })

  test("closeSpace returns unchanged for General scope", async () => {
    const { store } = createScopeStore()
    const actions = createWorkbenchActions({
      store,
      pty: { disposePanel: async () => {}, ensure: async ({ create }) => create(), disposePty: async () => {} },
      session: {
        create: async () => ({ id: "s", title: "S", directory: "", type: "chat" }),
        get: async () => ({ id: "s", title: "S", directory: "", type: "chat" }),
        project: () => {},
        rename: async () => {},
        remove: async () => {},
      },
    })
    expect(await actions.closeSpace(general)).toEqual({ status: "unchanged" })
  })

  test("closeSpace disposes panels and removes Space scope", async () => {
    const { store } = createScopeStore()
    const disposed: string[] = []
    const actions = createWorkbenchActions({
      store,
      pty: {
        disposePanel: async ({ panel }) => {
          disposed.push(panel.id)
        },
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: {
        create: async () => ({ id: "s", title: "S", directory: "/fixtures/workspaces/space-a", type: "chat" }),
        get: async () => ({ id: "s", title: "S", directory: "/fixtures/workspaces/space-a", type: "chat" }),
        project: () => {},
        rename: async () => {},
        remove: async () => {},
      },
    })
    expect(await actions.closeSpace(spaceA)).toEqual({ status: "committed" })
    expect(disposed).toEqual(["panel-s"])
  })

  test("General panel directory is empty string, Space panel directory is the space path", () => {
    const { store } = createScopeStore()
    expect(store.panel(general, "panel-g")?.directory).toBe("")
    expect(store.panel(spaceA, "panel-s")?.directory).toBe("/fixtures/workspaces/space-a")
  })
})

// ── Task 4 (O10): §5.6 additional coverage ──────────────────────────────
// Cover success, failure, repeated calls, and stale async results for
// actions not yet tested: deleteSession, renameSession, bindForkedSession,
// loadSessionIntoPanel edge cases, ensurePanelPty edge cases,
// closeSplitTerminal, recoverPanelPty edge cases, unbindSession idempotency.

describe("WorkbenchActions §5.6 additional coverage", () => {
  const scope = spaceScope("Space A", "/fixtures/workspaces/space-a")

  function createStorePort(options?: { withPty?: boolean }) {
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
    const store: WorkbenchActionStorePort = {
      panel: (_s, panelID) => (panel.id === panelID ? panel : undefined),
      panels: () => [panel],
      boundPanels: (sessionID) => (panel.boundSessionId === sessionID ? [{ scope, panelID: panel.id, panel }] : []),
      active: () => ({ scope, panelID: panel.id }),
      addPanel: () => undefined,
      setActivePanel: () => {},
      setActive: () => {},
      activePanelID: () => undefined,
      removePanel: () => false,
      removeSpace: () => false,
      commitSessionBinding: (_s, panelID, session) => {
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
      commitPanelPty: (_s, _panelID, kind, ptyID) => {
        ptys.push(ptyID)
        panel = {
          ...panel,
          tuiPtyId: kind === "tui" ? ptyID : panel.tuiPtyId,
          termPtyId: kind === "term" ? ptyID : panel.termPtyId,
          splitPtyId: kind === "split" ? ptyID : panel.splitPtyId,
        }
      },
      commitPanelMode: (_s, _panelID, mode) => {
        panel = { ...panel, viewMode: mode }
      },
      commitSplitTerminal: (_s, _panelID, splitTerminal) => {
        panel = { ...panel, splitTerminal }
      },
      spacePaths: () => [],
    }
    return { store, commits, ptys, panel: () => panel }
  }

  const nextSession = {
    id: "session-next",
    title: "Next",
    directory: "/fixtures/workspaces/space-a/project-next",
    type: "chat" as const,
  }

  const unusedSessionPort = {
    create: async () => nextSession,
    get: async () => nextSession,
    project: () => {},
    rename: async () => {},
    remove: async () => {},
  }

  // ── deleteSession ──────────────────────────────────────────
  test("deleteSession removes the session and unbinds all bound panels", async () => {
    const state = createStorePort()
    const removed: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: { disposePanel: async () => {}, ensure: async ({ create }) => create(), disposePty: async () => {} },
      session: {
        ...unusedSessionPort,
        get: async () => ({ ...nextSession, id: "session-old" }),
        remove: async ({ session }) => {
          removed.push(session.id)
        },
      },
    })
    expect(
      await actions.deleteSession({ scope, sessionID: "session-old", directory: state.panel().directory }),
    ).toEqual({ status: "committed" })
    expect(removed).toEqual(["session-old"])
    expect(state.panel().slotState).toBe("empty")
  })

  test("deleteSession with no bound panels still removes the session", async () => {
    const state = createStorePort()
    state.store.boundPanels = () => []
    const removed: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: { disposePanel: async () => {}, ensure: async ({ create }) => create(), disposePty: async () => {} },
      session: {
        ...unusedSessionPort,
        get: async () => ({ ...nextSession, id: "session-orphan" }),
        remove: async ({ session }) => {
          removed.push(session.id)
        },
      },
    })
    expect(await actions.deleteSession({ scope, sessionID: "session-orphan", directory: "/d" })).toEqual({
      status: "committed",
    })
    expect(removed).toEqual(["session-orphan"])
  })

  // ── renameSession ──────────────────────────────────────────
  test("renameSession delegates to session.rename", async () => {
    const state = createStorePort()
    const renamed: Array<{ sessionID: string; title: string }> = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: { disposePanel: async () => {}, ensure: async ({ create }) => create(), disposePty: async () => {} },
      session: {
        ...unusedSessionPort,
        rename: async ({ sessionID, title }) => {
          renamed.push({ sessionID, title })
        },
      },
    })
    await actions.renameSession({ scope, sessionID: "session-old", directory: "/d", title: "Renamed" })
    expect(renamed).toEqual([{ sessionID: "session-old", title: "Renamed" }])
  })

  // ── bindForkedSession ──────────────────────────────────────
  test("bindForkedSession adds a new panel, binds, and activates it", async () => {
    const state = createStorePort()
    const activations: string[] = []
    state.store.addPanel = () => "panel-fork"
    state.store.setActivePanel = (_s, id) => {
      activations.push(id)
    }
    const actions = createWorkbenchActions({
      store: state.store,
      pty: { disposePanel: async () => {}, ensure: async ({ create }) => create(), disposePty: async () => {} },
      session: {
        ...unusedSessionPort,
        get: async () => ({ ...nextSession, id: "session-forked" }),
      },
    })
    expect(
      await actions.bindForkedSession({ scope, sourcePanelID: state.panel().id, sessionID: "session-forked" }),
    ).toEqual({
      status: "committed",
      panelID: "panel-fork",
    })
    expect(state.commits).toEqual(["session-forked"])
    expect(activations).toEqual(["panel-fork"])
  })

  test("bindForkedSession replaces source panel when addPanel returns undefined", async () => {
    const state = createStorePort()
    state.store.addPanel = () => undefined
    const actions = createWorkbenchActions({
      store: state.store,
      pty: { disposePanel: async () => {}, ensure: async ({ create }) => create(), disposePty: async () => {} },
      session: {
        ...unusedSessionPort,
        get: async () => ({ ...nextSession, id: "session-forked" }),
      },
    })
    expect(
      await actions.bindForkedSession({ scope, sourcePanelID: state.panel().id, sessionID: "session-forked" }),
    ).toEqual({
      status: "committed",
      panelID: "panel-space-a",
    })
    expect(state.commits).toEqual(["session-forked"])
  })

  test("bindForkedSession returns stale when generation is cancelled", async () => {
    const state = createStorePort()
    const fetched = deferred<typeof nextSession>()
    const actions = createWorkbenchActions({
      store: state.store,
      pty: { disposePanel: async () => {}, ensure: async ({ create }) => create(), disposePty: async () => {} },
      session: { ...unusedSessionPort, get: () => fetched.promise },
    })
    const pending = actions.bindForkedSession({ scope, sourcePanelID: state.panel().id, sessionID: "session-forked" })
    actions.cancelPanel(scope, state.panel().id)
    fetched.resolve(nextSession)
    expect(await pending).toEqual({ status: "stale", panelID: "panel-space-a" })
  })

  // ── loadSessionIntoPanel ───────────────────────────────────
  test("loadSessionIntoPanel disposes old binding and commits new session", async () => {
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
      session: {
        ...unusedSessionPort,
        get: async () => ({ ...nextSession, id: "session-loaded" }),
      },
    })
    expect(
      await actions.loadSessionIntoPanel({
        scope,
        panelID: state.panel().id,
        sessionID: "session-loaded",
        directory: nextSession.directory,
      }),
    ).toEqual({
      status: "committed",
      panelID: "panel-space-a",
    })
    expect(disposed).toEqual(["panel-space-a"])
    expect(state.commits).toEqual(["session-loaded"])
  })

  test("loadSessionIntoPanel is idempotent when same session already bound", async () => {
    const state = createStorePort()
    state.store.commitSessionBinding(scope, state.panel().id, { ...nextSession, id: "session-old" })
    state.commits.length = 0
    let disposals = 0
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {
          disposals += 1
        },
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
      },
      session: {
        ...unusedSessionPort,
        get: async () => ({ ...nextSession, id: "session-old" }),
      },
    })
    expect(
      await actions.loadSessionIntoPanel({
        scope,
        panelID: state.panel().id,
        sessionID: "session-old",
        directory: state.panel().directory,
      }),
    ).toEqual({
      status: "unchanged",
      panelID: "panel-space-a",
    })
    expect(disposals).toBe(0)
    expect(state.commits).toEqual([])
  })

  test("loadSessionIntoPanel returns unchanged for archived session", async () => {
    const state = createStorePort()
    const actions = createWorkbenchActions({
      store: state.store,
      pty: { disposePanel: async () => {}, ensure: async ({ create }) => create(), disposePty: async () => {} },
      session: {
        ...unusedSessionPort,
        get: async () => ({ ...nextSession, id: "session-archived", timeArchived: 1 }),
      },
    })
    expect(
      await actions.loadSessionIntoPanel({
        scope,
        panelID: state.panel().id,
        sessionID: "session-archived",
        directory: "/d",
      }),
    ).toEqual({
      status: "unchanged",
      panelID: "panel-space-a",
      unavailableReason: "archived",
    })
  })

  test("loadSessionIntoPanel returns unchanged for child session", async () => {
    const state = createStorePort()
    const actions = createWorkbenchActions({
      store: state.store,
      pty: { disposePanel: async () => {}, ensure: async ({ create }) => create(), disposePty: async () => {} },
      session: {
        ...unusedSessionPort,
        get: async () => ({ ...nextSession, id: "session-child", parentID: "parent" }),
      },
    })
    expect(
      await actions.loadSessionIntoPanel({
        scope,
        panelID: state.panel().id,
        sessionID: "session-child",
        directory: "/d",
      }),
    ).toEqual({
      status: "unchanged",
      panelID: "panel-space-a",
      unavailableReason: "child",
    })
  })

  // ── ensurePanelPty ─────────────────────────────────────────
  test("ensurePanelPty creates a new PTY and commits it", async () => {
    const state = createStorePort({ withPty: false })
    const actions = createWorkbenchActions({
      store: state.store,
      pty: { disposePanel: async () => {}, ensure: async ({ create }) => create(), disposePty: async () => {} },
      session: unusedSessionPort,
    })
    expect(
      await actions.ensurePanelPty({ scope, panelID: state.panel().id, kind: "tui", create: async () => "pty-new" }),
    ).toEqual({
      status: "committed",
      panelID: "panel-space-a",
      ptyID: "pty-new",
    })
    expect(state.panel().tuiPtyId).toBe("pty-new")
  })

  test("ensurePanelPty returns unchanged when existing PTY matches", async () => {
    const state = createStorePort()
    const actions = createWorkbenchActions({
      store: state.store,
      pty: { disposePanel: async () => {}, ensure: async ({ create }) => create(), disposePty: async () => {} },
      session: unusedSessionPort,
    })
    expect(
      await actions.ensurePanelPty({
        scope,
        panelID: state.panel().id,
        kind: "tui",
        create: async () => "pty-existing",
      }),
    ).toEqual({
      status: "unchanged",
      panelID: "panel-space-a",
      ptyID: "pty-existing",
    })
  })

  test("ensurePanelPty disposes a late PTY when generation is stale", async () => {
    const state = createStorePort({ withPty: false })
    const created = deferred<string>()
    const disposed: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {},
        ensure: () => created.promise,
        disposePty: async ({ knownPtyID }) => {
          disposed.push(knownPtyID)
        },
      },
      session: unusedSessionPort,
    })
    const pending = actions.ensurePanelPty({
      scope,
      panelID: state.panel().id,
      kind: "tui",
      create: async () => "unused",
    })
    actions.cancelPanel(scope, state.panel().id)
    created.resolve("pty-late")
    expect(await pending).toEqual({ status: "stale", panelID: "panel-space-a" })
    expect(disposed).toEqual(["pty-late"])
    expect(state.ptys).toEqual([])
  })

  // ── closeSplitTerminal ──────────────────────────────────────
  test("closeSplitTerminal disposes the split PTY and clears store state", async () => {
    const state = createStorePort()
    state.store.commitPanelPty(scope, state.panel().id, "split", "pty-split")
    state.store.commitSplitTerminal?.(scope, state.panel().id, true)
    const disposed: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {},
        ensure: async ({ create }) => create(),
        disposePty: async ({ knownPtyID }) => {
          disposed.push(knownPtyID)
        },
      },
      session: unusedSessionPort,
    })
    expect(await actions.closeSplitTerminal({ scope, panelID: state.panel().id })).toEqual({
      status: "committed",
      panelID: "panel-space-a",
    })
    expect(disposed).toEqual(["pty-split"])
    expect(state.panel().splitPtyId).toBeUndefined()
    expect(state.panel().splitTerminal).toBeFalse()
  })

  test("closeSplitTerminal returns unchanged when no split PTY exists", async () => {
    const state = createStorePort({ withPty: false })
    const actions = createWorkbenchActions({
      store: state.store,
      pty: { disposePanel: async () => {}, ensure: async ({ create }) => create(), disposePty: async () => {} },
      session: unusedSessionPort,
    })
    expect(await actions.closeSplitTerminal({ scope, panelID: state.panel().id })).toEqual({
      status: "unchanged",
      panelID: "panel-space-a",
    })
  })

  test("closeSplitTerminal returns stale when generation is cancelled", async () => {
    const state = createStorePort()
    state.store.commitPanelPty(scope, state.panel().id, "split", "pty-split")
    const disposed = deferred<void>()
    const actions = createWorkbenchActions({
      store: state.store,
      pty: { disposePanel: async () => {}, ensure: async ({ create }) => create(), disposePty: () => disposed.promise },
      session: unusedSessionPort,
    })
    const pending = actions.closeSplitTerminal({ scope, panelID: state.panel().id })
    actions.cancelPanel(scope, state.panel().id)
    disposed.resolve()
    expect(await pending).toEqual({ status: "stale", panelID: "panel-space-a" })
  })

  // ── recoverPanelPty edge cases ─────────────────────────────
  test("recoverPanelPty returns stale when panel not found", async () => {
    const state = createStorePort()
    const actions = createWorkbenchActions({
      store: state.store,
      pty: { disposePanel: async () => {}, ensure: async ({ create }) => create(), disposePty: async () => {} },
      session: unusedSessionPort,
    })
    expect(await actions.recoverPanelPty({ scope, panelID: "nonexistent", kind: "tui", ptyID: "pty-x" })).toEqual({
      status: "stale",
      panelID: "nonexistent",
    })
  })

  test("recoverPanelPty returns stale when PTY ID does not match panel", async () => {
    const state = createStorePort()
    const actions = createWorkbenchActions({
      store: state.store,
      pty: { disposePanel: async () => {}, ensure: async ({ create }) => create(), disposePty: async () => {} },
      session: unusedSessionPort,
    })
    expect(
      await actions.recoverPanelPty({ scope, panelID: state.panel().id, kind: "tui", ptyID: "pty-mismatch" }),
    ).toEqual({
      status: "stale",
      panelID: "panel-space-a",
    })
  })

  test("recoverPanelPty clears TUI mode when TUI PTY is dead", async () => {
    const state = createStorePort()
    state.store.commitPanelMode?.(scope, state.panel().id, "tui")
    const forgotten: string[] = []
    const actions = createWorkbenchActions({
      store: state.store,
      pty: {
        disposePanel: async () => {},
        ensure: async ({ create }) => create(),
        disposePty: async () => {},
        probe: async () => "dead",
        forgetPty: ({ kind }) => {
          forgotten.push(kind)
        },
      },
      session: unusedSessionPort,
    })
    expect(
      await actions.recoverPanelPty({ scope, panelID: state.panel().id, kind: "tui", ptyID: "pty-existing" }),
    ).toEqual({
      status: "committed",
      panelID: "panel-space-a",
    })
    expect(forgotten).toEqual(["tui"])
    expect(state.panel().tuiPtyId).toBeUndefined()
    expect(state.panel().viewMode).toBe("chat")
  })

  // ── unbindSession idempotency ──────────────────────────────
  test("unbindSession is idempotent on already empty panel", async () => {
    const state = createStorePort()
    state.store.commitSessionUnbinding(scope, state.panel().id)
    const actions = createWorkbenchActions({
      store: state.store,
      pty: { disposePanel: async () => {}, ensure: async ({ create }) => create(), disposePty: async () => {} },
      session: unusedSessionPort,
    })
    expect(await actions.unbindSession({ scope, panelID: state.panel().id })).toEqual({
      status: "unchanged",
      panelID: "panel-space-a",
    })
  })

  test("unbindSession disposes PTY and unbinds a bound panel", async () => {
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
    expect(await actions.unbindSession({ scope, panelID: state.panel().id })).toEqual({
      status: "committed",
      panelID: "panel-space-a",
    })
    expect(disposed).toEqual(["panel-space-a"])
    expect(state.panel().slotState).toBe("empty")
  })
})

// ── Task 2 (O5): revealSession ───────────────────────────────────────
// The single deep-link transaction entry. It activates an already-bound
// session, loads an unbound one into an empty/new Panel, or reports that
// replacement must be confirmed when every Panel is bound.

describe("WorkbenchActions revealSession", () => {
  const scope = spaceScope("Space A", "/fixtures/workspaces/space-a")
  const path = scopePath(scope)

  function makeStore(initial: WorkbenchActionPanel[], options?: { addPanelReturns?: string | undefined }) {
    const panels = initial.map((p) => ({ ...p }))
    let activePanelID = panels[0]?.id ?? ""
    const calls: string[] = []
    const store: WorkbenchActionStorePort = {
      panel: (_s, id) => panels.find((p) => p.id === id),
      panels: () => panels,
      boundPanels: (sid) =>
        panels
          .filter((p) => p.slotState === "bound" && p.boundSessionId === sid)
          .map((p) => ({ scope, panelID: p.id, panel: p })),
      active: () => ({ scope, panelID: activePanelID }),
      addPanel: () => {
        calls.push("addPanel")
        if (options?.addPanelReturns === undefined) return undefined
        const id = options.addPanelReturns
        panels.push({ id, slotState: "empty", directory: path, mode: "", width: 1 })
        return id
      },
      setActivePanel: (_s, id) => {
        activePanelID = id
        calls.push(`setActivePanel:${id}`)
      },
      setActive: (name) => {
        calls.push(`setActive:${name}`)
      },
      activePanelID: () => activePanelID,
      removePanel: () => false,
      removeSpace: () => false,
      commitSessionBinding: (_s, id, session) => {
        calls.push(`bind:${id}:${session.id}`)
        const panel = panels.find((p) => p.id === id)
        if (panel) {
          panel.slotState = "bound"
          panel.boundSessionId = session.id
          panel.directory = session.directory
        }
      },
      commitSessionUnbinding: () => false,
      commitPanelPty: () => {},
      spacePaths: () => [],
    }
    return { store, panels: () => panels, calls, getActive: () => activePanelID }
  }

  const noopPty = {
    disposePanel: async () => {},
    ensure: async ({ create }: { create: () => Promise<string> }) => create(),
    disposePty: async () => {},
  }
  const loadedSession = {
    id: "session-new",
    title: "New",
    directory: "/fixtures/workspaces/space-a/project-new",
    type: "chat" as const,
  }
  const getSession = (over: Partial<WorkbenchActionSession> = {}) => ({
    create: async () => ({ ...loadedSession, ...over }),
    get: async () => ({ ...loadedSession, ...over }),
    project: () => {},
    rename: async () => {},
    remove: async () => {},
  })

  test("activates an already-bound session without loading it", async () => {
    const state = makeStore([
      { id: "p1", slotState: "bound", boundSessionId: "session-bound", directory: path, mode: "chat", width: 1 },
      { id: "p2", slotState: "empty", directory: path, mode: "", width: 1 },
    ])
    const actions = createWorkbenchActions({ store: state.store, pty: noopPty, session: getSession() })
    const result = await actions.revealSession({ scope, sessionID: "session-bound", directory: path })
    expect(result).toEqual({ status: "activated", panelID: "p1", scopePath: path })
    expect(state.calls).toContain(`setActive:${path}`)
    expect(state.calls).toContain("setActivePanel:p1")
    // never fetched or bound
    expect(state.calls.some((c) => c.startsWith("bind:"))).toBe(false)
  })

  test("loads an unbound session into an empty panel", async () => {
    const state = makeStore([
      { id: "p1", slotState: "bound", boundSessionId: "session-a", directory: path, mode: "chat", width: 1 },
      { id: "p2", slotState: "empty", directory: path, mode: "", width: 1 },
      { id: "p3", slotState: "empty", directory: path, mode: "", width: 1 },
    ])
    const actions = createWorkbenchActions({ store: state.store, pty: noopPty, session: getSession() })
    const result = await actions.revealSession({ scope, sessionID: "session-new", directory: path })
    expect(result).toEqual({ status: "loaded", panelID: "p2", scopePath: path })
    expect(state.calls).toContain("bind:p2:session-new")
    expect(state.calls).toContain("setActivePanel:p2")
  })

  test("adds a panel when no empty panel exists and the limit allows it", async () => {
    const state = makeStore(
      [
        { id: "p1", slotState: "bound", boundSessionId: "session-a", directory: path, mode: "chat", width: 1 },
        { id: "p2", slotState: "bound", boundSessionId: "session-b", directory: path, mode: "chat", width: 1 },
      ],
      { addPanelReturns: "p3" },
    )
    const actions = createWorkbenchActions({ store: state.store, pty: noopPty, session: getSession() })
    const result = await actions.revealSession({ scope, sessionID: "session-new", directory: path })
    expect(result).toEqual({ status: "loaded", panelID: "p3", scopePath: path })
    expect(state.calls).toContain("addPanel")
    expect(state.calls).toContain("bind:p3:session-new")
  })

  test("requests replacement when every Panel is bound and none can be added", async () => {
    const state = makeStore([
      { id: "p1", slotState: "bound", boundSessionId: "session-a", directory: path, mode: "chat", width: 1 },
      { id: "p2", slotState: "bound", boundSessionId: "session-b", directory: path, mode: "chat", width: 1 },
      { id: "p3", slotState: "bound", boundSessionId: "session-c", directory: path, mode: "chat", width: 1 },
    ])
    // addPanel returns undefined → cannot add
    const actions = createWorkbenchActions({ store: state.store, pty: noopPty, session: getSession() })
    const result = await actions.revealSession({ scope, sessionID: "session-new", directory: path })
    expect(result).toEqual({ status: "replacement_required", panelID: "p1", scopePath: path })
    // no binding change happened
    expect(state.calls.some((c) => c.startsWith("bind:"))).toBe(false)
    expect(state.calls.some((c) => c.startsWith("setActivePanel:"))).toBe(false)
  })

  test("replaces the active Panel when forceReplace is set on a full Space", async () => {
    const state = makeStore([
      { id: "p1", slotState: "bound", boundSessionId: "session-a", directory: path, mode: "chat", width: 1 },
      { id: "p2", slotState: "bound", boundSessionId: "session-b", directory: path, mode: "chat", width: 1 },
      { id: "p3", slotState: "bound", boundSessionId: "session-c", directory: path, mode: "chat", width: 1 },
    ])
    const actions = createWorkbenchActions({ store: state.store, pty: noopPty, session: getSession() })
    const result = await actions.revealSession({ scope, sessionID: "session-new", directory: path, forceReplace: true })
    expect(result).toEqual({ status: "loaded", panelID: "p1", scopePath: path })
    expect(state.calls).toContain("bind:p1:session-new")
  })

  test("returns unavailable for an archived session", async () => {
    const state = makeStore([
      { id: "p1", slotState: "empty", directory: path, mode: "", width: 1 },
      { id: "p2", slotState: "empty", directory: path, mode: "", width: 1 },
    ])
    const actions = createWorkbenchActions({
      store: state.store,
      pty: noopPty,
      session: getSession({ id: "session-archived", timeArchived: 1 }),
    })
    const result = await actions.revealSession({ scope, sessionID: "session-archived", directory: path })
    expect(result.status).toBe("unavailable")
    expect(result.reason).toBe("archived")
  })

  test("returns stale when the load generation is cancelled", async () => {
    const state = makeStore([
      { id: "p1", slotState: "empty", directory: path, mode: "", width: 1 },
      { id: "p2", slotState: "empty", directory: path, mode: "", width: 1 },
    ])
    const fetched = deferred<typeof loadedSession>()
    const actions = createWorkbenchActions({
      store: state.store,
      pty: noopPty,
      session: { ...getSession(), get: () => fetched.promise },
    })
    const pending = actions.revealSession({ scope, sessionID: "session-new", directory: path })
    actions.cancelPanel(scope, "p1")
    fetched.resolve(loadedSession)
    expect(await pending).toEqual({ status: "stale" })
  })
})

// ── W-02: clearAllPtyForServerChange ──────────────────────────────────────

describe("clearAllPtyForServerChange", () => {
  test("clears all PTY IDs, switches TUI to chat, closes split terminal", () => {
    const calls: string[] = []
    const diagnostics: Array<{ type: string; text: string }> = []

    const panel: WorkbenchActionPanel = {
      id: "p1",
      slotState: "bound",
      boundSessionId: "s1",
      directory: "/test",
      mode: "",
      width: 1,
      tuiPtyId: "pty-tui-1",
      termPtyId: "pty-term-1",
      splitPtyId: "pty-split-1",
      viewMode: "tui",
      splitTerminal: true,
    }

    const store: WorkbenchActionStorePort = {
      panel: () => panel,
      panels: () => [panel],
      boundPanels: () => [],
      active: () => undefined,
      addPanel: () => undefined,
      setActivePanel: () => {},
      setActive: () => {},
      activePanelID: () => undefined,
      removePanel: () => false,
      removeSpace: () => false,
      commitSessionBinding: () => {},
      commitSessionUnbinding: () => false,
      commitPanelPty: (_s, id, kind, ptyID) => {
        calls.push(`commitPanelPty:${id}:${kind}:${ptyID ?? "undefined"}`)
      },
      commitPanelMode: (_s, id, mode) => {
        calls.push(`commitPanelMode:${id}:${mode}`)
      },
      commitSplitTerminal: (_s, id, open) => {
        calls.push(`commitSplitTerminal:${id}:${open}`)
      },
      spacePaths: () => ["/test"],
      pushDiagnostic: (type, text) => {
        diagnostics.push({ type, text })
        return "diag-1"
      },
    }

    const actions = createWorkbenchActions({
      store,
      pty: {
        disposePanel: async () => {},
        ensure: async () => "",
        disposePty: async () => {},
        clearMemory: () => {
          calls.push("clearMemory")
        },
      },
      session: {
        create: async () => ({ id: "s1", title: "", directory: "/test", type: "chat" }),
        get: async () => ({ id: "s1", title: "", directory: "/test", type: "chat" }),
        project: () => {},
        rename: async () => {},
        remove: async () => {},
      },
    })

    actions.clearAllPtyForServerChange()

    // Verify viewMode switched to chat BEFORE tuiPtyId cleared (W-06 order)
    const modeIndex = calls.findIndex((c) => c.startsWith("commitPanelMode"))
    const tuiPtyIndex = calls.findIndex((c) => c.includes(":tui:undefined"))
    expect(modeIndex).toBeLessThan(tuiPtyIndex)

    // Verify all PTY IDs cleared
    expect(calls).toContain("commitPanelPty:p1:tui:undefined")
    expect(calls).toContain("commitPanelPty:p1:term:undefined")
    expect(calls).toContain("commitPanelPty:p1:split:undefined")

    // Verify TUI switched to chat
    expect(calls).toContain("commitPanelMode:p1:chat")

    // Verify split terminal closed
    expect(calls).toContain("commitSplitTerminal:p1:false")

    // Verify ptyManager memory cleared
    expect(calls).toContain("clearMemory")

    // Verify diagnostic hint added
    expect(diagnostics.length).toBe(1)
    expect(diagnostics[0].type).toBe("info")
    expect(diagnostics[0].text).toContain("Sidecar restarted")
  })

  test("handles General space panels", () => {
    const calls: string[] = []

    const panel: WorkbenchActionPanel = {
      id: "g1",
      slotState: "bound",
      boundSessionId: "s1",
      directory: "/test",
      mode: "",
      width: 1,
      tuiPtyId: "pty-tui-1",
      viewMode: "chat",
    }

    const store: WorkbenchActionStorePort = {
      panel: () => panel,
      panels: (scope) => (scope.kind === "general" ? [panel] : []),
      boundPanels: () => [],
      active: () => undefined,
      addPanel: () => undefined,
      setActivePanel: () => {},
      setActive: () => {},
      activePanelID: () => undefined,
      removePanel: () => false,
      removeSpace: () => false,
      commitSessionBinding: () => {},
      commitSessionUnbinding: () => false,
      commitPanelPty: (_s, id, kind, ptyID) => {
        calls.push(`commitPanelPty:${id}:${kind}:${ptyID ?? "undefined"}`)
      },
      commitPanelMode: (_s, id, mode) => {
        calls.push(`commitPanelMode:${id}:${mode}`)
      },
      commitSplitTerminal: (_s, id, open) => {
        calls.push(`commitSplitTerminal:${id}:${open}`)
      },
      spacePaths: () => [],
      pushDiagnostic: () => "diag-1",
    }

    const actions = createWorkbenchActions({
      store,
      pty: {
        disposePanel: async () => {},
        ensure: async () => "",
        disposePty: async () => {},
        clearMemory: () => {},
      },
      session: {
        create: async () => ({ id: "s1", title: "", directory: "/test", type: "chat" }),
        get: async () => ({ id: "s1", title: "", directory: "/test", type: "chat" }),
        project: () => {},
        rename: async () => {},
        remove: async () => {},
      },
    })

    actions.clearAllPtyForServerChange()

    // General space panel PTY cleared
    expect(calls).toContain("commitPanelPty:g1:tui:undefined")
    expect(calls).toContain("commitPanelPty:g1:term:undefined")
    expect(calls).toContain("commitPanelPty:g1:split:undefined")
  })

  describe("clearPtyEverywhere", () => {
    test("clears matching tuiPtyId from panel even when viewMode is chat (in background)", () => {
      const calls: string[] = []
      const panel: WorkbenchActionPanel = {
        id: "p1",
        slotState: "bound",
        boundSessionId: "s1",
        directory: "/test",
        mode: "",
        width: 1,
        tuiPtyId: "target-pty-123",
        viewMode: "chat",
      }

      const store: WorkbenchActionStorePort = {
        panel: () => panel,
        panels: () => [panel],
        boundPanels: () => [],
        active: () => undefined,
        addPanel: () => undefined,
        setActivePanel: () => {},
        setActive: () => {},
        activePanelID: () => undefined,
        removePanel: () => false,
        removeSpace: () => false,
        commitSessionBinding: () => {},
        commitSessionUnbinding: () => false,
        commitPanelPty: (_s, id, kind, ptyID) => {
          calls.push(`commitPanelPty:${id}:${kind}:${ptyID ?? "undefined"}`)
        },
        commitPanelMode: (_s, id, mode) => {
          calls.push(`commitPanelMode:${id}:${mode}`)
        },
        commitSplitTerminal: (_s, id, open) => {
          calls.push(`commitSplitTerminal:${id}:${open}`)
        },
        spacePaths: () => ["/test-space"],
        pushDiagnostic: () => "diag-1",
      }

      let forgottenKey = ""
      const actions = createWorkbenchActions({
        store,
        pty: {
          disposePanel: async () => {},
          ensure: async () => "",
          disposePty: async () => {},
          forgetPty: (opts) => {
            forgottenKey = `${opts.panelID}:${opts.kind}`
          },
          clearMemory: () => {},
        },
        session: {
          create: async () => ({ id: "s1", title: "", directory: "/test", type: "chat" }),
          get: async () => ({ id: "s1", title: "", directory: "/test", type: "chat" }),
          project: () => {},
          rename: async () => {},
          remove: async () => {},
        },
      })

      actions.clearPtyEverywhere("target-pty-123")

      expect(calls).toContain("commitPanelPty:p1:tui:undefined")
      expect(forgottenKey).toBe("p1:tui")
    })

    test("switches viewMode to chat before clearing tuiPtyId if active viewMode is tui", () => {
      const calls: string[] = []
      const panel: WorkbenchActionPanel = {
        id: "p2",
        slotState: "bound",
        boundSessionId: "s1",
        directory: "/test",
        mode: "",
        width: 1,
        tuiPtyId: "target-pty-456",
        viewMode: "tui",
      }

      const store: WorkbenchActionStorePort = {
        panel: () => panel,
        panels: () => [panel],
        boundPanels: () => [],
        active: () => undefined,
        addPanel: () => undefined,
        setActivePanel: () => {},
        setActive: () => {},
        activePanelID: () => undefined,
        removePanel: () => false,
        removeSpace: () => false,
        commitSessionBinding: () => {},
        commitSessionUnbinding: () => false,
        commitPanelPty: (_s, id, kind, ptyID) => {
          calls.push(`commitPanelPty:${id}:${kind}:${ptyID ?? "undefined"}`)
        },
        commitPanelMode: (_s, id, mode) => {
          calls.push(`commitPanelMode:${id}:${mode}`)
        },
        commitSplitTerminal: (_s, id, open) => {
          calls.push(`commitSplitTerminal:${id}:${open}`)
        },
        spacePaths: () => ["/test-space"],
        pushDiagnostic: () => "diag-1",
      }

      const actions = createWorkbenchActions({
        store,
        pty: {
          disposePanel: async () => {},
          ensure: async () => "",
          disposePty: async () => {},
          clearMemory: () => {},
        },
        session: {
          create: async () => ({ id: "s1", title: "", directory: "/test", type: "chat" }),
          get: async () => ({ id: "s1", title: "", directory: "/test", type: "chat" }),
          project: () => {},
          rename: async () => {},
          remove: async () => {},
        },
      })

      actions.clearPtyEverywhere("target-pty-456")

      expect(calls[0]).toBe("commitPanelMode:p2:chat")
      expect(calls[1]).toBe("commitPanelPty:p2:tui:undefined")
    })
  })
})
