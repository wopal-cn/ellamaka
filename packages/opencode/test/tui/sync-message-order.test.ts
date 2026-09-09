import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2"
import { Binary } from "@wopal/ellamaka-core/util/binary"
import { mergeMessages, keyOf, activeTurnAssistantID } from "@/cli/cmd/tui/context/sync-merge"

/**
 * Build a minimal user message literal. Only the fields relevant to the
 * merge logic are populated; the rest are omitted because the pure function
 * under test only reads `id`, `role`, and `time`.
 */
function userMsg(id: string, created: number): Message {
  return {
    id,
    sessionID: "ses_test",
    role: "user",
    time: { created },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
  }
}

/**
 * Build a minimal assistant message literal with all `Message.Assistant`
 * required fields populated. `completed` is optional to model the lifecycle
 * state (undefined = still running, number = finished).
 */
function assistantMsg(id: string, created: number, completed?: number): Message {
  const time: { created: number; completed?: number } = { created }
  if (completed != null) time.completed = completed
  return {
    id,
    sessionID: "ses_test",
    role: "assistant",
    time,
    parentID: "parent",
    modelID: "test",
    providerID: "test",
    mode: "primary",
    agent: "test",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  }
}

/** Assert the array is strictly ascending by id (the sort contract). */
function expectOrdered(messages: Message[]) {
  for (let i = 1; i < messages.length; i++) {
    expect(messages[i]!.id > messages[i - 1]!.id).toBe(true)
  }
}

/** Assert the array is strictly ascending by (time.created, id). */
function expectTimeOrdered(messages: Message[]) {
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1]!
    const curr = messages[i]!
    const prevKey = `${prev.time.created}:${prev.id}`
    const currKey = `${curr.time.created}:${curr.id}`
    expect(currKey > prevKey).toBe(true)
  }
}

/** Read `time.completed` after narrowing the union to an assistant message. */
function completedOf(message: Message): number | undefined {
  return message.role === "assistant" ? message.time.completed : undefined
}

describe("mergeMessages", () => {
  test("race: event-added messages survive a sync() that does not include them", () => {
    // Events added m_A, m_B before session.sync() resolved.
    const existing = [userMsg("m_A", 1), userMsg("m_B", 2)]
    // API snapshot (taken before m_A/m_B were created) does not contain them.
    const incoming = [userMsg("m_0", 0)]

    const merged = mergeMessages(existing, incoming)

    expect(merged.map((m) => m.id)).toEqual(["m_0", "m_A", "m_B"])
    expectOrdered(merged)
  })

  test("mixed: store messages partially present in API response are reconciled, others kept", () => {
    // Store has 3 event messages; 2 are in the API response (with updated content).
    const existing = [userMsg("m_A", 1), userMsg("m_B", 2), userMsg("m_C", 3)]
    const incoming = [userMsg("m_A", 1), userMsg("m_B", 2)]

    const merged = mergeMessages(existing, incoming)

    expect(merged.map((m) => m.id)).toEqual(["m_A", "m_B", "m_C"])
    // m_A and m_B should be the incoming (API) versions.
    expect(merged[0]).toBe(incoming[0])
    expect(merged[1]).toBe(incoming[1])
    expectOrdered(merged)
  })

  test("API order crossing id order: result is strictly id-ordered (sort contract)", () => {
    // API returns by (time_created, id); here time order differs from id order.
    const existing: Message[] = []
    const incoming = [userMsg("m_2", 10), userMsg("m_1", 5), userMsg("m_3", 15)]

    const merged = mergeMessages(existing, incoming)

    expect(merged.map((m) => m.id)).toEqual(["m_1", "m_2", "m_3"])
    expectOrdered(merged)
  })

  test("new messages are inserted at the correct ordered position", () => {
    const existing = [userMsg("m_1", 1), userMsg("m_3", 3)]
    const incoming = [userMsg("m_2", 2)]

    const merged = mergeMessages(existing, incoming)

    expect(merged.map((m) => m.id)).toEqual(["m_1", "m_2", "m_3"])
    expectOrdered(merged)
  })

  test("empty existing is equivalent to inserting all incoming in id order", () => {
    const merged = mergeMessages([], [userMsg("m_3", 3), userMsg("m_1", 1), userMsg("m_2", 2)])
    expect(merged.map((m) => m.id)).toEqual(["m_1", "m_2", "m_3"])
    expectOrdered(merged)
  })

  test("order guarantee: arbitrary input combinations stay id-ascending", () => {
    const cases: [Message[], Message[]][] = [
      [[userMsg("m_1", 1), userMsg("m_3", 3)], [userMsg("m_2", 2), userMsg("m_4", 4)]],
      [[userMsg("m_2", 2), userMsg("m_4", 4)], [userMsg("m_1", 1), userMsg("m_3", 3)]],
      [[userMsg("m_1", 1), userMsg("m_2", 2)], [userMsg("m_1", 1), userMsg("m_3", 3)]],
      [[userMsg("m_5", 5)], [userMsg("m_1", 1), userMsg("m_2", 2), userMsg("m_3", 3)]],
    ]
    for (const [existing, incoming] of cases) {
      expectOrdered(mergeMessages(existing, incoming))
    }
  })

  // Regression for #208. A post-wrap message id (`msg_00...`) is lexically
  // *smaller* than pre-wrap ids (`msg_fa...`) even though it is chronologically
  // newer. The merge must order by time.created (id tie-break) so the new
  // message lands at the array end, and `status()`'s `.at(-1)` reads the newest.
  test("cross-wrap: post-wrap message with lexically-smaller id merges to the array end", () => {
    const preWrap = userMsg("msg_fa2c3af72001", 1784448447887)
    const postWrap = userMsg("msg_002ceb729001", 1786753496981)

    const merged = mergeMessages([preWrap], [postWrap])

    expect(merged.map((m) => m.id)).toEqual(["msg_fa2c3af72001", "msg_002ceb729001"])
    expect(merged.at(-1)?.id).toBe("msg_002ceb729001")
    expectTimeOrdered(merged)
  })
})

