import { describe, expect, test } from "bun:test"
import { statusPlugins } from "./status-plugins"

describe("status plugin list", () => {
  const external = ["file:///workspace/plugins/wopal-plugin"]
  const sandbox = { enabled: true, mode: "workspace-write" }

  test("includes the enabled built-in adapter alongside external plugins", () => {
    expect(statusPlugins(external, sandbox, "ready")).toEqual([
      { name: "dsh-adapter", builtin: true },
      { name: external[0], builtin: false },
    ])
  })

  test("does not report the built-in adapter as enabled without a ready sandbox", () => {
    for (const status of [undefined, "disabled", "preparing", "degraded"] as const) {
      expect(statusPlugins(external, sandbox, status)).toEqual([{ name: external[0], builtin: false }])
    }
    expect(statusPlugins(external, { enabled: false }, "ready")).toEqual([{ name: external[0], builtin: false }])
    expect(statusPlugins([], undefined, "ready")).toEqual([])
  })

  test("counts a legacy named adapter once and preserves external tuple declarations", () => {
    expect(statusPlugins(["dsh-adapter", ["other-plugin", {}]], sandbox, "ready")).toEqual([
      { name: "dsh-adapter", builtin: true },
      { name: "other-plugin", builtin: false },
    ])
  })
})
