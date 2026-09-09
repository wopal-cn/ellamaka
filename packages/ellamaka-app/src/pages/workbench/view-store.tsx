import { createSimpleContext } from "@wopal/ui/context"
import { makePersisted } from "@solid-primitives/storage"
import { batch, createEffect, createRenderEffect, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import {
  clonePersistedWorkbench,
  createWorkbenchStore,
  GENERAL_TAB_PATH,
  PERSISTED_DEFAULTS,
  type PersistedWorkbench,
  type WorkbenchSessionBinding,
} from "./workbench-store"
import { scopeFromTab, type SpaceScope } from "./workbench-scope"
import { selectActiveWorkbenchContext } from "./active-workbench-context"
import type { BoundWorkbenchPanel } from "./workbench-actions"

export {
  DISPLAY_DEFAULTS,
  GENERAL_TAB_NAME,
  GENERAL_TAB_PATH,
  type PanelMode,
  type PanelSlotState,
  type PanelViewMode,
  type SpaceWorkbenchState,
  type WorkbenchDisplayState,
  type WorkbenchPanel,
  type WopalSpace,
} from "./workbench-store"

export type DiagnosticMessageType = "info" | "warning" | "error"

export interface DiagnosticMessage {
  id: string
  type: DiagnosticMessageType
  text: string
  timestamp: number
  source?: string
  autoDismiss?: boolean
  onRetry?: () => boolean | Promise<boolean>
  onDismiss?: () => void
}

const STATUS_MESSAGE_DURATION = 5_000

export function watchWorkbenchPersistence(
  workbench: ReturnType<typeof createWorkbenchStore>,
  hydrated: () => boolean,
  queueSave: () => void,
) {
  createEffect(() => {
    workbench.trackPersisted()
    if (hydrated()) queueSave()
  })
}

export function initWorkbenchState() {
  const workbench = createWorkbenchStore()
  const [hydrated, setHydrated] = createSignal(false)

  const [persisted, setPersisted] = makePersisted(
      createStore<PersistedWorkbench>(clonePersistedWorkbench(PERSISTED_DEFAULTS)),
      {
        name: "workbench",
        storage: typeof window !== "undefined" ? window.localStorage : undefined,
      },
    )

    onMount(() => {
      workbench.hydrate(persisted)
      setHydrated(true)
    })

    let saveTimer: ReturnType<typeof setTimeout> | undefined
    let dirty = false

    const syncToPersisted = () => {
      if (!dirty) return
      dirty = false
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = undefined
      const snapshot = workbench.snapshot()
      batch(() => {
        setPersisted("display", snapshot.display)
        setPersisted("spaces", snapshot.spaces)
        setPersisted("tabs", snapshot.tabs)
        setPersisted("schemaVersion", 2)
        setPersisted("activeTabPath", snapshot.activeTabPath)
      })
    }

    const queueSave = () => {
      dirty = true
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(syncToPersisted, 150)
    }

    watchWorkbenchPersistence(workbench, hydrated, queueSave)

    onMount(() => {
      const handleVisibility = () => {
        if (document.visibilityState === "hidden") syncToPersisted()
      }
      const handlePageHide = () => syncToPersisted()
      window.addEventListener("visibilitychange", handleVisibility)
      window.addEventListener("pagehide", handlePageHide)
      onCleanup(() => {
        window.removeEventListener("visibilitychange", handleVisibility)
        window.removeEventListener("pagehide", handlePageHide)
        if (saveTimer) clearTimeout(saveTimer)
      })
    })

    const [refreshVersion, setRefreshVersion] = createSignal(0)
    const [persistentHint, setPersistentHintValue] = createSignal("")
    const [statusMessage, setStatusMessageValue] = createSignal("")
    // DSH availability mirrors the server-side `ELLAMAKA_DSH` kill switch as
    // reported by /global/health (`dsh` field). Undefined until the first
    // health probe resolves.
    const [dshEnabled, setDshEnabled] = createSignal<boolean | undefined>(undefined)
    let persistentHintTimer: ReturnType<typeof setTimeout> | undefined
    let statusMessageTimer: ReturnType<typeof setTimeout> | undefined

    const [diagnosticsList, setDiagnosticsList] = createSignal<DiagnosticMessage[]>([])
    const diagnosticTimers = new Map<string, ReturnType<typeof setTimeout>>()

    const removeDiagnostic = (id: string) => {
      const timer = diagnosticTimers.get(id)
      if (timer) {
        clearTimeout(timer)
        diagnosticTimers.delete(id)
      }
      setDiagnosticsList((prev) => prev.filter((item) => item.id !== id))
    }

    const clearAllDiagnostics = () => {
      for (const timer of diagnosticTimers.values()) {
        clearTimeout(timer)
      }
      diagnosticTimers.clear()
      setDiagnosticsList([])
    }

    const pushDiagnostic = (
      type: DiagnosticMessageType,
      text: string,
      options?: { id?: string; source?: string; autoDismiss?: boolean; onRetry?: () => boolean | Promise<boolean>; onDismiss?: () => void },
    ): string => {
      const id = options?.id ?? `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      const autoDismiss = options?.autoDismiss ?? (type === "info")

      const existingTimer = diagnosticTimers.get(id)
      if (existingTimer) {
        clearTimeout(existingTimer)
        diagnosticTimers.delete(id)
      }

      setDiagnosticsList((prev) => {
        const filtered = prev.filter((item) => item.id !== id)
        return [
          ...filtered,
          {
            id,
            type,
            text,
            timestamp: Date.now(),
            source: options?.source,
            autoDismiss,
            onRetry: options?.onRetry,
            onDismiss: options?.onDismiss,
          },
        ]
      })

      if (autoDismiss) {
        const timer = setTimeout(() => {
          removeDiagnostic(id)
        }, STATUS_MESSAGE_DURATION)
        diagnosticTimers.set(id, timer)
      }

      return id
    }

    const timedMessage = (
      message: string,
      timer: ReturnType<typeof setTimeout> | undefined,
      setTimer: (value: ReturnType<typeof setTimeout> | undefined) => void,
      setValue: (value: string) => void,
      diagId: string,
    ) => {
      if (timer) clearTimeout(timer)
      setTimer(undefined)
      setValue(message)
      if (!message) {
        removeDiagnostic(diagId)
        return
      }
      pushDiagnostic("info", message, { id: diagId, autoDismiss: true })
    }

    const setPersistentHint = (message: string) => {
      timedMessage(message, persistentHintTimer, (value) => { persistentHintTimer = value }, setPersistentHintValue, "legacy-persistent-hint")
    }
    const setStatusMessage = (message: string) => {
      timedMessage(message, statusMessageTimer, (value) => { statusMessageTimer = value }, setStatusMessageValue, "legacy-status-message")
    }

    onCleanup(() => {
      for (const timer of diagnosticTimers.values()) {
        clearTimeout(timer)
      }
      diagnosticTimers.clear()
      if (persistentHintTimer) clearTimeout(persistentHintTimer)
      if (statusMessageTimer) clearTimeout(statusMessageTimer)
    })

    const bindSessionToPanel = (path: string, panelID: string, session: WorkbenchSessionBinding) =>
      workbench.bindSessionToPanel(path, panelID, session)

    // Task 1 (O4): StorePort methods — wb directly satisfies WorkbenchActionStorePort
    // so createWorkbenchActions can receive the store without an adapter layer.
    // boundPanels reuses the canonical findSessionBinding selector so the deep
    // link and Session Tree share one binding lookup (D-03).
    const boundPanels = (sessionID: string): BoundWorkbenchPanel[] => {
      const binding = workbench.findSessionBinding(sessionID)
      if (!binding) return []
      const tab = workbench.tabs.find((candidate) => candidate.path === binding.spacePath)
      const scope: SpaceScope = tab
        ? scopeFromTab(tab)
        : binding.spacePath
          ? { kind: "space", name: binding.spacePath, path: binding.spacePath }
          : { kind: "general" }
      const panel = workbench.spaceState(binding.spacePath)?.panels.find((p) => p.id === binding.panelID)
      if (!panel) return []
      return [{ scope, panelID: binding.panelID, panel }]
    }

    const active = () => {
      const ctx = selectActiveWorkbenchContext({
        spaces: workbench.spaces,
        tabs: workbench.tabs,
        activeTabPath: workbench.activeTabPath,
      })
      return ctx ? { scope: ctx.scope, panelID: ctx.panel.id } : undefined
    }

    const state = {
      ready: hydrated,
      display: () => workbench.display,
      get spaces() { return workbench.spaces },
      spaceState: workbench.spaceState,
      ensureSpace: workbench.ensureSpace,
      addPanel: workbench.addPanel,
      removePanel: workbench.removePanel,
      setPanelMode: workbench.setPanelMode,
      setPanelPtyId: workbench.setPanelPtyId,
      setPanelSplitTerminal: workbench.setPanelSplitTerminal,
      setActivePanel: workbench.setActivePanel,
      setPanelDirectory: workbench.setPanelDirectory,
      setDisplay: workbench.setDisplay,
      removeSpace: workbench.removeSpace,
      setPanelWidth: workbench.setPanelWidth,
      setPanelSplitHeight: workbench.setPanelSplitHeight,
      resetPanelWidths: workbench.resetPanelWidths,
      bindSessionToPanel,
      unbindSessionFromPanel: workbench.unbindSessionFromPanel,
      unbindSessionGlobal: workbench.unbindSessionGlobal,
      setPanelSlotState: workbench.setPanelSlotState,
      setPanelViewMode: workbench.setPanelViewMode,
      isSessionBound: workbench.isSessionBound,
      boundPanelIdForSession: workbench.boundPanelIdForSession,
      findSessionBinding: workbench.findSessionBinding,
      boundPanels,
      active,
      get tabs() { return workbench.tabs },
      activeTab: workbench.activeTab,
      get activeDirectory() { return workbench.activeDirectory },
      get activeTabPath() { return workbench.activeTabPath },
      get activeSpaceName() { return workbench.activeSpaceName },
      openTab: workbench.openTab,
      closeTab: workbench.closeTab,
      closeOtherTabs: workbench.closeOtherTabs,
      closeRightTabs: workbench.closeRightTabs,
      pinTab: workbench.pinTab,
      unpinTab: workbench.unpinTab,
      setActive: workbench.setActive,
      validateTabs: workbench.validateTabs,
      get statusMessage() { return statusMessage() },
      setStatusMessage,
      get persistentHint() { return persistentHint() },
      setPersistentHint,
      get dshEnabled() { return dshEnabled() },
      setDshEnabled,
      // DSH replaces the Assistant (general) tab content when enabled. Derived
      // from the active tab path so the tab highlight, click semantics, and
      // persistence (activeTabPath is persisted) stay truthful — no separate
      // visibility signal to desynchronize (DESIGN-dsh-poc §10).
      get dshVisible() {
        if (!dshEnabled()) return false
        return (workbench.activeTabPath ?? GENERAL_TAB_PATH) === GENERAL_TAB_PATH
      },
      get diagnostics() { return diagnosticsList() },
      pushDiagnostic,
      removeDiagnostic,
      clearAllDiagnostics,
      get refreshVersion() { return refreshVersion() },
      triggerRefresh: () => setRefreshVersion((version) => version + 1),
    }

    if (typeof window !== "undefined") {
      (window as any).__workbenchState = state
    }

    return state
}

const WorkbenchStateContext = createSimpleContext({
  name: "WorkbenchState",
  init: initWorkbenchState,
})

export const useWorkbenchState = () => WorkbenchStateContext.use()
export const WorkbenchStateProvider = WorkbenchStateContext.provider
