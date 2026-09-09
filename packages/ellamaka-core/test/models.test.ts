import { describe, expect, beforeAll, beforeEach, afterAll } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { Global } from "@wopal/ellamaka-core/global"
import { ModelsDev } from "@wopal/ellamaka-core/models-dev"
import { EventV2 } from "@wopal/ellamaka-core/event"
import { Flock } from "@wopal/ellamaka-core/util/flock"
import { it } from "./lib/effect"
import { mkdtemp, readFile, rm, writeFile, utimes, mkdir } from "fs/promises"
import os from "os"
import path from "path"

// The service deliberately skips network access for shell completion. Keep the
// suite in that mode except in the individual tests that exercise network
// recovery, so the scheduled refresh cannot race their assertions.
const COMPLETION_ARG = "--get-yargs-completions"
const originalUrl = process.env.ELLAMAKA_MODELS_URL
const originalPath = process.env.ELLAMAKA_MODELS_PATH
const originalFallbackPath = process.env.ELLAMAKA_MODELS_FALLBACK_PATH
const bundled = globalThis as typeof globalThis & { ELLAMAKA_MODELS_DEV?: unknown }
const originalSnapshot = bundled.ELLAMAKA_MODELS_DEV
const hadCompletionArg = process.argv.includes(COMPLETION_ARG)
const originalCachePath = Global.Path.cache
const originalStatePath = Global.Path.state
const testRoot = await mkdtemp(path.join(os.tmpdir(), "ellamaka-models-test-"))
const testCachePath = path.join(testRoot, "cache")
const testStatePath = path.join(testRoot, "state")

function restoreEnv(
  key: "ELLAMAKA_MODELS_URL" | "ELLAMAKA_MODELS_PATH" | "ELLAMAKA_MODELS_FALLBACK_PATH",
  value: string | undefined,
) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeAll(() => {
  Global.Path.cache = testCachePath
  Flock.setGlobal({ state: testStatePath })
  delete process.env.ELLAMAKA_MODELS_URL
  delete process.env.ELLAMAKA_MODELS_PATH
  delete process.env.ELLAMAKA_MODELS_FALLBACK_PATH
  delete bundled.ELLAMAKA_MODELS_DEV
  if (!hadCompletionArg) process.argv.push(COMPLETION_ARG)
})
afterAll(() => {
  Global.Path.cache = originalCachePath
  Flock.setGlobal({ state: originalStatePath })
  restoreEnv("ELLAMAKA_MODELS_URL", originalUrl)
  restoreEnv("ELLAMAKA_MODELS_PATH", originalPath)
  restoreEnv("ELLAMAKA_MODELS_FALLBACK_PATH", originalFallbackPath)
  if (originalSnapshot === undefined) delete bundled.ELLAMAKA_MODELS_DEV
  else bundled.ELLAMAKA_MODELS_DEV = originalSnapshot
  if (!hadCompletionArg) {
    const index = process.argv.lastIndexOf(COMPLETION_ARG)
    if (index >= 0) process.argv.splice(index, 1)
  }
})

const cacheFile = path.join(testCachePath, "models.json")
const explicitCacheFile = path.join(testCachePath, "models-explicit-test.json")

const fixture: Record<string, ModelsDev.Provider> = {
  acme: {
    id: "acme",
    name: "Acme",
    env: ["ACME_API_KEY"],
    models: {
      "acme-1": {
        id: "acme-1",
        name: "Acme One",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
      },
    },
  },
}

const fixture2: Record<string, ModelsDev.Provider> = {
  beta: {
    id: "beta",
    name: "Beta",
    env: ["BETA_API_KEY"],
    models: {
      "beta-1": {
        id: "beta-1",
        name: "Beta One",
        release_date: "2026-02-01",
        attachment: false,
        reasoning: true,
        temperature: false,
        tool_call: false,
        limit: { context: 64000, output: 4096 },
      },
    },
  },
}

interface MockState {
  body: string
  status: number
  calls: Array<{ url: string; userAgent: string | null }>
}

const makeMockClient = (state: Ref.Ref<MockState>) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* Ref.update(state, (s) => ({
        ...s,
        calls: [...s.calls, { url: request.url, userAgent: request.headers["user-agent"] ?? null }],
      }))
      const s = yield* Ref.get(state)
      return HttpClientResponse.fromWeb(request, new Response(s.body, { status: s.status }))
    }),
  )

const buildLayer = (state: Ref.Ref<MockState>) =>
  // Layer.fresh is required: ModelsDev.layer is a module-level Layer constant,
  // and Effect.provide uses a process-global MemoMap by default — without fresh,
  // every test would reuse the cachedInvalidateWithTTL state from the first run.
  Layer.fresh(ModelsDev.layer).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, makeMockClient(state))),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(EventV2.defaultLayer),
  )

