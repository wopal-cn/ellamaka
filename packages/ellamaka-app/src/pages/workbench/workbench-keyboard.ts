/**
 * The Workbench owns Cmd/Ctrl+W while it is mounted. Keeping the modifier
 * predicate in one place prevents the pinned-tab guard and command handling
 * from drifting apart.
 */
export function isWorkbenchClosePanelShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): boolean {
  return event.metaKey !== event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "w"
}

/** General and pinned tabs are intentionally protected from Cmd/Ctrl+W. */
export function isWorkbenchTabCloseProtected(tab: { path: string; pinned?: boolean } | undefined): boolean {
  return !tab || tab.path === "" || !!tab.pinned
}
