import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import {
  ASSISTANT_SEGMENT_PARTS,
  createRowStabilizer,
  isCompactionMarker,
  nearestUserTurnID,
  projectTranscript,
  rowKey,
  type TranscriptRow,
} from "./chat-transcript"

function userMessage(id: string, opts: Partial<UserMessage> = {}): UserMessage {
  return {
    id,
    sessionID: "ses_1",
    role: "user",
    time: { created: 1000 },
    agent: "primary",
    model: { providerID: "openai", modelID: "gpt-4o" },
    ...opts,
  }
}

function assistantMessage(id: string, parentID: string, opts: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant",
    time: { created: 2000, completed: 3000 },
    parentID,
    modelID: "gpt-4o",
    providerID: "openai",
    mode: "primary",
    agent: "primary",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...opts,
  }
}

function textPart(id: string, messageID: string, text: string): Part {
  return { id, sessionID: "ses_1", messageID, type: "text", text }
}

function reasoningPart(id: string, messageID: string, text: string): Part {
  return { id, sessionID: "ses_1", messageID, type: "reasoning", text, time: { start: 0, end: 1 } }
}

function stepStartPart(id: string, messageID: string): Part {
  return { id, sessionID: "ses_1", messageID, type: "step-start" }
}

function compactionPart(id: string, messageID: string): Part {
  return { id, sessionID: "ses_1", messageID, type: "compaction", auto: false }
}

const idle: SessionStatus = { type: "idle" }

function partsByID(parts: Part[]): (id: string) => Part[] {
  const map = new Map<string, Part[]>()
  for (const part of parts) {
    const list = map.get(part.messageID) ?? []
    list.push(part)
    map.set(part.messageID, list)
  }
  return (id: string) => map.get(id) ?? []
}

