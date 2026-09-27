import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import path from "path"
import { pathToFileURL } from "url"
import { HttpClient } from "effect/unstable/http"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { EffectFlock } from "@wopal/ellamaka-core/util/effect-flock"
import { Config } from "@/config/config"
import { isRecord } from "@/util/record"
import { Env } from "@/env"
import { disposeAllInstances, provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"

const { Plugin } = await import("../../src/plugin/index")
const { Bus } = await import("../../src/bus")
const { TestConfig } = await import("../fixture/config")
const { RuntimeFlags } = await import("../../src/effect/runtime-flags")

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, AppFileSystem.defaultLayer))

type Table = Record<string, Record<string, unknown>>
type Spec = string | [string, Record<string, unknown>]

function withTmp<T, A, E, R>(
  init: (dir: string) => Promise<T>,
  body: (tmp: { path: string; extra: T }) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const extra = yield* Effect.promise(() => init(dir))
    return yield* body({ path: dir, extra })
  })
}

function pluginFile(mark: string, id = "demo.plugin-config") {
  return [
    "export default {",
    `  id: ${JSON.stringify(id)},`,
    "  server: async (input, options) => {",
    `    await Bun.write(${JSON.stringify(mark)}, JSON.stringify({ pluginConfig: input.pluginConfig, options: options ?? null }))`,
    "    return {}",
    "  },",
    "}",
    "",
  ].join("\n")
}

function readDelivered(mark: string) {
  return Effect.promise(async () => {
    const raw: unknown = JSON.parse(await fs.readFile(mark, "utf8"))
    if (!isRecord(raw)) throw new Error(`plugin delivery marker is not an object: ${mark}`)
    return raw
  })
}

// Simulates the engine's Server-side delivery: whatever
// `Config.Interface.getPluginConfig()` returns must reach the plugin input.
function runWithTestConfig(dir: string, input: { plugin: Spec[]; pluginConfig: Table }) {
  const source = path.join(dir, "opencode.json")
  return Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    yield* plugin.list()
  }).pipe(
    Effect.provide(
      Plugin.layer.pipe(
        Layer.provide(Bus.layer),
        Layer.provide(RuntimeFlags.layer({ disableDefaultPlugins: true })),
        Layer.provide(
          TestConfig.layer({
            get: () =>
              Effect.succeed({
                plugin: input.plugin,
                plugin_origins: input.plugin.map((spec) => ({ spec, source, scope: "local" as const })),
              }),
            getPluginConfig: () => Effect.succeed(input.pluginConfig),
            directories: () => Effect.succeed([dir]),
          }),
        ),
      ),
    ),
    provideInstance(dir),
  )
}

const table: Table = {
  "demo.plugin-config": { level: 1, nested: { a: true } },
  "other.plugin": { level: 2 },
  "third.plugin": { list: ["x"], nested: { b: 1 } },
}

describe("PluginInput.pluginConfig delivery", () => {
  it.live("delivers the whole merged table without slicing by plugin name", () =>
    withTmp(
      async (dir) => {
        const file = path.join(dir, "plugin.ts")
        const mark = path.join(dir, "delivered.json")
        await Bun.write(file, pluginFile(mark))
        return { mark, spec: pathToFileURL(file).href }
      },
      (tmp) =>
        Effect.gen(function* () {
          yield* runWithTestConfig(tmp.path, { plugin: [tmp.extra.spec], pluginConfig: table })
          const seen = yield* readDelivered(tmp.extra.mark)
          // Entries for plugin names that were never loaded are still visible,
          // and the loaded plugin's own entry is not singled out.
          expect(seen.pluginConfig).toEqual(table)
        }),
    ),
  )

  it.live("passes inline options as the second argument and keeps them out of the table", () =>
    withTmp(
      async (dir) => {
        const file = path.join(dir, "plugin.ts")
        const mark = path.join(dir, "delivered.json")
        await Bun.write(file, pluginFile(mark))
        return { mark, spec: pathToFileURL(file).href }
      },
      (tmp) =>
        Effect.gen(function* () {
          yield* runWithTestConfig(tmp.path, {
            plugin: [[tmp.extra.spec, { inline: true }]],
            pluginConfig: table,
          })
          const seen = yield* readDelivered(tmp.extra.mark)
          expect(seen.options).toEqual({ inline: true })
          expect(seen.pluginConfig).toEqual(table)
          expect(seen.options).not.toHaveProperty("pluginConfig")
        }),
    ),
  )

  it.live("delivers the remaining entries when the plugin has no entry of its own", () =>
    withTmp(
      async (dir) => {
        const file = path.join(dir, "plugin.ts")
        const mark = path.join(dir, "delivered.json")
        await Bun.write(file, pluginFile(mark))
        return { mark, spec: pathToFileURL(file).href }
      },
      (tmp) =>
        Effect.gen(function* () {
          const pluginConfig: Table = { "someone.else": { x: 1 } }
          yield* runWithTestConfig(tmp.path, { plugin: [tmp.extra.spec], pluginConfig })
          const seen = yield* readDelivered(tmp.extra.mark)
          expect(seen.pluginConfig).toEqual(pluginConfig)
        }),
    ),
  )

  it.live("delivers an empty table outside a wopal space", () =>
    withTmp(
      async (dir) => {
        const file = path.join(dir, "plugin.ts")
        const mark = path.join(dir, "delivered.json")
        await Bun.write(file, pluginFile(mark))
        return { mark, spec: pathToFileURL(file).href }
      },
      (tmp) =>
        Effect.gen(function* () {
          yield* runWithTestConfig(tmp.path, { plugin: [tmp.extra.spec], pluginConfig: {} })
          const seen = yield* readDelivered(tmp.extra.mark)
          expect(seen.pluginConfig).toEqual({})
        }),
    ),
  )
})

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)

// Real engine chain for the non-space case: an actual Config instance reports an
// empty plugin config, and the plugin loader must deliver that empty table.
const realConfigLayer = Config.layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(AuthTest.empty),
  Layer.provide(AccountTest.empty),
  Layer.provideMerge(infra),
  Layer.provide(NpmTest.noop),
  Layer.provide(Layer.succeed(HttpClient.HttpClient, unexpectedHttp)),
  Layer.provideMerge(AppFileSystem.defaultLayer),
)

const realPluginLayer = Layer.mergeAll(
  Plugin.layer.pipe(
    Layer.provide(Bus.layer),
    Layer.provide(realConfigLayer),
    Layer.provide(RuntimeFlags.layer({ disableDefaultPlugins: true })),
  ),
  realConfigLayer,
)

const realIt = testEffect(realPluginLayer)

describe("PluginInput.pluginConfig on a real non-space instance", () => {
  realIt.instance("delivers {} end to end through the real Config and plugin loader", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, ".opencode", "plugin", "delivery.ts")
      const mark = path.join(test.directory, "delivered.json")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await Bun.write(file, pluginFile(mark))
      })

      const config = yield* Config.Service
      expect(yield* config.getPluginConfig()).toEqual({})
      expect(yield* config.isWopalSpace()).toBe(false)

      // The plugin is auto-discovered from `.opencode/plugin` by the real config
      // loader, so the empty engine table must reach its input.
      const plugin = yield* Plugin.Service
      yield* plugin.list()

      const seen = yield* readDelivered(mark)
      expect(seen.pluginConfig).toEqual({})
    }),
  )
})
