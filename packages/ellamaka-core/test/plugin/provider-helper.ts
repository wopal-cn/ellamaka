import { Npm } from "@wopal/ellamaka-core/npm"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { expect } from "bun:test"
import path from "path"
import { Effect, Layer, Option } from "effect"
import { AccountV2 } from "@wopal/ellamaka-core/account"
import { Catalog } from "@wopal/ellamaka-core/catalog"
import { EventV2 } from "@wopal/ellamaka-core/event"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { Global } from "@wopal/ellamaka-core/global"
import { Location } from "@wopal/ellamaka-core/location"
import { ModelV2 } from "@wopal/ellamaka-core/model"
import { PluginV2 } from "@wopal/ellamaka-core/plugin"
import { Policy } from "@wopal/ellamaka-core/policy"
import { ProviderV2 } from "@wopal/ellamaka-core/provider"
import { AbsolutePath } from "@wopal/ellamaka-core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

export const fixtureProvider = new URL("./fixtures/provider-factory.ts", import.meta.url).href
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("test") })),
)

export const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: Option.none<string>() }),
    install: () => Effect.void,
    which: () => Effect.succeed(Option.none<string>()),
  }),
)

export const catalogLayer = Layer.succeed(
  Catalog.Service,
  Catalog.Service.of({
    transform: () => Effect.die("unexpected catalog.transform"),
    provider: {
      get: () => Effect.die("unexpected provider.get"),
      all: () => Effect.succeed([]),
      available: () => Effect.succeed([]),
    },
    model: {
      get: () => Effect.die("unexpected model.get"),
      all: () => Effect.succeed([]),
      available: () => Effect.succeed([]),
      default: () => Effect.succeed(Option.none<ModelV2.Info>()),
      small: () => Effect.succeed(Option.none<ModelV2.Info>()),
    },
  }),
)

export const it = testEffect(
  Catalog.layer.pipe(
    Layer.provideMerge(PluginV2.defaultLayer),
    Layer.provideMerge(EventV2.defaultLayer),
    Layer.provide(Policy.defaultLayer),
    Layer.provideMerge(locationLayer),
    Layer.provideMerge(npmLayer),
  ),
)

export const scopedAccountLayer = Layer.unwrap(
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    return AccountV2.layer.pipe(
      Layer.provide(AppFileSystem.defaultLayer),
      Layer.provideMerge(EventV2.defaultLayer),
      Layer.provide(
        Global.layerWith({
          wopalHome: tmp.path,
          data: path.join(tmp.path, "data"),
          cache: path.join(tmp.path, "cache"),
          config: path.join(tmp.path, "config"),
          state: path.join(tmp.path, "state"),
          tmp: path.join(tmp.path, "tmp"),
          bin: path.join(tmp.path, "bin"),
          log: path.join(tmp.path, "log"),
          repos: path.join(tmp.path, "repos"),
        }),
      ),
    )
  }),
)

export const itWithAccount = testEffect(
  Catalog.layer.pipe(
    Layer.provideMerge(PluginV2.defaultLayer),
    Layer.provideMerge(scopedAccountLayer),
    Layer.provideMerge(EventV2.defaultLayer),
    Layer.provide(Policy.defaultLayer),
    Layer.provideMerge(locationLayer),
    Layer.provideMerge(npmLayer),
  ),
)

export function provider(providerID: string, options?: Partial<ProviderV2.Info>) {
  return new ProviderV2.Info({
    // oxlint-disable-next-line typescript-eslint/no-misused-spread
    ...ProviderV2.Info.empty(ProviderV2.ID.make(providerID)),
    endpoint: {
      type: "aisdk",
      package: "test-provider",
    },
    ...options,
    options: {
      headers: {},
      body: {},
      aisdk: {
        provider: {},
        request: {},
      },
      ...options?.options,
    },
  })
}

export function model(providerID: string, modelID: string, options?: Partial<ModelV2.Info>) {
  return new ModelV2.Info({
    // oxlint-disable-next-line typescript-eslint/no-misused-spread
    ...ModelV2.Info.empty(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID)),
    apiID: ModelV2.ID.make(modelID),
    endpoint: {
      type: "aisdk",
      package: "test-provider",
    },
    ...options,
    options: {
      headers: {},
      body: {},
      aisdk: {
        provider: {},
        request: {},
      },
      ...options?.options,
    },
  })
}

export function withEnv<A, E, R>(vars: Record<string, string | undefined>, fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      for (const [key, value] of Object.entries(vars)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return previous
    }),
    () => fx(),
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )
}

export function fakeSelectorSdk(calls: string[]) {
  const make = (method: string) => (id: string) => {
    calls.push(`${method}:${id}`)
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    return { modelId: id, provider: method, specificationVersion: "v3" } as unknown as LanguageModelV3
  }
  return {
    responses: make("responses"),
    messages: make("messages"),
    chat: make("chat"),
    languageModel: make("languageModel"),
  }
}

export function expectPluginRegistered(ids: string[], id: string) {
  expect(ids).toContain(PluginV2.ID.make(id))
}
