// Deep-link protocol for the Workbench "reply ready" browser notification.
//
// The notification only carries the Session ID. The target Space and
// directory are resolved inside the Workbench from the server-side
// `workbench.sessionTree()` projection, so this module deliberately
// expresses no Space/path semantics — it is pure URL contract only.

export const WORKBENCH_SESSION_LINK_PARAM = "session"

/**
 * Build a stable Workbench deep link for a session notification.
 * Only the Session ID is encoded; Spaces/directories are resolved later.
 */
export function workbenchSessionHref(sessionID: string): string {
  return `/workbench?${WORKBENCH_SESSION_LINK_PARAM}=${encodeURIComponent(sessionID)}`
}

export type ParsedWorkbenchSessionLink = {
  sessionID: string
}

/**
 * Parse a Workbench session deep link from a query string.
 *
 * Rejects:
 * - empty or missing `session` value
 * - more than one `session` parameter (ambiguous)
 * - path-style Session values that look like routes (`/`, `\`, leading `.`)
 *
 * Accepts both `?session=id` and `session=id` forms.
 */
export function parseWorkbenchSessionLink(
  search: string,
): ParsedWorkbenchSessionLink | undefined {
  const params = new URLSearchParams(search)
  const values = params.getAll(WORKBENCH_SESSION_LINK_PARAM)
  if (values.length !== 1) return undefined
  const sessionID = values[0]
  if (!sessionID) return undefined
  if (sessionID.includes("/") || sessionID.includes("\\") || sessionID.startsWith(".")) {
    return undefined
  }
  return { sessionID }
}
