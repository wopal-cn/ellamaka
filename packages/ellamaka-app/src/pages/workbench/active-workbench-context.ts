import type { SpaceWorkbenchState, WorkbenchPanel, WopalSpace } from "./view-store"
import { scopeFromTab, type SpaceScope } from "./workbench-scope"

export type ActiveWorkbenchSnapshot = {
  spaces: Record<string, SpaceWorkbenchState>
  tabs: WopalSpace[]
  activeTabPath?: string
  activeSpaceName?: string
}

export type ActiveWorkbenchContext = {
  scope: SpaceScope
  panel: WorkbenchPanel
  sessionID?: string
  directory: string
}

export function selectActiveWorkbenchContext(snapshot: ActiveWorkbenchSnapshot): ActiveWorkbenchContext | undefined {
  const tab =
    snapshot.activeTabPath !== undefined
      ? snapshot.tabs.find((candidate) => candidate.path === snapshot.activeTabPath)
      : snapshot.tabs.find((candidate) => candidate.name === snapshot.activeSpaceName)
  if (!tab) return undefined
  const space = snapshot.spaces[tab.path]
  if (!space) return undefined
  const panel = space.panels.find((candidate) => candidate.id === space.activePanelID)
  if (!panel) return undefined
  return {
    scope: scopeFromTab(tab),
    panel,
    sessionID: panel.boundSessionId,
    directory: panel.directory,
  }
}