describe("lifecycle merge", () => {
  test("stale snapshot cannot regress a completed assistant (keep existing whole)", () => {
    // Event side already has the finished assistant.
    const existing = [assistantMsg("m_1", 1, 100)]
    // Snapshot was taken before completion landed: same id, no completed.
    const incoming = [assistantMsg("m_1", 1)]

    const merged = mergeMessages(existing, incoming)

    // Reference equality: the existing (completed) message is kept whole.
    expect(merged[0]).toBe(existing[0])
    expect(completedOf(merged[0]!)).toBe(100)
  })

  test("snapshot fills in a completion lost during an event gap (use incoming)", () => {
    // Event side has an unfinished assistant (no completed).
    const existing = [assistantMsg("m_1", 1)]
    // Snapshot has the completion.
    const incoming = [assistantMsg("m_1", 1, 100)]

    const merged = mergeMessages(existing, incoming)

    expect(merged[0]).toBe(incoming[0])
    expect(completedOf(merged[0]!)).toBe(100)
  })

  test("both sides completed or both incomplete: use incoming", () => {
    // Both completed.
    const incomingDone = assistantMsg("m_1", 1, 100)
    const bothDone = mergeMessages([assistantMsg("m_1", 1, 100)], [incomingDone])
    expect(bothDone[0]).toBe(incomingDone)
    expect(completedOf(bothDone[0]!)).toBe(100)

    // Both incomplete.
    const incomingPending = assistantMsg("m_1", 1)
    const bothPending = mergeMessages([assistantMsg("m_1", 1)], [incomingPending])
    expect(bothPending[0]).toBe(incomingPending)
    expect(completedOf(bothPending[0]!)).toBeUndefined()
  })

  test("user messages never take the lifecycle branch (use incoming)", () => {
    const existing = [userMsg("m_1", 1)]
    const incoming = [userMsg("m_1", 1)]

    const merged = mergeMessages(existing, incoming)

    expect(merged[0]).toBe(incoming[0])
  })
})

