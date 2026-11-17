import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TuiPluginRuntime } from "../../../src/cli/cmd/tui/plugin/runtime"

test("registers the plugin sidebar in the TUI runtime", async () => {
  await using tmp = await tmpdir()
  try {
    await TuiPluginRuntime.init({
      api: createTuiPluginApi(),
      config: createTuiResolvedConfig(),
      environment: { pure: true, metaFile: path.join(tmp.path, "plugins.json") },
    })
    expect(TuiPluginRuntime.list().find((item) => item.id === "internal:sidebar-plugins")).toMatchObject({
      source: "internal",
      enabled: true,
      active: true,
    })
  } finally {
    await TuiPluginRuntime.dispose()
  }
})
