import type { Event, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { batch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

export type SessionActivity = { directory: string; sessionID: string; status: SessionStatus }
type ActivityEvent = { directory: string; event: Event }

/** Read-only server projection. No directory SDK or child-store creation belongs here. */
export function createSessionActivity(input: {
  snapshot: () => Promise<SessionActivity[]>
  onError: (error: unknown) => void
}) {
  const [state, setState] = createStore<{ sessions: Record<string, SessionActivity> }>({ sessions: {} })
  let generation = 0
  let pending: ActivityEvent[] | undefined
  let disposed = false

  const apply = ({ directory, event }: ActivityEvent) => {
    if (event.type === "global.disposed") {
      setState("sessions", reconcile({}))
      return
    }
    if (event.type === "server.instance.disposed") {
      const disposedDirectory = event.properties.directory
      for (const [id, entry] of Object.entries(state.sessions)) {
        if (entry.directory === disposedDirectory) setState("sessions", id, undefined!)
      }
      return
    }
    if (event.type === "session.deleted") {
      setState("sessions", event.properties.info.id, undefined!)
      return
    }
    if (event.type !== "session.status") return
    const { sessionID, status } = event.properties
    setState("sessions", sessionID, status.type === "idle" ? undefined! : { directory, sessionID, status })
  }

  const refresh = async () => {
    const request = ++generation
    pending = []
    try {
      const snapshot = await input.snapshot()
      if (disposed || request !== generation) return
      batch(() => {
        setState(
          "sessions",
          reconcile(
            Object.fromEntries(
              snapshot.filter((entry) => entry.status.type !== "idle").map((entry) => [entry.sessionID, entry]),
            ),
          ),
        )
        for (const event of pending ?? []) apply(event)
      })
    } catch (error) {
      if (!disposed && request === generation) input.onError(error)
    } finally {
      if (request === generation) pending = undefined
    }
  }

  return {
    refresh,
    receive(directory: string, event: Event) {
      if (disposed) return
      if (!["session.status", "session.deleted", "server.instance.disposed", "global.disposed"].includes(event.type))
        return
      const entry = { directory, event }
      if (pending) pending.push(entry)
      apply(entry)
    },
    status(sessionID: string): SessionStatus {
      return state.sessions[sessionID]?.status ?? { type: "idle" }
    },
    entries: () => Object.values(state.sessions),
    dispose() {
      disposed = true
      generation++
      pending = undefined
    },
  }
}
