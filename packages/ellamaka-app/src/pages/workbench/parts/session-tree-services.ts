import type { WopalSpace, WorkbenchPanel, SpaceWorkbenchState } from "../workbench-store"
import { scopeFromTab, type SpaceScope } from "../workbench-scope"
import { reportWorkbenchError } from "../workbench-error"

// ── Types ───────────────────────────────────────────────────────────────────

export type GroupSession = {
  id: string
  title: string
  directory: string
  directoryHealth: "healthy" | "missing" | "unavailable"
  agent?: string
  marker?: "" | "directory" | "worktree"
  relativePath?: string | null
  branch?: string | null
  timeCreated: number
  timeUpdated: number
}

export type SessionGroup = {
  id: string
  title: string
  type: "space" | "general"
  sessionCount: number
  sessions: GroupSession[]
}

export type SessionTreeLocation = {
  key: string
  label: string
  kind: "general-directory" | "general-date" | "space-root" | "project"
  relativePath?: string
  sessions: GroupSession[]
}

export type SessionTreeScope = {
  path: string
  name: string
  kind: "general" | "space"
  sessionCount: number
  truncated: boolean
  locations: SessionTreeLocation[]
}

export type WorkbenchSessionTree = {
  scopes: SessionTreeScope[]
}

// ── Minimal dependency interfaces (subset of full store / actions / dialog) ─

export interface OpenSessionWB {
  spaces: Record<string, SpaceWorkbenchState>
  openTab(space: WopalSpace): void
  ensureSpace(path: string): void
  setStatusMessage(message: string): void
  activeTab(): WopalSpace | undefined
  findSessionBinding(sessionID: string): { spacePath: string; panelID: string } | undefined
}

export interface OpenSessionActions {
  addPanel(scope: SpaceScope): string | undefined
  loadSessionIntoPanel(options: {
    scope: SpaceScope
    panelID: string
    sessionID: string
    directory: string
  }): Promise<{ status: string; panelID: string }>
}

// -- fetchSessionGroups (pure async: projects the canonical session tree) --

// The App BFF contract is fixed to createSession/sessionTree/locations/dshEntry,
// so this grouping is derived from the canonical session tree instead of a
// second private operation (DESIGN-workbench.md API ownership).

export type SessionGroupsSDK = SessionTreeSDK

export async function fetchSessionGroups(sdk: SessionGroupsSDK): Promise<SessionGroup[]> {
  const tree = await fetchSessionTree(sdk)
  return tree.scopes.map((scope) => ({
    id: scope.path,
    title: scope.name,
    type: scope.kind,
    sessionCount: scope.sessionCount,
    sessions: scope.locations.flatMap((location) => location.sessions),
  }))
}

function normalizeCount(n: number | string): number {
  return typeof n === "number" ? n : 0
}

function normalizeTimestamp(n: number | string): number {
  return typeof n === "number" ? n : 0
}

export type SessionTreeSDK = {
  bff: {
    workbench: {
      locations: (input: { spacePath: string }) => Promise<{ data?: { scopePath?: string } }>
      sessionTree: (input?: { limitPerScope?: string }) => Promise<{
        data?: {
          scopes?: Array<{
            path: string
            name: string
            kind: "general" | "space"
            sessionCount: number | string
            truncated: boolean
            locations?: Array<{
              key: string
              kind: SessionTreeLocation["kind"]
              name: string
              path: string
              sessionCount: number | string
              sessions?: Array<{
                id: string
                title: string
                directory: string
                directoryHealth: "healthy" | "missing" | "unavailable"
                agent?: string
                marker: "" | "directory" | "worktree"
                relativePath?: string | null
                branch?: string | null
                timeCreated: number | string
                timeUpdated: number | string
              }>
            }>
          }>
        }
      }>
    }
  }
}

export async function fetchSessionTree(sdk: SessionTreeSDK): Promise<WorkbenchSessionTree> {
  const response = await sdk.bff.workbench.sessionTree()
  const raw = response.data?.scopes ?? []
  const paths = await Promise.all(
    raw.map(async (scope) =>
      scope.kind === "space"
        ? ((await sdk.bff.workbench.locations({ spacePath: scope.path }).catch(() => undefined))?.data?.scopePath ??
          scope.path)
        : scope.path,
    ),
  )
  return {
    scopes: raw.map((scope, index) => ({
      path: paths[index],
      name: scope.name,
      kind: scope.kind,
      sessionCount: normalizeCount(scope.sessionCount),
      truncated: scope.truncated,
      locations: (scope.locations ?? []).map((location) => ({
        key: location.key,
        label: location.name,
        kind: location.kind,
        sessions: (location.sessions ?? []).map((session) => ({
          id: session.id,
          title: session.title,
          directory: session.directory,
          directoryHealth: session.directoryHealth,
          agent: session.agent,
          marker: session.marker,
          relativePath: session.relativePath,
          branch: session.branch,
          timeCreated: normalizeTimestamp(session.timeCreated),
          timeUpdated: normalizeTimestamp(session.timeUpdated),
        })),
      })),
    })),
  }
}

