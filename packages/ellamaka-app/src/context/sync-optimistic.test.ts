import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@wopal/ellamaka-sdk/v2/client"
import { applyOptimisticAdd, applyOptimisticRemove, mergeOptimisticPage } from "./sync"

type Text = Extract<Part, { type: "text" }>

const userMessage = (id: string, sessionID: string): Message => ({
  id,
  sessionID,
  role: "user",
  time: { created: 1 },
  agent: "assistant",
  model: { providerID: "openai", modelID: "gpt" },
})

const textPart = (id: string, sessionID: string, messageID: string): Text => ({
  id,
  sessionID,
  messageID,
  type: "text",
  text: id,
})

describe("sync optimistic reducers", () => {
  test("applyOptimisticAdd inserts message in sorted order and stores parts", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_2", sessionID)] },
      part: {} as Record<string, Part[] | undefined>,
    }

    applyOptimisticAdd(draft, {
      sessionID,
      message: userMessage("msg_1", sessionID),
      parts: [textPart("prt_2", sessionID, "msg_1"), textPart("prt_1", sessionID, "msg_1")],
    })

    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual(["msg_1", "msg_2"])
    expect(draft.part.msg_1?.map((x) => x.id)).toEqual(["prt_1", "prt_2"])
  })

  test("applyOptimisticRemove removes message and part entries", () => {
    const sessionID = "ses_1"
    const draft = {
      message: { [sessionID]: [userMessage("msg_1", sessionID), userMessage("msg_2", sessionID)] },
      part: {
        msg_1: [textPart("prt_1", sessionID, "msg_1")],
        msg_2: [textPart("prt_2", sessionID, "msg_2")],
      } as Record<string, Part[] | undefined>,
    }

    applyOptimisticRemove(draft, { sessionID, messageID: "msg_1" })

    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual(["msg_2"])
    expect(draft.part.msg_1).toBeUndefined()
    expect(draft.part.msg_2).toHaveLength(1)
  })

  test("mergeOptimisticPage keeps pending messages in fetched timelines", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_1", sessionID)],
        part: [{ id: "msg_1", part: [textPart("prt_1", sessionID, "msg_1")] }],
        complete: true,
      },
      [{ message: userMessage("msg_2", sessionID), parts: [textPart("prt_2", sessionID, "msg_2")] }],
    )

    expect(page.session.map((x) => x.id)).toEqual(["msg_1", "msg_2"])
    expect(page.part.find((x) => x.id === "msg_2")?.part.map((x) => x.id)).toEqual(["prt_2"])
    expect(page.confirmed).toEqual([])
    expect(page.complete).toBe(true)
  })

  test("mergeOptimisticPage keeps missing optimistic parts until the server has them", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_2", sessionID)],
        part: [{ id: "msg_2", part: [textPart("prt_2", sessionID, "msg_2")] }],
        complete: true,
      },
      [
        {
          message: userMessage("msg_2", sessionID),
          parts: [textPart("prt_1", sessionID, "msg_2"), textPart("prt_2", sessionID, "msg_2")],
        },
      ],
    )

    expect(page.part.find((x) => x.id === "msg_2")?.part.map((x) => x.id)).toEqual(["prt_1", "prt_2"])
    expect(page.confirmed).toEqual([])
  })

  test("mergeOptimisticPage confirms echoed messages once all parts arrive", () => {
    const sessionID = "ses_1"
    const page = mergeOptimisticPage(
      {
        session: [userMessage("msg_2", sessionID)],
        part: [
          {
            id: "msg_2",
            part: [{ ...textPart("prt_1", sessionID, "msg_2"), text: "server" }, textPart("prt_2", sessionID, "msg_2")],
          },
        ],
        complete: true,
      },
      [
        {
          message: userMessage("msg_2", sessionID),
          parts: [textPart("prt_1", sessionID, "msg_2"), textPart("prt_2", sessionID, "msg_2")],
        },
      ],
    )

    expect(page.confirmed).toEqual(["msg_2"])
    expect(page.part.find((x) => x.id === "msg_2")?.part).toMatchObject([
      { id: "prt_1", type: "text", text: "server" },
      { id: "prt_2", type: "text", text: "prt_2" },
    ])
  })

  // B-02: a post-wrap message id (`msg_00...`) is lexically smaller than
  // pre-wrap ids (`msg_fa...`) even though it is newer. Optimistic paths must
  // order by time.created (id tie-break) so the new message lands at the end,
  // not at the array head.
  test("applyOptimisticAdd inserts a post-wrap message at the array end across wrap-around", () => {
    const sessionID = "ses_1"
    const preWrap: Message = { ...userMessage("msg_fa2c3af72001", sessionID), time: { created: 1784448447887 } }
    const postWrap: Message = { ...userMessage("msg_002ceb729001", sessionID), time: { created: 1786753496981 } }
    const draft = {
      message: { [sessionID]: [preWrap] },
      part: {} as Record<string, Part[] | undefined>,
    }

    applyOptimisticAdd(draft, { sessionID, message: postWrap, parts: [] })

    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual(["msg_fa2c3af72001", "msg_002ceb729001"])
  })

  test("applyOptimisticRemove removes a post-wrap message located by id", () => {
    const sessionID = "ses_1"
    const preWrap: Message = { ...userMessage("msg_fa2c3af72001", sessionID), time: { created: 1784448447887 } }
    const postWrap: Message = { ...userMessage("msg_002ceb729001", sessionID), time: { created: 1786753496981 } }
    const draft = {
      message: { [sessionID]: [preWrap, postWrap] },
      part: {
        msg_002ceb729001: [textPart("prt_1", sessionID, "msg_002ceb729001")],
      } as Record<string, Part[] | undefined>,
    }

    applyOptimisticRemove(draft, { sessionID, messageID: "msg_002ceb729001" })

    expect(draft.message[sessionID]?.map((x) => x.id)).toEqual(["msg_fa2c3af72001"])
    expect(draft.part.msg_002ceb729001).toBeUndefined()
  })

  test("mergeOptimisticPage keeps a post-wrap pending message at the array end", () => {
    const sessionID = "ses_1"
    const preWrap: Message = { ...userMessage("msg_fa2c3af72001", sessionID), time: { created: 1784448447887 } }
    const postWrap: Message = { ...userMessage("msg_002ceb729001", sessionID), time: { created: 1786753496981 } }

    const page = mergeOptimisticPage(
      { session: [preWrap], part: [{ id: preWrap.id, part: [] }], complete: true },
      [{ message: postWrap, parts: [] }],
    )

    expect(page.session.map((x) => x.id)).toEqual(["msg_fa2c3af72001", "msg_002ceb729001"])
  })
})
