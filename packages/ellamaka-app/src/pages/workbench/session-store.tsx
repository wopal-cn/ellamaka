import { createSimpleContext } from "@wopal/ui/context"
import { createMemo, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { normalizeSpacePath } from "./workbench-scope"

export type SessionType = "tui" | "chat"
export type DirectoryHealth = "healthy" | "missing" | "unavailable"

export type Session = {
  id: string
  spaceName: string
  /** Canonical scope identity. Legacy projections may only have `spaceName`. */
  spacePath?: string
  projectPath: string
  type: SessionType
  title: string
  directoryHealth: DirectoryHealth
  timeArchived?: number
  createdAt: number
  lastActiveAt: number
}

export type SessionProjectionInput = Session
export type SessionProjectionPatch = Partial<
  Pick<Session, "title" | "type" | "spacePath" | "projectPath" | "directoryHealth" | "timeArchived" | "lastActiveAt">
>

type SessionProjectionState = {
  spaces: Record<string, Session[]>
}

function limitSessions(sessions: Session[]): Session[] {
  return sessions
}

export function createSessionProjection() {
  const [store, setStore] = createStore<SessionProjectionState>({ spaces: {} })
  const [refreshKey, setRefreshKey] = createSignal(0)

  // id -> spaceName index. Lets getSession/upsert/patch/remove skip the
  // previous full O(N·M) scan over every space's session list. Stale entries
  // (e.g. a session dropped by limitSessions or removed elsewhere) are
  // reconciled lazily inside `find`.
  const idToSpace = new Map<string, string>()

  const find = (id: string) => {
    // Fast path: indexed.
    const indexedSpace = idToSpace.get(id)
    if (indexedSpace) {
      const sessions = store.spaces[indexedSpace]
      if (sessions) {
        const index = sessions.findIndex((session) => session.id === id)
        if (index !== -1) return { spaceName: indexedSpace, index, session: sessions[index] }
      }
      // Stale index entry — clean it up and fall through to full scan.
      idToSpace.delete(id)
    }
    // Fallback: full scan (covers sessions inserted before indexing, or any
    // external mutation that bypassed the index).
    for (const [spaceName, sessions] of Object.entries(store.spaces)) {
      const index = sessions.findIndex((session) => session.id === id)
      if (index !== -1) {
        idToSpace.set(id, spaceName)
        return { spaceName, index, session: sessions[index] }
      }
    }
    return undefined
  }

  const getSession = (id: string) => find(id)?.session

  const upsert = (input: SessionProjectionInput) => {
    const existing = find(input.id)
    const normalizedPath = input.spacePath ? normalizeSpacePath(input.spacePath) : undefined
    const spaceKey = normalizedPath ?? input.spaceName
    const normalizedInput = normalizedPath ? { ...input, spacePath: normalizedPath } : input
    if (existing?.spaceName === spaceKey) {
      setStore("spaces", spaceKey, existing.index, { ...normalizedInput })
      return
    }
    if (existing) {
      setStore("spaces", existing.spaceName, (sessions) => sessions.filter((session) => session.id !== input.id))
      idToSpace.delete(input.id)
    }
    if (!store.spaces[spaceKey]) setStore("spaces", spaceKey, [])
    setStore("spaces", spaceKey, (sessions) => limitSessions([...sessions, { ...normalizedInput }]))
    // limitSessions may have dropped the new entry; only index if it actually landed.
    if (store.spaces[spaceKey].some((session) => session.id === input.id)) {
      idToSpace.set(input.id, spaceKey)
    } else {
      idToSpace.delete(input.id)
    }
  }

  const patch = (id: string, updates: SessionProjectionPatch) => {
    const existing = find(id)
    if (!existing) return false
    const normUpdates = updates.spacePath !== undefined
      ? { ...updates, spacePath: normalizeSpacePath(updates.spacePath) }
      : updates
    setStore("spaces", existing.spaceName, existing.index, produce((session) => {
      if (normUpdates.title !== undefined) session.title = normUpdates.title
      if (normUpdates.type !== undefined) session.type = normUpdates.type
      if (normUpdates.spacePath !== undefined) session.spacePath = normUpdates.spacePath
      if (normUpdates.projectPath !== undefined) session.projectPath = normUpdates.projectPath
      if (normUpdates.directoryHealth !== undefined) session.directoryHealth = normUpdates.directoryHealth
      if (Object.hasOwn(normUpdates, "timeArchived")) session.timeArchived = normUpdates.timeArchived
      if (normUpdates.lastActiveAt !== undefined) session.lastActiveAt = normUpdates.lastActiveAt
    }))
    return true
  }

  const remove = (id: string) => {
    const existing = find(id)
    if (!existing) return false
    setStore("spaces", existing.spaceName, (sessions) => sessions.filter((session) => session.id !== id))
    idToSpace.delete(id)
    return true
  }

  return {
    reader: {
      sessions: createMemo(() => store.spaces),
      spaceSessions: (spaceName: string) => store.spaces[normalizeSpacePath(spaceName)] ?? store.spaces[spaceName] ?? [],
      getSession,
      refreshKey,
    },
    writer: {
      upsert,
      patch,
      remove,
      invalidate: () => setRefreshKey((key) => key + 1),
    },
  }
}

const SessionProjectionContext = createSimpleContext({
  name: "SessionProjection",
  init: () => {
    return createSessionProjection()
  },
})

export const useSessionStore = () => SessionProjectionContext.use().reader
export const useSessionProjectionWriter = () => SessionProjectionContext.use().writer
export const SessionStoreProvider = SessionProjectionContext.provider
