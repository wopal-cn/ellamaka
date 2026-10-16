import { describe, expect, test } from "bun:test"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Event, RuntimeReloaded } from "@/server/event"
import { emitRuntimeReloaded, revisionOf, resetRuntimeRevisions } from "@/server/runtime-reload"

/** Collect matching global-bus events while `run` executes (plain bun:test). */
async function collectReloaded(run: () => void): Promise<GlobalEvent[]> {
  const collected: GlobalEvent[] = []
  const listener = (event: GlobalEvent) => {
    if (event.payload.type === "runtime.reloaded") collected.push(event)
  }
  GlobalBus.on("event", listener)
  try {
    run()
    // The emit is synchronous on the GlobalBus; a microtask turn flushes it.
    await new Promise((resolve) => setTimeout(resolve, 0))
  } finally {
    GlobalBus.off("event", listener)
  }
  return collected
}

describe("runtime.reloaded event", () => {
  test("schema registers the runtime.reloaded event type", () => {
    expect(RuntimeReloaded.type).toBe("runtime.reloaded")
  })

  test("emitRuntimeReloaded publishes unit and a monotonic per-unit revision", async () => {
    resetRuntimeRevisions()
    const events = await collectReloaded(() => emitRuntimeReloaded("dsh:web"))
    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toMatchObject({
      type: "runtime.reloaded",
      properties: { unit: "dsh:web", revision: 1 },
    })

    const next = await collectReloaded(() => emitRuntimeReloaded("dsh:web"))
    expect(next).toHaveLength(1)
    expect(next[0]!.payload).toMatchObject({
      type: "runtime.reloaded",
      properties: { unit: "dsh:web", revision: 2 },
    })
  })

  test("revisions are independent per unit", () => {
    resetRuntimeRevisions()
    emitRuntimeReloaded("dsh:web")
    emitRuntimeReloaded("dsh:tools")
    emitRuntimeReloaded("dsh:web")
    emitRuntimeReloaded("global")
    expect(revisionOf("dsh:web")).toBe(2)
    expect(revisionOf("dsh:tools")).toBe(1)
    expect(revisionOf("global")).toBe(1)
    expect(revisionOf("instance:/tmp/space-a" as const)).toBe(0)
  })

  test("global.disposed event definition keeps its original type", () => {
    expect(Event.Disposed.type).toBe("global.disposed")
  })
})
