/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createOpencodeClient } from "@wopal/ellamaka-sdk/v2"
import { View } from "../../../src/cli/cmd/tui/feature-plugins/sidebar/plugins"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createFetch, json } from "../../fixture/tui-sdk"

test("renders server and TUI plugins from their respective sources", async () => {
  let resolveReady: (() => void) | undefined
  let listCalls = 0
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const transport = createFetch((url) => {
    if (url.pathname === "/wopal-space/spaces/resolve")
      return json({
        name: "test",
        path: "/tmp/opencode",
        space: { name: "test", path: "/tmp/opencode" },
        source: "directory",
      })
    if (url.pathname === "/global/health")
      return json({ healthy: true, version: "test", dsh: { tools: "ready", web: "disabled" } })
    if (url.pathname === "/config-v2")
      return json({
        effective: {
          ellamaka: {},
          wopal: { dsh: { web: { enabled: false } }, pluginConfig: { "dsh-adapter": { sandbox: { enabled: true } } } },
        },
      })
    return undefined
  })
  const client = createOpencodeClient({ baseUrl: "http://test", fetch: transport.fetch })
  const base = createTuiPluginApi({
    client,
    state: {
      config: { plugin: ["file:///tmp/opencode/plugins/wopal-plugin/src/index.ts"] },
      path: { state: "", config: "", worktree: "/tmp/opencode/project", directory: "/tmp/opencode/project" },
    },
  })
  const api = {
    ...base,
    plugins: {
      ...base.plugins,
      list: () => {
        if (++listCalls === 2) resolveReady?.()
        return [{ id: "test.tui", source: "file" as const, spec: "test", target: "test", enabled: true, active: true }]
      },
    },
  }
  const app = await testRender(() => <View api={api} />, { width: 37, height: 20 })
  try {
    await ready
    await Promise.resolve()
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Server Plugins")
    expect(frame).toContain("dsh-adapter")
    expect(frame).toContain("Enabled")
    expect(frame).toContain("wopal-plugin")
    expect(frame).toContain("space")
    expect(frame).toContain("Configured")
    expect(frame).toContain("TUI Plugins")
    expect(frame).toContain("test.tui")
    expect(frame).toContain("Active")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps TUI plugins visible and reports unknown when server status cannot be read", async () => {
  let resolveReady: (() => void) | undefined
  let listCalls = 0
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const transport = createFetch((url) => {
    if (url.pathname === "/global/health" || url.pathname === "/config-v2")
      return json({ message: "unavailable" }, { status: 503 })
    return undefined
  })
  const client = createOpencodeClient({ baseUrl: "http://test", fetch: transport.fetch })
  const base = createTuiPluginApi({ client })
  const api = {
    ...base,
    plugins: {
      ...base.plugins,
      list: () => {
        if (++listCalls === 2) resolveReady?.()
        return [{ id: "test.tui", source: "file" as const, spec: "test", target: "test", enabled: true, active: true }]
      },
    },
  }
  const app = await testRender(() => <View api={api} />, { width: 37, height: 12 })
  try {
    await ready
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("dsh-adapter")
    expect(frame).toContain("Unknown")
    expect(frame).toContain("test.tui")
    expect(frame).toContain("Active")
  } finally {
    app.renderer.destroy()
  }
})
