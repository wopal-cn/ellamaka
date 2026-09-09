import { describe, expect, test } from "bun:test"
import { activateSpaceTab } from "./space-tab-activation"

describe("activateSpaceTab", () => {
  test("activates the tab directly; DSH visibility is derived from the active tab", () => {
    const calls: string[] = []
    const wb = {
      setActive: (path: string) => calls.push(`active:${path}`),
    }
    activateSpaceTab(wb as never, "/space-a")
    expect(calls).toEqual(["active:/space-a"])
  })

  test("activating the general tab switches DSH into view without extra state writes", () => {
    const calls: string[] = []
    const wb = {
      setActive: (path: string) => calls.push(`active:${path}`),
    }
    activateSpaceTab(wb as never, "")
    expect(calls).toEqual(["active:"])
  })
})