// B-01: realtime event handlers in sync.tsx must locate messages in the
// time-ordered array by the (time.created, id) composite key, not by id alone.
// Across a wrap-around a post-wrap id (`msg_00...`) is lexically smaller than
// pre-wrap ids (`msg_fa...`) even though it is newer, so an id-based binary
// search fails and the message would be re-inserted at the array head.
describe("sync.tsx event-path composite-key lookup", () => {
  const preWrap = userMsg("msg_fa2c3af72001", 1784448447887)
  const postWrap = userMsg("msg_002ceb729001", 1786753496981)

  test("message.updated finds an existing post-wrap message by composite key", () => {
    const messages = [preWrap, postWrap]
    const incoming = userMsg("msg_002ceb729001", 1786753496981)

    const result = Binary.search(messages, keyOf(incoming), keyOf)

    expect(result.found).toBe(true)
    expect(result.index).toBe(1)
  })

  test("message.updated inserts a new post-wrap message at its time position (not the head)", () => {
    const messages = [preWrap]
    const incoming = postWrap

    const result = Binary.search(messages, keyOf(incoming), keyOf)
    const merged = Binary.insert(messages.slice(), incoming, keyOf)

    expect(result.found).toBe(false)
    expect(merged.map((m) => m.id)).toEqual(["msg_fa2c3af72001", "msg_002ceb729001"])
    expectTimeOrdered(merged)
  })

  test("message.updated upsert does not duplicate the post-wrap message on streaming updates", () => {
    // Streaming emits repeated message.updated for the same assistant; each
    // must locate the existing row (not insert a fresh copy at the head).
    const streamed = userMsg("msg_002ceb729001", 1786753496981)
    let messages = [preWrap, streamed]

    for (let i = 0; i < 5; i++) {
      const result = Binary.search(messages, keyOf(streamed), keyOf)
      if (result.found) {
        messages = messages.slice()
        messages[result.index] = streamed
      } else {
        messages = Binary.insert(messages, streamed, keyOf)
      }
    }

    expect(messages.map((m) => m.id)).toEqual(["msg_fa2c3af72001", "msg_002ceb729001"])
    expectTimeOrdered(messages)
  })

  test("message.removed finds and removes a post-wrap message by id", () => {
    const messages = [preWrap, postWrap]

    // message.removed only carries the id (no time), so sync.tsx locates it
    // linearly over the time-ordered array.
    const index = messages.findIndex((m) => m.id === postWrap.id)
    const merged = messages.slice()
    if (index >= 0) merged.splice(index, 1)

    expect(merged.map((m) => m.id)).toEqual(["msg_fa2c3af72001"])
  })
})

// The QUEUED badge is driven by the last open assistant turn. A historical
// orphan (an assistant killed mid-stream with no time.completed) buried in the
// middle of the array must not mark every later user message as QUEUED.
describe("activeTurnAssistantID", () => {
  test("returns the last unfinished assistant when it is the trailing open turn", () => {
    const messages = [userMsg("u1", 1), assistantMsg("a1", 2), userMsg("u2", 3)]
    expect(activeTurnAssistantID(messages)).toBe("a1")
  })

  test("returns undefined when the last assistant is completed", () => {
    const messages = [userMsg("u1", 1), assistantMsg("a1", 2, 100), userMsg("u2", 3), assistantMsg("a2", 4, 200)]
    expect(activeTurnAssistantID(messages)).toBeUndefined()
  })

  test("ignores a buried orphan and returns undefined when a later assistant completed", () => {
    const messages = [
      userMsg("u1", 1),
      assistantMsg("a1", 2),
      userMsg("u2", 3),
      assistantMsg("a2", 4, 200),
      userMsg("u3", 5),
    ]
    expect(activeTurnAssistantID(messages)).toBeUndefined()
  })

  test("returns the trailing orphan as an open turn (retry semantics preserved)", () => {
    const messages = [userMsg("u1", 1), assistantMsg("a1", 2)]
    expect(activeTurnAssistantID(messages)).toBe("a1")
  })

  test("returns undefined for empty or user-only arrays", () => {
    expect(activeTurnAssistantID([])).toBeUndefined()
    expect(activeTurnAssistantID([userMsg("u1", 1)])).toBeUndefined()
  })
})
