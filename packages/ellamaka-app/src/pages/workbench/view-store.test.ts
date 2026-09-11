import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { clonePersistedWorkbench, createWorkbenchStore, PERSISTED_DEFAULTS } from "./workbench-store"
import { initWorkbenchState } from "./view-store"

describe("view-store reactive guard", () => {
  test("queues persistence when a persisted store field changes", () => {
    const store = createWorkbenchStore()
    const [hydrated, setHydrated] = createSignal(false)
    let saves = 0
    const checkSave = () => {
      store.trackPersisted()
      if (hydrated()) saves += 1
    }

    checkSave()
    expect(saves).toBe(0)

    setHydrated(true)
    checkSave()
    expect(saves).toBe(1)
  })

  test("clonePersistedWorkbench creates a deep clone isolated from mutations", () => {
    const original = clonePersistedWorkbench(PERSISTED_DEFAULTS)
    const clone1 = clonePersistedWorkbench(original)
    const clone2 = clonePersistedWorkbench(original)

    // Each clone is a new object (not the same reference)
    expect(clone1).not.toBe(original)
    expect(clone2).not.toBe(clone1)

    // Mutating the original does not affect clones
    original.display.showTitlebar = false
    expect(clone1.display.showTitlebar).toBe(true)
    expect(clone2.display.showTitlebar).toBe(true)

    // Nested objects are also cloned (no shared references)
    original.spaces = {}
    expect(clone1.spaces).not.toBe(original.spaces)
  })

  test("snapshot reflects store mutations through the reactive proxy", () => {
    const store = createWorkbenchStore()
    store.hydrate(PERSISTED_DEFAULTS)

    const snap1 = store.snapshot()
    expect(snap1.display.showTitlebar).toBe(true)

    store.setDisplay("showTitlebar", false)
    const snap2 = store.snapshot()
    expect(snap2.display.showTitlebar).toBe(false)

    // snap1 is isolated — mutation does not retroactively affect it
    expect(snap1.display.showTitlebar).toBe(true)
  })

  test("snapshot reflects space panel additions through the reactive proxy", () => {
    const store = createWorkbenchStore()
    store.hydrate(PERSISTED_DEFAULTS)

    store.ensureSpace("/fixtures/space-a")
    const panelID = store.addPanel("/fixtures/space-a")

    const snap = store.snapshot()
    expect(snap.spaces["/fixtures/space-a"]).toBeDefined()
    expect(snap.spaces["/fixtures/space-a"].panels.length).toBe(2)
    expect(snap.spaces["/fixtures/space-a"].panels.some((panel) => panel.id === panelID)).toBe(true)
  })

  test("snapshot reflects tab mutations through the reactive proxy", () => {
    const store = createWorkbenchStore()
    store.hydrate(PERSISTED_DEFAULTS)

    store.openTab({ id: "space-x", name: "Space X", path: "/fixtures/space-x", type: "space" })
    const snap = store.snapshot()
    expect(snap.tabs.some((tab) => tab.name === "Space X")).toBe(true)
  })
})

describe("view-store diagnostics", () => {
  test("pushDiagnostic adds messages and legacy setStatusMessage pushes to diagnostics queue", () => {
    let state: any
    const dispose = createRoot((dis) => {
      state = initWorkbenchState()
      return dis
    })

    expect(state.diagnostics).toEqual([])

    const errId = state.pushDiagnostic("error", "Directory load failed", { autoDismiss: false })
    expect(state.diagnostics.length).toBe(1)
    expect(state.diagnostics[0].id).toBe(errId)
    expect(state.diagnostics[0].type).toBe("error")
    expect(state.diagnostics[0].text).toBe("Directory load failed")

    state.setStatusMessage("Refreshing space...")
    expect(state.diagnostics.length).toBe(2)
    expect(state.diagnostics.some((item: any) => item.text === "Refreshing space..." && item.type === "info")).toBe(
      true,
    )

    state.removeDiagnostic(errId)
    expect(state.diagnostics.length).toBe(1)
    expect(state.diagnostics[0].id).not.toBe(errId)

    state.clearAllDiagnostics()
    expect(state.diagnostics).toEqual([])

    dispose()
  })
})
