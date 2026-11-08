import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { Flag } from "@wopal/ellamaka-core/flag/flag"
import { Bus } from "../../src/bus"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"
import { isRecord } from "@/util/record"
import { TestConfig } from "../fixture/config"
import { disposeAllInstances, provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const AUTH_SECRET = "server-headers-test-secret"
const AUTH_USERNAME = "ellamaka"
const original = {
  ELLAMAKA_SERVER_PASSWORD: Flag.ELLAMAKA_SERVER_PASSWORD,
  ELLAMAKA_SERVER_USERNAME: Flag.ELLAMAKA_SERVER_USERNAME,
}

beforeEach(() => {
  Flag.ELLAMAKA_SERVER_PASSWORD = AUTH_SECRET
  Flag.ELLAMAKA_SERVER_USERNAME = AUTH_USERNAME
})

afterEach(async () => {
  Flag.ELLAMAKA_SERVER_PASSWORD = original.ELLAMAKA_SERVER_PASSWORD
  Flag.ELLAMAKA_SERVER_USERNAME = original.ELLAMAKA_SERVER_USERNAME
  await disposeAllInstances()
})

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, AppFileSystem.defaultLayer))

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

function serverHeadersPluginFile(mark: string) {
  return [
    "export default {",
    `  id: "demo.server-headers",`,
    "  server: async (input) => {",
    `    await Bun.write(${JSON.stringify(mark)}, JSON.stringify({ serverHeaders: input.serverHeaders ?? null }))`,
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

function runPluginLoad(dir: string, spec: string) {
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
                plugin: [spec],
                plugin_origins: [{ spec, source, scope: "local" as const }],
              }),
            getPluginConfig: () => Effect.succeed({}),
            directories: () => Effect.succeed([dir]),
          }),
        ),
      ),
    ),
    provideInstance(dir),
  )
}

describe("PluginInput.serverHeaders delivery", () => {
  it.live("passes the sidecar Authorization header through to plugin input", () =>
    withTmp(
      async (dir) => {
        const file = path.join(dir, "plugin.ts")
        const mark = path.join(dir, "delivered.json")
        await Bun.write(file, serverHeadersPluginFile(mark))
        return { mark, spec: pathToFileURL(file).href }
      },
      (tmp) =>
        Effect.gen(function* () {
          yield* runPluginLoad(tmp.path, tmp.extra.spec)
          const seen = yield* readDelivered(tmp.extra.mark)
          const headers: unknown = seen.serverHeaders
          expect(headers).not.toBeNull()
          expect(isRecord(headers)).toBe(true)
          const record: Record<string, unknown> = isRecord(headers) ? headers : {}
          const expected = `Basic ${Buffer.from(`ellamaka:${AUTH_SECRET}`).toString("base64")}`
          expect(record["Authorization"]).toBe(expected)
        }),
    ),
  )
})
