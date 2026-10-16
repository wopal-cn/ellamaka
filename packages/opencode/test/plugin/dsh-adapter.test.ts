import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Exit } from "effect"
import { pathToFileURL } from "node:url"
import path from "node:path"
import fs from "node:fs/promises"
import { Plugin } from "@/plugin"
import { Bus } from "@/bus"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"

const globals = globalThis as Record<string, unknown>
const old = globals.__ellamakaDshContainer
const env = process.env.ELLAMAKA_DSH
afterEach(async () => {
  await disposeAllInstances()
  globals.__ellamakaDshContainer = old
  if (env === undefined) delete process.env.ELLAMAKA_DSH
  else process.env.ELLAMAKA_DSH = env
})

const declarations: Array<string | [string, Record<string, unknown>]> = []
let config: Record<string, Record<string, unknown>> = {}
let preparations = 0
const layer = Plugin.layer.pipe(
  Layer.provide(Bus.layer),
  Layer.provide(RuntimeFlags.layer({ disableDefaultPlugins: true })),
  Layer.provide(
    TestConfig.layer({
      get: () =>
        Effect.succeed({
          plugin: declarations,
          plugin_origins: declarations.map((spec) => ({ spec, source: "test", scope: "local" as const })),
        }),
      getPluginConfig: () => Effect.sync(() => config),
      waitForDependencies: () =>
        Effect.sync(() => {
          preparations++
        }),
    }),
  ),
)
const it = testEffect(layer)

function setup() {
  process.env.ELLAMAKA_DSH = "1"
  config = { "dsh-adapter": { sandbox: { enabled: true } } }
  declarations.length = 0
  preparations = 0
  globals.__ellamakaDshContainer = {
    get: () => ({
      schemas: () =>
        ["bash", "edit", "glob", "grep", "read", "str_replace_editor", "write"].map((name) => ({
          name,
          description: name,
          parameters: { properties: {} },
        })),
    }),
    on: () => () => {},
    logger: () => ({ error() {} }),
  }
}

describe("built-in adapter engine registration", () => {
  it.instance("takes legacy inline options without installing the external package", () =>
    Effect.gen(function* () {
      setup()
      config = {}
      declarations.push(["dsh-adapter@0.1.0", { sandbox: { enabled: true } }])
      const service = yield* Plugin.Service
      const output = yield* service.trigger("tool.provider", { providerID: "test", modelID: "test" }, { tools: {} })
      expect(Object.keys(output.tools)).toHaveLength(7)
      expect(preparations).toBe(0)
    }),
  )

  it.instance("retains invalid-parameter failure instead of using native defaults", () =>
    Effect.gen(function* () {
      setup()
      config = { "dsh-adapter": { sandbox: { enabled: "yes" } } }
      const service = yield* Plugin.Service
      const exit = yield* service
        .trigger("tool.provider", { providerID: "test", modelID: "test" }, { tools: {} })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
  it.instance("projects without any external adapter declaration", () =>
    Effect.gen(function* () {
      setup()
      const service = yield* Plugin.Service
      const output = yield* service.trigger("tool.provider", { providerID: "test", modelID: "test" }, { tools: {} })
      expect(Object.keys(output.tools)).toHaveLength(7)
    }),
  )

  it.instance("never imports the old duplicate, including a renamed metadata-identified package", () =>
    Effect.gen(function* () {
      setup()
      const instance = yield* TestInstance
      const dir = path.join(instance.directory, "renamed")
      const marker = path.join(instance.directory, "external-executed")
      yield* Effect.promise(async () => {
        await fs.mkdir(dir)
        await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "dsh-adapter", main: "index.ts" }))
        await fs.writeFile(
          path.join(dir, "index.ts"),
          `await Bun.write(${JSON.stringify(marker)}, "executed"); export default {id: "dsh-adapter", server: async () => ({})}`,
        )
      })
      declarations.push(pathToFileURL(dir).href)
      const service = yield* Plugin.Service
      const output = yield* service.trigger("tool.provider", { providerID: "test", modelID: "test" }, { tools: {} })
      expect(Object.keys(output.tools)).toHaveLength(7)
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
    }),
  )

  it.instance("does not swallow required container or config failure as an optional internal plugin", () =>
    Effect.gen(function* () {
      setup()
      delete globals.__ellamakaDshContainer
      const service = yield* Plugin.Service
      // Passive config/discovery hooks remain usable; only an adopted tool
      // request must fail, never quietly substitute the native backend.
      expect(Exit.isSuccess(yield* service.list().pipe(Effect.exit))).toBe(true)
      expect(
        Exit.isFailure(
          yield* service
            .trigger("tool.provider", { providerID: "test", modelID: "test" }, { tools: {} })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
    }),
  )

  it.instance("explicitly disabled adoption retains native hooks", () =>
    Effect.gen(function* () {
      setup()
      config = { "dsh-adapter": { sandbox: { enabled: false } } }
      delete globals.__ellamakaDshContainer
      const service = yield* Plugin.Service
      expect(yield* service.list()).toEqual([])
    }),
  )
})
