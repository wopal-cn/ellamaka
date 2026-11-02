import path from "path"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Global } from "./global"
import { Flag } from "./flag/flag"
import { Flock } from "./util/flock"
import { Hash } from "./util/hash"
import { AppFileSystem } from "./filesystem"
import { InstallationChannel, InstallationVersion } from "./installation/version"
import { EventV2 } from "./event"

export const CatalogModelStatus = Schema.Literals(["alpha", "beta", "deprecated"])
export type CatalogModelStatus = typeof CatalogModelStatus.Type

const USER_AGENT = `opencode/${InstallationChannel}/${InstallationVersion}/${Flag.OPENCODE_CLIENT}`

const CostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const Cost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tiers: Schema.optional(Schema.Array(CostTier)),
  context_over_200k: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
    }),
  ),
})

export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  release_date: Schema.String,
  attachment: Schema.Boolean,
  reasoning: Schema.Boolean,
  temperature: Schema.Boolean,
  tool_call: Schema.Boolean,
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Literal(true),
      Schema.Struct({
        field: Schema.Literals(["reasoning_content", "reasoning_details"]),
      }),
    ]),
  ),
  cost: Schema.optional(Cost),
  limit: Schema.Struct({
    context: Schema.Finite,
    input: Schema.optional(Schema.Finite),
    output: Schema.Finite,
  }),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
      output: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      modes: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            cost: Schema.optional(Cost),
            provider: Schema.optional(
              Schema.Struct({
                body: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
                headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
  status: Schema.optional(CatalogModelStatus),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
})
export type Model = Schema.Schema.Type<typeof Model>

export const Provider = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.String,
  env: Schema.Array(Schema.String),
  id: Schema.String,
  npm: Schema.optional(Schema.String),
  models: Schema.Record(Schema.String, Model),
})

export type Provider = Schema.Schema.Type<typeof Provider>

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function isProviderCatalog(input: unknown): input is Record<string, Provider> {
  if (!isRecord(input)) return false
  const entries = Object.entries(input)
  if (entries.length === 0) return false

  for (const [id, provider] of entries) {
    if (
      !isRecord(provider) ||
      provider.id !== id ||
      typeof provider.name !== "string" ||
      !Array.isArray(provider.env) ||
      !provider.env.every((item) => typeof item === "string") ||
      !isRecord(provider.models) ||
      Object.keys(provider.models).length === 0 ||
      !Object.values(provider.models).every(isRecord)
    ) {
      return false
    }
  }

  return true
}

function catalogFromUnknown(input: unknown): Record<string, Provider> | undefined {
  if (!isProviderCatalog(input)) return undefined

  // The upstream catalog evolves faster than the runtime's complete Model
  // schema. Validate only the provider-record boundary so additive model
  // fields remain forward-compatible with newer catalog revisions.
  return input
}

export const Event = {
  Refreshed: EventV2.define({
    type: "models-dev.refreshed",
    schema: {},
  }),
}

declare const ELLAMAKA_MODELS_DEV: Record<string, Provider> | undefined

export interface Interface {
  readonly get: () => Effect.Effect<Record<string, Provider>>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelsDev") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const events = yield* EventV2.Service
    const http = HttpClient.filterStatusOk(
      (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({
          retryOn: "errors-and-responses",
          times: 2,
          schedule: Schedule.exponential(200).pipe(Schedule.jittered),
        }),
      ),
    )

    const source = Flag.ELLAMAKA_MODELS_URL || "https://models.opencode.ai"
    const filepath = () =>
      path.join(
        Global.Path.cache,
        source === "https://models.opencode.ai" ? "models.json" : `models-${Hash.fast(source)}.json`,
      )
    const ttl = Duration.minutes(5)
    const lockKey = () => `models-dev:${filepath()}`
    const explicitPath = Flag.ELLAMAKA_MODELS_PATH
    const fallbackPath = Flag.ELLAMAKA_MODELS_FALLBACK_PATH
    const fetchEnabled = !process.argv.includes("--get-yargs-completions")

    const fetchApi = Effect.fn("ModelsDev.fetchApi")(function* () {
      return yield* HttpClientRequest.get(`${source}/api.json`).pipe(
        HttpClientRequest.setHeader("User-Agent", USER_AGENT),
        http.execute,
        Effect.flatMap((res) => res.text),
        Effect.timeout("10 seconds"),
      )
    })

    const parseCatalog = (text: string) =>
      Effect.try({
        try: () => catalogFromUnknown(JSON.parse(text)),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined))

    const loadFromFile = Effect.fn("ModelsDev.loadFromFile")(function* (candidate: string, managed = false) {
      // AppFileSystem.readJson delegates to JSON.parse, which can defect rather
      // than fail. Catalog input failures must remain recoverable.
      const text = yield* fs.readFileString(candidate).pipe(Effect.orElseSucceed(() => undefined))
      const catalog = text === undefined ? undefined : yield* parseCatalog(text)
      if (catalog) return catalog

      // A caller-owned snapshot is strictly read-only. Only the cache under
      // Global.Path.cache is managed by this runtime and safe to self-heal.
      if (managed && text !== undefined) {
        yield* fs.remove(candidate, { force: true }).pipe(Effect.ignore)
      }
      return undefined
    })

    const loadFromDisk = () => loadFromFile(explicitPath ?? filepath(), explicitPath === undefined)
    const loadDefaultCache = () => loadFromFile(filepath(), true)
    const loadFallback = () => (fallbackPath === undefined ? Effect.succeed(undefined) : loadFromFile(fallbackPath))

