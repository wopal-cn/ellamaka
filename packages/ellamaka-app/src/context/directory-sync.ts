import { batch, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@wopal/ellamaka-core/util/binary"
import { retry } from "@wopal/ellamaka-core/util/retry"
import {
  clearSessionPrefetch,
  getSessionPrefetch,
  getSessionPrefetchPromise,
  setSessionPrefetch,
} from "./global-sync/session-prefetch"
import { createServerSyncContext } from "./server-sync"
import type { Message, Part, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { SESSION_CACHE_LIMIT, dropSessionCaches, pickSessionCacheEvictions } from "./global-sync/session-cache"
import { message as clean } from "@/utils/diffs"
import { useServerSDK } from "./server-sdk"
import { cmpMessage, keyOf } from "./global-sync/utils"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])

function sortParts(parts: Part[]) {
  return parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id))
}

function startInflight(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>) {
  let promise: Promise<void>
  promise = task().finally(() => {
    // A forced task can replace the map entry while an earlier task settles.
    // Only its own finalizer may remove the current entry.
    if (map.get(key) === promise) map.delete(key)
  })
  map.set(key, promise)
  return promise
}

export function runInflight(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>) {
  return map.get(key) ?? startInflight(map, key, task)
}

/**
 * Runs a recovery read after any active request for the same session. The
 * active request may have begun before an SSE gap, so reusing it would return
 * the stale data that recovery is meant to replace.
 */
export function forceInflight(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>) {
  const pending = map.get(key)
  return startInflight(map, key, pending ? () => pending.then(task, task) : task)
}

const keyFor = (directory: string, id: string) => `${directory}\n${id}`

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * GET /session/status stores only non-idle sessions. An absent entry is
 * therefore a positive idle result, never a reason to preserve a previously
 * streamed busy status.
 */
export function sessionStatusFromSnapshot(
  snapshot: Record<string, SessionStatus> | undefined,
  sessionID: string,
): SessionStatus {
  return snapshot?.[sessionID] ?? { type: "idle" }
}

const isNotFound = (error: unknown) =>
  error instanceof Error &&
  typeof error.cause === "object" &&
  error.cause !== null &&
  (error.cause as { status?: unknown }).status === 404

function merge<T extends { id: string; time?: { created: number } }>(a: readonly T[], b: readonly T[]) {
  const map = new Map(a.map((item) => [item.id, item] as const))
  for (const item of b) map.set(item.id, item)
  return [...map.values()].sort(cmpMessage)
}

type OptimisticStore = {
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
}

type OptimisticAddInput = {
  sessionID: string
  message: Message
  parts: Part[]
}

type OptimisticRemoveInput = {
  sessionID: string
  messageID: string
}

type OptimisticItem = {
  message: Message
  parts: Part[]
}

type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
}

const hasParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return want.length === 0
  return want.every((part) => Binary.search(parts, part.id, (item) => item.id).found)
}

/**
 * Decides whether `sync` must fetch message pages from the server.
 *
 * `loadMessages` bails out on its `meta.loading` re-entrancy guard. Prefetch
 * seeding can flip that flag between the check here and the call, and a
 * forced reload must run regardless of any leftover `loading` state — an
 * early skip in that path leaves the flag stuck and the session's messages
 * never load (the stale-history-after-fork bug). So when `force` is set the
 * delegation answer is always true and the loading flag is owned entirely by
 * `loadMessages`.
 */
export function shouldDelegateMessageLoad(input: { force?: boolean; cached: boolean; hasSession: boolean }) {
  if (input.force) return true
  return !(input.cached && input.hasSession)
}

/**
 * SSE reconnect reconciliation. Events emitted while the transport was down are
 * lost; on resync probe the newest server-side message id for each active
 * session and force a full message reload only when the cached tail is stale.
 */
