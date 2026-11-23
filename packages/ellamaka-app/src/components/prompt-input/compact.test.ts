import { describe, expect, test } from "bun:test"
import { compactSession } from "./compact"

type SummarizeCall = {
  sessionID?: string
  modelID?: string
  providerID?: string
}

describe("compactSession", () => {
  test("returns false and does not summarize when sessionID is missing", async () => {
    const summarizeCalls: SummarizeCall[] = []
    const client = {
      session: {
        summarize: async (params: SummarizeCall) => {
          summarizeCalls.push(params)
          return { data: undefined }
        },
      },
    }
    const result = await compactSession({
      client,
      model: { providerID: "provider-a", modelID: "model-a" },
    })
    expect(result).toBe(false)
    expect(summarizeCalls).toHaveLength(0)
  })

  test("returns false and does not summarize when model is missing", async () => {
    const summarizeCalls: SummarizeCall[] = []
    const client = {
      session: {
        summarize: async (params: SummarizeCall) => {
          summarizeCalls.push(params)
          return { data: undefined }
        },
      },
    }
    const result = await compactSession({ client, sessionID: "ses_1" })
    expect(result).toBe(false)
    expect(summarizeCalls).toHaveLength(0)
  })

  test("calls summarize with sessionID, modelID and providerID when both are present", async () => {
    const summarizeCalls: SummarizeCall[] = []
    const client = {
      session: {
        summarize: async (params: SummarizeCall) => {
          summarizeCalls.push(params)
          return { data: undefined }
        },
      },
    }
    const result = await compactSession({
      client,
      sessionID: "ses_1",
      model: { providerID: "provider-a", modelID: "model-a" },
    })
    expect(result).toBe(true)
    expect(summarizeCalls).toEqual([{ sessionID: "ses_1", modelID: "model-a", providerID: "provider-a" }])
  })
})
