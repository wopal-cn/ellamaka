import { batch, createSignal } from "solid-js"
import { scopeKey, scopePath, type SpaceScope } from "./workbench-scope"
import type { WorkbenchPanel } from "./workbench-store"

export type WorkbenchActionPtyKind = "tui" | "term" | "split"
export type WorkbenchPtyProbeResult = "alive" | "dead" | "unknown"

// Task 2 (O5): WorkbenchActionPanel is now a type alias for the canonical
// WorkbenchPanel. The previous standalone type was a field subset duplicate.
export type WorkbenchActionPanel = WorkbenchPanel

// Task 2 (O5): WorkbenchActionSession is the server API session DTO shape.
// It is intentionally distinct from the local Session projection type
// (session-store.tsx) because the server response carries `directory` and
// `parentID` while the local projection stores `spaceName`/`projectPath`.
// The two types overlap on id/title/type/directoryHealth/timestamps but
// serve different layers — a simple alias would force false equivalence.
export type WorkbenchActionSession = {
  id: string
  parentID?: string
  title: string
  directory: string
  type: "tui" | "chat"
  directoryHealth?: "healthy" | "missing" | "unavailable"
  createdAt?: number
  lastActiveAt?: number
  timeArchived?: number
}

export type WorkbenchPanelAction = {
  id: string
  disabled?: () => boolean
  execute: () => void
}

export type ActiveWorkbenchTarget = {
  scope: SpaceScope
  panelID: string
}

export type BoundWorkbenchPanel = ActiveWorkbenchTarget & {
  panel: WorkbenchActionPanel
}

export type WorkbenchActionStorePort = {
  panel: (scope: SpaceScope, panelID: string) => WorkbenchActionPanel | undefined
  panels: (scope: SpaceScope) => readonly WorkbenchActionPanel[]
  boundPanels: (sessionID: string) => readonly BoundWorkbenchPanel[]
  active: () => ActiveWorkbenchTarget | undefined
  addPanel: (scope: SpaceScope) => string | undefined
  setActivePanel: (scope: SpaceScope, panelID: string) => void
  setActive: (spacePath: string) => void
  activePanelID: (scope: SpaceScope) => string | undefined
  removePanel: (scope: SpaceScope, panelID: string) => boolean
  removeSpace: (scope: SpaceScope) => boolean
  commitSessionBinding: (scope: SpaceScope, panelID: string, session: WorkbenchActionSession) => void
  commitSessionUnbinding: (scope: SpaceScope, panelID: string) => boolean
  commitPanelPty: (scope: SpaceScope, panelID: string, kind: WorkbenchActionPtyKind, ptyID?: string) => void
  commitPanelMode?: (scope: SpaceScope, panelID: string, mode: string) => void
  commitSplitTerminal?: (scope: SpaceScope, panelID: string, open: boolean) => void
  spacePaths: () => string[]
  pushDiagnostic?: (type: "info" | "warning" | "error", text: string, options?: { id?: string; autoDismiss?: boolean }) => string
}

export type WorkbenchActionPtyPort = {
  disposePanel: (input: { scope: SpaceScope; panel: WorkbenchActionPanel }) => Promise<void>
  ensure: (input: {
    scope: SpaceScope
    panel: WorkbenchActionPanel
    kind: WorkbenchActionPtyKind
    directory: string
    create: () => Promise<string>
  }) => Promise<string>
  disposePty: (input: {
    scope: SpaceScope
    panelID: string
    kind: WorkbenchActionPtyKind
    knownPtyID: string
  }) => Promise<void>
  probe?: (input: { directory: string; ptyID: string }) => Promise<WorkbenchPtyProbeResult>
  forgetPty?: (input: { scope: SpaceScope; panelID: string; kind: WorkbenchActionPtyKind }) => void
  clearMemory?: () => void
}

export type WorkbenchActionSessionPort = {
  create: (input: { scope: SpaceScope; panel: WorkbenchActionPanel; initialView?: "chat" | "tui" }) => Promise<WorkbenchActionSession>
  get: (input: { scope: SpaceScope; sessionID: string; directory: string }) => Promise<WorkbenchActionSession>
  project: (input: { scope: SpaceScope; session: WorkbenchActionSession }) => void
  rename: (input: { scope: SpaceScope; sessionID: string; directory: string; title: string }) => Promise<void>
  remove: (input: { scope: SpaceScope; session: WorkbenchActionSession }) => Promise<void>
}

