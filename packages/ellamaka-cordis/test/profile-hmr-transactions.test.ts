import { describe, expect, test } from "bun:test"
import { createBunHmr } from "../src/plugins/bun-hmr"

describe("profile configuration transactions", () => {
  test("serializes different configuration consumers and rejects reentry", async () => {
    const hmr = createBunHmr({ containers: [], dshRoot: "/unused" })
    await hmr.mount()
    let active = 0
    let maximum = 0
    const result = await Promise.all(
      [1, 2, 3].map((value) =>
        hmr.runExclusive(async () => {
          active++
          maximum = Math.max(maximum, active)
          await Promise.resolve()
          active--
          return value
        }),
      ),
    )
    expect(result).toEqual([1, 2, 3])
    expect(maximum).toBe(1)
    await expect(hmr.runExclusive(() => hmr.runExclusive(async () => 1))).rejects.toThrow(/nested/)
    expect(await hmr.runExclusive(async () => "next")).toBe("next")
    await hmr.stop()
    await expect(hmr.runExclusive(async () => 1)).rejects.toThrow(/stopped|inactive/)
  })

  test("stop waits for the active transaction and refuses self-deadlock", async () => {
    const hmr = createBunHmr({ containers: [], dshRoot: "/unused" })
    await hmr.mount()
    await expect(hmr.runExclusive(() => hmr.stop())).rejects.toThrow(/transaction/)
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    const call = hmr.runExclusive(async () => {
      started()
      await blocker
      return "done"
    })
    await entered
    let stopped = false
    const stop = hmr.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    release()
    expect(await call).toBe("done")
    await stop
    expect(stopped).toBe(true)
  })

  test("failed activation restores the previous Include config before rejecting", async () => {
    const entry = {
      id: "root",
      options: { config: { value: "good" } },
      async update(options: unknown) {
        this.options = options as typeof this.options
      },
    }
    let validations = 0
    const hmr = createBunHmr({
      dshRoot: "/unused",
      containers: [{ profile: "fixture", includeEntry: entry }],
      afterApply: async () => {
        validations++
        if (entry.options.config.value === "bad") throw new Error("provider unavailable")
      },
    })
    await hmr.mount()
    await expect(hmr.runExclusive(() => entry.update({ config: { value: "bad" } }))).rejects.toThrow(
      "provider unavailable",
    )
    expect(entry.options.config.value).toBe("good")
    expect(validations).toBe(2)
    await hmr.stop()
  })
})