describe("projectTranscript", () => {
  test("includes reasoning parts in transcript regardless of showReasoningSummaries", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const parts = [reasoningPart("r1", "a1", "private reasoning"), textPart("p1", "a1", "answer")]

    const defaultOff = projectTranscript({
      messages: [u1, a1],
      getParts: partsByID(parts),
      status: idle,
      showReasoningSummaries: false,
    })
    const defaultOn = projectTranscript({
      messages: [u1, a1],
      getParts: partsByID(parts),
      status: idle,
      showReasoningSummaries: true,
    })

    expect(
      defaultOff.rows.flatMap((row) => (row.type === "assistant" ? row.parts : [])).map((part) => part.id),
    ).toEqual(["r1", "p1"])
    expect(defaultOn.rows.flatMap((row) => (row.type === "assistant" ? row.parts : [])).map((part) => part.id)).toEqual(
      ["r1", "p1"],
    )
  })

  test("groups assistant messages by parentID into stable turns", () => {
    const u1 = userMessage("u1")
    const u2 = userMessage("u2")
    const a1 = assistantMessage("a1", "u1")
    const a2 = assistantMessage("a2", "u1")
    const a3 = assistantMessage("a3", "u2")

    const messages: Message[] = [u1, a1, a2, u2, a3]
    const parts = [textPart("p1", "u1", "hello"), textPart("p2", "a1", "reply"), textPart("p3", "a3", "reply2")]

    const { turns } = projectTranscript({
      messages,
      getParts: partsByID(parts),
      status: idle,
    })

    expect(turns).toHaveLength(2)
    expect(turns[0].id).toBe("u1")
    expect(turns[0].user.id).toBe("u1")
    expect(turns[0].assistant.map((m) => m.id)).toEqual(["a1", "a2"])
    expect(turns[1].id).toBe("u2")
    expect(turns[1].assistant.map((m) => m.id)).toEqual(["a3"])
  })

  test("produces a partial turn when parent user is not yet loaded", () => {
    const a1 = assistantMessage("a1", "u1")

    const { turns } = projectTranscript({
      messages: [a1],
      getParts: () => [],
      status: idle,
    })

    expect(turns).toHaveLength(1)
    expect(turns[0].partial).toBe(true)
    expect(turns[0].assistant.map((m) => m.id)).toEqual(["a1"])
  })

  test("merges a partial turn into a formal turn when the parent arrives", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")

    const partial = projectTranscript({ messages: [a1], getParts: () => [], status: idle })
    expect(partial.turns[0].partial).toBe(true)

    const merged = projectTranscript({ messages: [u1, a1], getParts: () => [], status: idle })
    expect(merged.turns).toHaveLength(1)
    expect(merged.turns[0].partial).toBeUndefined()
    expect(merged.turns[0].user.id).toBe("u1")
  })

  test("splits an assistant message with many visible parts into stable segments", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const parts: Part[] = []
    for (let i = 0; i < ASSISTANT_SEGMENT_PARTS + 5; i++) {
      parts.push(textPart(`p${i}`, "a1", `text ${i}`))
    }

    const { rows } = projectTranscript({ messages: [u1, a1], getParts: partsByID(parts), status: idle })

    const assistantRows = rows.filter((r) => r.type === "assistant")
    expect(assistantRows).toHaveLength(2)
    expect(assistantRows[0].parts).toHaveLength(ASSISTANT_SEGMENT_PARTS)
    expect(assistantRows[1].parts).toHaveLength(5)
  })

  test("hides non-renderable parts from assistant segments", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const parts: Part[] = [stepStartPart("s1", "a1"), textPart("p1", "a1", "visible"), stepStartPart("s2", "a1")]

    const { rows } = projectTranscript({ messages: [u1, a1], getParts: partsByID(parts), status: idle })

    const assistantRows = rows.filter((r) => r.type === "assistant")
    expect(assistantRows).toHaveLength(1)
    expect(assistantRows[0].parts.map((p) => p.id)).toEqual(["p1"])
  })

  test("marks only the final assistant message's last narrative for the meta footer", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const a2 = assistantMessage("a2", "u1")
    const parts = [textPart("p1", "u1", "hello"), textPart("p2", "a1", "中间回复"), textPart("p3", "a2", "最终回复")]

    const { rows } = projectTranscript({ messages: [u1, a1, a2], getParts: partsByID(parts), status: idle })

    const metaFlags = rows
      .filter((r): r is Extract<TranscriptRow, { type: "assistant" }> => r.type === "assistant")
      .map((r) => r.metaPartID)
    expect(metaFlags).toEqual([undefined, "p3"])
  })

  test("places the meta footer on the last segment of a segmented final message", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const parts: Part[] = []
    for (let i = 0; i < ASSISTANT_SEGMENT_PARTS + 5; i++) {
      parts.push(textPart(`p${i}`, "a1", `text ${i}`))
    }

    const { rows } = projectTranscript({ messages: [u1, a1], getParts: partsByID(parts), status: idle })

    const assistantRows = rows.filter((r): r is Extract<TranscriptRow, { type: "assistant" }> => r.type === "assistant")
    expect(assistantRows).toHaveLength(2)
    expect(assistantRows[0]?.metaPartID).toBeUndefined()
    expect(assistantRows[1]?.metaPartID).toBe(`p${ASSISTANT_SEGMENT_PARTS + 4}`)
  })

  test("stabilizer refreshes a row when the meta flag moves to a newer assistant message", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const a2 = assistantMessage("a2", "u1", { time: { created: 2000 } }) // arrives later, still running
    const stabilize = createRowStabilizer()

    const first = projectTranscript({
      messages: [u1, a1],
      getParts: partsByID([textPart("p1", "a1", "first reply")]),
      status: idle,
      stabilize,
    })
    const second = projectTranscript({
      messages: [u1, a1, a2],
      getParts: partsByID([textPart("p1", "a1", "first reply"), textPart("p2", "a2", "growing")]),
      status: { type: "busy" },
      stabilize,
    })

    const findAssistant = (rows: TranscriptRow[], messageID: string) =>
      rows
        .filter((r): r is Extract<TranscriptRow, { type: "assistant" }> => r.type === "assistant")
        .find((r) => r.message.id === messageID)
    const firstRow = findAssistant(first.rows, "a1")
    const secondRow = findAssistant(second.rows, "a1")
    expect(firstRow).toBeDefined()
    expect(secondRow).toBeDefined()
    expect(firstRow?.metaPartID).toBe("p1")
    expect(secondRow?.metaPartID).toBeUndefined()
    expect(secondRow).not.toBe(firstRow)
  })

  test("stabilizer refreshes a pending read row when its streamed raw input grows", () => {
    const u1 = userMessage("u-read-stream")
    const a1 = assistantMessage("a-read-stream", "u-read-stream", { time: { created: 2000 } })
    const stabilize = createRowStabilizer()
    const firstPart = {
      id: "t-read-stream",
      sessionID: "ses_1",
      messageID: "a-read-stream",
      type: "tool" as const,
      callID: "c-read-stream",
      tool: "read",
      state: { status: "pending" as const, input: {}, raw: '{"filePath":"/repo/src/early.ts"' },
    } satisfies Part
    const secondPart = {
      ...firstPart,
      state: { ...firstPart.state, raw: '{"filePath":"/repo/src/early.ts","line_end":20}' },
    } satisfies Part

    const first = projectTranscript({
      messages: [u1, a1],
      getParts: partsByID([firstPart]),
      status: { type: "busy" },
      stabilize,
    })
    const second = projectTranscript({
      messages: [u1, a1],
      getParts: partsByID([secondPart]),
      status: { type: "busy" },
      stabilize,
    })
    const firstRow = first.partition.direct.find((row) => row.type === "assistant")
    const secondRow = second.partition.direct.find((row) => row.type === "assistant")

    expect(firstRow).toBeDefined()
    expect(secondRow).toBeDefined()
    expect(secondRow).not.toBe(firstRow)
    expect((secondRow as Extract<TranscriptRow, { type: "assistant" }>).parts[0]).toBe(secondPart)
  })

  test("emits an error row for an assistant message with an error", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1", {
      error: { name: "UnknownError", data: { message: "boom" } },
    })

    const { rows } = projectTranscript({ messages: [u1, a1], getParts: () => [], status: idle })

    const errorRows = rows.filter((r) => r.type === "error")
    expect(errorRows).toHaveLength(1)
    expect(errorRows[0].message.id).toBe("a1")
  })

  test("respects the revert boundary and only projects visible messages", () => {
    const u1 = userMessage("u1")
    const u2 = userMessage("u2")
    const a1 = assistantMessage("a1", "u1")
    const a2 = assistantMessage("a2", "u2")

    const { turns, rows } = projectTranscript({
      messages: [u1, a1, u2, a2],
      getParts: () => [],
      status: idle,
      revert: "u2",
    })

    expect(turns.map((t) => t.id)).toEqual(["u1"])
    expect(rows.every((r) => r.turnID === "u1")).toBe(true)
  })

  test("keeps the growing segment of the running turn in direct when live", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1", { time: { created: 2000 } }) // no completed -> running
    const parts = [textPart("p1", "a1", "growing")]

    const { partition } = projectTranscript({
      messages: [u1, a1],
      getParts: partsByID(parts),
      status: { type: "busy" },
      live: true,
    })

    expect(partition.direct.map((r) => r.type)).toEqual(["user", "assistant"])
    expect(partition.virtual).toHaveLength(0)
  })

  test("keeps the whole running turn direct when the user scrolled up", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1", { time: { created: 2000 } })
    const parts = [textPart("p1", "a1", "growing")]

    const { partition } = projectTranscript({
      messages: [u1, a1],
      getParts: partsByID(parts),
      status: { type: "busy" },
      live: false,
    })

    expect(partition.direct.map((r) => r.type)).toEqual(["user", "assistant"])
    expect(partition.virtual).toHaveLength(0)
  })

  test("keeps a submitted busy turn direct before the assistant message arrives", () => {
    const u1 = userMessage("u-awaiting-assistant")

    const beforeAssistant = projectTranscript({
      messages: [u1],
      getParts: partsByID([textPart("p-awaiting-assistant", "u-awaiting-assistant", "run tools")]),
      status: { type: "busy" },
    })

    expect(beforeAssistant.partition.virtual).toHaveLength(0)
    expect(beforeAssistant.partition.direct.map((row) => row.key)).toEqual(["user:u-awaiting-assistant"])
  })

  test("moves completed turns into virtual history", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const u2 = userMessage("u2")
    const a2 = assistantMessage("a2", "u2", { time: { created: 2000 } }) // running
    const parts = [textPart("p1", "a1", "done"), textPart("p2", "a2", "growing")]

    const { partition } = projectTranscript({
      messages: [u1, a1, u2, a2],
      getParts: partsByID(parts),
      status: { type: "busy" },
      live: true,
    })

    expect(partition.virtual.map((r) => r.turnID)).toEqual(["u1", "u1"])
    expect(partition.direct.map((r) => r.turnID)).toEqual(["u2", "u2"])
  })

  test("generates stable row keys from turn, message and first part id", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const parts = [textPart("p1", "a1", "x"), textPart("p2", "a1", "y")]

    const { rows } = projectTranscript({ messages: [u1, a1], getParts: partsByID(parts), status: idle })

    const userRow = rows.find((r) => r.type === "user")!
    const assistantRow = rows.find((r) => r.type === "assistant")!
    expect(rowKey(userRow)).toBe("user:u1")
    expect(rowKey(assistantRow)).toBe("assistant:a1:p1")
  })

  test("row keys are stable across re-projection (object reuse)", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const parts = [textPart("p1", "a1", "x")]

    const first = projectTranscript({ messages: [u1, a1], getParts: partsByID(parts), status: idle })
    const second = projectTranscript({ messages: [u1, a1], getParts: partsByID(parts), status: idle })

    const firstKeys = first.rows.map(rowKey)
    const secondKeys = second.rows.map(rowKey)
    expect(secondKeys).toEqual(firstKeys)
  })

  test("unchanged live rows keep object identity across a token delta", () => {
    // A growing live tail re-projects on every message.part.delta. Rows whose
    // content has not changed must reuse the previous object reference,
    // otherwise <For> in the live tail unmounts and remounts the whole row
    // (including its markdown renderer) on every token — the visible flicker.
    const u1 = userMessage("u1")
    const running = assistantMessage("a1", "u1", { time: { created: 2000 } })
    const status = { type: "busy" } as SessionStatus

    const grown1 = [textPart("p1", "a1", "hello")]
    const stabilize = createRowStabilizer()
    const first = projectTranscript({ messages: [u1, running], getParts: partsByID(grown1), status, stabilize })

    const grown2 = [textPart("p1", "a1", "hello world"), textPart("p2", "a1", "new")]
    const second = projectTranscript({ messages: [u1, running], getParts: partsByID(grown2), status, stabilize })

    const firstDirect = first.partition.direct
    const secondDirect = second.partition.direct
    expect(secondDirect.length).toBeGreaterThanOrEqual(firstDirect.length)

    // The user row exists in both projections with identical content and must
    // be the same object. The growing assistant row changes, so it is exempt.
    const firstUser = firstDirect.find((row) => row.type === "user")
    const secondUser = secondDirect.find((row) => row.type === "user")
    expect(firstUser).toBeDefined()
    expect(secondUser).toBe(firstUser)
  })

  test("user row identity survives parts-array rebuilds with identical content", () => {
    // The live store hands back a fresh parts array on every delta even when
    // no part changed, so identity stabilization must compare part contents,
    // not the array reference.
    const u1 = userMessage("u1")
    const running = assistantMessage("a1", "u1", { time: { created: 2000 } })
    const status = { type: "busy" } as SessionStatus
    const shared = textPart("pu", "u1", "same question")

    const stabilize = createRowStabilizer()
    const first = projectTranscript({
      messages: [u1, running],
      getParts: (id) => (id === "u1" ? [shared] : []),
      status,
      stabilize,
    })
    const second = projectTranscript({
      messages: [u1, running],
      getParts: (id) => (id === "u1" ? [shared] : []),
      status,
      stabilize,
    })

    const firstUser = first.partition.direct.find((row) => row.type === "user")
    const secondUser = second.partition.direct.find((row) => row.type === "user")
    expect(secondUser).toBe(firstUser)
  })
})

