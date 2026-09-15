/**
 * Draft (unpersisted) workbench session helpers.
 *
 * A "draft session" lets /new switch a panel into a fresh chat view without
 * creating anything on the server. The panel binds a synthetic id that can
 * never collide with a real server session id; the real session is created
 * lazily when the user sends their first message (see createPromptSubmit +
 * workbench-actions.adoptSession).
 *
 * The id embeds a per-draft token (timestamp + counter) so a second /new
 * invalidates the first draft: an in-flight adopt from the stale draft can
 * no longer match the panel's binding.
 */
export const DRAFT_SESSION_PREFIX = "draft:"

let draftCounter = 0

export function draftSessionId(panelID: string): string {
  draftCounter += 1
  return `${DRAFT_SESSION_PREFIX}${panelID}.${Date.now().toString(36)}-${draftCounter}`
}

export function isDraftSessionId(sessionID: string | undefined): boolean {
  return !!sessionID && sessionID.startsWith(DRAFT_SESSION_PREFIX)
}

export function parseDraftSessionId(sessionID: string | undefined): string | undefined {
  if (!isDraftSessionId(sessionID)) return undefined
  return sessionID!.slice(DRAFT_SESSION_PREFIX.length)
}
