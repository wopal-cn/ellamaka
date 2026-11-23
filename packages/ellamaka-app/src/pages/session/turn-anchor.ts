/**
 * The jump anchor for PgUp/PgDn and prompt-directory jumps must be resolved
 * inside the panel's own scroller. A document-wide query can match the same
 * turn rendered by another keep-alive panel (hidden Space tab, split panel),
 * scrolling the wrong scroller and leaving the visible one untouched.
 */
export function resolveTurnAnchor(scopeRoot: HTMLElement | undefined, turnID: string): HTMLElement | undefined {
  if (!scopeRoot) return undefined
  return scopeRoot.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnID)}"]`) ?? undefined
}