export function reconcileActiveSessions(input: {
  store: { message: Record<string, Message[] | undefined> }
  loading: Record<string, boolean | undefined>
  keyFor: (directory: string, sessionID: string) => string
  directory: string
  /** Limits reconciliation to explicitly visible sessions when supplied. */
  sessionIDs?: Iterable<string>
  fetchLatest: (sessionID: string) => Promise<string | undefined>
  sync: (sessionID: string, opts: { force: true }) => Promise<unknown> | unknown
}) {
  const ids = input.sessionIDs ? [...input.sessionIDs] : Object.keys(input.store.message)
  for (const sessionID of ids) {
    const cached = input.store.message[sessionID] ?? []
    if (cached.length === 0) continue
    const newestCached = cached[cached.length - 1]!
    const key = input.keyFor(input.directory, sessionID)
    if (input.loading[key]) continue
    void input
      .fetchLatest(sessionID)
      .then((latest) => {
        if (!latest || latest === newestCached.id) return
        return input.sync(sessionID, { force: true })
      })
      .catch(() => {})
  }
}

const mergeParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return sortParts(want)
  const next = [...parts]
  let changed = false
  for (const part of want) {
    const result = Binary.search(next, part.id, (item) => item.id)
    if (result.found) continue
    next.splice(result.index, 0, part)
    changed = true
  }
  if (!changed) return parts
  return next
}

export function mergeOptimisticPage(page: MessagePage, items: OptimisticItem[]) {
  if (items.length === 0) return { ...page, confirmed: [] as string[] }

  const session = [...page.session]
  const part = new Map(page.part.map((item) => [item.id, sortParts(item.part)]))
  const confirmed: string[] = []

  for (const item of items) {
    // The same message (same id) may already exist with a different
    // `time.created` (optimistic local time vs. confirmed server time), so
    // locate by id to avoid duplicating it; only insert when truly absent.
    const existing = session.findIndex((m) => m.id === item.message.id)
    const found = existing >= 0
    if (!found) {
      const result = Binary.search(session, keyOf(item.message), keyOf)
      session.splice(result.index, 0, item.message)
    }

    const current = part.get(item.message.id)
    if (found && hasParts(current, item.parts)) {
      confirmed.push(item.message.id)
      continue
    }

    part.set(item.message.id, mergeParts(current, item.parts))
  }

  return {
    cursor: page.cursor,
    complete: page.complete,
    session,
    part: [...part.entries()].sort((a, b) => cmp(a[0], b[0])).map(([id, part]) => ({ id, part })),
    confirmed,
  }
}

export function applyOptimisticAdd(draft: OptimisticStore, input: OptimisticAddInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    // Locate by id so an optimistic/confirmed pair never duplicates; insert by
    // the time-ordered composite key only when the message is truly absent.
    if (messages.findIndex((m) => m.id === input.message.id) < 0) {
      const result = Binary.search(messages, keyOf(input.message), keyOf)
      messages.splice(result.index, 0, input.message)
    }
  } else {
    draft.message[input.sessionID] = [input.message]
  }
  draft.part[input.message.id] = sortParts(input.parts)
}

export function applyOptimisticRemove(draft: OptimisticStore, input: OptimisticRemoveInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    // message.removed only carries the id (no time), so locate linearly.
    const index = messages.findIndex((m) => m.id === input.messageID)
    if (index >= 0) messages.splice(index, 1)
  }
  delete draft.part[input.messageID]
}

function setOptimisticAdd(setStore: (...args: unknown[]) => void, input: OptimisticAddInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return [input.message]
    if (messages.findIndex((m) => m.id === input.message.id) >= 0) return messages
    const result = Binary.search(messages, keyOf(input.message), keyOf)
    const next = [...messages]
    next.splice(result.index, 0, input.message)
    return next
  })
  setStore("part", input.message.id, sortParts(input.parts))
}

function setOptimisticRemove(setStore: (...args: unknown[]) => void, input: OptimisticRemoveInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return messages
    // message.removed only carries the id (no time), so locate linearly.
    const index = messages.findIndex((m) => m.id === input.messageID)
    if (index < 0) return messages
    const next = [...messages]
    next.splice(index, 1)
    return next
  })
  setStore("part", (part: Record<string, Part[] | undefined>) => {
    if (!(input.messageID in part)) return part
    const next = { ...part }
    delete next[input.messageID]
    return next
  })
}

