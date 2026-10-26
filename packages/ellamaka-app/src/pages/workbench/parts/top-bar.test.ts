import { describe, expect, test } from "bun:test"
import { activateSpaceTab } from "./space-tab-activation"

describe("activateSpaceTab", () => {
  test("activates the tab directly; WorkbenchState clears transient DSH selection", () => {
    const calls: string[] = []
    const wb = {
      setActive: (path: string) => calls.push(`active:${path}`),
    }
    activateSpaceTab(wb, "/space-a")
    expect(calls).toEqual(["active:/space-a"])
  })

  test("activating the general tab uses the same navigation entry", () => {
    const calls: string[] = []
    const wb = {
      setActive: (path: string) => calls.push(`active:${path}`),
    }
    activateSpaceTab(wb, "")
    expect(calls).toEqual(["active:"])
  })
})