describe("compaction marker projection", () => {
  test("isCompactionMarker is true for a user message whose parts are all compaction", () => {
    const marker = userMessage("u-mark")
    const parts = [compactionPart("cp1", "u-mark")]
    expect(isCompactionMarker(marker, partsByID(parts))).toBe(true)
  })

  test("isCompactionMarker is false for a user message with any text part", () => {
    const u1 = userMessage("u1")
    const parts = [compactionPart("cp1", "u1"), textPart("p1", "u1", "real prompt")]
    expect(isCompactionMarker(u1, partsByID(parts))).toBe(false)
  })

  test("isCompactionMarker is false for a user message with file or agent parts", () => {
    const u1 = userMessage("u1")
    const filePart: Part = {
      id: "f1",
      sessionID: "ses_1",
      messageID: "u1",
      type: "file",
      mime: "text/plain",
      url: "file:///x",
    }
    expect(isCompactionMarker(u1, partsByID([compactionPart("cp1", "u1"), filePart]))).toBe(false)
  })

  test("isCompactionMarker is false for assistant messages and for user messages without compaction parts", () => {
    const a1 = assistantMessage("a1", "u1")
    const u1 = userMessage("u1")
    expect(isCompactionMarker(a1, partsByID([]))).toBe(false)
    expect(isCompactionMarker(u1, partsByID([textPart("p1", "u1", "hello")]))).toBe(false)
  })

  test("projects a compaction marker turn as a compaction row instead of a user bubble row", () => {
    const u1 = userMessage("u1", { model: { providerID: "openai", modelID: "gpt-4o" } })
    const uComp = userMessage("u-comp", { model: { providerID: "openai", modelID: "gpt-4o" } })
    const aComp = assistantMessage("a-comp", "u-comp", {
      mode: "compaction",
      agent: "compaction",
      summary: true,
      time: { created: 2000, completed: 3000 },
    })
    const u2 = userMessage("u2")
    const a2 = assistantMessage("a2", "u2")
    const parts = [
      textPart("p1", "u1", "hello"),
      textPart("p2", "a1", "reply"),
      compactionPart("cp1", "u-comp"),
      textPart("p3", "a-comp", "summary of the conversation so far"),
      textPart("p4", "u2", "next question"),
      textPart("p5", "a2", "answer"),
    ]
    // a1 parentID is u1; a-comp parentID is u-comp
    const a1 = assistantMessage("a1", "u1")
    const messages: Message[] = [u1, a1, uComp, aComp, u2, a2]

    const { turns, rows } = projectTranscript({ messages, getParts: partsByID(parts), status: idle })

    expect(turns.map((t) => t.id)).toEqual(["u1", "u-comp", "u2"])
    const userRowTurnIDs = rows.filter((r) => r.type === "user").map((r) => r.turnID)
    expect(userRowTurnIDs).toEqual(["u1", "u2"])
    const compactionRow = rows.find((r): r is Extract<TranscriptRow, { type: "compaction" }> => r.type === "compaction")
    expect(compactionRow).toBeDefined()
    expect(compactionRow?.turnID).toBe("u-comp")
    expect(compactionRow?.key).toBe(`compaction:u-comp`)
    expect(compactionRow?.parts.map((p) => p.id)).toEqual(["cp1"])
    // The compaction summary assistant parts stay projected under the marker turn.
    const summaryRow = rows.find((r) => r.type === "assistant" && r.turnID === "u-comp")
    expect(summaryRow).toBeDefined()
  })

  test("a compaction marker turn that is still running keeps its rows direct", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const uComp = userMessage("u-comp")
    const aComp = assistantMessage("a-comp", "u-comp", {
      mode: "compaction",
      agent: "compaction",
      summary: true,
      time: { created: 2000 }, // no completed -> running
    })
    const parts = [compactionPart("cp1", "u-comp"), textPart("p1", "a-comp", "partial summary")]

    const { partition } = projectTranscript({
      messages: [u1, a1, uComp, aComp],
      getParts: partsByID(parts),
      status: { type: "busy" },
      live: true,
    })

    expect(partition.direct.some((r) => r.type === "compaction")).toBe(true)
    expect(partition.virtual.map((r) => r.turnID)).toEqual(["u1", "u1"])
  })

  test("promptIndex maps a compaction marker turn to its compaction row key", () => {
    const uComp = userMessage("u-comp")
    const parts = [compactionPart("cp1", "u-comp")]

    const { promptIndex } = projectTranscript({ messages: [uComp], getParts: partsByID(parts), status: idle })

    expect(promptIndex.get("u-comp")).toBe("compaction:u-comp")
  })
})

