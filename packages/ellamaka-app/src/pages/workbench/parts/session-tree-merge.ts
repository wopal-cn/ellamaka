import type { Session } from "../session-store"

export type SessionTreeMergedSession = {
  id: string
  title: string
  status: "idle" | "bound" | "archived"
}

type ServerSession = {
  id: string
  title: string
  timeArchived?: number
}

type ServerTitlePatch = {
  id: string
  title: string
}

export function mergeSessionTreeSessions(
  serverSessions: ServerSession[],
  isSessionBound: (sessionId: string) => boolean,
  localSessions: Session[] = [],
): SessionTreeMergedSession[] {
  const localTitles = new Map(localSessions.map((session) => [session.id, session.title]))
  const seenIds = new Set<string>()

  return serverSessions.flatMap((serverSession) => {
    if (seenIds.has(serverSession.id)) return []
    seenIds.add(serverSession.id)

    return [
      {
        id: serverSession.id,
        title: localTitles.get(serverSession.id) ?? (serverSession.title || serverSession.id),
        status: isSessionBound(serverSession.id) ? "bound" : serverSession.timeArchived ? "archived" : "idle",
      },
    ]
  })
}

export function getServerTitlePatches(serverSessions: ServerSession[], localSessions: Session[]): ServerTitlePatch[] {
  const localById = new Map(localSessions.map((session) => [session.id, session]))
  const seenIds = new Set<string>()

  return serverSessions.flatMap((serverSession) => {
    if (!serverSession.title) return []
    if (seenIds.has(serverSession.id)) return []
    seenIds.add(serverSession.id)

    const local = localById.get(serverSession.id)
    if (!local) return []
    if (local.title === serverSession.title) return []

    return [{ id: serverSession.id, title: serverSession.title }]
  })
}