// ── mergeTree: preserve referential identity for unchanged nodes ─────────────
//
// `setTree(value)` always hands SolidJS fresh object references, which makes
// `<For>` treat every row as new and remount the whole list — visible as a
// tree re-animation on every background refresh. `mergeTree(prev, next)`
// walks both trees in parallel and, for each scope / location / session whose
// shallow fields are unchanged, returns the *previous* reference so `<For>`'s
// referential diff keeps the existing DOM. Only genuinely changed subtrees get
// new references, so re-renders stay localized to the row that actually moved.
//
// Scopes are keyed by `path`, locations by `key`, sessions by `id`. Order is
// not special-cased: the merged output follows `next`'s order, but stable
// nodes reuse `prev` references wherever they land.

function sessionEqual(a: GroupSession, b: GroupSession): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.directory === b.directory &&
    a.directoryHealth === b.directoryHealth &&
    a.agent === b.agent &&
    a.marker === b.marker &&
    a.relativePath === b.relativePath &&
    a.branch === b.branch &&
    a.timeCreated === b.timeCreated &&
    a.timeUpdated === b.timeUpdated
  )
}

function mergeSessions(prev: GroupSession[], next: GroupSession[]): GroupSession[] {
  if (prev.length !== next.length) return next
  const prevById = new Map(prev.map((s) => [s.id, s]))
  let anyChanged = false
  const merged = next.map((nextSession) => {
    const prevSession = prevById.get(nextSession.id)
    if (!prevSession || !sessionEqual(prevSession, nextSession)) {
      anyChanged = true
      return nextSession
    }
    return prevSession
  })
  return anyChanged ? merged : prev
}

function mergeLocation(prev: SessionTreeLocation, next: SessionTreeLocation): SessionTreeLocation {
  const topEqual = prev.label === next.label && prev.kind === next.kind && prev.relativePath === next.relativePath
  const mergedSessions = mergeSessions(prev.sessions, next.sessions)
  if (topEqual && mergedSessions === prev.sessions) return prev
  return { ...next, sessions: mergedSessions }
}

function mergeLocations(prev: SessionTreeLocation[], next: SessionTreeLocation[]): SessionTreeLocation[] {
  if (prev.length !== next.length) return next
  const prevByKey = new Map(prev.map((l) => [l.key, l]))
  let anyChanged = false
  const merged = next.map((nextLoc) => {
    const prevLoc = prevByKey.get(nextLoc.key)
    if (!prevLoc) {
      anyChanged = true
      return nextLoc
    }
    const mergedLoc = mergeLocation(prevLoc, nextLoc)
    if (mergedLoc !== prevLoc) anyChanged = true
    return mergedLoc
  })
  return anyChanged ? merged : prev
}

function mergeScope(prev: SessionTreeScope, next: SessionTreeScope): SessionTreeScope {
  const topEqual =
    prev.name === next.name &&
    prev.kind === next.kind &&
    prev.sessionCount === next.sessionCount &&
    prev.truncated === next.truncated
  const mergedLocs = mergeLocations(prev.locations, next.locations)
  if (topEqual && mergedLocs === prev.locations) return prev
  return { ...next, locations: mergedLocs }
}

export function mergeTree(prev: WorkbenchSessionTree, next: WorkbenchSessionTree): WorkbenchSessionTree {
  if (prev.scopes.length === 0) return next
  if (prev.scopes.length !== next.scopes.length) return next
  const prevByPath = new Map(prev.scopes.map((s) => [s.path, s]))
  let anyChanged = false
  const merged = next.scopes.map((nextScope) => {
    const prevScope = prevByPath.get(nextScope.path)
    if (!prevScope) {
      anyChanged = true
      return nextScope
    }
    const mergedScope = mergeScope(prevScope, nextScope)
    if (mergedScope !== prevScope) anyChanged = true
    return mergedScope
  })
  return anyChanged ? { scopes: merged } : prev
}

export function createSessionGroupsLoader<T>(input: {
  fetch: () => Promise<T>
  commit: (groups: T) => void
  setLoading: (loading: boolean) => void
  onError: (error: unknown) => void
  // When `hasData` returns true, the loader skips `setLoading(true)` and
  // keeps the previously committed data visible during the refetch. This
  // prevents the tree from flashing a "loading" placeholder on every
  // background refresh; only the first load (no data yet) shows loading.
  hasData?: () => boolean
}) {
  let latestRequest = 0

  return async () => {
    const request = latestRequest + 1
    latestRequest = request
    const showLoading = !input.hasData?.()
    if (showLoading) input.setLoading(true)
    try {
      const groups = await input.fetch()
      if (request !== latestRequest) return
      input.commit(groups)
    } catch (error) {
      if (request === latestRequest) input.onError(error)
    } finally {
      if (request === latestRequest && showLoading) input.setLoading(false)
    }
  }
}

