import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSpaceMount } from "./space-mount"

describe("Space runtime lifetime", () => {
  test("restores only the current tab, mounts on first visit, and retains background Panels", () => {
    createRoot((dispose) => {
      const [active, setActive] = createSignal("general")
      const general = createSpaceMount(() => active() === "general")
      const a = createSpaceMount(() => active() === "a")
      const b = createSpaceMount(() => active() === "b")
      expect([general(), a(), b()]).toEqual([true, false, false])
      setActive("a")
      expect([general(), a(), b()]).toEqual([true, true, false])
      setActive("b")
      expect([general(), a(), b()]).toEqual([true, true, true])
      setActive("general")
      expect([general(), a(), b()]).toEqual([true, true, true])
      dispose()
    })
  })

  test("a new page lifetime does not inherit visited state from persisted tabs", () => {
    createRoot((dispose) => {
      expect(createSpaceMount(() => false)()).toBe(false)
      dispose()
    })
  })
})