describe("rowKey", () => {
  test("returns a stable key for each row type", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")

    const userRow: TranscriptRow = { type: "user", key: "user:u1", turnID: "u1", message: u1, parts: [] }
    const assistantRow: TranscriptRow = {
      type: "assistant",
      key: "assistant:a1:p1",
      turnID: "u1",
      message: a1,
      parts: [],
    }
    const errorRow: TranscriptRow = { type: "error", key: "error:a1", turnID: "u1", message: a1 }

    expect(rowKey(userRow)).toBe("user:u1")
    expect(rowKey(assistantRow)).toBe("assistant:a1:p1")
    expect(rowKey(errorRow)).toBe("error:a1")
  })
})

describe("nearestUserTurnID", () => {
  test("walks assistant rows back to their owning user turn", () => {
    const u1 = userMessage("u1")
    const a1 = assistantMessage("a1", "u1")
    const u2 = userMessage("u2")
    const a2 = assistantMessage("a2", "u2")
    const { rows } = projectTranscript({ messages: [u1, a1, u2, a2], getParts: () => [], status: idle })

    expect(nearestUserTurnID(rows, "user:u2")).toBe("u2")
    expect(nearestUserTurnID(rows, "assistant:a2:none")).toBe("u2")
    expect(nearestUserTurnID(rows, "missing")).toBeUndefined()
  })
})
