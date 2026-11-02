import { describe, expect, test } from "bun:test"
import type { OpencodeClient } from "@wopal/ellamaka-sdk/v2/client"
import { createSetupClient, type SetupEventView } from "./setup-client"

function sdk(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; parameters?: unknown }> = []
  const setup = {
    inspect: async () => {
      calls.push({ method: "inspect" })
      return { data: { fingerprint: "abc", goals: [] } }
    },
    home: {
      select: async (parameters: unknown) => {
        calls.push({ method: "home.select", parameters })
        return {
          data: {
            mode: "development",
            source: "selected",
            path: "/tmp/uat-home",
            locked: true,
            selectable: false,
            persisted: false,
          },
        }
      },
    },
    plan: async (parameters: unknown) => {
      calls.push({ method: "plan", parameters })
      return { data: { planId: "plan-1", actions: [] } }
    },
    execute: async (parameters: unknown) => {
      calls.push({ method: "execute", parameters })
      return { data: { runId: "run-1", status: "running", sequence: 0 } }
    },
    progress: async (parameters: unknown) => {
      calls.push({ method: "progress", parameters })
      return { data: { runId: "run-1", status: "completed", sequence: 2 } }
    },
    progress2: {
      events: async (parameters: { after?: string }) => {
        calls.push({ method: "events", parameters })
        return {
          stream: (async function* () {
            yield { sequence: 1, phase: "started", message: "one", type: "progress" }
            yield { sequence: 2, phase: "completed", message: "done", type: "progress" }
          })(),
        }
      },
    },
    cancel: async (parameters: unknown) => {
      calls.push({ method: "cancel", parameters })
      return { data: { runId: "run-1", status: "cancelled", sequence: 1 } }
    },
    complete: async (parameters: unknown) => {
      calls.push({ method: "complete", parameters })
      return { data: { completed: true, planId: "plan-1" } }
    },
    ...overrides,
  }
  return {
    calls,
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- injectable transport double covers only the generated surfaces used here
    client: {
      wopalSpace: { setup },
      global: {
        runtime: {
          prepare: async () => {
            calls.push({ method: "runtime.prepare" })
            return { data: { status: "ready" } }
          },
        },
      },
    } as unknown as OpencodeClient,
  }
}

describe("generated Setup SDK adapter", () => {
  test("uses the generated Setup client for every operation", async () => {
    const fake = sdk()
    const client = createSetupClient(fake.client)

    await client.inspect()
    await client.selectHome("/tmp/uat-home")
    await client.plan(["foundation"])
    await client.execute({ planId: "plan-1", actionId: "foundation", input: { token: "secret" } })
    await client.cancel("run-1")
    await client.complete("plan-1")
    expect(await client.prepareRuntime()).toEqual({ status: "ready" })

    expect(fake.calls.map((call) => call.method)).toEqual([
      "inspect",
      "home.select",
      "plan",
      "execute",
      "cancel",
      "complete",
      "runtime.prepare",
    ])
    expect(fake.calls[1]?.parameters).toEqual({ path: "/tmp/uat-home" })
    expect(fake.calls[2]?.parameters).toEqual({ goals: ["foundation"] })
    expect(fake.calls[3]?.parameters).toEqual({
      planId: "plan-1",
      actionId: "foundation",
      input: { token: "secret" },
    })
  })

  test("resumes the event stream after the last observed sequence", async () => {
    const fake = sdk()
    const client = createSetupClient(fake.client, { reconnectDelayMs: 0 })
    const events: SetupEventView[] = []

    const result = await client.follow("run-1", (event) => events.push(event))

    expect(result.status).toBe("completed")
    expect(fake.calls.find((call) => call.method === "events")?.parameters).toEqual({ runId: "run-1", after: "0" })
    expect(events.map((event) => event.sequence)).toEqual([1, 2])
  })

  test("reconnects with after=N and reads the terminal snapshot when the stream drops", async () => {
    let attempts = 0
    const fake = sdk({
      progress2: {
        events: async (parameters: { after?: string }) => {
          attempts += 1
          if (attempts === 1) {
            return {
              stream: (async function* () {
                yield { sequence: 4, phase: "progress", message: "working", type: "progress" }
                throw new Error("transport dropped")
              })(),
            }
          }
          expect(parameters.after).toBe("5")
          return {
            stream: (async function* () {
              yield { sequence: 6, phase: "completed", message: "done", type: "progress" }
            })(),
          }
        },
      },
      progress: async () => ({ data: { runId: "run-1", status: "running", sequence: 5 } }),
    })
    const client = createSetupClient(fake.client, { reconnectDelayMs: 0 })
    const events: SetupEventView[] = []

    await client.follow("run-1", (event) => events.push(event))

    expect(attempts).toBe(2)
    expect(events.map((event) => event.sequence)).toEqual([4, 6])
  })
})