export type WorkbenchActionResult = {
  status: "committed" | "unchanged" | "stale" | "offline"
  panelID: string
  ptyID?: string
  unavailableReason?: "archived" | "child"
}

export type WorkbenchActionStatus = Pick<WorkbenchActionResult, "status">

export type WorkbenchRuntimePort = {
  canWrite: () => boolean
}

// Deep-link reveal result. The single transaction outcome returned by
// revealSession — it is the only entry point that mutates Tab/Panel/
// Projection/PTY state for a notification deep link.
export type RevealSessionStatus =
  | "activated" // already bound; target Tab opened and Panel activated
  | "loaded" // unbound; loaded into an empty or newly added Panel
  | "replacement_required" // all Panels bound; caller must confirm overwrite
  | "unavailable" // archived / child session — not loadable
  | "stale" // superseded by a newer request

export type RevealSessionResult = {
  status: RevealSessionStatus
  panelID?: string
  scopePath?: string
  reason?: "archived" | "child"
}

export type RevealSessionInput = {
  scope: SpaceScope
  sessionID: string
  directory: string
  displayMode?: "chat" | "tui"
  forceReplace?: boolean
}

const ptyID = (panel: WorkbenchActionPanel, kind: WorkbenchActionPtyKind) => {
  if (kind === "tui") return panel.tuiPtyId
  if (kind === "term") return panel.termPtyId
  return panel.splitPtyId
}

function snapshotPanel(panel: WorkbenchActionPanel): WorkbenchActionPanel {
  return {
    id: panel.id,
    mode: panel.mode,
    directory: panel.directory,
    slotState: panel.slotState,
    boundSessionId: panel.boundSessionId,
    width: panel.width,
    viewMode: panel.viewMode,
    tuiPtyId: panel.tuiPtyId,
    termPtyId: panel.termPtyId,
    splitPtyId: panel.splitPtyId,
    splitTerminal: panel.splitTerminal,
    splitHeight: panel.splitHeight,
  }
}

