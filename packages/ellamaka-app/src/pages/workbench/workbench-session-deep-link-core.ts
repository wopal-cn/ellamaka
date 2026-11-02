import { spaceScope, scopePath, type SpaceScope } from "./workbench-scope"
import type { RevealSessionInput, RevealSessionResult } from "./workbench-actions"
import type { WopalSpace } from "./space-store"

// ── Pure coordination logic (unit-tested directly) ──────────────────────
// Resolves a notification deep link into a Space scope via the server-side
// session-tree projection, then delegates the actual Tab/Panel/Projection/
// PTY mutation to the single `revealSession` transaction on WorkbenchActions.
// Kept free of Solid/router imports so it can be unit-tested in isolation.

export type WorkbenchSessionGroupSummary = {
  id: string
  title: string
  type: "space" | "general"
  sessions: Array<{
    id: string
    title: string
    directory: string
    directoryHealth: "healthy" | "missing" | "unavailable"
  }>
}

export type CoordinateWorkbenchSessionLinkParams = {
  sessionID: string
  groups: WorkbenchSessionGroupSummary[]
  spaces: WopalSpace[]
  reveal: (input: RevealSessionInput) => Promise<RevealSessionResult>
  openTab: (space: WopalSpace) => void
  showConfirm: (onConfirm: () => void, onCancel: () => void) => void
  setStatusMessage: (message: string) => void
  consume: () => void
  t: (key: string, params?: Record<string, string | number | boolean>) => string
  isCurrent?: () => boolean
}

export async function coordinateWorkbenchSessionLink(
  params: CoordinateWorkbenchSessionLinkParams,
): Promise<void> {
  const {
    sessionID,
    groups,
    spaces,
    reveal,
    openTab,
    showConfirm,
    setStatusMessage,
    consume,
    t,
    isCurrent,
  } = params

  if (isCurrent && !isCurrent()) return

  const group = groups.find((candidate) => candidate.sessions.some((s) => s.id === sessionID))
  if (!group) {
    setStatusMessage(t("workbench.status.sessionNotFound"))
    consume()
    return
  }
  const groupSession = group.sessions.find((s) => s.id === sessionID)!

  // Unavailable directory → never load; just surface a localized hint.
  if (groupSession.directoryHealth !== "healthy") {
    setStatusMessage(t("workbench.status.dirHealthWarning"))
    consume()
    return
  }

  let scope: SpaceScope
  let owningSpace: WopalSpace | undefined
  if (group.type === "general") {
    scope = { kind: "general" }
  } else {
    const space = spaces.find((candidate) => candidate.id === group.id)
    if (!space) {
      setStatusMessage(t("workbench.status.spaceNotRegistered"))
      consume()
      return
    }
    owningSpace = space
    scope = spaceScope(space.name, space.path)
  }

  if (isCurrent && !isCurrent()) return

  // Ensure the owning Space Tab exists and is active so the Panel shows.
  if (scope.kind === "space" && owningSpace) {
    openTab(owningSpace)
  }

  const result = await reveal({ scope, sessionID, directory: groupSession.directory })
  if (isCurrent && !isCurrent()) {
    consume()
    return
  }

  switch (result.status) {
    case "activated":
      if (result.scopePath !== undefined && result.scopePath !== scopePath(scope)) {
        const owningSpace = result.scopePath
          ? spaces.find((s) => s.path === result.scopePath)
          : undefined
        if (owningSpace) {
          openTab(owningSpace)
        }
      }
      break
    case "loaded":
      break
    case "replacement_required":
      showConfirm(
        () => {
          void reveal({ scope, sessionID, directory: groupSession.directory, forceReplace: true }).then(() => consume())
        },
        () => consume(),
      )
      return
    case "unavailable":
      setStatusMessage(t("workbench.status.sessionUnavailable", { reason: result.reason ?? "" }))
      break
    case "stale":
      break
  }
  consume()
}
