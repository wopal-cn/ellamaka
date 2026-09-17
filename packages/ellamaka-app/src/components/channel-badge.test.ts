import { describe, expect, test } from "bun:test"
import { shouldShowChannelIndicator } from "./channel-badge"

describe("titlebar channel indicator predicate", () => {
  test("shows badge on main, local and beta; hides on stable", () => {
    expect(shouldShowChannelIndicator("main")).toBe(true)
    expect(shouldShowChannelIndicator("local")).toBe(true)
    expect(shouldShowChannelIndicator("beta")).toBe(true)
    expect(shouldShowChannelIndicator("stable")).toBe(false)
  })

  test("hides badge when channel is undefined", () => {
    expect(shouldShowChannelIndicator(undefined)).toBe(false)
  })
})
