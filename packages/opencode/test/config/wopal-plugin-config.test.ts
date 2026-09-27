import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Global } from "@wopal/ellamaka-core/global"
import { EffectFlock } from "@wopal/ellamaka-core/util/effect-flock"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { HttpClient } from "effect/unstable/http"
import { Config } from "@/config/config"
import type { Info } from "@/config/config"
import { ConfigWopalPluginConfig } from "@/config/wopal-plugin-config"
import { tryLoadWopalSpaceConfig } from "@/config/wopal-space"
import type { WopalSpaceDeps } from "@/config/wopal-space"
import { Env } from "@/env"
import { InstanceRuntime } from "@/project/instance-runtime"
import { testEffect } from "../lib/effect"
import { TestInstance, tmpdir } from "../fixture/fixture"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"

const globalFile = "/global/config/settings.jsonc"
const spaceFile = "/space/.wopal/config/settings.jsonc"
const localFile = "/space/.wopal/config/settings.local.jsonc"

const layerOf = (source: "global" | "space" | "space-local", text: string | undefined, file: string) => ({
  source,
  path: file,
  text,
})
const globalLayer = (text: string | undefined) => layerOf("global", text, globalFile)
const spaceLayer = (text: string | undefined) => layerOf("space", text, spaceFile)
const localLayer = (text: string | undefined) => layerOf("space-local", text, localFile)

const settingsText = (pluginConfig: unknown, wrap: "wopal" | "bare" = "wopal") =>
  JSON.stringify(wrap === "wopal" ? { wopal: { pluginConfig } } : pluginConfig)

describe("mergePluginConfig", () => {
  test("deep merges global, space and space-local layers with later layers winning", () => {
    const result = ConfigWopalPluginConfig.mergePluginConfig([
      globalLayer(
        settingsText({
          app: { a: 1, nested: { x: 1, y: 2 }, list: ["g", "g2"] },
          other: { flag: true },
        }),
      ),
      spaceLayer(settingsText({ app: { b: 2, nested: { y: 3 }, list: ["s"] } })),
      localLayer(settingsText({ app: { nested: { z: 4 } }, localOnly: { v: 1 } })),
    ])

    expect(result.pluginConfig).toEqual({
      app: { a: 1, b: 2, nested: { x: 1, y: 3, z: 4 }, list: ["s"] },
      other: { flag: true },
      localOnly: { v: 1 },
    })
    expect(result.sources).toEqual({
      "app.a": "global",
      "app.nested.x": "global",
      "app.nested.y": "space",
      "app.b": "space",
      "app.list": "space",
      "other.flag": "global",
      "app.nested.z": "space-local",
      "localOnly.v": "space-local",
    })
  })

  test("replaces arrays as whole keys instead of merging them", () => {
    const result = ConfigWopalPluginConfig.mergePluginConfig([
      globalLayer(settingsText({ app: { list: [1, 2, 3], untouched: [1] } })),
      spaceLayer(settingsText({ app: { list: [9] } })),
    ])

    expect(result.pluginConfig).toEqual({ app: { list: [9], untouched: [1] } })
    expect(result.sources).toEqual({ "app.list": "space", "app.untouched": "global" })
  })

  test("records the effective layer only for overwritten scalar keys", () => {
    const result = ConfigWopalPluginConfig.mergePluginConfig([
      globalLayer(settingsText({ app: { mode: "global", other: 1 } })),
      localLayer(settingsText({ app: { mode: "local" } })),
    ])

    expect(result.pluginConfig).toEqual({ app: { mode: "local", other: 1 } })
    expect(result.sources).toEqual({ "app.mode": "space-local", "app.other": "global" })
  })

  test("drops stale leaf sources when a later layer changes a value's shape", () => {
    const objectOverScalar = ConfigWopalPluginConfig.mergePluginConfig([
      globalLayer(settingsText({ app: { mode: "simple" } })),
      localLayer(settingsText({ app: { mode: { deep: true } } })),
    ])
    expect(objectOverScalar.pluginConfig).toEqual({ app: { mode: { deep: true } } })
    expect(objectOverScalar.sources).toEqual({ "app.mode.deep": "space-local" })

    const scalarOverObject = ConfigWopalPluginConfig.mergePluginConfig([
      globalLayer(settingsText({ app: { mode: { deep: true } } })),
      localLayer(settingsText({ app: { mode: "simple" } })),
    ])
    expect(scalarOverObject.pluginConfig).toEqual({ app: { mode: "simple" } })
    expect(scalarOverObject.sources).toEqual({ "app.mode": "space-local" })
  })

  test("does not occupy source keys for empty objects", () => {
    const result = ConfigWopalPluginConfig.mergePluginConfig([
      globalLayer(settingsText({ app: { empty: {}, value: 1 } })),
    ])

    expect(result.pluginConfig).toEqual({ app: { empty: {}, value: 1 } })
    expect(result.sources).toEqual({ "app.value": "global" })
  })

  test("treats missing layers, unreadable files and absent wopal sections as empty contributions", () => {
    expect(ConfigWopalPluginConfig.mergePluginConfig([])).toEqual({ pluginConfig: {}, sources: {} })
    expect(
      ConfigWopalPluginConfig.mergePluginConfig([
        globalLayer(undefined),
        spaceLayer("{}"),
        localLayer(JSON.stringify({ ellamaka: { username: "x" } })),
      ]),
    ).toEqual({ pluginConfig: {}, sources: {} })
    expect(
      ConfigWopalPluginConfig.mergePluginConfig([
        spaceLayer(JSON.stringify({ wopal: {} })),
        localLayer(JSON.stringify({ wopal: { pluginConfig: {} } })),
      ]),
    ).toEqual({ pluginConfig: {}, sources: {} })
  })

  test("parses jsonc syntax including comments and trailing commas", () => {
    const result = ConfigWopalPluginConfig.mergePluginConfig([
      spaceLayer('{\n  // comment\n  "wopal": { "pluginConfig": { "app": { "a": 1, }, }, },\n}'),
    ])

    expect(result.pluginConfig).toEqual({ app: { a: 1 } })
  })

  test("degrades a syntax-corrupt layer to an empty contribution without throwing", () => {
    const result = ConfigWopalPluginConfig.mergePluginConfig([
      spaceLayer("{ this is : not jsonc"),
      localLayer(settingsText({ app: { a: 1 } })),
    ])

    expect(result.pluginConfig).toEqual({ app: { a: 1 } })
    expect(result.sources).toEqual({ "app.a": "space-local" })
  })

  test("fails loud with file path and key when pluginConfig is not an object", () => {
    const attempt = (text: string) => () =>
      ConfigWopalPluginConfig.mergePluginConfig([layerOf("space", text, "/space/.wopal/config/settings.jsonc")])

    for (const invalid of ["nope", null, ["a"]]) {
      expect(attempt(settingsText(invalid))).toThrow("wopal.pluginConfig")
      expect(attempt(settingsText(invalid))).toThrow("/space/.wopal/config/settings.jsonc")
    }

    expect(attempt(settingsText({ app: "not-an-object" }))).toThrow("wopal.pluginConfig.app")
    expect(attempt('{ "wopal": { "pluginConfig": } }')).not.toThrow()
  })

  test("classifies space settings files into public and local sources", () => {
    expect(ConfigWopalPluginConfig.settingsFileSource("/space/.wopal/config/settings.jsonc")).toBe("space")
    expect(ConfigWopalPluginConfig.settingsFileSource("/space/.wopal/config/settings.json")).toBe("space")
    expect(ConfigWopalPluginConfig.settingsFileSource("/space/.wopal/config/settings.local.jsonc")).toBe("space-local")
  })
})

