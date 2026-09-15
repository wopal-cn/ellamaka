import { batch } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { GENERAL_SPACE_NAME, normalizeSpacePath } from "./workbench-scope"
import { isDraftSessionId } from "@/utils/draft-session"

export type PanelMode = "" | "tui" | "chat"
export type PanelSlotState = "empty" | "bound"
export type PanelViewMode = string

export type WorkbenchPanel = {
  id: string
  slotState: PanelSlotState
  boundSessionId?: string
  viewMode?: PanelViewMode
  mode: PanelMode
  directory: string
  width: number
  splitTerminal?: boolean
  tuiPtyId?: string
  termPtyId?: string
  splitPtyId?: string
  splitHeight?: number
}

export type SpaceWorkbenchState = {
  panels: WorkbenchPanel[]
  activePanelID: string
}

export type WorkbenchDisplayState = {
  showTitlebar: boolean
  showStatusbar: boolean
  showSpaceRail: boolean
  showFileViewer: boolean
}

export type WopalSpace = {
  id: string
  name: string
  path: string
  type?: string
  pinned?: boolean
}

export type PersistedWorkbench = {
  schemaVersion?: number
  display: WorkbenchDisplayState
  spaces: Record<string, SpaceWorkbenchState>
  tabs: WopalSpace[]
  activeTabPath?: string
  /** Legacy v1 field. Read only during hydration; never written back. */
  activeSpaceName?: string
}

export type HydratableWorkbench = Omit<PersistedWorkbench, "spaces"> & {
  spaces: Record<string, {
    panels: Array<Omit<WorkbenchPanel, "slotState" | "viewMode"> & {
      slotState?: PanelSlotState
      viewMode?: PanelViewMode
    }>
    activePanelID: string
  }>
}

export type WorkbenchSessionBinding = {
  id: string
  directory: string
  type: PanelMode
}

export const GENERAL_TAB_NAME = GENERAL_SPACE_NAME
export const GENERAL_TAB_PATH = ""

export const DISPLAY_DEFAULTS: WorkbenchDisplayState = {
  showTitlebar: true,
  showStatusbar: true,
  showSpaceRail: true,
  showFileViewer: true,
}

export const PERSISTED_DEFAULTS: PersistedWorkbench = {
  schemaVersion: 2,
  display: { ...DISPLAY_DEFAULTS },
  spaces: {},
  tabs: [{ id: GENERAL_TAB_NAME, name: GENERAL_TAB_NAME, path: GENERAL_TAB_PATH, type: "general" }],
  activeTabPath: GENERAL_TAB_PATH,
}

let nextPanelSequence = 0

function uniquePanelID() {
  nextPanelSequence += 1
  return `p-${Date.now().toString(36)}-${nextPanelSequence}`
}

function defaultSpaceState(directory = "/"): SpaceWorkbenchState {
  const normDir = normalizeSpacePath(directory) || directory
  const firstID = uniquePanelID()
  return {
    panels: [{ id: firstID, slotState: "empty", mode: "", directory: normDir, width: 1 }],
    activePanelID: firstID,
  }
}

function hydratePanel(
  panel: Omit<WorkbenchPanel, "slotState" | "viewMode"> & { slotState?: PanelSlotState; viewMode?: PanelViewMode },
): WorkbenchPanel {
  const viewMode = panel.viewMode ?? (panel.tuiPtyId ? "tui" : undefined)
  const normDir = normalizeSpacePath(panel.directory) || panel.directory
  // Draft bindings are unpersisted by design. If one leaked into a snapshot
  // (e.g. the tab was closed before the app could persist), restore the
  // panel to a clean empty state: the synthetic session does not exist on
  // the server, so binding to it would wedge the panel on "restoring…".
  if (isDraftSessionId(panel.boundSessionId)) {
    return {
      id: panel.id,
      slotState: "empty",
      mode: "",
      directory: normDir,
      width: panel.width,
    }
  }
  return {
    ...panel,
    directory: normDir,
    slotState: panel.slotState ?? (panel.tuiPtyId ? "bound" : "empty"),
    ...(viewMode === undefined ? {} : { viewMode }),
  }
}