// ── resolveTargetPanel (pure sync — panel selection decision) ───────────────

export type TargetPanelResolution =
  | { kind: "empty"; panel: WorkbenchPanel }
  | { kind: "new" }
  | { kind: "overwrite"; panel: WorkbenchPanel; index: number }

export function resolveTargetPanel(
  panels: WorkbenchPanel[],
  activePanelID: string,
  maxPanels: number,
): TargetPanelResolution {
  const emptyPanel = panels.find((p) => p.slotState === "empty")
  if (emptyPanel) return { kind: "empty", panel: emptyPanel }

  if (panels.length < maxPanels) return { kind: "new" }

  const activePanel = panels.find((p) => p.id === activePanelID)
  if (activePanel) {
    const idx = panels.findIndex((p) => p.id === activePanelID)
    return { kind: "overwrite", panel: activePanel, index: idx + 1 }
  }
  return { kind: "overwrite", panel: panels[0], index: 1 }
}

// ── getPanelBadge (pure helper) ─────────────────────────────────────────────

export function getPanelBadge(wb: OpenSessionWB, sessionId: string): string | undefined {
  const binding = wb.findSessionBinding(sessionId)
  if (!binding) return undefined
  const index = wb.spaces[binding.spacePath]?.panels.findIndex((panel) => panel.id === binding.panelID) ?? -1
  return index === -1 ? undefined : `P${index + 1}`
}

// ── openSessionInPanel (orchestration) ──────────────────────────────────────

export async function openSessionInPanel(params: {
  session: { id: string; title: string }
  sessionDirectory: string
  targetSpace?: WopalSpace
  /** Legacy input retained for existing callers during the path migration. */
  spaceName?: string
  spaces?: WopalSpace[]
  wb: OpenSessionWB
  actions: OpenSessionActions
  t: (key: string, params?: Record<string, string | number | boolean>) => string
  showOverwriteDialog: (panelIndex: number, onConfirm: () => Promise<void>) => void
}): Promise<void> {
  const targetSpace = params.targetSpace ?? params.spaces?.find((space) => space.name === params.spaceName)
  if (!targetSpace) return

  const targetSpacePath = targetSpace.path
  const scope = scopeFromTab(targetSpace)

  const loadSessionIntoPanel = async (panel: WorkbenchPanel) => {
    await params.actions.loadSessionIntoPanel({
      scope,
      panelID: panel.id,
      sessionID: params.session.id,
      directory: params.sessionDirectory || targetSpacePath,
    })
  }

  params.wb.openTab(targetSpace)
  params.wb.ensureSpace(targetSpacePath)

  const space = params.wb.spaces[targetSpacePath]
  if (!space || space.panels.length === 0) return

  const resolution = resolveTargetPanel(space.panels, space.activePanelID, 3)

  if (resolution.kind === "empty") {
    await loadSessionIntoPanel(resolution.panel).catch((error) =>
      reportWorkbenchError("load session into panel", error),
    )
  } else if (resolution.kind === "new") {
    const newPanelId = params.actions.addPanel(scope)
    if (newPanelId) {
      const updatedSpace = params.wb.spaces[targetSpacePath]
      const newPanel = updatedSpace?.panels?.find((p) => p.id === newPanelId)
      if (newPanel) {
        await loadSessionIntoPanel(newPanel).catch((error) => reportWorkbenchError("load session into panel", error))
      }
    }
  } else {
    params.showOverwriteDialog(resolution.index, () => loadSessionIntoPanel(resolution.panel))
  }
}

// ── getSessionMarker (pure helper for SessionMarkerIcon UI styling) ────────

export interface SessionMarkerInfo {
  type: "worktree" | "directory" | "dot"
  colorClass: string
  text?: string
}

export function getSessionMarker(
  marker: "" | "directory" | "worktree",
  status: "idle" | "bound" | "archived",
  dirHealth: "healthy" | "missing" | "unavailable",
): SessionMarkerInfo {
  const colorClass =
    dirHealth !== "healthy"
      ? "text-amber-500"
      : status === "bound"
        ? "text-v2-icon-icon-accent"
        : "text-v2-icon-icon-muted"

  if (marker === "worktree") {
    return { type: "worktree", colorClass }
  }
  if (marker === "directory") {
    return { type: "directory", colorClass }
  }
  return {
    type: "dot",
    colorClass,
    text: dirHealth !== "healthy" ? "!" : undefined,
  }
}
