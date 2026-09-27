import { expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { isRecord } from "@/util/record"
import { tmpdir } from "../../fixture/fixture"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TuiConfig } from "../../../src/cli/cmd/tui/config/tui"

const { TuiPluginRuntime } = await import("../../../src/cli/cmd/tui/plugin/runtime")

type Table = Record<string, Record<string, unknown>>

// Same values the config-chain fixture produces (test/config/tui-plugin-config.test.ts),
// so a delivered table can be compared key by key with the server-side chain.
const fixtureTable: Table = { app: { a: 1, b: 2, nested: { x: 1, y: 2, z: 3 } }, other: { flag: true } }

function pluginSource(marker: string) {
  return [
    "export default {",
    '  id: "demo.plugin-config-delivery",',
    "  tui: async (api) => {",
    `    await Bun.write(${JSON.stringify(marker)}, JSON.stringify({`,
    "      pluginConfig: api.pluginConfig,",
    "      theme: api.tuiConfig.theme,",
    "      selected: api.theme.selected,",
    "      kv_ready: api.kv.ready,",
    "      slots: typeof api.slots.register,",
    "      state_ready: api.state.ready,",
    "    }))",
    "  },",
    "}",
    "",
  ].join("\n")
}

async function delivered(marker: string) {
  const raw: unknown = JSON.parse(await fs.readFile(marker, "utf8"))
  if (!isRecord(raw)) throw new Error(`tui plugin marker is not an object: ${marker}`)
  return raw
}

async function runDelivery(opts?: Parameters<typeof createTuiPluginApi>[0]) {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const file = path.join(dir, "config-delivery-plugin.ts")
      const marker = path.join(dir, "delivered.json")
      await Bun.write(file, pluginSource(marker))
      return { spec: pathToFileURL(file).href, marker }
    },
  })

  process.env.OPENCODE_PLUGIN_META_FILE = path.join(tmp.path, "plugin-meta.json")
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
  const cwd = spyOn(process, "cwd").mockImplementation(() => tmp.path)

  try {
    await TuiPluginRuntime.init({
      api: createTuiPluginApi(opts),
      config: createTuiResolvedConfig({
        plugin: [tmp.extra.spec],
        plugin_origins: [{ spec: tmp.extra.spec, scope: "local", source: path.join(tmp.path, "tui.json") }],
      }),
    })
    return await delivered(tmp.extra.marker)
  } finally {
    await TuiPluginRuntime.dispose()
    cwd.mockRestore()
    wait.mockRestore()
    delete process.env.OPENCODE_PLUGIN_META_FILE
  }
}

test("delivers the plugin config table to tui plugins without regressing existing api fields", async () => {
  const seen = await runDelivery({ pluginConfig: fixtureTable, tuiConfig: { theme: "demo-theme" } })

  expect(seen.pluginConfig).toEqual(fixtureTable)
  expect(seen.theme).toBe("demo-theme")
  expect(seen.selected).toBe("opencode")
  expect(seen.kv_ready).toBe(true)
  expect(seen.slots).toBe("function")
  expect(seen.state_ready).toBe(true)
})

test("delivers an empty plugin config table by default", async () => {
  const seen = await runDelivery()

  expect(seen.pluginConfig).toEqual({})
})