export function clonePersistedWorkbench(value: PersistedWorkbench): PersistedWorkbench
export function clonePersistedWorkbench(value: HydratableWorkbench): HydratableWorkbench
export function clonePersistedWorkbench(value: HydratableWorkbench): HydratableWorkbench {
  return {
    schemaVersion: value.schemaVersion,
    display: { ...DISPLAY_DEFAULTS, ...value.display },
    spaces: Object.fromEntries(
      Object.entries(value.spaces ?? {}).map(([spacePath, space]) => [
        normalizeSpacePath(spacePath),
        {
          ...space,
          panels: (space.panels ?? []).map((panel) => ({ ...panel })),
        },
      ]),
    ),
    tabs: (value.tabs ?? []).map((tab) => ({ ...tab, path: normalizeSpacePath(tab.path) })),
    ...(value.activeTabPath === undefined ? {} : { activeTabPath: normalizeSpacePath(value.activeTabPath) }),
    ...(value.activeSpaceName === undefined ? {} : { activeSpaceName: value.activeSpaceName }),
  }
}

function normalizePersistedWorkbench(value: HydratableWorkbench): PersistedWorkbench {
  const snapshot = clonePersistedWorkbench(value)
  // Backfill the stable space id for tabs persisted before `id` existed. The
  // General tab uses its name; other tabs fall back to their path. This does
  // not migrate the legacy `tab.name` (D-05) — it only fills the new id field.
  const backfillId = (tab: WopalSpace): WopalSpace => ({
    ...tab,
    id: tab.id ?? (tab.path === GENERAL_TAB_PATH ? GENERAL_TAB_NAME : tab.path),
  })
  const tabs = snapshot.tabs.some((tab) => tab.path === GENERAL_TAB_PATH)
    ? snapshot.tabs.map(backfillId)
    : [{ id: GENERAL_TAB_NAME, name: GENERAL_TAB_NAME, path: GENERAL_TAB_PATH, type: "general" }, ...snapshot.tabs.map(backfillId)]
  const requestedPath = snapshot.activeTabPath
  const legacyMatches = snapshot.activeSpaceName
    ? tabs.filter((tab) => tab.name === snapshot.activeSpaceName)
    : []
  const activeTabPath = requestedPath !== undefined && tabs.some((tab) => tab.path === requestedPath)
    ? requestedPath
    : legacyMatches.length === 1
      ? legacyMatches[0].path
      : GENERAL_TAB_PATH
  return {
    schemaVersion: 2,
    display: snapshot.display,
    spaces: Object.fromEntries(
      Object.entries(snapshot.spaces).map(([path, space]) => [
        normalizeSpacePath(path),
        {
          ...space,
          panels: space.panels.map(hydratePanel),
        },
      ]),
    ),
    tabs,
    activeTabPath,
  }
}

function isPanelMode(mode: PanelViewMode): mode is PanelMode {
  return mode === "" || mode === "tui" || mode === "chat"
}