async function writeSpace(root: string, settings: Record<string, unknown>) {
  await fs.mkdir(path.join(root, ".wopal", "config"), { recursive: true })
  await fs.writeFile(path.join(root, ".wopal", ".git"), "")
  for (const [file, content] of Object.entries(settings)) {
    await fs.writeFile(path.join(root, ".wopal", "config", file), JSON.stringify(content))
  }
}

function createMockDeps(overrides: Record<string, string> = {}): WopalSpaceDeps {
  const result: Partial<Info> = {}
  return {
    installPluginDeps: () => Effect.die(new Error("unexpected plugin dependency install in test")),
    installPluginDepsWithFingerprint: () => Effect.die(new Error("unexpected plugin dependency install in test")),
    readConfigFile: (filepath) =>
      Effect.promise(async () => overrides[filepath] ?? (await fs.readFile(filepath, "utf8").catch(() => undefined))),
    loadConfig: () => Effect.succeed({} as Info),
    getGlobal: () => Effect.succeed({} as Info),
    merge: () => Effect.succeed(undefined),
    mergePluginOrigins: () => Effect.succeed(undefined),
    ensureGitignore: () => Effect.succeed(undefined),
    applyPostMerge: () => {},
    initContainers: () => {},
    getResult: () => result as Info,
  }
}

