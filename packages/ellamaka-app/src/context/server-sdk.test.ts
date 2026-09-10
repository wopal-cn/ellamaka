import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { preserveServerSdkEventStatus, createDirSdkMode, createServerSdkEventResync } from "./server-sdk"

describe("preserveServerSdkEventStatus", () => {
  test("keeps eventStatus reactive after preparing the provider value", () => {
    let status = "stopped"
    const sdk = {
      url: "http://localhost:4096",
      get eventStatus() {
        return status
      },
    }

    const provider = preserveServerSdkEventStatus(sdk, {})
    expect(provider.eventStatus).toBe("stopped")

    status = "connected"
    expect(provider.eventStatus).toBe("connected")
  })
})

describe("createServerSdkEventResync", () => {
  test("emits resync after a real disconnect, not on first connect", () => {
    const resync = createServerSdkEventResync()
    const seen: string[] = []
    resync.onResync(() => seen.push("resync"))

    resync.notifyConnected()
    expect(seen).toEqual([])

    resync.notifyDisconnected()
    resync.notifyConnected()
    expect(seen).toEqual(["resync"])

    resync.notifyDisconnected()
    resync.notifyConnected()
    expect(seen).toEqual(["resync", "resync"])
  })

  test("does not emit when stream ends without reconnect", () => {
    const resync = createServerSdkEventResync()
    const seen: string[] = []
    resync.onResync(() => seen.push("resync"))

    resync.notifyConnected()
    resync.notifyDisconnected()
    expect(seen).toEqual([])
  })
})

describe("createDirSdkMode", () => {
  test("does not request mode until a shared directory context is activated", async () => {
    let loads = 0
    let resolveLoad: ((value: boolean) => void) | undefined
    let mode: ReturnType<typeof createDirSdkMode> | undefined

    const dispose = createRoot((dispose) => {
      mode = createDirSdkMode({
        load: () => {
          loads += 1
          return new Promise<boolean>((resolve) => {
            resolveLoad = resolve
          })
        },
      })
      return dispose
    })

    try {
      if (!mode) throw new Error("mode required")
      expect(loads).toBe(0)
      expect(mode.isWopalSpaceLoading).toBe(false)

      mode.activate()
      expect(loads).toBe(1)
      expect(mode.isWopalSpaceLoading).toBe(true)

      resolveLoad?.(true)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(mode.isWopalSpace).toBe(true)
    } finally {
      dispose()
    }
  })
})