export function createWorkbenchActions(input: {
  store: WorkbenchActionStorePort
  pty: WorkbenchActionPtyPort
  session: WorkbenchActionSessionPort
  runtime?: WorkbenchRuntimePort
}) {
  const runtime = input.runtime ?? { canWrite: () => true }
  const generations = new Map<string, number>()
  const panelActions = new Map<string, Map<string, WorkbenchPanelAction>>()
  // panelActions is a plain Map, so mutations are invisible to SolidJS
  // reactivity. panelActionsRevision is bumped on every register/unregister;
  // canExecuteActivePanelAction reads it inside reactive contexts (e.g. the
  // command catalog memo) so dependents re-run when panel action availability
  // changes.
  const [panelActionsRevision, bumpPanelActionsRevision] = createSignal(0)
  const disposingPanels = new Map<string, number>()
  const panelKey = (scope: SpaceScope, panelID: string) => `${scopeKey(scope)}\n${panelID}`
  const nextGeneration = (scope: SpaceScope, panelID: string) => {
    const key = panelKey(scope, panelID)
    const generation = (generations.get(key) ?? 0) + 1
    generations.set(key, generation)
    return generation
  }
  const isCurrent = (scope: SpaceScope, panelID: string, generation: number) =>
    generations.get(panelKey(scope, panelID)) === generation

  const disposePanel = async (scope: SpaceScope, panel: WorkbenchActionPanel) => {
    const key = panelKey(scope, panel.id)
    disposingPanels.set(key, (disposingPanels.get(key) ?? 0) + 1)
    try {
      await input.pty.disposePanel({ scope, panel })
    } finally {
      const remaining = (disposingPanels.get(key) ?? 1) - 1
      if (remaining === 0) disposingPanels.delete(key)
      else disposingPanels.set(key, remaining)
    }
  }

  const panelOrThrow = (scope: SpaceScope, panelID: string) => {
    const panel = input.store.panel(scope, panelID)
    if (!panel) throw new Error(`Workbench panel not found: ${panelID}`)
    return panel
  }

  const unbindPanel = async (scope: SpaceScope, panelID: string): Promise<WorkbenchActionResult> => {
    const panel = input.store.panel(scope, panelID)
    if (!panel || (panel.slotState === "empty" && !panel.boundSessionId)) {
      return { status: "unchanged", panelID }
    }
    // Capture snapshot BEFORE synchronous store resets so PTY IDs are not lost to reactivity
    const panelSnap = snapshotPanel(panel)

    // Flip viewMode to chat and clear all PTY ids synchronously BEFORE awaiting
    // backend disposal. Otherwise the view-registry createEffect re-enters
    // while the backend PTY is gone but the store id is still set, spawning a
    // new PTY (and resurrecting the blue dot / ellamaka process).
    input.store.commitPanelMode?.(scope, panelID, "chat")
    input.store.commitPanelPty(scope, panelID, "tui", undefined)
    input.store.commitPanelPty(scope, panelID, "term", undefined)
    input.store.commitPanelPty(scope, panelID, "split", undefined)
    input.store.commitSplitTerminal?.(scope, panelID, false)
    const generation = nextGeneration(scope, panelID)
    await disposePanel(scope, panelSnap)
    if (!isCurrent(scope, panelID, generation)) return { status: "stale", panelID }
    input.store.commitSessionUnbinding(scope, panelID)
    return { status: "committed", panelID }
  }

  return {
    activeTarget: input.store.active,
    addPanel(scope: SpaceScope) {
      return input.store.addPanel(scope)
    },
    registerPanelAction(scope: SpaceScope, panelID: string, action: WorkbenchPanelAction) {
      batch(() => {
        const key = panelKey(scope, panelID)
        const actions = panelActions.get(key)
        if (actions) actions.set(action.id, action)
        else panelActions.set(key, new Map([[action.id, action]]))
        bumpPanelActionsRevision((n) => n + 1)
      })
    },
    unregisterPanelAction(scope: SpaceScope, panelID: string, actionID: string) {
      batch(() => {
        const key = panelKey(scope, panelID)
        const actions = panelActions.get(key)
        if (!actions) return
        actions.delete(actionID)
        if (actions.size === 0) panelActions.delete(key)
        bumpPanelActionsRevision((n) => n + 1)
      })
    },
    canExecuteActivePanelAction(actionID: string) {
      // Read the revision so this function tracks panel action mutations in
      // SolidJS reactive contexts (e.g. the command catalog memo that feeds
      // the slash-command popover).
      panelActionsRevision()
      const active = input.store.active()
      if (!active) return false
      const action = panelActions.get(panelKey(active.scope, active.panelID))?.get(actionID)
      if (!action) return false
      return action.disabled ? !action.disabled() : true
    },
    executeActivePanelAction(actionID: string) {
      const active = input.store.active()
      if (!active) return
      const action = panelActions.get(panelKey(active.scope, active.panelID))?.get(actionID)
      if (action && !action.disabled?.()) action.execute()
    },
    cancelPanel(scope: SpaceScope, panelID: string) {
      nextGeneration(scope, panelID)
    },
    clearPtyMemory() {
      input.pty.clearMemory?.()
    },
    fallbackToChat(options: { scope: SpaceScope; panelID: string }): WorkbenchActionResult {
      const panel = input.store.panel(options.scope, options.panelID)
      if (!panel) return { status: "stale", panelID: options.panelID }
      input.store.commitPanelPty(options.scope, options.panelID, "tui", undefined)
      input.store.commitPanelMode?.(options.scope, options.panelID, "chat")
      return { status: "committed", panelID: options.panelID }
    },
    async exitTui(options: {
      scope: SpaceScope
      panelID: string
      ptyID: string
    }): Promise<WorkbenchActionResult> {
      // TUI process exited normally (WS code 1000). The backend's proc.onExit
      // handler already called remove(id) on its side, so we do NOT issue a
      // DELETE here — that would race with the backend cleanup and surface a
      // 404 PtyNotFoundError in the browser console. We only clear local
      // state: flip viewMode to chat first (so the view-registry createEffect
      // guard returns early and does not spawn a new PTY), then clear the
      // store's tuiPtyId (removes the blue dot) and drop the in-memory
      // ptyManager entry. The session binding is kept so the user sees the
      // conversation they just left.
      const panel = input.store.panel(options.scope, options.panelID)
      if (!panel) return { status: "stale", panelID: options.panelID }
      input.store.commitPanelMode?.(options.scope, options.panelID, "chat")
      input.store.commitPanelPty(options.scope, options.panelID, "tui", undefined)
      input.pty.forgetPty?.({ scope: options.scope, panelID: options.panelID, kind: "tui" })
      return { status: "committed", panelID: options.panelID }
    },
    async createSession(options: {
      scope: SpaceScope
      panelID: string
      initialView?: "chat" | "tui"
    }): Promise<WorkbenchActionResult> {
      if (!runtime.canWrite()) return { status: "offline", panelID: options.panelID }
      const panel = panelOrThrow(options.scope, options.panelID)
      const generation = nextGeneration(options.scope, options.panelID)
      const panelSnap = snapshotPanel(panel)
      const session = await input.session.create({ scope: options.scope, panel, initialView: options.initialView })
      if (!isCurrent(options.scope, options.panelID, generation)) {
        await input.session.remove({ scope: options.scope, session })
        return { status: "stale", panelID: options.panelID }
      }
      try {
        await disposePanel(options.scope, panelSnap)
        if (!isCurrent(options.scope, options.panelID, generation)) {
          await input.session.remove({ scope: options.scope, session })
          return { status: "stale", panelID: options.panelID }
        }
        input.session.project({ scope: options.scope, session })
        input.store.commitSessionBinding(options.scope, options.panelID, session)
        input.store.setActivePanel(options.scope, options.panelID)
      } catch (error) {
        await input.session.remove({ scope: options.scope, session })
        throw error
      }
      return { status: "committed", panelID: options.panelID }
    },
    async closePanel(options: {
      scope: SpaceScope
      panelID: string
    }): Promise<WorkbenchActionResult> {
      if (!runtime.canWrite()) return { status: "offline", panelID: options.panelID }
      const panel = input.store.panel(options.scope, options.panelID)
      if (!panel) return { status: "unchanged", panelID: options.panelID }
      if (input.store.panels(options.scope).length <= 1) {
        return unbindPanel(options.scope, options.panelID)
      }
      // Capture snapshot BEFORE synchronous store resets so PTY IDs are not lost to reactivity
      const panelSnap = snapshotPanel(panel)

      // Flip viewMode to chat and clear all PTY ids synchronously BEFORE awaiting
      // backend disposal. Otherwise the view-registry createEffect re-enters
      // while the backend PTY is gone but the store id is still set, spawning a
      // new PTY (and resurrecting the blue dot / ellamaka process).
      input.store.commitPanelMode?.(options.scope, options.panelID, "chat")
      input.store.commitPanelPty(options.scope, options.panelID, "tui", undefined)
      input.store.commitPanelPty(options.scope, options.panelID, "term", undefined)
      input.store.commitPanelPty(options.scope, options.panelID, "split", undefined)
      input.store.commitSplitTerminal?.(options.scope, options.panelID, false)
      const generation = nextGeneration(options.scope, options.panelID)
      await disposePanel(options.scope, panelSnap)
      const stillCurrent = isCurrent(options.scope, options.panelID, generation)
      if (!stillCurrent) {
        return { status: "stale", panelID: options.panelID }
      }
      input.store.removePanel(options.scope, options.panelID)
      return { status: "committed", panelID: options.panelID }
    },
    unbindSession(options: {
      scope: SpaceScope
      panelID: string
    }) {
      if (!runtime.canWrite()) return Promise.resolve({ status: "offline", panelID: options.panelID } satisfies WorkbenchActionResult)
      return unbindPanel(options.scope, options.panelID)
    },
    async unbindSessionEverywhere(sessionID: string): Promise<WorkbenchActionStatus & { affectedPanelCount: number }> {
      if (!runtime.canWrite()) return { status: "offline", affectedPanelCount: 0 }
      const targets = input.store.boundPanels(sessionID)
      if (targets.length === 0) return { status: "unchanged", affectedPanelCount: 0 }
      const results = await Promise.all(targets.map((target) => unbindPanel(target.scope, target.panelID)))
      return {
        status: results.some((result) => result.status === "stale") ? "stale" : "committed",
        affectedPanelCount: targets.length,
      }
    },
    async closeSpace(scope: SpaceScope): Promise<WorkbenchActionStatus> {
      if (scope.kind === "general") return { status: "unchanged" }
      if (!runtime.canWrite()) return { status: "offline" }
      const panels = input.store.panels(scope)
      if (panels.length === 0) return { status: "unchanged" }
      const pending = panels.map((panel) => ({
        panel: snapshotPanel(panel),
        generation: nextGeneration(scope, panel.id),
      }))
      await Promise.all(pending.map(({ panel }) => disposePanel(scope, panel)))
      if (pending.some(({ panel, generation }) => !isCurrent(scope, panel.id, generation))) {
        return { status: "stale" }
      }
      input.store.removeSpace(scope)
      return { status: "committed" }
    },
    async bindForkedSession(options: {
      scope: SpaceScope
      sourcePanelID: string
      sessionID: string
      directory?: string
    }): Promise<WorkbenchActionResult> {
      const sourcePanel = panelOrThrow(options.scope, options.sourcePanelID)
      const generation = nextGeneration(options.scope, options.sourcePanelID)
      const directory = options.directory || sourcePanel.directory
      const session = await input.session.get({
        scope: options.scope,
        sessionID: options.sessionID,
        directory,
      })
      if (!isCurrent(options.scope, options.sourcePanelID, generation)) {
        return { status: "stale", panelID: options.sourcePanelID }
      }

      input.session.project({ scope: options.scope, session })
      const panels = input.store.panels(options.scope)
      const emptyPanel = panels.find((p) => p.slotState === "empty")
      const targetPanelID = emptyPanel?.id ?? input.store.addPanel(options.scope)
      if (targetPanelID) {
        input.store.commitSessionBinding(options.scope, targetPanelID, session)
        input.store.setActivePanel(options.scope, targetPanelID)
        return { status: "committed", panelID: targetPanelID }
      }
      const replaceGeneration = nextGeneration(options.scope, options.sourcePanelID)
      const sourceSnap = snapshotPanel(sourcePanel)
      await disposePanel(options.scope, sourceSnap)
      if (!isCurrent(options.scope, options.sourcePanelID, replaceGeneration)) {
        return { status: "stale", panelID: options.sourcePanelID }
      }
      input.store.commitSessionBinding(options.scope, options.sourcePanelID, session)
      input.store.setActivePanel(options.scope, options.sourcePanelID)
      return { status: "committed", panelID: options.sourcePanelID }
    },
    async refreshSession(options: {
      scope: SpaceScope
      panelID: string
      sessionID: string
      directory: string
    }): Promise<WorkbenchActionResult> {
      if (!runtime.canWrite()) return { status: "offline", panelID: options.panelID }
      const session = await input.session.get({
        scope: options.scope,
        sessionID: options.sessionID,
        directory: options.directory,
      })
      const panel = input.store.panel(options.scope, options.panelID)
      if (!panel || panel.boundSessionId !== options.sessionID) {
        return { status: "stale", panelID: options.panelID }
      }
      const unavailableReason = typeof session.timeArchived === "number"
        ? "archived" as const
        : session.parentID
          ? "child" as const
          : undefined
      if (unavailableReason) {
        return { ...await unbindPanel(options.scope, options.panelID), unavailableReason }
      }
      input.session.project({ scope: options.scope, session })
      return { status: "committed", panelID: options.panelID }
    },
    async loadSessionIntoPanel(options: {
      scope: SpaceScope
      panelID: string
      sessionID: string
      directory: string
    }): Promise<WorkbenchActionResult> {
      if (!runtime.canWrite()) return { status: "offline", panelID: options.panelID }
      const generation = nextGeneration(options.scope, options.panelID)
      const session = await input.session.get({
        scope: options.scope,
        sessionID: options.sessionID,
        directory: options.directory,
      })
      if (!isCurrent(options.scope, options.panelID, generation)) {
        return { status: "stale", panelID: options.panelID }
      }
      const unavailableReason = typeof session.timeArchived === "number"
        ? "archived" as const
        : session.parentID
          ? "child" as const
          : undefined
      if (unavailableReason) {
        return { status: "unchanged", panelID: options.panelID, unavailableReason }
      }
      const panel = panelOrThrow(options.scope, options.panelID)
      if (
        panel.slotState === "bound" &&
        panel.boundSessionId === session.id &&
        panel.directory === session.directory
      ) {
        input.session.project({ scope: options.scope, session })
        return { status: "unchanged", panelID: options.panelID }
      }
      const panelSnap = snapshotPanel(panel)
      await disposePanel(options.scope, panelSnap)
      if (!isCurrent(options.scope, options.panelID, generation)) {
        return { status: "stale", panelID: options.panelID }
      }
      input.session.project({ scope: options.scope, session })
      input.store.commitSessionBinding(options.scope, options.panelID, session)
      input.store.setActivePanel(options.scope, options.panelID)
      return { status: "committed", panelID: options.panelID }
    },
    async revealSession(options: RevealSessionInput): Promise<RevealSessionResult> {
      const scopePathValue = scopePath(options.scope)

      // 1. Already bound → open the owning Tab and activate the Panel.
      //    No Session API call or PTY dispose — the existing binding is reused.
      const bindings = input.store.boundPanels(options.sessionID)
      const binding = bindings[0]
      if (binding) {
        input.store.setActive(scopePath(binding.scope))
        input.store.setActivePanel(binding.scope, binding.panelID)
        return { status: "activated", panelID: binding.panelID, scopePath: scopePath(binding.scope) }
      }

      // 2. Unbound → locate an empty Panel, otherwise add one (max 3).
      const panels = input.store.panels(options.scope)
      const emptyPanel = panels.find((panel) => panel.slotState === "empty")
      const targetPanelID =
        emptyPanel?.id ?? (panels.length < 3 ? input.store.addPanel(options.scope) : undefined)

      if (!targetPanelID) {
        // All Panels are bound. Without confirmation we must not silently
        // overwrite the user's work — signal the caller to ask first.
        if (options.forceReplace) {
          const activeID = input.store.activePanelID(options.scope)
          if (!activeID) return { status: "replacement_required", panelID: "", scopePath: scopePathValue }
          const result = await this.loadSessionIntoPanel({
            scope: options.scope,
            panelID: activeID,
            sessionID: options.sessionID,
            directory: options.directory,
          })
          if (result.status === "stale") return { status: "stale" }
          if (result.unavailableReason) {
            return { status: "unavailable", reason: result.unavailableReason, panelID: activeID, scopePath: scopePathValue }
          }
          return { status: "loaded", panelID: activeID, scopePath: scopePathValue }
        }
        return {
          status: "replacement_required",
          panelID: input.store.activePanelID(options.scope) ?? "",
          scopePath: scopePathValue,
        }
      }

      // 3. Load into the chosen Panel (reuses server read + PTY release +
      //    Projection update + single binding commit from loadSessionIntoPanel).
      const result = await this.loadSessionIntoPanel({
        scope: options.scope,
        panelID: targetPanelID,
        sessionID: options.sessionID,
        directory: options.directory,
      })
      if (result.status === "stale") return { status: "stale" }
      if (result.unavailableReason) {
        return { status: "unavailable", reason: result.unavailableReason, panelID: targetPanelID, scopePath: scopePathValue }
      }
      return { status: "loaded", panelID: targetPanelID, scopePath: scopePathValue }
    },
    renameSession(options: {
      scope: SpaceScope
      sessionID: string
      directory: string
      title: string
    }) {
      if (!runtime.canWrite()) return Promise.resolve({ status: "offline" } satisfies WorkbenchActionStatus)
      return input.session.rename(options)
    },
    async deleteSession(options: {
      scope: SpaceScope
      sessionID: string
      directory: string
    }): Promise<WorkbenchActionStatus> {
      if (!runtime.canWrite()) return { status: "offline" }
      const session = await input.session.get(options)
      await input.session.remove({ scope: options.scope, session })
      const targets = input.store.boundPanels(options.sessionID)
      if (targets.length === 0) return { status: "committed" }
      const results = await Promise.all(targets.map((target) => unbindPanel(target.scope, target.panelID)))
      return { status: results.some((result) => result.status === "stale") ? "stale" : "committed" }
    },
    async replaceSession(options: {
      scope: SpaceScope
      panelID: string
      session: WorkbenchActionSession
    }): Promise<WorkbenchActionResult> {
      if (!runtime.canWrite()) return { status: "offline", panelID: options.panelID }
      const panel = panelOrThrow(options.scope, options.panelID)
      if (
        panel.slotState === "bound" &&
        panel.boundSessionId === options.session.id &&
        panel.directory === options.session.directory
      ) {
        input.session.project({ scope: options.scope, session: options.session })
        return { status: "unchanged", panelID: options.panelID }
      }

      const panelSnap = snapshotPanel(panel)
      const generation = nextGeneration(options.scope, options.panelID)
      await disposePanel(options.scope, panelSnap)
      if (!isCurrent(options.scope, options.panelID, generation)) {
        return { status: "stale", panelID: options.panelID }
      }
      input.session.project({ scope: options.scope, session: options.session })
      input.store.commitSessionBinding(options.scope, options.panelID, options.session)
      input.store.setActivePanel(options.scope, options.panelID)
      return { status: "committed", panelID: options.panelID }
    },
    async ensurePanelPty(options: {
      scope: SpaceScope
      panelID: string
      kind: WorkbenchActionPtyKind
      create: () => Promise<string>
    }): Promise<WorkbenchActionResult> {
      if (!runtime.canWrite()) return { status: "offline", panelID: options.panelID }
      const panel = panelOrThrow(options.scope, options.panelID)
      const existingPtyID = ptyID(panel, options.kind)
      const generation = nextGeneration(options.scope, options.panelID)
      const createdPtyID = await input.pty.ensure({
        scope: options.scope,
        panel,
        kind: options.kind,
        directory: panel.directory,
        create: options.create,
      })
      if (!isCurrent(options.scope, options.panelID, generation)) {
        if (createdPtyID !== existingPtyID) {
          await input.pty.disposePty({
            scope: options.scope,
            panelID: options.panelID,
            kind: options.kind,
            knownPtyID: createdPtyID,
          })
        }
        return { status: "stale", panelID: options.panelID }
      }
      if (createdPtyID === existingPtyID) {
        return { status: "unchanged", panelID: options.panelID, ptyID: createdPtyID }
      }
      input.store.commitPanelPty(options.scope, options.panelID, options.kind, createdPtyID)
      return { status: "committed", panelID: options.panelID, ptyID: createdPtyID }
    },
    async closeSplitTerminal(options: {
      scope: SpaceScope
      panelID: string
    }): Promise<WorkbenchActionResult> {
      if (!runtime.canWrite()) return { status: "offline", panelID: options.panelID }
      const panel = panelOrThrow(options.scope, options.panelID)
      const existingPtyID = ptyID(panel, "split")
      const generation = nextGeneration(options.scope, options.panelID)
      if (existingPtyID) {
        await input.pty.disposePty({
          scope: options.scope,
          panelID: options.panelID,
          kind: "split",
          knownPtyID: existingPtyID,
        })
      }
      if (!isCurrent(options.scope, options.panelID, generation)) {
        return { status: "stale", panelID: options.panelID }
      }
      input.store.commitSplitTerminal?.(options.scope, options.panelID, false)
      input.store.commitPanelPty(options.scope, options.panelID, "split", undefined)
      return { status: existingPtyID ? "committed" : "unchanged", panelID: options.panelID }
    },
    async recoverPanelPty(options: {
      scope: SpaceScope
      panelID: string
      kind: WorkbenchActionPtyKind
      ptyID: string
    }): Promise<WorkbenchActionResult> {
      if (disposingPanels.has(panelKey(options.scope, options.panelID))) {
        return { status: "stale", panelID: options.panelID }
      }
      const panel = input.store.panel(options.scope, options.panelID)
      if (!panel || ptyID(panel, options.kind) !== options.ptyID) {
        return { status: "stale", panelID: options.panelID }
      }
      const generation = nextGeneration(options.scope, options.panelID)
      const probe = await (input.pty.probe?.({ directory: panel.directory, ptyID: options.ptyID }) ?? Promise.resolve("unknown"))
      if (!isCurrent(options.scope, options.panelID, generation)) {
        return { status: "stale", panelID: options.panelID }
      }
      if (probe !== "dead") return { status: "unchanged", panelID: options.panelID }

      input.pty.forgetPty?.({ scope: options.scope, panelID: options.panelID, kind: options.kind })
      batch(() => {
        if (options.kind === "tui") input.store.commitPanelMode?.(options.scope, options.panelID, "chat")
        if (options.kind === "split") input.store.commitSplitTerminal?.(options.scope, options.panelID, false)
        input.store.commitPanelPty(options.scope, options.panelID, options.kind, undefined)
      })
      return { status: "committed", panelID: options.panelID }
    },
    clearAllPtyForServerChange() {
      const paths = input.store.spacePaths()
      batch(() => {
        for (const path of paths) {
          const panels = input.store.panels({ kind: "space", name: path, path })
          for (const panel of panels) {
            // Per AGENTS.md §5.6: switch viewMode to chat BEFORE clearing tuiPtyId
            if (panel.viewMode === "tui") {
              input.store.commitPanelMode?.({ kind: "space", name: path, path }, panel.id, "chat")
            }
            // Close split terminal
            if (panel.splitTerminal) {
              input.store.commitSplitTerminal?.({ kind: "space", name: path, path }, panel.id, false)
            }
            // Clear all PTY IDs
            input.store.commitPanelPty({ kind: "space", name: path, path }, panel.id, "tui", undefined)
            input.store.commitPanelPty({ kind: "space", name: path, path }, panel.id, "term", undefined)
            input.store.commitPanelPty({ kind: "space", name: path, path }, panel.id, "split", undefined)
          }
        }
        // Also handle General space
        const generalPanels = input.store.panels({ kind: "general" })
        for (const panel of generalPanels) {
          if (panel.viewMode === "tui") {
            input.store.commitPanelMode?.({ kind: "general" }, panel.id, "chat")
          }
          if (panel.splitTerminal) {
            input.store.commitSplitTerminal?.({ kind: "general" }, panel.id, false)
          }
          input.store.commitPanelPty({ kind: "general" }, panel.id, "tui", undefined)
          input.store.commitPanelPty({ kind: "general" }, panel.id, "term", undefined)
          input.store.commitPanelPty({ kind: "general" }, panel.id, "split", undefined)
        }
        // Clear ptyManager memory
        input.pty.clearMemory?.()
        // Add diagnostic hint
        input.store.pushDiagnostic?.("info", "Sidecar restarted — PTY sessions have been reset. Re-open TUI/Terminal as needed.", { id: "sidecar-restart-pty-reset", autoDismiss: true })
      })
    },
    clearPtyEverywhere(ptyID: string) {
      if (!ptyID) return
      const paths = input.store.spacePaths()
      const scopes: SpaceScope[] = [
        ...paths.map((path) => ({ kind: "space" as const, name: path, path })),
        { kind: "general" as const },
      ]

      batch(() => {
        for (const scope of scopes) {
          const panels = input.store.panels(scope)
          for (const panel of panels) {
            if (panel.tuiPtyId === ptyID) {
              if (panel.viewMode === "tui") {
                input.store.commitPanelMode?.(scope, panel.id, "chat")
              }
              input.store.commitPanelPty(scope, panel.id, "tui", undefined)
              input.pty.forgetPty?.({ scope, panelID: panel.id, kind: "tui" })
            }
            if (panel.termPtyId === ptyID) {
              input.store.commitPanelPty(scope, panel.id, "term", undefined)
              input.pty.forgetPty?.({ scope, panelID: panel.id, kind: "term" })
            }
            if (panel.splitPtyId === ptyID) {
              if (panel.splitTerminal) {
                input.store.commitSplitTerminal?.(scope, panel.id, false)
              }
              input.store.commitPanelPty(scope, panel.id, "split", undefined)
              input.pty.forgetPty?.({ scope, panelID: panel.id, kind: "split" })
            }
          }
        }
      })
    },
  }
}

