import { describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2/client"
import { createSessionActivity, type SessionActivity } from "./session-activity"

const busy = (sessionID: string, directory = "/cold"): SessionActivity => ({
  sessionID,
  directory,
  status: { type: "busy" },
})
const status = (sessionID: string, type: "busy" | "idle"): Event => ({
  id: `event-${sessionID}-${type}`,
  type: "session.status",
  properties: { sessionID, status: { type } },
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("Session activity read projection", () => {
  test("reads running sessions from cold directories without a directory client", async () => {
    let reads = 0
    const activity = createSessionActivity({
      snapshot: async () => {
        reads++
        return [busy("s1")]
      },
      onError: () => {},
    })
    await activity.refresh()
    expect(reads).toBe(1)
    expect(activity.status("s1").type).toBe("busy")
    activity.receive("/other-cold", status("s2", "busy"))
    expect(activity.entries().map((x) => x.directory)).toEqual(["/cold", "/other-cold"])
    activity.receive("/cold", status("s1", "idle"))
    expect(activity.status("s1").type).toBe("idle")
  })

  test("a late snapshot cannot overwrite completion or instance disposal events", async () => {
    const request = deferred<SessionActivity[]>()
    const activity = createSessionActivity({ snapshot: () => request.promise, onError: () => {} })
    const loading = activity.refresh()
    activity.receive("/cold", status("s1", "idle"))
    activity.receive("global", {
      id: "dispose",
      type: "server.instance.disposed",
      properties: { directory: "/disposed" },
    })
    activity.receive("/live", status("s3", "busy"))
    request.resolve([busy("s1"), busy("s2", "/disposed")])
    await loading
    expect(activity.entries()).toEqual([busy("s3", "/live")])
  })

  test("reconnect snapshot clears missed idle events and ignores superseded responses", async () => {
    const old = deferred<SessionActivity[]>()
    let reads = 0
    const activity = createSessionActivity({
      snapshot: () => (++reads === 1 ? old.promise : Promise.resolve([])),
      onError: () => {},
    })
    activity.receive("/cold", status("s1", "busy"))
    const first = activity.refresh()
    await activity.refresh()
    old.resolve([busy("s1")])
    await first
    expect(activity.entries()).toEqual([])
  })

  test("failed refresh preserves live updates and reports the error", async () => {
    const errors: unknown[] = []
    const activity = createSessionActivity({
      snapshot: async () => {
        throw new Error("offline")
      },
      onError: (e) => errors.push(e),
    })
    activity.receive("/cold", status("s1", "busy"))
    await activity.refresh()
    expect(activity.status("s1").type).toBe("busy")
    expect(errors).toHaveLength(1)
    activity.dispose()
    activity.receive("/cold", status("s1", "idle"))
    expect(activity.status("s1").type).toBe("busy")
  })
})