    const loadSnapshot = Effect.sync(() =>
      typeof ELLAMAKA_MODELS_DEV === "undefined" ? undefined : catalogFromUnknown(ELLAMAKA_MODELS_DEV),
    )

    const runtimeCacheReady = () =>
      fs.stat(Global.Path.cache).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      )

    const fetchEphemeralCatalog = Effect.fn("ModelsDev.fetchEphemeralCatalog")(function* () {
      const text = yield* fetchApi()
      const catalog = yield* parseCatalog(text)
      if (!catalog) return yield* Effect.fail(new Error("Invalid provider catalog response"))
      return catalog
    })

    const fresh = Effect.fnUntraced(function* () {
      const stat = yield* fs.stat(filepath()).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat) return false
      const mtime = Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
      if (Date.now() - mtime >= Duration.toMillis(ttl)) return false
      return Boolean(yield* loadDefaultCache())
    })

    const fetchAndWrite = Effect.fn("ModelsDev.fetchAndWrite")(function* () {
      const text = yield* fetchApi()
      const catalog = yield* parseCatalog(text)
      if (!catalog) return yield* Effect.fail(new Error("Invalid provider catalog response"))

      const target = filepath()
      const tempfile = `${target}.${process.pid}.${Date.now()}.tmp`
      yield* fs.writeWithDirs(tempfile, text).pipe(
        Effect.andThen(fs.rename(tempfile, target)),
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* fs.remove(tempfile, { force: true }).pipe(Effect.ignore)
            return yield* Effect.fail(error)
          }),
        ),
      )
      yield* Effect.logDebug("Loaded provider catalog from network").pipe(
        Effect.annotateLogs("source", source),
        Effect.annotateLogs("providerCount", Object.keys(catalog).length),
      )
      return catalog
    })

    const fetchWithLock = () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey())
          return yield* fetchAndWrite()
        }),
      )

    const loadLiveFallback = Effect.fn("ModelsDev.loadLiveFallback")(function* () {
      const fromCache = yield* loadDefaultCache()
      if (fromCache) return fromCache
      const fallback = yield* loadFallback()
      if (fallback) return fallback
      return yield* loadSnapshot
    })

    const fetchLiveCatalog = Effect.fn("ModelsDev.fetchLiveCatalog")(function* () {
      return yield* fetchWithLock().pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const fallback = yield* loadLiveFallback()
            if (fallback) {
              yield* Effect.logWarning("Failed to fetch provider catalog; using local fallback").pipe(
                Effect.annotateLogs("source", source),
                Effect.annotateLogs("error", String(error)),
                Effect.annotateLogs("providerCount", Object.keys(fallback).length),
              )
              return fallback
            }
            return yield* Effect.fail(error)
          }),
        ),
      )
    })

    const populate = Effect.gen(function* () {
      // Onboarding mounts the provider routes before Core Runtime Preparation.
      // A premature provider request may read/fetch the catalog, but it must
      // not materialize the Runtime cache/state tree merely by observing it.
      if (!(yield* runtimeCacheReady())) {
        if (fallbackPath !== undefined && explicitPath === undefined) {
          if (!fetchEnabled) return (yield* loadFallback()) ?? (yield* loadSnapshot) ?? {}
          return yield* fetchEphemeralCatalog().pipe(
            Effect.catch(() =>
              Effect.gen(function* () {
                return (yield* loadFallback()) ?? (yield* loadSnapshot) ?? {}
              }),
            ),
          )
        }

        const fromExplicit = explicitPath === undefined ? undefined : yield* loadFromFile(explicitPath)
        if (fromExplicit) return fromExplicit
        const snapshot = yield* loadSnapshot
        if (snapshot) return snapshot
        if (!fetchEnabled) return {}
        return yield* fetchEphemeralCatalog()
      }

      // The development launcher supplies a fallback snapshot explicitly. In
      // that mode the network is authoritative: a successful request exposes
      // new providers immediately, while a failure still has local recovery.
      if (fallbackPath !== undefined && explicitPath === undefined) {
        if (!fetchEnabled) return (yield* loadLiveFallback()) ?? {}
        return yield* fetchLiveCatalog()
      }

      const fromDisk = yield* loadFromDisk()
      if (fromDisk) return fromDisk
      const snapshot = yield* loadSnapshot
      if (snapshot) return snapshot
      if (!fetchEnabled) return {}
      // Flock is cross-process: concurrent opencode CLIs can race on this cache file.
      return yield* fetchWithLock()
    }).pipe(Effect.withSpan("ModelsDev.populate"), Effect.orDie)

    const [cachedGet, invalidate] = yield* Effect.cachedInvalidateWithTTL(populate, Duration.hours(1))

    const get = (): Effect.Effect<Record<string, Provider>> => cachedGet

    const refresh = Effect.fn("ModelsDev.refresh")(function* (force = false) {
      if (!(yield* runtimeCacheReady())) {
        yield* invalidate
        return
      }
      if (!force && (yield* fresh())) return
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey())
          // Re-check under the lock: another process may have refreshed between
          // our outer check and lock acquisition.
          if (!force && (yield* fresh())) return
          yield* fetchAndWrite()
          yield* invalidate
          yield* events.publish(Event.Refreshed, {})
        }),
      ).pipe(
        Effect.tapCause((cause) =>
          Effect.logError("Failed to fetch provider catalog").pipe(
            Effect.annotateLogs("source", source),
            Effect.annotateLogs("cause", cause),
          ),
        ),
        Effect.ignore,
      )
    })

    return Service.of({ get, refresh })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
)

export * as ModelsDev from "./models-dev"
