import { describe, expect, afterEach, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Config } from "@/config/config"
import { ConfigPlugin } from "@/config/plugin"
import { EffectFlock } from "@wopal/ellamaka-core/util/effect-flock"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { Env } from "@/env"
import { HttpClient } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { InstanceRuntime } from "@/project/instance-runtime"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"

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

const clear = (wait = false) =>
  Effect.runPromise(
    Config.use
      .invalidate()
      .pipe(
        Effect.scoped,
        Effect.provide(layer),
        Effect.andThen(wait ? Effect.promise(() => InstanceRuntime.disposeAllInstances()) : Effect.void),
      ),
  )

beforeEach(async () => {
  await clear(true)
})

afterEach(async () => {
  await clear(true)
})

// A WopalSpace settings file declares plugin paths relative to itself. The loader
// must normalize them against the declaring file before merge; otherwise the spec
// keeps a bare relative path and is later resolved against the process CWD at
// module-load time.
//
// Layout mirrors a real space:
//   <root>/.wopal/.git                         worktree marker
//   <root>/.wopal/config/settings.jsonc        public settings
//   <root>/.wopal/config/settings.local.jsonc  private settings (merged later)
//   <root>/.wopal/plugins/<name>/index.ts      plugin sources
const PLUGIN_NAMES = ["dsh-adapter", "wopal-plugin"] as const

async function writeSpace(root: string, settings: Record<string, unknown>) {
  await fs.mkdir(path.join(root, ".wopal", "config"), { recursive: true })
  await fs.writeFile(path.join(root, ".wopal", ".git"), "")
  for (const name of PLUGIN_NAMES) {
    const dir = path.join(root, ".wopal", "plugins", name)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "index.ts"), "export default {}")
  }
  for (const [file, content] of Object.entries(settings)) {
    await fs.writeFile(path.join(root, ".wopal", "config", file), JSON.stringify(content))
  }
}

function pluginSpecs(config: { plugin?: ConfigPlugin.Spec[] }) {
  return (config.plugin ?? []).map((spec) => ConfigPlugin.pluginSpecifier(spec))
}

function pluginUrl(root: string, name: string) {
  return pathToFileURL(path.join(root, ".wopal", "plugins", name, "index.ts")).href
}

const publicSettings = {
  ellamaka: { plugin: ["../plugins/dsh-adapter/index.ts", "../plugins/wopal-plugin/index.ts"] },
}

describe("WopalSpace settings plugin path resolution", () => {
  it.instance("normalizes relative plugin paths declared in settings.jsonc", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeSpace(test.directory, { "settings.jsonc": publicSettings }))

      const config = yield* Config.use.get()
      const specs = pluginSpecs(config)
      for (const name of PLUGIN_NAMES) expect(specs).toContain(pluginUrl(test.directory, name))
    }),
  )

  it.instance("normalizes relative plugin paths declared in settings.local.jsonc", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeSpace(test.directory, { "settings.local.jsonc": publicSettings }))

      const config = yield* Config.use.get()
      const specs = pluginSpecs(config)
      for (const name of PLUGIN_NAMES) expect(specs).toContain(pluginUrl(test.directory, name))
    }),
  )

  it.instance("deduplicates the same plugin declared in both settings files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeSpace(test.directory, {
          "settings.jsonc": publicSettings,
          "settings.local.jsonc": { ellamaka: { plugin: ["../plugins/dsh-adapter/index.ts"] } },
        }),
      )

      const config = yield* Config.use.get()
      const specs = pluginSpecs(config)
      const adapter = pluginUrl(test.directory, "dsh-adapter")
      expect(specs.filter((spec) => spec === adapter).length).toBe(1)
    }),
  )
})
