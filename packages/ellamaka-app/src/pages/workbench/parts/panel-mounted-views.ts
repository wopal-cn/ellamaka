import type { PanelSlotState, PanelViewMode } from "../view-store"

type ReconcileMountedViewsInput = {
  prevBoundSessionId?: string
  nextBoundSessionId?: string
  slotState: PanelSlotState
  viewMode?: PanelViewMode
  hasTuiPtyId?: boolean
}

export function reconcileMountedViews(prev: Set<string>, input: ReconcileMountedViewsInput): Set<string> {
  const next =
    input.prevBoundSessionId !== input.nextBoundSessionId || input.slotState === "empty"
      ? new Set<string>()
      : new Set(prev)

  if (input.slotState !== "empty" && input.viewMode) {
    next.add(input.viewMode)
  }

  if (input.slotState !== "empty" && input.hasTuiPtyId) {
    next.add("tui")
  } else if (!input.hasTuiPtyId && input.viewMode !== "tui") {
    next.delete("tui")
  }

  if (prev.size === next.size && [...prev].every((item) => next.has(item))) {
    return prev
  }

  return next
}
