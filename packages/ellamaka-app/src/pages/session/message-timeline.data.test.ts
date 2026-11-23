import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@wopal/ellamaka-sdk/v2"
import { Timeline, TimelineRow } from "./message-timeline.data"

function userMessage(): UserMessage {
  return {
    id: "u1",
    sessionID: "ses_1",
    role: "user",
    time: { created: 1000 },
    agent: "primary",
    model: { providerID: "openai", modelID: "gpt-4o" },
  }
}

function erroredAssistant(error: AssistantMessage["error"]): AssistantMessage {
  return {
    id: "a1",
    sessionID: "ses_1",
    role: "assistant",
    time: { created: 2000, completed: 3000 },
    parentID: "u1",
    modelID: "gpt-4o",
    providerID: "openai",
    mode: "primary",
    agent: "primary",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    error,
  }
}

function errorRow(error: AssistantMessage["error"]): TimelineRow.Error {
  const rows = Timeline.constructMessageRows(
    userMessage(),
    () => [] as Part[],
    [erroredAssistant(error)],
    0,
    true,
    "idle",
    true,
  )
  const row = rows.find((entry): entry is TimelineRow.Error => entry._tag === "Error")
  if (!row) throw new Error("expected an Error row")
  return row
}

describe("Timeline error row text", () => {
  test("keeps a string message unchanged", () => {
    const row = errorRow({ name: "UnknownError", data: { message: "provider exploded" } })
    expect(row.text).toBe("provider exploded")
    expect(row.text).not.toContain("[object Object]")
  })

  test("recovers the message from an object-valued payload instead of [object Object]", () => {
    // MessageOutputLengthError types `data` as an open record, so `message` can
    // arrive as an object. Stringifying it used to render "[object Object]".
    const row = errorRow({
      name: "MessageOutputLengthError",
      data: { message: { message: "output length exceeded", code: "E_LENGTH" } },
    })
    expect(row.text).not.toContain("[object Object]")
    expect(row.text).toContain("output length exceeded")
  })

  test("renders an empty string when the payload has no message", () => {
    const row = errorRow({ name: "MessageOutputLengthError", data: {} })
    expect(row.text).toBe("")
  })
})
