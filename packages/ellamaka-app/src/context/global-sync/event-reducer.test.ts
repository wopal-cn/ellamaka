import { describe, expect, test } from "bun:test"
import type { Message, Part, PermissionRequest, Project, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
import type { State } from "./types"
import { applyDirectoryEvent, applyGlobalEvent, cleanupDroppedSessionCaches } from "./event-reducer"

const rootSession = (input: { id: string; parentID?: string; archived?: number }) =>
  ({
    id: input.id,
    parentID: input.parentID,
    time: {
      created: 1,
      updated: 1,
      archived: input.archived,
    },
  }) as Session

const userMessage = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "assistant",
    model: { providerID: "openai", modelID: "gpt" },
  }) as Message

const textPart = (id: string, sessionID: string, messageID: string) =>
  ({
    id,
    sessionID,
    messageID,
    type: "text",
    text: id,
  }) as Part

const permissionRequest = (id: string, sessionID: string, title = id) =>
  ({
    id,
    sessionID,
    permission: title,
    patterns: ["*"],
    metadata: {},
    always: [],
  }) as PermissionRequest

const questionRequest = (id: string, sessionID: string, title = id) =>
  ({
    id,
    sessionID,
    questions: [
      {
        question: title,
        header: title,
        options: [{ label: title, description: title }],
      },
    ],
  }) as QuestionRequest

const baseState = (input: Partial<State> = {}) =>
  ({
    status: "complete",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider: {} as State["provider"],
    config: {} as State["config"],
    path: { directory: "/tmp" } as State["path"],
    session: [],
    sessionTotal: 0,
    session_status: {},
    todo: {},
    permission: {},
    question: {},
    mcp: {},
    lsp: [],
    vcs: undefined,
    limit: 10,
    message: {},
    part: {},
    part_text_accum_delta: {},
    ...input,
  }) as State

describe("applyGlobalEvent", () => {
  test("upserts project.updated in sorted position", () => {
    const project = [{ id: "a" }, { id: "c" }] as Project[]
    let refreshCount = 0
    applyGlobalEvent({
      event: { type: "project.updated", properties: { id: "b" } },
      project,
      refresh: () => {
        refreshCount += 1
      },
      setGlobalProject(next) {
        if (typeof next === "function") next(project)
      },
    })

    expect(project.map((x) => x.id)).toEqual(["a", "b", "c"])
    expect(refreshCount).toBe(0)
  })

  test("handles global.disposed by triggering refresh", () => {
    let refreshCount = 0
    applyGlobalEvent({
      event: { type: "global.disposed" },
      project: [],
      refresh: () => {
        refreshCount += 1
      },
      setGlobalProject() {},
    })

    expect(refreshCount).toBe(1)
  })

  test("keeps current data for a transport reconnection", () => {
    let refreshCount = 0
    applyGlobalEvent({
      event: { type: "server.connected" },
      project: [],
      refresh: () => {
        refreshCount += 1
      },
      setGlobalProject() {},
    })

    expect(refreshCount).toBe(0)
  })
})

