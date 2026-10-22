import { describe, expect, test } from "bun:test"
import { describeStatusPlugin, statusPlugins } from "./status-plugins"

describe("status plugin list", () => {
  const external = ["file:///workspace/plugins/wopal-plugin"]
  const sandbox = { enabled: true, mode: "workspace-write" }

  test("includes the enabled built-in adapter alongside external plugins", () => {
    expect(statusPlugins(external, sandbox, "ready")).toEqual([
      { name: "dsh-adapter", source: "internal" },
      { name: external[0] },
    ])
  })

  test("does not report the built-in adapter as enabled without a ready sandbox", () => {
    for (const status of [undefined, "disabled", "preparing", "degraded"] as const) {
      expect(statusPlugins(external, sandbox, status)).toEqual([{ name: external[0] }])
    }
    expect(statusPlugins(external, { enabled: false }, "ready")).toEqual([{ name: external[0] }])
    expect(statusPlugins([], undefined, "ready")).toEqual([])
  })

  test("counts a legacy named adapter once and preserves external tuple declarations", () => {
    expect(statusPlugins(["dsh-adapter", ["other-plugin", {}]], sandbox, "ready")).toEqual([
      { name: "dsh-adapter", source: "internal" },
      { name: "other-plugin" },
    ])
  })
})

describe("plugin names and sources", () => {
  const roots = { spaceRoot: "/Users/sam/workspace", userHome: "/Users/sam" }

  test("space paths take precedence over the user home and display the package directory", () => {
    expect(
      describeStatusPlugin({ name: "file:///Users/sam/workspace/.wopal/plugins/wopal-plugin/index.ts" }, roots),
    ).toEqual({ name: "wopal-plugin", source: "space" })
  })

  test("plugins loaded from the user directory are user plugins", () => {
    expect(describeStatusPlugin({ name: "file:///Users/sam/.wopal/plugins/my-plugin.ts" }, roots)).toEqual({
      name: "my-plugin",
      source: "user",
    })
  })

  test("bundled system and imported internal sources are explicit", () => {
    expect(describeStatusPlugin({ name: "auth-plugin", source: "system" }, roots)).toEqual({
      name: "auth-plugin",
      source: "system",
    })
    expect(describeStatusPlugin({ name: "dsh-adapter", source: "internal" }, roots)).toEqual({
      name: "dsh-adapter",
      source: "internal",
    })
    expect(describeStatusPlugin({ name: "@vendor/plugin" }, roots)).toEqual({
      name: "@vendor/plugin",
      source: "internal",
    })
  })

  test("path matching respects directory boundaries", () => {
    expect(describeStatusPlugin({ name: "file:///Users/sam/workspace-other/plugin.js" }, roots).source).toBe("user")
    expect(describeStatusPlugin({ name: "file:///Users/samantha/plugin.js" }, roots).source).toBe("internal")
  })

  test("file URL decoding and compiled package entry names remain readable", () => {
    expect(
      describeStatusPlugin({ name: "file:///Users/sam/workspace/plugins/%E6%8F%92%E4%BB%B6/dist/index.js" }, roots),
    ).toEqual({ name: "插件", source: "space" })
  })

  test("Windows paths and file URLs use the same containment rules", () => {
    const windows = { spaceRoot: "C:\\Users\\Sam\\Space", userHome: "C:\\Users\\Sam" }
    expect(describeStatusPlugin({ name: "file:///c:/users/sam/space/plugins/fixture/index.js" }, windows)).toEqual({
      name: "fixture",
      source: "space",
    })
    expect(describeStatusPlugin({ name: "C:\\Users\\Sam\\.wopal\\plugins\\fixture.ts" }, windows)).toEqual({
      name: "fixture",
      source: "user",
    })
  })
})