const writeCache = (data: object, mtimeMs?: number) =>
  Effect.promise(async () => {
    await mkdir(testCachePath, { recursive: true })
    await writeFile(cacheFile, JSON.stringify(data))
    if (mtimeMs !== undefined) {
      const t = mtimeMs / 1000
      await utimes(cacheFile, t, t)
    }
  })

const writeCacheText = (text: string, filepath = cacheFile) =>
  Effect.promise(async () => {
    await mkdir(path.dirname(filepath), { recursive: true })
    await writeFile(filepath, text)
  })

const readCacheText = (filepath = cacheFile) => Effect.promise(() => readFile(filepath, "utf8"))

const enableFetch = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.sync(() => {
    const index = process.argv.lastIndexOf(COMPLETION_ARG)
    if (index >= 0) process.argv.splice(index, 1)
    return index
  }).pipe(
    Effect.flatMap((index) =>
      effect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (index >= 0) process.argv.splice(index, 0, COMPLETION_ARG)
          }),
        ),
      ),
    ),
  )

const provided = <A, E>(state: Ref.Ref<MockState>, eff: Effect.Effect<A, E, ModelsDev.Service>) =>
  eff.pipe(Effect.provide(buildLayer(state)))

beforeEach(async () => {
  await rm(cacheFile, { force: true })
  await rm(explicitCacheFile, { force: true })
  delete process.env.ELLAMAKA_MODELS_URL
  delete process.env.ELLAMAKA_MODELS_PATH
  delete process.env.ELLAMAKA_MODELS_FALLBACK_PATH
  delete bundled.ELLAMAKA_MODELS_DEV
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

const initialState: MockState = {
  body: JSON.stringify(fixture),
  status: 200,
  calls: [],
}

describe("ModelsDev Service", () => {
  it.live("get() returns providers from disk when cache file exists", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result).toEqual(fixture)
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("get() returns empty catalog when disk empty, fetch disabled, and no bundled snapshot is injected", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result).toEqual({})
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("get() replaces a malformed default cache with a valid network catalog", () =>
    enableFetch(
      Effect.gen(function* () {
        yield* writeCacheText('{"acme":')
        const state = yield* Ref.make(initialState)
        const result = yield* provided(
          state,
          ModelsDev.Service.use((s) => s.get()),
        )
        expect(result).toEqual(fixture)
        expect(yield* readCacheText()).toBe(JSON.stringify(fixture))
        const final = yield* Ref.get(state)
        // Layer startup also schedules a refresh once fetch is enabled, so it
        // may race the first get(). Both calls must use the recovered catalog.
        expect(final.calls.length).toBeGreaterThanOrEqual(1)
      }),
    ),
  )

  it.live("get() replaces an empty default cache with a valid network catalog", () =>
    enableFetch(
      Effect.gen(function* () {
        yield* writeCache({})
        const state = yield* Ref.make(initialState)
        const result = yield* provided(
          state,
          ModelsDev.Service.use((s) => s.get()),
        )
        expect(result).toEqual(fixture)
        expect(yield* readCacheText()).toBe(JSON.stringify(fixture))
      }),
    ),
  )

  it.live("get() replaces a structurally invalid default cache with a valid network catalog", () =>
    enableFetch(
      Effect.gen(function* () {
        yield* writeCache({ acme: {} })
        const state = yield* Ref.make(initialState)
        const result = yield* provided(
          state,
          ModelsDev.Service.use((s) => s.get()),
        )
        expect(result).toEqual(fixture)
        expect(yield* readCacheText()).toBe(JSON.stringify(fixture))
      }),
    ),
  )

  it.live("get() preserves an invalid explicit snapshot while recovering from the network", () =>
    enableFetch(
      Effect.gen(function* () {
        process.env.ELLAMAKA_MODELS_PATH = explicitCacheFile
        const invalid = '{"acme":'
        yield* writeCacheText(invalid, explicitCacheFile)
        const state = yield* Ref.make(initialState)
        const result = yield* provided(
          state,
          ModelsDev.Service.use((s) => s.get()),
        )
        expect(result).toEqual(fixture)
        expect(yield* readCacheText(explicitCacheFile)).toBe(invalid)
        expect(yield* readCacheText(cacheFile)).toBe(JSON.stringify(fixture))
      }),
    ),
  )

  it.live("get() uses a valid ELLAMAKA_MODELS_DEV snapshot without fetching", () =>
    Effect.gen(function* () {
      bundled.ELLAMAKA_MODELS_DEV = fixture
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result).toEqual(fixture)
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("get() ignores an empty ELLAMAKA_MODELS_DEV snapshot and fetches a valid catalog", () =>
    enableFetch(
      Effect.gen(function* () {
        bundled.ELLAMAKA_MODELS_DEV = {}
        const state = yield* Ref.make(initialState)
        const result = yield* provided(
          state,
          ModelsDev.Service.use((s) => s.get()),
        )
        expect(result).toEqual(fixture)
        const final = yield* Ref.get(state)
        expect(final.calls.length).toBeGreaterThanOrEqual(1)
      }),
    ),
  )

  it.live("get() falls back to the developer snapshot when a live catalog request is invalid", () =>
    enableFetch(
      Effect.gen(function* () {
        process.env.ELLAMAKA_MODELS_URL = "https://catalog.example.test"
        process.env.ELLAMAKA_MODELS_FALLBACK_PATH = explicitCacheFile
        const fallback = JSON.stringify(fixture)
        yield* writeCacheText(fallback, explicitCacheFile)
        const state = yield* Ref.make({ ...initialState, body: "{}" })
        const result = yield* provided(
          state,
          ModelsDev.Service.use((s) => s.get()),
        )
        expect(result).toEqual(fixture)
        expect(yield* readCacheText(explicitCacheFile)).toBe(fallback)
        const final = yield* Ref.get(state)
        expect(final.calls.length).toBeGreaterThanOrEqual(1)
        expect(final.calls[0]?.url).toBe("https://catalog.example.test/api.json")
      }),
    ),
  )

  it.live("get() prefers a live catalog over stale cache and the developer snapshot", () =>
    enableFetch(
      Effect.gen(function* () {
        process.env.ELLAMAKA_MODELS_FALLBACK_PATH = explicitCacheFile
        const fallback = JSON.stringify(fixture)
        yield* writeCache(fixture)
        yield* writeCacheText(fallback, explicitCacheFile)
        const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
        const result = yield* provided(
          state,
          ModelsDev.Service.use((s) => s.get()),
        )
        expect(result).toEqual(fixture2)
        expect(yield* readCacheText()).toBe(JSON.stringify(fixture2))
        expect(yield* readCacheText(explicitCacheFile)).toBe(fallback)
        const final = yield* Ref.get(state)
        expect(final.calls.length).toBeGreaterThanOrEqual(1)
        expect(final.calls[0]?.url).toBe("https://models.opencode.ai/api.json")
      }),
    ),
  )

  it.live("refresh() never persists an invalid network catalog", () =>
    enableFetch(
      Effect.gen(function* () {
        yield* writeCache(fixture)
        const state = yield* Ref.make({ ...initialState, body: "{}" })
        yield* provided(
          state,
          ModelsDev.Service.use((s) => s.refresh(true)),
        )
        expect(yield* readCacheText()).toBe(JSON.stringify(fixture))
      }),
    ),
  )

  it.live("get() is single-flight under concurrent calls", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make(initialState)
      const results = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          return yield* Effect.all([svc.get(), svc.get(), svc.get(), svc.get(), svc.get()], {
            concurrency: "unbounded",
          })
        }),
      )
      for (const result of results) expect(result).toEqual(fixture)
    }),
  )

  it.live("get() caches across calls (later disk writes are ignored until invalidate)", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make(initialState)
      const first = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          const a = yield* svc.get()
          // mutate disk between calls — cache should mask the change
          yield* writeCache(fixture2)
          const b = yield* svc.get()
          return { a, b }
        }),
      )
      expect(first.a).toEqual(fixture)
      expect(first.b).toEqual(fixture)
    }),
  )

  it.live("refresh(true) fetches via HttpClient and updates the cache", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          const before = yield* svc.get()
          yield* svc.refresh(true)
          const after = yield* svc.get()
          return { before, after }
        }),
      )
      expect(result.before).toEqual(fixture)
      expect(result.after).toEqual(fixture2)
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBe(1)
      expect(final.calls[0].url).toContain("/api.json")
      expect(final.calls[0].userAgent).toContain("/cli")
    }),
  )

  it.live("refresh(false) skips fetch when on-disk file is fresh", () =>
    Effect.gen(function* () {
      // Fresh: mtime within the 5-minute TTL.
      yield* writeCache(fixture, Date.now() - 1000)
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      yield* provided(
        state,
        ModelsDev.Service.use((s) => s.refresh(false)),
      )
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("refresh(false) fetches when on-disk file is stale", () =>
    Effect.gen(function* () {
      // Stale: mtime 10 minutes ago, beyond the 5-minute TTL.
      yield* writeCache(fixture, Date.now() - 10 * 60 * 1000)
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      const after = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          yield* svc.refresh(false)
          return yield* svc.get()
        }),
      )
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBe(1)
      expect(after).toEqual(fixture2)
    }),
  )

  it.live("refresh swallows HTTP errors and leaves cache intact", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make({ ...initialState, status: 500, body: "boom" })
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          yield* svc.refresh(true)
          return yield* svc.get()
        }),
      )
      expect(result).toEqual(fixture)
      // retryTransient retries 5xx, so calls may be > 1.
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBeGreaterThanOrEqual(1)
    }),
  )
})