export const createDirSyncContext = (directory: string, serverSync: ReturnType<typeof createServerSyncContext>) => {
  const serverSDK = useServerSDK()
  const client = serverSDK.createClient({ directory, throwOnError: true })

  type Child = ReturnType<(typeof serverSync)["child"]>
  type Setter = Child[1]

  const current = createMemo(() => serverSync.child(directory, { mcp: true }))
  const target = (directory?: string) => {
    if (!directory || directory === directory) return current()
    return serverSync.child(directory)
  }
  const absolute = (path: string) => (current()[0].path.directory + "/" + path).replace("//", "/")
  const initialMessagePageSize = 80
  const historyMessagePageSize = 200
  const inflight = new Map<string, Promise<void>>()
  const inflightTodo = new Map<string, Promise<void>>()
  const optimistic = new Map<string, Map<string, OptimisticItem>>()
  const maxDirs = 30
  const seen = new Map<string, Set<string>>()
  // Workbench keeps previously visited Panels mounted. Registering their
  // visibility here lets an SSE reconnect defer reconciliation for background
  // Panels until the user returns, while ordinary directory pages preserve
  // their existing eager reconnect behavior.
  const reconnectRegistrations = new Map<string, Set<Accessor<boolean>>>()
  const [reconnectVersion, setReconnectVersion] = createSignal(0)
  const [meta, setMeta] = createStore({
    limit: {} as Record<string, number>,
    cursor: {} as Record<string, string | undefined>,
    complete: {} as Record<string, boolean>,
    loading: {} as Record<string, boolean>,
  })

  const getSession = (sessionID: string) => {
    const store = current()[0]
    const match = Binary.search(store.session, sessionID, (s) => s.id)
    if (match.found) return store.session[match.index]
    return undefined
  }

  const setOptimistic = (directory: string, sessionID: string, item: OptimisticItem) => {
    const key = keyFor(directory, sessionID)
    const list = optimistic.get(key)
    if (list) {
      list.set(item.message.id, { message: item.message, parts: sortParts(item.parts) })
      return
    }
    optimistic.set(key, new Map([[item.message.id, { message: item.message, parts: sortParts(item.parts) }]]))
  }

  const clearOptimistic = (directory: string, sessionID: string, messageID?: string) => {
    const key = keyFor(directory, sessionID)
    if (!messageID) {
      optimistic.delete(key)
      return
    }

    const list = optimistic.get(key)
    if (!list) return
    list.delete(messageID)
    if (list.size === 0) optimistic.delete(key)
  }

  const getOptimistic = (directory: string, sessionID: string) => [
    ...(optimistic.get(keyFor(directory, sessionID))?.values() ?? []),
  ]

  const seenFor = (directory: string) => {
    const existing = seen.get(directory)
    if (existing) {
      seen.delete(directory)
      seen.set(directory, existing)
      return existing
    }
    const created = new Set<string>()
    seen.set(directory, created)
    while (seen.size > maxDirs) {
      const first = seen.keys().next().value
      if (!first) break
      const stale = [...(seen.get(first) ?? [])]
      seen.delete(first)
      const [, setStore] = serverSync.child(first, { bootstrap: false })
      evict(first, setStore, stale)
    }
    return created
  }

  const clearMeta = (directory: string, sessionIDs: string[]) => {
    if (sessionIDs.length === 0) return
    for (const sessionID of sessionIDs) {
      clearOptimistic(directory, sessionID)
    }
    setMeta(
      produce((draft) => {
        for (const sessionID of sessionIDs) {
          const key = keyFor(directory, sessionID)
          delete draft.limit[key]
          delete draft.cursor[key]
          delete draft.complete[key]
          delete draft.loading[key]
        }
      }),
    )
  }

  const evict = (directory: string, setStore: Setter, sessionIDs: string[]) => {
    if (sessionIDs.length === 0) return
    clearSessionPrefetch(directory, sessionIDs)
    for (const sessionID of sessionIDs) {
      serverSync.todo.set(sessionID, undefined)
    }
    setStore(
      produce((draft) => {
        dropSessionCaches(draft, sessionIDs)
      }),
    )
    clearMeta(directory, sessionIDs)
  }

  const touch = (directory: string, setStore: Setter, sessionID: string) => {
    const stale = pickSessionCacheEvictions({
      seen: seenFor(directory),
      keep: sessionID,
      limit: SESSION_CACHE_LIMIT,
    })
    evict(directory, setStore, stale)
  }

  const fetchMessages = async (input: { client: typeof client; sessionID: string; limit: number; before?: string }) => {
    const messages = await retry(() =>
      input.client.session.messages({ sessionID: input.sessionID, limit: input.limit, before: input.before }),
    )
    const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
    const session = items.map((x) => clean(x.info)).sort(cmpMessage)
    const part = items.map((message) => ({ id: message.info.id, part: sortParts(message.parts) }))
    const cursor = messages.response.headers.get("x-next-cursor") ?? undefined
    return {
      session,
      part,
      cursor,
      complete: !cursor,
    }
  }

  const tracked = (directory: string, sessionID: string) => seen.get(directory)?.has(sessionID) ?? false

  const loadMessages = async (input: {
    directory: string
    client: typeof client
    setStore: Setter
    sessionID: string
    limit: number
    before?: string
    mode?: "replace" | "prepend"
    force?: boolean
  }) => {
    const key = keyFor(input.directory, input.sessionID)
    if (meta.loading[key] && !input.force) return

    setMeta("loading", key, true)
    await fetchMessages(input)
      .then((page) => {
        if (!tracked(input.directory, input.sessionID)) return
        const next = mergeOptimisticPage(page, getOptimistic(input.directory, input.sessionID))
        for (const messageID of next.confirmed) {
          clearOptimistic(input.directory, input.sessionID, messageID)
        }
        const [store] = serverSync.child(input.directory, { bootstrap: false })
        const cached = input.mode === "prepend" ? (store.message[input.sessionID] ?? []) : []
        const message = input.mode === "prepend" ? merge(cached, next.session) : next.session
        batch(() => {
          input.setStore("message", input.sessionID, reconcile(message, { key: "id" }))
          for (const p of next.part) {
            const filtered = p.part.filter((x) => !SKIP_PARTS.has(x.type))
            if (filtered.length) input.setStore("part", p.id, filtered)
          }
          setMeta("limit", key, message.length)
          setMeta("cursor", key, next.cursor)
          setMeta("complete", key, next.complete)
          setSessionPrefetch({
            directory: input.directory,
            sessionID: input.sessionID,
            limit: message.length,
            cursor: next.cursor,
            complete: next.complete,
          })
        })
      })
      .catch((error) => {
        if (isNotFound(error) && !tracked(input.directory, input.sessionID)) return
        throw error
      })
      .finally(() => {
        setMeta(
          produce((draft) => {
            if (!tracked(input.directory, input.sessionID)) {
              delete draft.loading[key]
              return
            }
            draft.loading[key] = false
          }),
        )
      })
  }

  const context = {
    get data() {
      return current()[0]
    },
    get set(): Setter {
      return current()[1]
    },
    get status() {
      return current()[0].status
    },
    get ready() {
      return current()[0].status !== "loading"
    },
    get project() {
      const store = current()[0]
      const match = Binary.search(serverSync.data.project, store.project, (p) => p.id)
      if (match.found) return serverSync.data.project[match.index]
      return undefined
    },
    session: {
      get: getSession,
      /** Opt into visibility-aware reconnect recovery for an embedded Panel. */
      registerReconnect(sessionID: string, isVisible: Accessor<boolean>) {
        let entries = reconnectRegistrations.get(sessionID)
        if (!entries) {
          entries = new Set()
          reconnectRegistrations.set(sessionID, entries)
        }
        entries.add(isVisible)
        return () => {
          const current = reconnectRegistrations.get(sessionID)
          if (!current) return
          current.delete(isVisible)
          if (current.size === 0) reconnectRegistrations.delete(sessionID)
        }
      },
      /** Increments after a server reconnect for registered Workbench Panels. */
      get reconnectVersion() {
        return reconnectVersion()
      },
      optimistic: {
        add(input: { directory?: string; sessionID: string; message: Message; parts: Part[] }) {
          const _directory = input.directory ?? directory
          const [, setStore] = target(input.directory)
          setOptimistic(_directory, input.sessionID, { message: input.message, parts: input.parts })
          setOptimisticAdd(setStore as (...args: unknown[]) => void, input)
        },
        remove(input: { directory?: string; sessionID: string; messageID: string }) {
          const _directory = input.directory ?? directory
          const [, setStore] = target(input.directory)
          clearOptimistic(_directory, input.sessionID, input.messageID)
          setOptimisticRemove(setStore as (...args: unknown[]) => void, input)
        },
      },
      addOptimisticMessage(input: {
        sessionID: string
        messageID: string
        parts: Part[]
        agent: string
        model: { providerID: string; modelID: string }
        variant?: string
      }) {
        const message: Message = {
          id: input.messageID,
          sessionID: input.sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: input.agent,
          model: { ...input.model, variant: input.variant },
        }
        const [, setStore] = target()
        setOptimistic(directory, input.sessionID, { message, parts: input.parts })
        setOptimisticAdd(setStore as (...args: unknown[]) => void, {
          sessionID: input.sessionID,
          message,
          parts: input.parts,
        })
      },
      async sync(sessionID: string, opts?: { force?: boolean }) {
        const [store, setStore] = serverSync.child(directory)
        const key = keyFor(directory, sessionID)

        touch(directory, setStore, sessionID)

        const seeded = getSessionPrefetch(directory, sessionID)
        if (seeded && store.message[sessionID] !== undefined && meta.limit[key] === undefined) {
          batch(() => {
            setMeta("limit", key, seeded.limit)
            setMeta("cursor", key, seeded.cursor)
            setMeta("complete", key, seeded.complete)
            setMeta("loading", key, false)
          })
        }

        const load = opts?.force ? forceInflight : runInflight
        return load(inflight, key, async () => {
          if (opts?.force) setMeta("loading", key, true)
          const pending = getSessionPrefetchPromise(directory, sessionID)
          if (pending) {
            await pending
            const seeded = getSessionPrefetch(directory, sessionID)
            if (seeded && store.message[sessionID] !== undefined && meta.limit[key] === undefined) {
              batch(() => {
                setMeta("limit", key, seeded.limit)
                setMeta("cursor", key, seeded.cursor)
                setMeta("complete", key, seeded.complete)
                setMeta("loading", key, false)
              })
            }
          }

          const hasSession = Binary.search(store.session, sessionID, (s) => s.id).found
          const cached = store.message[sessionID] !== undefined && meta.limit[key] !== undefined
          if (!shouldDelegateMessageLoad({ force: opts?.force, cached, hasSession })) return

          const limit = meta.limit[key] ?? initialMessagePageSize
          const sessionReq =
            hasSession && !opts?.force
              ? Promise.resolve()
              : retry(() => client.session.get({ sessionID }))
                  .then((session) => {
                    if (!tracked(directory, sessionID)) return
                    const data = session.data
                    if (!data) return
                    setStore(
                      "session",
                      produce((draft) => {
                        const match = Binary.search(draft, sessionID, (s) => s.id)
                        if (match.found) {
                          draft[match.index] = data
                          return
                        }
                        draft.splice(match.index, 0, data)
                      }),
                    )
                  })
                  .catch((error) => {
                    if (isNotFound(error) && !tracked(directory, sessionID)) return
                    throw error
                  })

          const messagesReq = loadMessages({
            directory,
            client,
            setStore,
            sessionID,
            limit,
            force: opts?.force,
          })

          // A reconnect can miss both the final message update and its
          // session.status idle event. Message reload alone repairs the
          // transcript but leaves the live-activity tail spinning forever.
          // Read the authoritative status snapshot for the recovered session
          // and turn an omitted entry into idle.
          const statusReq = opts?.force
            ? retry(() => client.session.status()).then((status) => {
                if (!tracked(directory, sessionID)) return
                setStore("session_status", sessionID, reconcile(sessionStatusFromSnapshot(status.data, sessionID)))
              })
            : Promise.resolve()

          await Promise.all([sessionReq, messagesReq, statusReq])
        })
      },
      async todo(sessionID: string, opts?: { force?: boolean }) {
        const [store, setStore] = serverSync.child(directory)
        touch(directory, setStore, sessionID)
        const existing = store.todo[sessionID]
        const cached = serverSync.data.session_todo[sessionID]
        if (existing !== undefined) {
          if (cached === undefined) {
            serverSync.todo.set(sessionID, existing)
          }
          if (!opts?.force) return
        }

        if (cached !== undefined) {
          setStore("todo", sessionID, reconcile(cached, { key: "id" }))
        }

        const key = keyFor(directory, sessionID)
        return runInflight(inflightTodo, key, () =>
          retry(() => client.session.todo({ sessionID })).then((todo) => {
            if (!tracked(directory, sessionID)) return
            const list = todo.data ?? []
            setStore("todo", sessionID, reconcile(list, { key: "id" }))
            serverSync.todo.set(sessionID, list)
          }),
        )
      },
      history: {
        more(sessionID: string) {
          const store = current()[0]
          const key = keyFor(directory, sessionID)
          if (store.message[sessionID] === undefined) return false
          if (meta.limit[key] === undefined) return false
          if (meta.complete[key]) return false
          return !!meta.cursor[key]
        },
        loading(sessionID: string) {
          const key = keyFor(directory, sessionID)
          return meta.loading[key] ?? false
        },
        async loadMore(sessionID: string, count?: number) {
          const [, setStore] = serverSync.child(directory)
          touch(directory, setStore, sessionID)
          const key = keyFor(directory, sessionID)
          const step = count ?? historyMessagePageSize
          if (meta.loading[key]) return
          if (meta.complete[key]) return
          const before = meta.cursor[key]
          if (!before) return

          await loadMessages({
            directory,
            client,
            setStore,
            sessionID,
            limit: step,
            before,
            mode: "prepend",
          })
        },
      },
      evict(sessionID: string, _directory = directory) {
        const [, setStore] = serverSync.child(_directory)
        seenFor(_directory).delete(sessionID)
        evict(_directory, setStore, [sessionID])
      },
      fetch: async (count = 10) => {
        const [store, setStore] = serverSync.child(directory)
        setStore("limit", (x) => x + count)
        await client.session.list().then((x) => {
          const sessions = (x.data ?? [])
            .filter((s) => !!s?.id)
            .sort((a, b) => cmp(a.id, b.id))
            .slice(0, store.limit)
          setStore("session", reconcile(sessions, { key: "id" }))
        })
      },
      more: createMemo(() => current()[0].session.length >= current()[0].limit),
      archive: async (sessionID: string) => {
        const [, setStore] = serverSync.child(directory)
        await client.session.update({ sessionID, time: { archived: Date.now() } })
        setStore(
          produce((draft) => {
            const match = Binary.search(draft.session, sessionID, (s) => s.id)
            if (match.found) draft.session.splice(match.index, 1)
          }),
        )
      },
    },
    absolute,
    get directory() {
      return current()[0].path.directory
    },
  }

  const reconcileOnReconnect = (sessionIDs?: Iterable<string>) =>
    reconcileActiveSessions({
      store: current()[0],
      loading: meta.loading,
      keyFor,
      directory,
      sessionIDs,
      fetchLatest: (sessionID) =>
        client.session.messages({ sessionID, limit: 1 }).then((res) => res.data?.[0]?.info?.id),
      sync: context.session.sync,
    })

  const unsubResync = serverSDK.event.onResync(() => {
    // A registered Workbench Panel owns its own recovery. It will read the
    // version above only while visible; keeping the Panel mounted in a hidden
    // Space therefore cannot recreate an instance after the backend restarts.
    if (reconnectRegistrations.size > 0) {
      setReconnectVersion((value) => value + 1)
      return
    }
    reconcileOnReconnect()
  })
  onCleanup(unsubResync)

  return context
}
