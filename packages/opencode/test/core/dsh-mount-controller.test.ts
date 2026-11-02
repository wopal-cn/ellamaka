import { describe, expect, test } from "bun:test"
import { createDshMountController } from "@/cli/cmd/dsh-mount-controller"
import type { Listener } from "@/server/server"

// The injected mount function owns the fake listener boundary in these tests.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const server = {} as Listener

describe("DSH mount controller", () => {
  test("resolves the effective Home when mount actually starts", async () => {
    let effectiveHome = "/candidate-home"
    let mountedHome: string | undefined
    const controller = createDshMountController({
      server,
      resolveWopalHome: () => effectiveHome,
      mountEngine: async (wopalHome) => {
        mountedHome = wopalHome
        return { mountPath: "/dsh", dispose: async () => {} }
      },
    })

    effectiveHome = "/selected-home"
    expect(await controller.ensure()).toBe(true)
    expect(mountedHome).toBe("/selected-home")
    await controller.dispose()
  })

  test("joins concurrent requests and retries after a failed mount", async () => {
    let calls = 0
    const controller = createDshMountController({
      server,
      mountEngine: async () => {
        calls += 1
        if (calls === 1) return undefined
        return { mountPath: "/dsh", dispose: async () => {} }
      },
    })
    expect(await Promise.all([controller.ensure(), controller.ensure()])).toEqual([false, false])
    expect(calls).toBe(1)
    expect(await controller.ensure()).toBe(true)
    expect(calls).toBe(2)
    await controller.dispose()
  })

  test("waits for an in-flight mount and disposes it during shutdown", async () => {
    let finish!: (handle: { mountPath: string; dispose: () => Promise<void> }) => void
    const pending = new Promise<{ mountPath: string; dispose: () => Promise<void> }>((resolve) => (finish = resolve))
    let disposed = false
    const controller = createDshMountController({ server, mountEngine: () => pending })
    const mounting = controller.ensure()
    const closing = controller.dispose()
    finish({
      mountPath: "/dsh",
      dispose: async () => {
        disposed = true
      },
    })
    expect(await mounting).toBe(false)
    await closing
    expect(disposed).toBe(true)
    expect(controller.current()).toBeUndefined()
  })
})