describe("applyDirectoryEvent", () => {
  test("inserts root sessions in sorted order and updates sessionTotal", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "b" })],
        sessionTotal: 1,
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: rootSession({ id: "a" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session.map((x) => x.id)).toEqual(["a", "b"])
    expect(store.sessionTotal).toBe(2)

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: rootSession({ id: "c", parentID: "a" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.sessionTotal).toBe(2)
  })

  test("cleans session caches when archived", () => {
    const message = userMessage("msg_1", "ses_1")
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "ses_1" }), rootSession({ id: "ses_2" })],
        sessionTotal: 2,
        message: { ses_1: [message] },
        part: { [message.id]: [textPart("prt_1", "ses_1", message.id)] },
        todo: { ses_1: [] },
        permission: { ses_1: [] },
        question: { ses_1: [] },
        session_status: { ses_1: { type: "busy" } },
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.updated", properties: { info: rootSession({ id: "ses_1", archived: 10 }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session.map((x) => x.id)).toEqual(["ses_2"])
    expect(store.sessionTotal).toBe(1)
    expect(store.message.ses_1).toEqual([message])
    expect(store.part[message.id]).toEqual([textPart("prt_1", "ses_1", message.id)])
    expect(store.todo.ses_1).toBeUndefined()
    expect(store.permission.ses_1).toBeUndefined()
    expect(store.question.ses_1).toBeUndefined()
    expect(store.session_status.ses_1).toBeUndefined()
  })

  test("cleans session caches when deleted and decrements only root totals", () => {
    const cases = [
      { info: rootSession({ id: "ses_1" }), expectedTotal: 1 },
      { info: rootSession({ id: "ses_2", parentID: "ses_1" }), expectedTotal: 2 },
    ]

    for (const item of cases) {
      const message = userMessage("msg_1", item.info.id)
      const [store, setStore] = createStore(
        baseState({
          session: [
            rootSession({ id: "ses_1" }),
            rootSession({ id: "ses_2", parentID: "ses_1" }),
            rootSession({ id: "ses_3" }),
          ],
          sessionTotal: 2,
          message: { [item.info.id]: [message] },
          part: { [message.id]: [textPart("prt_1", item.info.id, message.id)] },
          todo: { [item.info.id]: [] },
          permission: { [item.info.id]: [] },
          question: { [item.info.id]: [] },
          session_status: { [item.info.id]: { type: "busy" } },
        }),
      )

      applyDirectoryEvent({
        event: { type: "session.deleted", properties: { info: item.info } },
        store,
        setStore,
        push() {},
        directory: "/tmp",
        loadLsp() {},
      })

      expect(store.session.find((x) => x.id === item.info.id)).toBeUndefined()
      expect(store.sessionTotal).toBe(item.expectedTotal)
      expect(store.message[item.info.id]).toEqual([message])
      expect(store.part[message.id]).toEqual([textPart("prt_1", item.info.id, message.id)])
      expect(store.todo[item.info.id]).toBeUndefined()
      expect(store.permission[item.info.id]).toBeUndefined()
      expect(store.question[item.info.id]).toBeUndefined()
      expect(store.session_status[item.info.id]).toBeUndefined()
    }
  })

  test("cleans caches for trimmed sessions on session.created but preserves message history", () => {
    const dropped = rootSession({ id: "ses_b" })
    const kept = rootSession({ id: "ses_a" })
    const message = userMessage("msg_1", dropped.id)
    const todos: string[] = []
    const [store, setStore] = createStore(
      baseState({
        limit: 1,
        session: [dropped],
        message: { [dropped.id]: [message] },
        part: { [message.id]: [textPart("prt_1", dropped.id, message.id)] },
        todo: { [dropped.id]: [] },
        permission: { [dropped.id]: [] },
        question: { [dropped.id]: [] },
        session_status: { [dropped.id]: { type: "busy" } },
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: kept } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      setSessionTodo(sessionID, value) {
        if (value !== undefined) return
        todos.push(sessionID)
      },
    })

    expect(store.session.map((x) => x.id)).toEqual([kept.id])
    expect(store.message[dropped.id]).toEqual([message])
    expect(store.part[message.id]).toEqual([textPart("prt_1", dropped.id, message.id)])
    expect(store.todo[dropped.id]).toBeUndefined()
    expect(store.permission[dropped.id]).toBeUndefined()
    expect(store.question[dropped.id]).toBeUndefined()
    expect(store.session_status[dropped.id]).toBeUndefined()
    expect(todos).toEqual([dropped.id])
  })

  // Snapshot mechanism removed (plan 216): the engine no longer emits
  // session.diff events and the session_diff cache no longer exists, so the
  // reducer must ignore the event entirely.
  test("ignores session.diff events", () => {
    const [store, setStore] = createStore(baseState())

    applyDirectoryEvent({
      event: { type: "session.diff", properties: { sessionID: "ses_1", diff: [] } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect((store as Record<string, unknown>).session_diff).toBeUndefined()
  })

  test("cleanupDroppedSessionCaches preserves part-only state and message history", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "ses_keep" })],
        part: { msg_1: [textPart("prt_1", "ses_drop", "msg_1")] },
      }),
    )

    cleanupDroppedSessionCaches(store, setStore, store.session)

    expect(store.part.msg_1).toEqual([textPart("prt_1", "ses_drop", "msg_1")])
  })

  test("upserts and removes messages while clearing orphaned parts", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(
      baseState({
        message: { [sessionID]: [userMessage("msg_1", sessionID), userMessage("msg_3", sessionID)] },
        part: { msg_2: [textPart("prt_1", sessionID, "msg_2")] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "message.updated", properties: { info: userMessage("msg_2", sessionID) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.map((x) => x.id)).toEqual(["msg_1", "msg_2", "msg_3"])

    applyDirectoryEvent({
      event: {
        type: "message.updated",
        properties: {
          info: {
            ...userMessage("msg_2", sessionID),
            role: "assistant",
          } as Message,
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.find((x) => x.id === "msg_2")?.role).toBe("assistant")

    applyDirectoryEvent({
      event: { type: "message.removed", properties: { sessionID, messageID: "msg_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.map((x) => x.id)).toEqual(["msg_1", "msg_3"])
    expect(store.part.msg_2).toBeUndefined()
  })

  // B-01: message.updated/removed must locate messages in the time-ordered
  // array by the (time.created, id) composite key. A post-wrap id (`msg_00...`)
  // is lexically smaller than pre-wrap ids (`msg_fa...`) even though it is
  // newer, so id-based binary search would re-insert it at the array head and
  // duplicate it, and message.removed would fail to find it.
  test("message.updated upserts a post-wrap message at the array end across wrap-around", () => {
    const sessionID = "ses_1"
    const preWrap = userMessage("msg_fa2c3af72001", sessionID)
    preWrap.time = { created: 1784448447887 }
    const postWrap = userMessage("msg_002ceb729001", sessionID)
    postWrap.time = { created: 1786753496981 }
    const [store, setStore] = createStore(baseState({ message: { [sessionID]: [preWrap] } }))

    applyDirectoryEvent({
      event: { type: "message.updated", properties: { info: postWrap } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.map((x) => x.id)).toEqual(["msg_fa2c3af72001", "msg_002ceb729001"])
  })

  test("repeated message.updated for a post-wrap message does not duplicate it", () => {
    const sessionID = "ses_1"
    const preWrap = userMessage("msg_fa2c3af72001", sessionID)
    preWrap.time = { created: 1784448447887 }
    const postWrap = userMessage("msg_002ceb729001", sessionID)
    postWrap.time = { created: 1786753496981 }
    const [store, setStore] = createStore(baseState({ message: { [sessionID]: [preWrap, postWrap] } }))

    for (let i = 0; i < 3; i++) {
      applyDirectoryEvent({
        event: { type: "message.updated", properties: { info: postWrap } },
        store,
        setStore,
        push() {},
        directory: "/tmp",
        loadLsp() {},
      })
    }

    expect(store.message[sessionID]?.map((x) => x.id)).toEqual(["msg_fa2c3af72001", "msg_002ceb729001"])
  })

  test("message.updated reconciles an existing message whose time.created changed (optimistic vs confirmed)", () => {
    // Regression: an optimistic user message is inserted with a local
    // `Date.now()` timestamp. The confirmed `message.updated` event carries the
    // server's `time.created`, which differs by tens of ms. Locating the message
    // by the (time.created, id) composite key then fails to find the optimistic
    // copy and inserts a duplicate. The same message (same id) must be matched
    // by id and reconciled in place, regardless of the timestamp drift.
    const sessionID = "ses_1"
    const optimistic = userMessage("msg_002ceb729001", sessionID)
    optimistic.time = { created: 1786753496981 } // local Date.now() at send time
    const confirmed = userMessage("msg_002ceb729001", sessionID)
    confirmed.time = { created: 1786753496940 } // server time.created (41ms earlier)
    const [store, setStore] = createStore(baseState({ message: { [sessionID]: [optimistic] } }))

    applyDirectoryEvent({
      event: { type: "message.updated", properties: { info: confirmed } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    const messages = store.message[sessionID] ?? []
    expect(messages).toHaveLength(1)
    expect(messages[0]?.id).toBe("msg_002ceb729001")
    expect(messages[0]?.time.created).toBe(1786753496940)
  })

  test("message.removed removes a post-wrap message located by id", () => {
    const sessionID = "ses_1"
    const preWrap = userMessage("msg_fa2c3af72001", sessionID)
    preWrap.time = { created: 1784448447887 }
    const postWrap = userMessage("msg_002ceb729001", sessionID)
    postWrap.time = { created: 1786753496981 }
    const [store, setStore] = createStore(
      baseState({
        message: { [sessionID]: [preWrap, postWrap] },
        part: { msg_002ceb729001: [textPart("prt_1", sessionID, "msg_002ceb729001")] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "message.removed", properties: { sessionID, messageID: "msg_002ceb729001" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.map((x) => x.id)).toEqual(["msg_fa2c3af72001"])
    expect(store.part.msg_002ceb729001).toBeUndefined()
  })

  test("upserts and prunes message parts", () => {
    const sessionID = "ses_1"
    const messageID = "msg_1"
    const [store, setStore] = createStore(
      baseState({
        part: { [messageID]: [textPart("prt_1", sessionID, messageID), textPart("prt_3", sessionID, messageID)] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "message.part.updated", properties: { part: textPart("prt_2", sessionID, messageID) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.part[messageID]?.map((x) => x.id)).toEqual(["prt_1", "prt_2", "prt_3"])

    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            ...textPart("prt_2", sessionID, messageID),
            text: "changed",
          } as Part,
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    const updated = store.part[messageID]?.find((x) => x.id === "prt_2")
    expect(updated?.type).toBe("text")
    if (updated?.type === "text") expect(updated.text).toBe("changed")

    applyDirectoryEvent({
      event: { type: "message.part.removed", properties: { messageID, partID: "prt_1" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    applyDirectoryEvent({
      event: { type: "message.part.removed", properties: { messageID, partID: "prt_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    applyDirectoryEvent({
      event: { type: "message.part.removed", properties: { messageID, partID: "prt_3" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.part[messageID]).toBeUndefined()
  })

  test("tracks permission and question request lifecycles", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(
      baseState({
        permission: { [sessionID]: [permissionRequest("perm_1", sessionID), permissionRequest("perm_3", sessionID)] },
        question: { [sessionID]: [questionRequest("q_1", sessionID), questionRequest("q_3", sessionID)] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "permission.asked", properties: permissionRequest("perm_2", sessionID) },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.permission[sessionID]?.map((x) => x.id)).toEqual(["perm_1", "perm_2", "perm_3"])

    applyDirectoryEvent({
      event: { type: "permission.asked", properties: permissionRequest("perm_2", sessionID, "updated") },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.permission[sessionID]?.find((x) => x.id === "perm_2")?.permission).toBe("updated")

    applyDirectoryEvent({
      event: { type: "permission.replied", properties: { sessionID, requestID: "perm_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.permission[sessionID]?.map((x) => x.id)).toEqual(["perm_1", "perm_3"])

    applyDirectoryEvent({
      event: { type: "question.asked", properties: questionRequest("q_2", sessionID) },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.question[sessionID]?.map((x) => x.id)).toEqual(["q_1", "q_2", "q_3"])

    applyDirectoryEvent({
      event: { type: "question.asked", properties: questionRequest("q_2", sessionID, "updated") },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.question[sessionID]?.find((x) => x.id === "q_2")?.questions[0]?.header).toBe("updated")

    applyDirectoryEvent({
      event: { type: "question.rejected", properties: { sessionID, requestID: "q_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.question[sessionID]?.map((x) => x.id)).toEqual(["q_1", "q_3"])
  })

  test("updates vcs branch in store and cache", () => {
    const [store, setStore] = createStore(baseState({ vcs: { branch: "main", default_branch: "main" } }))
    const [cacheStore, setCacheStore] = createStore({
      value: { branch: "main", default_branch: "main" } as State["vcs"],
    })

    applyDirectoryEvent({
      event: { type: "vcs.branch.updated", properties: { branch: "feature/test" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      vcsCache: {
        store: cacheStore,
        setStore: setCacheStore,
        ready: () => true,
      },
    })

    expect(store.vcs).toEqual({ branch: "feature/test", default_branch: "main" })
    expect(cacheStore.value).toEqual({ branch: "feature/test", default_branch: "main" })
  })

  test("routes disposal and lsp events to side-effect handlers", () => {
    const [store, setStore] = createStore(baseState())
    const pushes: string[] = []
    let lspLoads = 0

    applyDirectoryEvent({
      event: { type: "server.instance.disposed" },
      store,
      setStore,
      push(directory) {
        pushes.push(directory)
      },
      directory: "/tmp",
      loadLsp() {
        lspLoads += 1
      },
    })

    applyDirectoryEvent({
      event: { type: "lsp.updated" },
      store,
      setStore,
      push(directory) {
        pushes.push(directory)
      },
      directory: "/tmp",
      loadLsp() {
        lspLoads += 1
      },
    })

    expect(pushes).toEqual(["/tmp"])
    expect(lspLoads).toBe(1)
  })
})
