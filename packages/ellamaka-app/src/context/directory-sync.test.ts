import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import {
  forceInflight,
  reconcileActiveSessions,
  runInflight,
  sessionStatusFromSnapshot,
  shouldDelegateMessageLoad,
} from "./directory-sync"

const message = (id: string, sessionID: string): Message =>
  ({
    id,
    sessionID,
    role: "assistant",
    time: { created: 1 },
  }) as Message

describe("reconcileActiveSessions", () => {
  test("does not sync when cached tail matches the latest server message", async () => {
    const synced: string[] = []
    reconcileActiveSessions({
      store: { message: { ses_1: [message("m1", "ses_1"), message("m2", "ses_1")] } },
      loading: {},
      keyFor: (dir, id) => `${dir}\n${id}`,
      directory: "dir",
      fetchLatest: async () => "m2",
      sync: (id) => {
        synced.push(id)
      },
    })
    await Promise.resolve()
    expect(synced).toEqual([])
  })

  test("forces sync when the cached tail is stale after a reconnect", async () => {
    const synced: Array<{ id: string; force: boolean }> = []
    reconcileActiveSessions({
      store: { message: { ses_1: [message("m1", "ses_1"), message("m2", "ses_1")] } },
      loading: {},
      keyFor: (dir, id) => `${dir}\n${id}`,
      directory: "dir",
      fetchLatest: async () => "m3",
      sync: (id, opts) => {
        synced.push({ id, force: opts.force })
      },
    })
    await Promise.resolve()
    expect(synced).toEqual([{ id: "ses_1", force: true }])
  })

  test("skips sessions that are already loading", async () => {
    const synced: string[] = []
    reconcileActiveSessions({
      store: { message: { ses_1: [message("m1", "ses_1")] } },
      loading: { "dir\nses_1": true },
      keyFor: (dir, id) => `${dir}\n${id}`,
      directory: "dir",
      fetchLatest: async () => "m2",
      sync: (id) => {
        synced.push(id)
      },
    })
    await Promise.resolve()
    expect(synced).toEqual([])
  })

  test("can limit a reconnect to the visible Panel's session", async () => {
    const checked: string[] = []
    const synced: string[] = []
    reconcileActiveSessions({
      store: {
        message: {
          ses_visible: [message("m1", "ses_visible")],
          ses_hidden: [message("m1", "ses_hidden")],
        },
      },
      loading: {},
      keyFor: (dir, id) => `${dir}\\n${id}`,
      directory: "dir",
      sessionIDs: ["ses_visible"],
      fetchLatest: async (id) => {
        checked.push(id)
        return "m2"
      },
      sync: (id) => {
        synced.push(id)
      },
    })
    await Promise.resolve()
    expect(checked).toEqual(["ses_visible"])
    expect(synced).toEqual(["ses_visible"])
  })

  test("ignores empty caches and missing latest id", async () => {
    const synced: string[] = []
    reconcileActiveSessions({
      store: { message: { ses_1: [] } },
      loading: {},
      keyFor: (dir, id) => `${dir}\n${id}`,
      directory: "dir",
      fetchLatest: async () => undefined,
      sync: (id) => {
        synced.push(id)
      },
    })
    await Promise.resolve()
    expect(synced).toEqual([])
  })
})

describe("shouldDelegateMessageLoad", () => {
  test("delegates load when nothing is cached", () => {
    expect(
      shouldDelegateMessageLoad({
        force: false,
        cached: false,
        hasSession: false,
      }),
    ).toBe(true)
  })

  test("skips cached load, then force re-loads even though loading flag is on", () => {
    // The loading flag is only observable through delegation: when force is
    // set, loadMessages must run even if a (stale or self-set) loading flag
    // would tell it to bail, otherwise the flag leaks forever and the
    // session's messages never load.
    expect(
      shouldDelegateMessageLoad({
        force: true,
        cached: true,
        hasSession: true,
      }),
    ).toBe(true)
  })

  test("skips load for a cached session without force", () => {
    expect(
      shouldDelegateMessageLoad({
        force: false,
        cached: true,
        hasSession: true,
      }),
    ).toBe(false)
  })

  test("loads an uncached session even when it is listed", () => {
    expect(
      shouldDelegateMessageLoad({
        force: false,
        cached: false,
        hasSession: true,
      }),
    ).toBe(true)
  })
})

describe("reconnect recovery", () => {
  test("runs a forced reload after an in-flight cached load instead of reusing its stale result", async () => {
    const inflight = new Map<string, Promise<void>>()
    let releaseInitial: (() => void) | undefined
    let runs = 0

    const initial = runInflight(inflight, "dir\\nses_1", async () => {
      runs += 1
      await new Promise<void>((resolve) => {
        releaseInitial = resolve
      })
    })
    await Promise.resolve()

    const recovered = forceInflight(inflight, "dir\\nses_1", async () => {
      runs += 1
    })

    expect(runs).toBe(1)
    releaseInitial?.()
    await Promise.all([initial, recovered])

    expect(runs).toBe(2)
    expect(inflight.size).toBe(0)
  })

  test("treats a missing status-snapshot entry as idle after a reconnect", () => {
    // The server intentionally omits idle sessions from GET /session/status.
    // Leaving the old busy entry in the client would keep the Chat tail
    // spinning indefinitely even after the final message was persisted.
    expect(sessionStatusFromSnapshot({}, "ses_1")).toEqual({ type: "idle" })
  })
})