// ── Workbench-local action ownership ─────────────────────────────────────
// Actions hold generations and PTY bookkeeping, so their lifetime must match
// one Workbench provider tree. A module singleton leaks those maps across
// remounts, server changes, and multiple Workbench instances.

import { createSimpleContext } from "@wopal/ui/context"
import { useWorkbenchState } from "./view-store"
import { useSessionStore, useSessionProjectionWriter } from "./session-store"
import { useServerSDK } from "@/context/server-sdk"
import { buildStorePort, buildPtyPort, buildSessionPort } from "./workbench-actions-ports"
import { useWorkbenchRuntime } from "./workbench-runtime"

const WorkbenchActionsContext = createSimpleContext({
  name: "WorkbenchActions",
  init: () => {
    const wb = useWorkbenchState()
    const sessions = useSessionStore()
    const projection = useSessionProjectionWriter()
    const serverSDK = useServerSDK()
    const runtime = useWorkbenchRuntime()
    const store = buildStorePort(wb)
    return createWorkbenchActions({
      store,
      pty: buildPtyPort(serverSDK, store),
      session: buildSessionPort(serverSDK, sessions, projection),
      runtime,
    })
  },
})

export const useWorkbenchActions = () => WorkbenchActionsContext.use()
export const WorkbenchActionsProvider = WorkbenchActionsContext.provider