export function createWorkbenchStore(initial: PersistedWorkbench = PERSISTED_DEFAULTS) {
  const [store, setStore] = createStore<PersistedWorkbench>(normalizePersistedWorkbench(initial))

  function migrateLegacyPanels(rawPath: string) {
    const path = normalizeSpacePath(rawPath)
    const space = store.spaces[path]
    if (!space?.panels.some((panel) => panel.slotState === undefined)) return
    setStore("spaces", path, "panels", (panels) =>
      panels.map((panel) => {
        if (panel.slotState !== undefined) return panel
        if (panel.tuiPtyId) return { ...panel, slotState: "bound", viewMode: "tui" }
        return { ...panel, slotState: "empty" }
      }),
    )
  }

  function hydrate(value: HydratableWorkbench) {
    const snapshot = normalizePersistedWorkbench(value)
    batch(() => {
      setStore("display", snapshot.display)
      setStore("spaces", snapshot.spaces)
      setStore("tabs", snapshot.tabs)
      setStore("activeTabPath", snapshot.activeTabPath ?? GENERAL_TAB_PATH)
      setStore("schemaVersion", 2)
    })
  }

  function snapshot() {
    return clonePersistedWorkbench(store)
  }

  function trackPersisted() {
    store.schemaVersion
    store.activeTabPath
    store.display.showTitlebar
    store.display.showStatusbar
    store.display.showSpaceRail
    store.display.showFileViewer
    for (const tab of store.tabs) {
      tab.name
      tab.path
      tab.type
      tab.pinned
    }
    for (const [path, space] of Object.entries(store.spaces)) {
      path
      space.activePanelID
      for (const panel of space.panels) {
        panel.id
        panel.slotState
        panel.boundSessionId
        panel.viewMode
        panel.mode
        panel.directory
        panel.width
        panel.splitTerminal
        panel.tuiPtyId
        panel.termPtyId
        panel.splitPtyId
        panel.splitHeight
      }
    }
  }

  function spaceState(rawPath: string): SpaceWorkbenchState | undefined {
    return store.spaces[normalizeSpacePath(rawPath)]
  }

  function ensureSpace(rawPath: string) {
    const path = normalizeSpacePath(rawPath)
    if (!store.spaces[path]) {
      setStore("spaces", path, defaultSpaceState(path))
      return
    }
    migrateLegacyPanels(path)
  }

  function addPanel(rawPath: string): string | undefined {
    const path = normalizeSpacePath(rawPath)
    ensureSpace(path)
    const space = store.spaces[path]
    if (!space || space.panels.length >= 3) return undefined
    const id = uniquePanelID()
    setStore("spaces", path, "panels", space.panels.length, {
      id,
      slotState: "empty",
      mode: "",
      viewMode: "chat",
      directory: path,
      width: 1,
    })
    return id
  }

  function removePanel(rawPath: string, id: string) {
    const path = normalizeSpacePath(rawPath)
    const space = store.spaces[path]
    if (!space || space.panels.length <= 1 || !space.panels.some((panel) => panel.id === id)) return false
    setStore(
      "spaces",
      path,
      produce((value) => {
        const index = value.panels.findIndex((panel) => panel.id === id)
        if (index === -1) return
        value.panels.splice(index, 1)
        if (value.activePanelID === id) value.activePanelID = value.panels[0]?.id ?? ""
        value.panels.forEach((panel) => {
          panel.width = 1
        })
      }),
    )
    return true
  }

  function setPanelMode(rawPath: string, id: string, mode: PanelMode) {
    const path = normalizeSpacePath(rawPath)
    ensureSpace(path)
    setStore("spaces", path, "panels", (panel) => panel.id === id, produce((panel) => {
      panel.mode = mode
      panel.viewMode = mode
    }))
  }

  function setPanelPtyId(rawPath: string, id: string, type: "tui" | "term" | "split", ptyID: string | undefined) {
    const path = normalizeSpacePath(rawPath)
    ensureSpace(path)
    setStore("spaces", path, "panels", (panel) => panel.id === id, produce((panel) => {
      if (type === "tui") panel.tuiPtyId = ptyID
      else if (type === "term") panel.termPtyId = ptyID
      else panel.splitPtyId = ptyID
    }))
  }

  function setPanelSplitTerminal(rawPath: string, id: string, open: boolean) {
    const path = normalizeSpacePath(rawPath)
    ensureSpace(path)
    setStore("spaces", path, "panels", (panel) => panel.id === id, "splitTerminal", open)
  }

  function setActivePanel(rawPath: string, id: string) {
    const path = normalizeSpacePath(rawPath)
    ensureSpace(path)
    if (!store.spaces[path]?.panels.some((panel) => panel.id === id)) return
    setStore("spaces", path, "activePanelID", id)
  }

  function setPanelDirectory(rawPath: string, id: string, directory: string) {
    const path = normalizeSpacePath(rawPath)
    ensureSpace(path)
    const normDir = normalizeSpacePath(directory) || directory
    setStore("spaces", path, "panels", (panel) => panel.id === id, "directory", normDir)
  }

  function setDisplay<K extends keyof WorkbenchDisplayState>(key: K, value: WorkbenchDisplayState[K]) {
    setStore("display", key, value)
  }

  function setPanelWidth(rawPath: string, id: string, width: number) {
    const path = normalizeSpacePath(rawPath)
    ensureSpace(path)
    setStore("spaces", path, "panels", (panel) => panel.id === id, "width", width)
  }

  function setPanelSplitHeight(rawPath: string, id: string, height: number) {
    const path = normalizeSpacePath(rawPath)
    ensureSpace(path)
    setStore("spaces", path, "panels", (panel) => panel.id === id, "splitHeight", height)
  }

  function resetPanelWidths(rawPath: string) {
    const path = normalizeSpacePath(rawPath)
    ensureSpace(path)
    setStore("spaces", path, "panels", () => true, "width", 1)
  }

  function pinTab(rawPath: string) {
    const path = normalizeSpacePath(rawPath)
    if (path === GENERAL_TAB_PATH) return
    const index = store.tabs.findIndex((tab) => tab.path === path)
    if (index !== -1) {
      setStore("tabs", index, "pinned", true)
    }
  }

  function unpinTab(rawPath: string) {
    const path = normalizeSpacePath(rawPath)
    if (path === GENERAL_TAB_PATH) return
    const index = store.tabs.findIndex((tab) => tab.path === path)
    if (index !== -1) {
      setStore("tabs", index, "pinned", false)
    }
  }

  function closeTab(rawPath: string) {
    const path = normalizeSpacePath(rawPath)
    if (path === GENERAL_TAB_PATH) return false
    const index = store.tabs.findIndex((tab) => tab.path === path)
    if (index === -1) return false
    if (store.tabs[index].pinned) return false
    batch(() => {
      setStore("tabs", (tabs) => tabs.filter((tab) => tab.path !== path))
      if (store.activeTabPath === path) {
        const next = store.tabs[index + 1] ?? store.tabs[index - 1]
        setStore("activeTabPath", next?.path ?? GENERAL_TAB_PATH)
      }
    })
    return true
  }

  function closeOtherTabs(rawPath: string) {
    const path = normalizeSpacePath(rawPath)
    batch(() => {
      setStore("tabs", (tabs) => tabs.filter((tab) => tab.path === GENERAL_TAB_PATH || tab.pinned || tab.path === path))
      if (!store.tabs.some((tab) => tab.path === store.activeTabPath)) {
        setStore("activeTabPath", path)
      }
    })
  }

  function closeRightTabs(rawPath: string) {
    const path = normalizeSpacePath(rawPath)
    const index = store.tabs.findIndex((tab) => tab.path === path)
    if (index === -1) return
    batch(() => {
      setStore("tabs", (tabs) => tabs.filter((tab, i) => i <= index || tab.path === GENERAL_TAB_PATH || tab.pinned))
      if (!store.tabs.some((tab) => tab.path === store.activeTabPath)) {
        setStore("activeTabPath", path)
      }
    })
  }

  function removeSpace(rawPath: string) {
    const path = normalizeSpacePath(rawPath)
    if (!store.spaces[path] && !store.tabs.some((t) => t.path === path)) return false
    const tab = store.tabs.find((candidate) => candidate.path === path)
    batch(() => {
      if (tab) closeTab(tab.path)
      if (store.spaces[path]) {
        setStore("spaces", produce((spaces) => {
          delete spaces[path]
        }))
      }
    })
    return true
  }

  function bindSessionToPanel(rawPath: string, panelID: string, session: WorkbenchSessionBinding) {
    const path = normalizeSpacePath(rawPath)
    ensureSpace(path)
    const normDir = normalizeSpacePath(session.directory) || session.directory || path
    setStore("spaces", path, "panels", (panel) => panel.id === panelID, produce((panel) => {
      panel.slotState = "bound"
      panel.boundSessionId = session.id
      panel.viewMode = session.type
      panel.mode = session.type
      panel.directory = normDir
    }))
  }

  function unbindSessionFromPanel(rawPath: string, panelID: string) {
    const path = normalizeSpacePath(rawPath)
    const panel = store.spaces[path]?.panels.find((candidate) => candidate.id === panelID)
    if (!panel || (panel.slotState === "empty" && !panel.boundSessionId)) return false
    setStore("spaces", path, "panels", (candidate) => candidate.id === panelID, produce((value) => {
      value.slotState = "empty"
      value.boundSessionId = undefined
      value.tuiPtyId = undefined
      value.termPtyId = undefined
      value.splitPtyId = undefined
      value.splitTerminal = false
    }))
    return true
  }

  function unbindSessionGlobal(sessionID: string) {
    let changed = false
    batch(() => {
      for (const [path, space] of Object.entries(store.spaces)) {
        for (const panel of space.panels) {
          if (panel.boundSessionId !== sessionID) continue
          changed = unbindSessionFromPanel(path, panel.id) || changed
        }
      }
    })
    return changed
  }

  function setPanelSlotState(rawPath: string, panelID: string, state: PanelSlotState) {
    const path = normalizeSpacePath(rawPath)
    ensureSpace(path)
    setStore("spaces", path, "panels", (panel) => panel.id === panelID, "slotState", state)
  }

  function setPanelViewMode(rawPath: string, panelID: string, mode: PanelViewMode) {
    const path = normalizeSpacePath(rawPath)
    ensureSpace(path)
    setStore("spaces", path, "panels", (panel) => panel.id === panelID, produce((panel) => {
      panel.viewMode = mode
      if (isPanelMode(mode)) panel.mode = mode
    }))
  }

  function isSessionBound(sessionID: string) {
    return findSessionBinding(sessionID) !== undefined
  }

  function boundPanelIdForSession(sessionID: string): string | undefined {
    return findSessionBinding(sessionID)?.panelID
  }

  // Canonical, structured binding lookup shared by the deep-link coordinator
  // and the Session Tree. Returns the owning Space path and Panel ID so callers
  // never re-scan `spaces` and lose which Space a binding belongs to.
  function findSessionBinding(sessionID: string): { spacePath: string; panelID: string } | undefined {
    for (const [spacePath, space] of Object.entries(store.spaces)) {
      if (!store.tabs.some((tab) => tab.path === spacePath)) continue
      const panel = space.panels.find(
        (candidate) => candidate.boundSessionId === sessionID && candidate.slotState === "bound",
      )
      if (panel) return { spacePath, panelID: panel.id }
    }
    return undefined
  }

  function activeTab() {
    return store.tabs.find((tab) => tab.path === store.activeTabPath)
  }

  function openTab(space: WopalSpace) {
    const normPath = normalizeSpacePath(space.path)
    const normSpace = { ...space, path: normPath }
    batch(() => {
      if (!store.tabs.some((tab) => tab.path === normPath)) {
        setStore("tabs", store.tabs.length, normSpace)
      }
      setStore("activeTabPath", normPath)
    })
  }

  function setActive(rawPath: string) {
    const path = normalizeSpacePath(rawPath)
    if (store.tabs.some((tab) => tab.path === path)) setStore("activeTabPath", path)
  }

  function validateTabs(validPaths: Set<string>) {
    const normalizedValid = new Set(Array.from(validPaths).map(normalizeSpacePath))
    batch(() => {
      setStore("tabs", (tabs) => {
        const filtered = tabs.filter((tab) => tab.path === GENERAL_TAB_PATH || normalizedValid.has(tab.path))
        return filtered.length === tabs.length ? tabs : filtered
      })
      const current = store.activeTabPath
      if (!store.tabs.some((tab) => tab.path === current)) {
        setStore("activeTabPath", store.tabs[0]?.path ?? GENERAL_TAB_PATH)
      }
    })
  }

  return {
    hydrate,
    snapshot,
    trackPersisted,
    get display() { return store.display },
    get spaces() { return store.spaces },
    spaceState,
    ensureSpace,
    addPanel,
    removePanel,
    setPanelMode,
    setPanelPtyId,
    setPanelSplitTerminal,
    setActivePanel,
    setPanelDirectory,
    setDisplay,
    removeSpace,
    setPanelWidth,
    setPanelSplitHeight,
    resetPanelWidths,
    bindSessionToPanel,
    unbindSessionFromPanel,
    unbindSessionGlobal,
    setPanelSlotState,
    setPanelViewMode,
    isSessionBound,
    boundPanelIdForSession,
    findSessionBinding,
    get tabs() { return store.tabs },
    activeTab,
    get activeDirectory() {
      const tab = activeTab()
      const space = tab ? store.spaces[tab.path] : undefined
      return space?.panels.find((panel) => panel.id === space.activePanelID)?.directory ?? ""
    },
    get activeTabPath() { return store.activeTabPath ?? GENERAL_TAB_PATH },
    get activeSpaceName() { return activeTab()?.name ?? GENERAL_TAB_NAME },
    openTab,
    closeTab,
    closeOtherTabs,
    closeRightTabs,
    pinTab,
    unpinTab,
    setActive,
    validateTabs,
  }
}
