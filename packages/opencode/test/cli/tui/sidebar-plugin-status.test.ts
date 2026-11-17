import { describe, expect, test } from "bun:test"
import { serverPlugins, tuiPlugins } from "../../../src/cli/cmd/tui/feature-plugins/sidebar/plugin-status"

describe("sidebar plugin status", () => {
  test("distinguishes DSH runtime availability from configured server plugins", () => {
    const plugins = ["file:///workspace/.wopal/plugins/wopal-plugin/src/index.ts", ["@vendor/tool", {}] as const]
    expect(serverPlugins(plugins, { enabled: true }, "ready", { spaceRoot: "/workspace", home: "/home/user" })).toEqual(
      [
        { name: "dsh-adapter", source: "internal", status: "enabled" },
        { name: "wopal-plugin", source: "space", status: "configured" },
        { name: "@vendor/tool", source: "internal", status: "configured" },
      ],
    )
    expect(serverPlugins(["dsh-adapter"], { enabled: true }, "preparing", {})[0]?.status).toBe("preparing")
    expect(serverPlugins([], { enabled: true }, "degraded", {})[0]?.status).toBe("unavailable")
    expect(serverPlugins([], { enabled: true }, undefined, {})[0]?.status).toBe("unknown")
    expect(serverPlugins([], { enabled: false }, "ready", {})[0]?.status).toBe("disabled")
  })

  test("uses the live TUI runtime enabled and active flags", () => {
    const items = [
      {
        id: "internal:sidebar-mcp",
        source: "internal" as const,
        spec: "internal:sidebar-mcp",
        target: "",
        enabled: true,
        active: true,
      },
      { id: "demo", source: "file" as const, spec: "file:///tmp/demo", target: "", enabled: true, active: false },
      { id: "off", source: "file" as const, spec: "file:///tmp/off", target: "", enabled: false, active: false },
    ]
    expect(tuiPlugins(items)).toEqual([
      { name: "internal:sidebar-mcp", source: "internal", status: "active" },
      { name: "demo", source: "file", status: "inactive" },
      { name: "off", source: "file", status: "disabled" },
    ])
  })
})
