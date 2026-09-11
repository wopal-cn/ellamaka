import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { reconcileActiveSessions, shouldDelegateMessageLoad } from "./directory-sync"

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
