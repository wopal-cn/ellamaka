import type { PanelSlotState } from "../view-store"
import { isDraftSessionId } from "@/utils/draft-session"

type PanelHeaderView = {
  id: string
  label: string
  requiresSession: boolean
}

type PanelHeaderViewState = PanelHeaderView & {
  disabled: boolean
  hasOpenTui: boolean
}

export function getPanelHeaderViews(
  views: PanelHeaderView[],
  slotState: PanelSlotState,
  tuiPtyId?: string,
  boundSessionId?: string,
): PanelHeaderViewState[] {
  if (slotState === "empty") return []

  const seen = new Set<string>()
  const uniqueViews: PanelHeaderView[] = []

  for (const view of views) {
    if (!view.requiresSession) continue
    if (seen.has(view.id)) continue
    seen.add(view.id)
    uniqueViews.push(view)
  }

  // Draft sessions are unpersisted: TUI and Context have no server session
  // to attach to, so their entry points stay disabled until the first
  // message adopts a real session. Chat is the only meaningful target.
  const isDraft = isDraftSessionId(boundSessionId)

  return uniqueViews.map((view) => ({
    ...view,
    disabled: isDraft && view.id !== "chat",
    hasOpenTui: view.id === "tui" && !!tuiPtyId,
  }))
}
