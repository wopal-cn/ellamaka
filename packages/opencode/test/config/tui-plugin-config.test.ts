import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { Global } from "@wopal/ellamaka-core/global"
import { Config } from "@/config/config"
import type { Info } from "@/config/config"
import { CurrentWorkingDirectory } from "@/cli/cmd/tui/config/cwd"
import { TuiConfig } from "../../src/cli/cmd/tui/config/tui"
import { tryLoadWopalSpaceTuiConfig } from "../../src/cli/cmd/tui/config/wopal-space"
import { TestInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Config.defaultLayer, AppFileSystem.defaultLayer))

const globalSettingsPath = path.join(Global.Path.config, "settings.jsonc")

async function writeGlobalSettings(settings: unknown) {
  await fs.mkdir(Global.Path.config, { recursive: true })
  await fs.writeFile(globalSettingsPath, JSON.stringify(settings, null, 2))
}

async function removeGlobalSettings() {
  await fs.rm(globalSettingsPath, { force: true }).catch(() => undefined)
}

beforeEach(removeGlobalSettings)
afterEach(removeGlobalSettings)

async function writeSpace(root: string, settings: Record<string, unknown>) {
  await fs.mkdir(path.join(root, ".wopal", "config"), { recursive: true })
  await fs.writeFile(path.join(root, ".wopal", ".git"), "")
  for (const [file, content] of Object.entries(settings)) {
    await fs.writeFile(path.join(root, ".wopal", "config", file), JSON.stringify(content))
  }
}

const getTuiConfig = (directory: string) =>
  TuiConfig.Service.use((svc) => svc.get()).pipe(
    Effect.provide(TuiConfig.defaultLayer.pipe(Layer.provide(Layer.succeed(CurrentWorkingDirectory, directory)))),
  )

const withEnv = <A, E, R>(name: string, value: string | undefined, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[name]
        else process.env[name] = previous
      }),
  )

// The same three-layer fixture on both chains: global settings file + space
// public/local settings. Server and TUI must produce the identical table from
// independent merges.
const fixtureGlobal = {
  ellamaka: {},
  wopal: { pluginConfig: { app: { a: 1, nested: { x: 1 } }, other: { flag: true } } },
}
const fixtureSpace = {
  "settings.jsonc": { ellamaka: {}, wopal: { pluginConfig: { app: { b: 2, nested: { y: 2 } } } } },
  "settings.local.jsonc": { wopal: { pluginConfig: { app: { nested: { z: 3 } } } } },
}
const fixtureTable = { app: { a: 1, b: 2, nested: { x: 1, y: 2, z: 3 } }, other: { flag: true } }

describe("TuiConfig.Resolved.pluginConfig", () => {
  it.instance("delivers the same three-layer merge as the server chain", () =>
    withEnv(
      "WOPAL_SPACE",
      "1",
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => writeGlobalSettings(fixtureGlobal))
        yield* Effect.promise(() => writeSpace(test.directory, fixtureSpace))

        const server = yield* Config.use.getPluginConfig()
        const tui = (yield* getTuiConfig(test.directory)).pluginConfig

        expect(server).toEqual(fixtureTable)
        expect(tui).toEqual(fixtureTable)
        expect(tui).toEqual(server)
        // Independent merges: the two chains must not share the same object.
        expect(tui).not.toBe(server)
      }),
    ),
  )

  it.instance("reports an empty table outside a wopal space", () =>
    withEnv(
      "WOPAL_SPACE",
      "1",
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => writeGlobalSettings({ ellamaka: {}, wopal: { pluginConfig: { app: { a: 1 } } } }))

        const server = yield* Config.use.getPluginConfig()
        const tui = (yield* getTuiConfig(test.directory)).pluginConfig

        expect(server).toEqual({})
        expect(tui).toEqual({})
      }),
    ),
  )
})

describe("tryLoadWopalSpaceTuiConfig plugin config", () => {
  test("merges the global layer with the space layers into pluginConfig", async () => {
    await using tmp = await tmpdir()
    await writeSpace(tmp.path, {
      "settings.jsonc": { wopal: { pluginConfig: { app: { b: 2, nested: { y: 2 } } } } },
      "settings.local.jsonc": { wopal: { pluginConfig: { app: { nested: { z: 3 } } } } },
    })
    const globalText = JSON.stringify(fixtureGlobal)

    const result = await Effect.runPromise(
      tryLoadWopalSpaceTuiConfig(
        {
          readConfigFile: (file) =>
            Effect.promise(async () => {
              if (file === globalSettingsPath) return globalText
              return fs.readFile(file, "utf8").catch(() => undefined)
            }),
          loadConfig: () => Effect.succeed({} as Info),
          merge: () => Effect.succeed(undefined),
        },
        { directory: tmp.path },
      ),
    )

    expect(result?.pluginConfig).toEqual(fixtureTable)
    expect(result?.dirs).toEqual([path.join(tmp.path, ".wopal")])
  })

  test("degrades a corrupt global layer without affecting the space layers", async () => {
    await using tmp = await tmpdir()
    await writeSpace(tmp.path, {
      "settings.jsonc": { wopal: { pluginConfig: { app: { b: 2 } } } },
    })

    const result = await Effect.runPromise(
      tryLoadWopalSpaceTuiConfig(
        {
          readConfigFile: (file) =>
            Effect.promise(async () => {
              if (file === globalSettingsPath) return "{ not jsonc"
              return fs.readFile(file, "utf8").catch(() => undefined)
            }),
          loadConfig: () => Effect.succeed({} as Info),
          merge: () => Effect.succeed(undefined),
        },
        { directory: tmp.path },
      ),
    )

    expect(result?.pluginConfig).toEqual({ app: { b: 2 } })
  })
})