describe("wopal-space engine plugin config", () => {
  test("merges the global settings file with the space layers in one load", async () => {
    await using tmp = await tmpdir()
    await writeSpace(tmp.path, {
      "settings.jsonc": {
        ellamaka: {},
        wopal: { pluginConfig: { app: { b: 2, nested: { x: 99, y: 2 }, list: ["s"] } } },
      },
      "settings.local.jsonc": { wopal: { pluginConfig: { app: { nested: { z: 3 } }, g: { only: true } } } },
    })
    const globalPath = path.join(Global.Path.config, "settings.jsonc")
    const deps = createMockDeps({
      [globalPath]: JSON.stringify({
        ellamaka: {},
        wopal: { pluginConfig: { app: { a: 1, nested: { x: 1 }, list: ["g"] }, other: { flag: true } } },
      }),
    })

    const result = await Effect.runPromise(tryLoadWopalSpaceConfig(deps, { directory: tmp.path }))

    expect(result?.pluginConfig).toEqual({
      app: { a: 1, b: 2, nested: { x: 99, y: 2, z: 3 }, list: ["s"] },
      other: { flag: true },
      g: { only: true },
    })
    expect(result?.pluginConfigSources).toEqual({
      "app.a": "global",
      "app.b": "space",
      "app.nested.x": "space",
      "app.nested.y": "space",
      "app.nested.z": "space-local",
      "app.list": "space",
      "other.flag": "global",
      "g.only": "space-local",
    })
  })

  test("degrades a corrupt global settings file to an empty layer", async () => {
    await using tmp = await tmpdir()
    await writeSpace(tmp.path, {})
    const globalPath = path.join(Global.Path.config, "settings.jsonc")

    const result = await Effect.runPromise(
      tryLoadWopalSpaceConfig(createMockDeps({ [globalPath]: "{ not jsonc" }), { directory: tmp.path }),
    )

    expect(result?.pluginConfig).toEqual({})
    expect(result?.pluginConfigSources).toEqual({})
  })

  test("fails loud when a space settings file declares a non-object pluginConfig", async () => {
    await using tmp = await tmpdir()
    await writeSpace(tmp.path, {
      "settings.jsonc": { wopal: { pluginConfig: "nope" } },
    })

    const failure = Effect.runPromise(tryLoadWopalSpaceConfig(createMockDeps(), { directory: tmp.path }))
    const outcome = await failure.then(
      () => undefined,
      (error: unknown) => error,
    )
    if (!(outcome instanceof Error)) throw new Error("expected the plugin config merge to fail")
    expect(outcome.message).toContain("wopal.pluginConfig")
  })
})

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)

const layer = Config.layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(AuthTest.empty),
  Layer.provide(AccountTest.empty),
  Layer.provideMerge(infra),
  Layer.provide(NpmTest.noop),
  Layer.provide(Layer.succeed(HttpClient.HttpClient, unexpectedHttp)),
  Layer.provideMerge(AppFileSystem.defaultLayer),
)

const it = testEffect(layer)

const clear = () =>
  Effect.runPromise(
    Config.use
      .invalidate()
      .pipe(
        Effect.scoped,
        Effect.provide(layer),
        Effect.andThen(Effect.promise(() => InstanceRuntime.disposeAllInstances())),
      ),
  )

const globalSettingsPath = path.join(Global.Path.config, "settings.jsonc")

async function writeGlobalSettings(settings: unknown) {
  await fs.mkdir(Global.Path.config, { recursive: true })
  await fs.writeFile(globalSettingsPath, JSON.stringify(settings, null, 2))
}

async function removeGlobalSettings() {
  await fs.rm(globalSettingsPath, { force: true }).catch(() => undefined)
}

beforeEach(async () => {
  await removeGlobalSettings()
  await clear()
})

afterEach(async () => {
  await removeGlobalSettings()
  await clear()
})

describe("Config.Interface.getPluginConfig", () => {
  it.instance("mounts the merged table on the instance state and keeps ellamaka extraction intact", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeGlobalSettings({
          ellamaka: {},
          wopal: { pluginConfig: { app: { a: 1, nested: { x: 1 }, list: ["g"] } } },
        }),
      )
      yield* Effect.promise(() =>
        writeSpace(test.directory, {
          "settings.jsonc": {
            ellamaka: { username: "space-user" },
            wopal: { pluginConfig: { app: { b: 2, nested: { y: 2 }, list: ["s"] } } },
          },
          "settings.local.jsonc": { wopal: { pluginConfig: { app: { nested: { z: 3 } } } } },
        }),
      )

      const pluginConfig = yield* Config.use.getPluginConfig()
      expect(pluginConfig).toEqual({ app: { a: 1, b: 2, nested: { x: 1, y: 2, z: 3 }, list: ["s"] } })

      const config = yield* Config.use.get()
      expect(config.username).toBe("space-user")
    }),
  )

  it.instance("returns an empty table outside a wopal space", () =>
    Effect.gen(function* () {
      const pluginConfig = yield* Config.use.getPluginConfig()
      expect(pluginConfig).toEqual({})
    }),
  )
})
