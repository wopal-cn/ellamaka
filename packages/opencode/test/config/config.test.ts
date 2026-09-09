import { test, expect, describe, afterEach, beforeEach, spyOn } from "bun:test"
import { Effect, Exit, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Config } from "@/config/config"
import { ConfigManaged } from "@/config/managed"
import { ConfigParse } from "../../src/config/parse"
import { EffectFlock } from "@wopal/ellamaka-core/util/effect-flock"

import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { AccessToken, AccountID, OrgID } from "../../src/account/schema"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { Env } from "../../src/env"
import {
  provideTmpdirInstance,
  TestInstance,
  tmpdir,
  tmpdirScoped,
  provideInstanceEffect,
  testInstanceStoreLayer,
} from "../fixture/fixture"
import { InstanceRuntime } from "@/project/instance-runtime"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { pathToFileURL } from "url"
import { Global } from "@wopal/ellamaka-core/global"
import { Filesystem } from "@/util/filesystem"
import { isRecord } from "@/util/record"
import { ConfigPlugin } from "@/config/plugin"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"

/** Infra layer that provides FileSystem, Path, ChildProcessSpawner for test fixtures */
const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const testFlock = EffectFlock.defaultLayer

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)

const json = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const wellKnownAuth = (url: string) =>
  Layer.mock(Auth.Service)({
    all: () =>
      Effect.succeed({
        [url]: new Auth.WellKnown({ type: "wellknown", key: "TEST_TOKEN", token: "test-token" }),
      }),
  })

function remoteConfigClient(input: {
  wellKnown: unknown
  remote?: unknown
  seen: { wellKnown?: string; remote?: string; authorization?: string }
}) {
  return HttpClient.make((request) => {
    if (request.url.includes(".well-known/opencode")) {
      input.seen.wellKnown = request.url
      return Effect.succeed(json(request, input.wellKnown))
    }
    if (input.remote !== undefined && request.url.includes("config.example.com")) {
      input.seen.remote = request.url
      input.seen.authorization = request.headers.authorization
      return Effect.succeed(json(request, input.remote))
    }
    return Effect.succeed(json(request, {}, 404))
  })
}

const configLayer = (
  options: {
    auth?: Layer.Layer<Auth.Service>
    account?: Layer.Layer<Account.Service>
    client?: HttpClient.HttpClient
  } = {},
) =>
  Config.layer.pipe(
    Layer.provide(testFlock),
    Layer.provide(Env.defaultLayer),
    Layer.provide(options.auth ?? AuthTest.empty),
    Layer.provide(options.account ?? AccountTest.empty),
    Layer.provideMerge(infra),
    Layer.provide(NpmTest.noop),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, options.client ?? unexpectedHttp)),
    Layer.provideMerge(AppFileSystem.defaultLayer),
  )

const layer = configLayer()

const it = testEffect(layer)
const configIt = (options?: Parameters<typeof configLayer>[0]) => testEffect(configLayer(options))

const schemaConfig = (config: object) => ({ $schema: "https://opencode.ai/config.json", ...config })

const clearEffect = (wait = false) =>
  Config.use
    .invalidate()
    .pipe(
      Effect.scoped,
      Effect.provide(layer),
      Effect.andThen(wait ? Effect.promise(() => InstanceRuntime.disposeAllInstances()) : Effect.void),
    )
const clear = (wait = false) => Effect.runPromise(clearEffect(wait))
// Get managed config directory from environment (set in preload.ts)
const managedConfigDir = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR!
const originalTestToken = process.env.TEST_TOKEN
const originalConsoleToken = process.env.OPENCODE_CONSOLE_TOKEN

beforeEach(async () => {
  await clear(true)
})

afterEach(async () => {
  await fs.rm(managedConfigDir, { force: true, recursive: true }).catch(() => {})
  if (originalTestToken === undefined) delete process.env.TEST_TOKEN
  else process.env.TEST_TOKEN = originalTestToken
  if (originalConsoleToken === undefined) delete process.env.OPENCODE_CONSOLE_TOKEN
  else process.env.OPENCODE_CONSOLE_TOKEN = originalConsoleToken
  await clear(true)
})

const writeManagedSettingsEffect = (settings: object, filename?: string) =>
  AppFileSystem.use.writeWithDirs(path.join(managedConfigDir, filename ?? "opencode.json"), JSON.stringify(settings))

const writeConfigEffect = (dir: string, config: object, name = "opencode.json") =>
  AppFileSystem.use.writeWithDirs(path.join(dir, name), JSON.stringify(config))

const withGlobalConfigDir = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const previous = Global.Path.config
      ;(Global.Path as { config: string }).config = dir
      yield* clearEffect(true)
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.gen(function* () {
        ;(Global.Path as { config: string }).config = previous
        yield* clearEffect(true)
      }),
  )

const withGlobalConfig = <A, E, R>(
  input: { config?: object; name?: string },
  fn: (input: { dir: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    if (input.config) yield* writeConfigEffect(dir, schemaConfig(input.config), input.name)
    return yield* withGlobalConfigDir(dir, fn({ dir }))
  })

const wellKnown = (input: {
  authUrl?: string
  config?: unknown
  remoteConfig?: { url: string; headers?: Record<string, string> }
  remote?: unknown
  wellKnown?: unknown
}) => {
  const seen: { wellKnown?: string; remote?: string; authorization?: string } = {}
  const client = remoteConfigClient({
    seen,
    wellKnown: input.wellKnown ?? {
      ...(input.config !== undefined ? { config: input.config } : {}),
      ...(input.remoteConfig !== undefined ? { remote_config: input.remoteConfig } : {}),
    },
    remote: input.remote,
  })
  return {
    seen,
    it: configIt({ auth: wellKnownAuth(input.authUrl ?? "https://example.com"), client }),
  }
}

function withProcessEnv<A, E, R>(key: string, value: string | undefined, effect: Effect.Effect<A, E, R>) {
  return withProcessEnvs({ [key]: value }, effect)
}

function withProcessEnvs<A, E, R>(entries: Record<string, string | undefined>, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const originals: Record<string, string | undefined> = {}
      for (const [key, value] of Object.entries(entries)) {
        originals[key] = process.env[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return originals
    }),
    () => effect,
    (originals) =>
      Effect.sync(() => {
        for (const [key, original] of Object.entries(originals)) {
          if (original !== undefined) process.env[key] = original
          else delete process.env[key]
        }
      }),
  )
}

it.instance("loads config with defaults when no files exist", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.username).toBeDefined()
  }),
)

it.instance("falls back to generic username when system user info is unavailable", () =>
  Effect.gen(function* () {
    const userInfo = spyOn(os, "userInfo").mockImplementation(() => {
      throw Object.assign(new Error("missing passwd entry"), { code: "ENOENT" })
    })
    try {
      const config = yield* Config.use.get()
      expect(config.username).toBe("user")
    } finally {
      userInfo.mockRestore()
    }
  }),
)

it.effect("does not create global config when OPENCODE_CONFIG_DIR is set", () =>
  Effect.gen(function* () {
    const custom = yield* tmpdirScoped()
    yield* withGlobalConfig({}, ({ dir }) =>
      withProcessEnv(
        "OPENCODE_CONFIG_DIR",
        custom,
        Effect.gen(function* () {
          yield* Config.use.get().pipe(provideInstanceEffect(dir))

          expect(yield* AppFileSystem.use.existsSafe(path.join(dir, "opencode.jsonc"))).toBe(false)
        }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
      ),
    )
  }),
)

it.instance(
  "loads JSON config file",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.model).toBe("test/model")
    expect(config.username).toBe("testuser")
  }),
  { config: { model: "test/model", username: "testuser" } },
)

it.instance(
  "loads shell config field",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.shell).toBe("bash")
  }),
  { config: { shell: "bash" } },
)

it.instance("updates config and preserves empty shell sentinel", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(
      test.directory,
      { $schema: "https://opencode.ai/config.json", shell: "bash" },
      "config.json",
    )

    yield* Config.Service.use((svc) => svc.update(ConfigParse.schema(Config.Info, { shell: "" }, "test:config")))

    const writtenConfig = yield* AppFileSystem.use.readJson(path.join(test.directory, "config.json"))
    expect(writtenConfig).toMatchObject({ shell: "" })
  }),
)

it.effect("updates global config and omits empty shell key in json", () =>
  withGlobalConfig({ config: { shell: "bash" }, name: "settings.jsonc" }, ({ dir }) =>
    Effect.gen(function* () {
      yield* Config.use.updateGlobal({ shell: "" })

      const writtenConfig = yield* AppFileSystem.use.readJson(path.join(dir, "settings.jsonc"))
      expect(writtenConfig).not.toHaveProperty("shell")
    }),
  ),
)

it.effect("updates global config and omits empty shell key in jsonc", () =>
  withGlobalConfig({ config: { shell: "bash", model: "test/model" }, name: "settings.jsonc" }, ({ dir }) =>
    Effect.gen(function* () {
      yield* Config.use.updateGlobal({ shell: "" })

      const file = path.join(dir, "settings.jsonc")
      const writtenConfig = yield* AppFileSystem.use.readFileString(file)
      const parsed = ConfigParse.schema(Config.Info, ConfigParse.jsonc(writtenConfig, file), file)
      expect(writtenConfig).not.toContain('"shell"')
      expect(parsed.shell).toBeUndefined()
      expect(parsed.model).toBe("test/model")
    }),
  ),
)

it.effect("updates global config inside ellamaka wrapper and preserves top-level keys", () =>
  withGlobalConfig({}, ({ dir }) =>
    Effect.gen(function* () {
      yield* writeConfigEffect(
        dir,
        { ellamaka: { shell: "bash", model: "test/model" }, spaces: { active: "x" } },
        "settings.jsonc",
      )

      yield* Config.use.updateGlobal({ model: "new/model" })

      const file = path.join(dir, "settings.jsonc")
      const writtenConfig = yield* AppFileSystem.use.readFileString(file)
      const parsed = ConfigParse.jsonc(writtenConfig, file)
      expect(isRecord(parsed)).toBe(true)
      if (!isRecord(parsed)) return
      const ellamaka = parsed.ellamaka
      expect(isRecord(ellamaka)).toBe(true)
      if (!isRecord(ellamaka)) return
      expect(ellamaka.model).toBe("new/model")
      expect(ellamaka.shell).toBe("bash")
      expect(parsed.spaces).toEqual({ active: "x" })
      expect(parsed).not.toHaveProperty("model")
    }),
  ),
)

it.effect("returns global config info consistent with getGlobal reload after ellamaka wrapper update", () =>
  withGlobalConfig({}, ({ dir }) =>
    Effect.gen(function* () {
      yield* writeConfigEffect(
        dir,
        { ellamaka: { shell: "bash", model: "test/model" }, spaces: { active: "x" } },
        "settings.jsonc",
      )

      const result = yield* Config.use.updateGlobal({ model: "new/model" })

      expect(result.info.model).toBe("new/model")
      expect(result.info.shell).toBe("bash")
      expect(result.info).toEqual(yield* Config.use.getGlobal())
    }),
  ),
)

it.instance(
  "loads formatter boolean config",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.formatter).toBe(true)
  }),
  { config: { formatter: true } },
)

it.instance(
  "loads lsp boolean config",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.lsp).toBe(true)
  }),
   { config: { lsp: true } },
)

const accountTokenIt = configIt({
  account: Layer.mock(Account.Service)({
    active: () =>
      Effect.succeed(
        Option.some({
          id: AccountID.make("account-1"),
          email: "user@example.com",
          url: "https://control.example.com",
          active_org_id: OrgID.make("org-1"),
        }),
      ),
    activeOrg: () =>
      Effect.succeed(
        Option.some({
          account: {
            id: AccountID.make("account-1"),
            email: "user@example.com",
            url: "https://control.example.com",
            active_org_id: OrgID.make("org-1"),
          },
          org: {
            id: OrgID.make("org-1"),
            name: "Example Org",
          },
        }),
      ),
    config: () =>
      Effect.succeed(
        Option.some({
          provider: { opencode: { options: { apiKey: "{env:OPENCODE_CONSOLE_TOKEN}" } } },
        }),
      ),
    token: () => Effect.succeed(Option.some(AccessToken.make("st_test_token"))),
  }),
})

accountTokenIt.instance("resolves env templates in account config with account token", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.provider?.["opencode"]?.options?.apiKey).toBe("st_test_token")
  }),
)

it.instance("loads config from .opencode directory", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* AppFileSystem.use.writeWithDirs(
      path.join(test.directory, ".opencode", "agent", "test.md"),
      `---
model: test/model
---
Test agent prompt`,
    )

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]).toEqual(
      expect.objectContaining({
        name: "test",
        model: "test/model",
        prompt: "Test agent prompt",
      }),
    )
  }),
)

it.instance("agent markdown permission config preserves user key order", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* AppFileSystem.use.writeWithDirs(
      path.join(test.directory, ".opencode", "agent", "ordered.md"),
      `---
permission:
  bash: allow
  "*": deny
  edit: ask
---
Ordered permissions`,
    )

    const config = yield* Config.use.get()
    expect(Object.keys(config.agent?.ordered?.permission ?? {})).toEqual(["bash", "*", "edit"])
  }),
)

it.instance("loads agents from .opencode/agents (plural)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* AppFileSystem.use.writeWithDirs(
      path.join(test.directory, ".opencode", "agents", "helper.md"),
      `---
model: test/model
mode: subagent
---
Helper agent prompt`,
    )

    yield* AppFileSystem.use.writeWithDirs(
      path.join(test.directory, ".opencode", "agents", "nested", "child.md"),
      `---
model: test/model
mode: subagent
---
Nested agent prompt`,
    )

    const config = yield* Config.use.get()

    expect(config.agent?.["helper"]).toMatchObject({
      name: "helper",
      model: "test/model",
      mode: "subagent",
      prompt: "Helper agent prompt",
    })

    expect(config.agent?.["nested/child"]).toMatchObject({
      name: "nested/child",
      model: "test/model",
      mode: "subagent",
      prompt: "Nested agent prompt",
    })
  }),
)

it.instance("loads commands from .opencode/command (singular)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* AppFileSystem.use.writeWithDirs(
      path.join(test.directory, ".opencode", "command", "hello.md"),
      `---
description: Test command
---
Hello from singular command`,
    )

    yield* AppFileSystem.use.writeWithDirs(
      path.join(test.directory, ".opencode", "command", "nested", "child.md"),
      `---
description: Nested command
---
Nested command template`,
    )

    const config = yield* Config.use.get()

    expect(config.command?.["hello"]).toEqual({
      description: "Test command",
      template: "Hello from singular command",
    })

    expect(config.command?.["nested/child"]).toEqual({
      description: "Nested command",
      template: "Nested command template",
    })
  }),
)

it.instance("loads commands from .opencode/commands (plural)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* AppFileSystem.use.writeWithDirs(
      path.join(test.directory, ".opencode", "commands", "hello.md"),
      `---
description: Test command
---
Hello from plural commands`,
    )

    yield* AppFileSystem.use.writeWithDirs(
      path.join(test.directory, ".opencode", "commands", "nested", "child.md"),
      `---
description: Nested command
---
Nested command template`,
    )

    const config = yield* Config.use.get()

    expect(config.command?.["hello"]).toEqual({
      description: "Test command",
      template: "Hello from plural commands",
    })

    expect(config.command?.["nested/child"]).toEqual({
      description: "Nested command",
      template: "Nested command template",
    })
  }),
)

it.instance("updates config and writes to file", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* Config.Service.use((svc) =>
      svc.update(ConfigParse.schema(Config.Info, { model: "updated/model" }, "test:config")),
    )

    const writtenConfig = yield* AppFileSystem.use.readJson(path.join(test.directory, "config.json"))
    expect(writtenConfig).toMatchObject({ model: "updated/model" })
  }),
)

it.instance("gets config directories", () =>
  Effect.gen(function* () {
    const dirs = yield* Config.use.directories()
    expect(dirs.length).toBeGreaterThanOrEqual(1)
  }),
)

it.effect("does not try to install dependencies in read-only OPENCODE_CONFIG_DIR", () =>
  Effect.gen(function* () {
    if (process.platform === "win32") return

    const dir = yield* tmpdirScoped()
    const readonly = path.join(dir, "readonly")
    yield* AppFileSystem.use.ensureDir(readonly)
    yield* AppFileSystem.use.chmod(readonly, 0o555)
    yield* Effect.addFinalizer(() => AppFileSystem.use.chmod(readonly, 0o755).pipe(Effect.ignore))

    yield* withProcessEnv("OPENCODE_CONFIG_DIR", readonly, Config.use.get().pipe(provideInstanceEffect(dir)))
  }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
)

it.effect("installs dependencies in writable OPENCODE_CONFIG_DIR", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const configDir = path.join(dir, "configdir")
    yield* AppFileSystem.use.ensureDir(configDir)

    yield* withProcessEnv(
      "OPENCODE_CONFIG_DIR",
      configDir,
      Config.Service.use((svc) => svc.get().pipe(Effect.andThen(svc.waitForDependencies()))).pipe(
        provideInstanceEffect(dir),
      ),
    )

    expect(yield* AppFileSystem.use.readFileString(path.join(configDir, ".gitignore"))).toContain("package-lock.json")
  }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
)

// Note: deduplication and serialization of npm installs is now handled by the
// core Npm.Service (via EffectFlock). Those behaviors are tested in the core
// package's npm tests, not here.

it.instance("does not error when only custom agent is a subagent", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* AppFileSystem.use.writeWithDirs(
      path.join(test.directory, ".opencode", "agent", "helper.md"),
      `---
model: test/model
mode: subagent
---
Helper subagent prompt`,
    )

    const config = yield* Config.use.get()
    expect(config.agent?.["helper"]).toMatchObject({
      name: "helper",
      model: "test/model",
      mode: "subagent",
      prompt: "Helper subagent prompt",
    })
  }),
)

// Legacy tools migration tests

// Managed settings tests
// Note: preload.ts sets OPENCODE_TEST_MANAGED_CONFIG which Global.Path.managedConfig uses

it.instance(
  "managed settings override user settings",
  Effect.gen(function* () {
    yield* writeManagedSettingsEffect({
      $schema: "https://opencode.ai/config.json",
      model: "managed/model",
      share: "disabled",
    })

    const config = yield* Config.use.get()
    expect(config.model).toBe("managed/model")
    expect(config.share).toBe("disabled")
    expect(config.username).toBe("testuser")
  }),
  { config: { model: "user/model", share: "auto", username: "testuser" } },
)

it.instance(
  "managed settings override project settings",
  Effect.gen(function* () {
    yield* writeManagedSettingsEffect({
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      disabled_providers: ["openai"],
    })

    const config = yield* Config.use.get()
    expect(config.autoupdate).toBe(false)
    expect(config.disabled_providers).toEqual(["openai"])
  }),
  { config: { autoupdate: true, disabled_providers: [] } },
)

it.instance("managed jsonc settings override managed json settings", () =>
  Effect.gen(function* () {
    yield* writeManagedSettingsEffect({ model: "managed/json" })
    yield* writeManagedSettingsEffect({ model: "managed/jsonc" }, "opencode.jsonc")

    const config = yield* Config.use.get()
    expect(config.model).toBe("managed/jsonc")
  }),
)

it.instance(
  "missing managed settings file is not an error",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.model).toBe("user/model")
  }),
  { config: { model: "user/model" } },
)

test("config parser preserves permission order while rejecting unknown top-level keys", () => {
  const config = ConfigParse.schema(
    Config.Info,
    {
      permission: {
        bash: "allow",
        "*": "deny",
        edit: "ask",
      },
    },
    "test",
  )

  expect(Object.keys(config.permission!)).toEqual(["bash", "*", "edit"])
  try {
    ConfigParse.schema(Config.Info, { invalid_field: true }, "test")
    throw new Error("expected config parse to fail")
  } catch (err) {
    const error = err as { data?: { issues?: Array<{ code?: string; keys?: string[]; path?: string[] }> } }
    expect(error.data?.issues?.[0]).toMatchObject({ code: "unrecognized_keys", keys: ["invalid_field"], path: [] })
  }
})

// MCP config merging tests

const remoteProjectOverride = wellKnown({
  config: {
    mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: false } },
  },
})

remoteProjectOverride.it.instance(
  "project config overrides remote well-known config",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(remoteProjectOverride.seen.wellKnown).toBe("https://example.com/.well-known/opencode")
      expect(config.mcp?.jira?.enabled).toBe(true)
    }),
  {
    git: true,
    config: { mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: true } } },
  },
)

const trailingSlashWellKnown = wellKnown({
  authUrl: "https://example.com/",
  config: {
    mcp: { slack: { type: "remote", url: "https://slack.example.com/mcp", enabled: true } },
  },
})

trailingSlashWellKnown.it.instance("wellknown URL with trailing slash is normalized", () =>
  Effect.gen(function* () {
    yield* Config.use.get()
    expect(trailingSlashWellKnown.seen.wellKnown).toBe("https://example.com/.well-known/opencode")
  }),
)

test("remote well-known config can use FetchHttpClient layer", async () => {
  let fetchedUrl: string | undefined
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      fetchedUrl = request.url
      return new Response(
        JSON.stringify({
          config: {
            mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: true } },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    },
  })

  try {
    await provideTmpdirInstance(
      () =>
        Config.Service.use((svc) =>
          Effect.gen(function* () {
            const config = yield* svc.get()
            expect(fetchedUrl).toBe(`${server.url.origin}/.well-known/opencode`)
            expect(config.mcp?.jira?.enabled).toBe(true)
          }),
        ),
      { git: true },
    ).pipe(
      Effect.scoped,
      Effect.provide(
        Config.layer.pipe(
          Layer.provide(testFlock),
          Layer.provide(AppFileSystem.defaultLayer),
          Layer.provide(Env.defaultLayer),
          Layer.provide(wellKnownAuth(server.url.origin)),
          Layer.provide(AccountTest.empty),
          Layer.provideMerge(infra),
          Layer.provide(NpmTest.noop),
          Layer.provide(FetchHttpClient.layer),
        ),
      ),
      Effect.runPromise,
    )
  } finally {
    await server.stop(true)
  }
})

const templatedHeaderWellKnown = wellKnown({
  remoteConfig: {
    url: "https://config.example.com/opencode.json",
    headers: { Authorization: "Bearer {env:TEST_TOKEN}" },
  },
  remote: {
    mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: true } },
  },
})

templatedHeaderWellKnown.it.instance("wellknown remote_config supports templated env vars in headers", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(templatedHeaderWellKnown.seen.wellKnown).toBe("https://example.com/.well-known/opencode")
    expect(templatedHeaderWellKnown.seen.remote).toBe("https://config.example.com/opencode.json")
    expect(templatedHeaderWellKnown.seen.authorization).toBe("Bearer test-token")
    expect(config.mcp?.confluence?.enabled).toBe(true)
  }),
)

const remotePrecedenceWellKnown = wellKnown({
  config: {
    mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: false } },
  },
  remoteConfig: { url: "https://config.example.com/{env:TEST_TOKEN}/opencode.json" },
  remote: {
    config: { mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: true } } },
  },
})

remotePrecedenceWellKnown.it.instance(
  "wellknown remote_config url tokens and nested config override embedded config",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(remotePrecedenceWellKnown.seen.remote).toBe("https://config.example.com/test-token/opencode.json")
      expect(config.mcp?.confluence?.enabled).toBe(true)
    }),
)

const nullConfigWellKnown = wellKnown({
  wellKnown: {
    config: null,
    remote_config: { url: "https://config.example.com/opencode.json" },
  },
  remote: {
    mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: true } },
  },
})

nullConfigWellKnown.it.instance("wellknown config null is treated as absent", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(nullConfigWellKnown.seen.remote).toBe("https://config.example.com/opencode.json")
    expect(config.mcp?.confluence?.enabled).toBe(true)
  }),
)

const invalidRemoteWellKnown = wellKnown({
  remoteConfig: { url: "https://config.example.com/opencode.json" },
  remote: "not an object",
})

invalidRemoteWellKnown.it.instance("wellknown remote_config rejects non-object config responses", () =>
  Effect.gen(function* () {
    const exit = yield* Config.use.get().pipe(Effect.exit)
    expect(invalidRemoteWellKnown.seen.remote).toBe("https://config.example.com/opencode.json")
    expect(Exit.isFailure(exit)).toBe(true)
  }),
)

describe("resolvePluginSpec", () => {
  test("keeps package specs unchanged", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "opencode.json")
    expect(await ConfigPlugin.resolvePluginSpec("oh-my-opencode@2.4.3", file)).toBe("oh-my-opencode@2.4.3")
    expect(await ConfigPlugin.resolvePluginSpec("@scope/pkg", file)).toBe("@scope/pkg")
  })

  test("resolves windows-style relative plugin directory specs", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "opencode.json")
    const hit = await ConfigPlugin.resolvePluginSpec(".\\plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin", "index.ts")).href)
  })

  test("resolves relative file plugin paths to file urls", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "plugin.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "opencode.json")
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin.ts", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin.ts")).href)
  })

  test("resolves plugin directory paths to directory urls", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.writeJson(path.join(plugin, "package.json"), {
          name: "demo-plugin",
          type: "module",
          main: "./index.ts",
        })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "opencode.json")
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin")).href)
  })

  test("resolves plugin directories without package.json to index.ts", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "opencode.json")
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin", "index.ts")).href)
  })
})

describe("deduplicatePluginOrigins", () => {
  const dedupe = (plugins: ConfigPlugin.Spec[]) =>
    ConfigPlugin.deduplicatePluginOrigins(
      plugins.map((spec) => ({
        spec,
        source: "",
        scope: "global" as const,
      })),
    ).map((item) => item.spec)

  test("removes duplicates keeping higher priority (later entries)", () => {
    const plugins = ["global-plugin@1.0.0", "shared-plugin@1.0.0", "local-plugin@2.0.0", "shared-plugin@2.0.0"]

    const result = dedupe(plugins)

    expect(result).toContain("global-plugin@1.0.0")
    expect(result).toContain("local-plugin@2.0.0")
    expect(result).toContain("shared-plugin@2.0.0")
    expect(result).not.toContain("shared-plugin@1.0.0")
    expect(result.length).toBe(3)
  })

  test("keeps path plugins separate from package plugins", () => {
    const plugins = ["oh-my-opencode@2.4.3", "file:///project/.opencode/plugin/oh-my-opencode.js"]

    const result = dedupe(plugins)

    expect(result).toEqual(plugins)
  })

  test("deduplicates direct path plugins by exact spec", () => {
    const plugins = ["file:///project/.opencode/plugin/demo.ts", "file:///project/.opencode/plugin/demo.ts"]

    const result = dedupe(plugins)

    expect(result).toEqual(["file:///project/.opencode/plugin/demo.ts"])
  })

  test("preserves order of remaining plugins", () => {
    const plugins = ["a-plugin@1.0.0", "b-plugin@1.0.0", "c-plugin@1.0.0"]

    const result = dedupe(plugins)

    expect(result).toEqual(["a-plugin@1.0.0", "b-plugin@1.0.0", "c-plugin@1.0.0"])
  })

  test("dedupes same-name file plugins across directories by module id, keeping the winner's origin", () => {
    const globalSpec = "file:///Users/me/.wopal/plugins/wopal-plugin.ts"
    const spaceSpec = "file:///work/space/.wopal/plugins/wopal-plugin.ts"

    const result = ConfigPlugin.deduplicatePluginOrigins([
      { spec: globalSpec, source: "/Users/me/.wopal/config/settings.jsonc", scope: "global" as const, id: "wopal-plugin" },
      { spec: spaceSpec, source: "/work/space/.wopal/config/settings.jsonc", scope: "local" as const, id: "wopal-plugin" },
    ])

    expect(result).toHaveLength(1)
    expect(result[0].spec).toBe(spaceSpec)
    expect(result[0].source).toBe("/work/space/.wopal/config/settings.jsonc")
    expect(result[0].scope).toBe("local")
  })

  test("dedupes same-name file plugins by file name when module id is unknown, keeping the higher-precedence one", () => {
    const globalSpec = "file:///Users/me/.wopal/plugins/wopal-plugin.ts"
    const spaceSpec = "file:///work/space/.wopal/plugins/wopal-plugin.ts"

    const result = ConfigPlugin.deduplicatePluginOrigins([
      { spec: globalSpec, source: "/Users/me/.wopal/config/settings.jsonc", scope: "global" as const },
      { spec: spaceSpec, source: "/work/space/.wopal/config/settings.jsonc", scope: "local" as const },
    ])

    expect(result).toHaveLength(1)
    expect(result[0].spec).toBe(spaceSpec)
    expect(result[0].source).toBe("/work/space/.wopal/config/settings.jsonc")
  })

  test("keeps different-name file plugins separate", () => {
    const a = "file:///Users/me/.wopal/plugins/one.ts"
    const b = "file:///work/space/.wopal/plugins/two.ts"

    const result = ConfigPlugin.deduplicatePluginOrigins([
      { spec: a, source: "", scope: "global" as const },
      { spec: b, source: "", scope: "local" as const },
    ])

    expect(result).toHaveLength(2)
    expect(result.map((item) => ConfigPlugin.pluginSpecifier(item.spec))).toEqual([a, b])
  })

  test("only global plugin with no space counterpart stays unchanged", () => {
    const spec = "file:///Users/me/.wopal/plugins/wopal-plugin.ts"

    const result = ConfigPlugin.deduplicatePluginOrigins([
      { spec, source: "/Users/me/.wopal/config/settings.jsonc", scope: "global" as const },
    ])

    expect(result).toHaveLength(1)
    expect(ConfigPlugin.pluginSpecifier(result[0].spec)).toBe(spec)
  })

  test("different ids on same-name file plugins are treated as distinct", () => {
    const a = "file:///Users/me/.wopal/plugins/wopal-plugin.ts"
    const b = "file:///work/space/.wopal/plugins/wopal-plugin.ts"

    const result = ConfigPlugin.deduplicatePluginOrigins([
      { spec: a, source: "", scope: "global" as const, id: "user-wopal" },
      { spec: b, source: "", scope: "local" as const, id: "space-wopal" },
    ])

    expect(result).toHaveLength(2)
    expect(result.map((item) => item.id)).toEqual(["user-wopal", "space-wopal"])
  })

})

describe("OPENCODE_DISABLE_PROJECT_CONFIG", () => {
  it.instance("skips project .opencode/ directories when flag is set", () =>
    withProcessEnv(
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "true",
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* AppFileSystem.use.writeWithDirs(
          path.join(test.directory, ".opencode", "command", "test-cmd.md"),
          "# Test Command\nThis is a test command.",
        )
        const directories = yield* Config.use.directories()
        expect(directories.some((d) => d.startsWith(test.directory))).toBe(false)
      }),
    ),
  )

  it.instance("still loads global config when flag is set", () =>
    withProcessEnv(
      "OPENCODE_DISABLE_PROJECT_CONFIG",
      "true",
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config).toBeDefined()
        expect(config.username).toBeDefined()
      }),
    ),
  )

  it.instance(
    "skips relative instructions with warning when flag is set but no config dir",
    () =>
      withProcessEnvs(
        { OPENCODE_CONFIG_DIR: undefined, OPENCODE_DISABLE_PROJECT_CONFIG: "true" },
        Effect.gen(function* () {
          const test = yield* TestInstance
          yield* AppFileSystem.use.writeWithDirs(path.join(test.directory, "CUSTOM.md"), "# Custom Instructions")
          // The relative instruction should be skipped without error
          const config = yield* Config.use.get()
          expect(config).toBeDefined()
        }),
      ),
    { config: { instructions: ["./CUSTOM.md"] } },
  )
})

// Regression for #28206: malformed OPENCODE_PERMISSION JSON used to crash
// the app on startup with an unhandled SyntaxError. Loading the config with
// an invalid JSON value in this env var should not throw.
describe("OPENCODE_PERMISSION env var", () => {
  it.instance("does not crash when OPENCODE_PERMISSION contains invalid JSON", () =>
    withProcessEnv(
      "OPENCODE_PERMISSION",
      "{invalid",
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        // Regression: load() used to throw before returning anything.
        expect(config).toBeDefined()
      }),
    ),
  )
})

describe("OPENCODE_CONFIG_CONTENT token substitution", () => {
  it.instance("substitutes {env:} tokens in OPENCODE_CONFIG_CONTENT", () =>
    withProcessEnv(
      "TEST_CONFIG_VAR",
      "test_api_key_12345",
      withProcessEnv(
        "OPENCODE_CONFIG_CONTENT",
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          username: "{env:TEST_CONFIG_VAR}",
        }),
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.username).toBe("test_api_key_12345")
        }),
      ),
    ),
  )

  it.instance("substitutes {file:} tokens in OPENCODE_CONFIG_CONTENT", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* AppFileSystem.use.writeWithDirs(path.join(test.directory, "api_key.txt"), "secret_key_from_file")
      yield* withProcessEnv(
        "OPENCODE_CONFIG_CONTENT",
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          username: "{file:./api_key.txt}",
        }),
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.username).toBe("secret_key_from_file")
        }),
      )
    }),
  )
})

// parseManagedPlist unit tests — pure function, no OS interaction

test("parseManagedPlist strips MDM metadata keys", async () => {
  const config = ConfigParse.schema(
    Config.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          PayloadDisplayName: "OpenCode Managed",
          PayloadIdentifier: "ai.opencode.managed.test",
          PayloadType: "ai.opencode.managed",
          PayloadUUID: "AAAA-BBBB-CCCC",
          PayloadVersion: 1,
          _manualProfile: true,
          share: "disabled",
          model: "mdm/model",
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.share).toBe("disabled")
  expect(config.model).toBe("mdm/model")
  // MDM keys must not leak into the parsed config
  expect((config as any).PayloadUUID).toBeUndefined()
  expect((config as any).PayloadType).toBeUndefined()
  expect((config as any)._manualProfile).toBeUndefined()
})

test("parseManagedPlist parses server settings", async () => {
  const config = ConfigParse.schema(
    Config.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          server: { hostname: "127.0.0.1", mdns: false },
          autoupdate: true,
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.server?.hostname).toBe("127.0.0.1")
  expect(config.server?.mdns).toBe(false)
  expect(config.autoupdate).toBe(true)
})

test("parseManagedPlist parses permission rules", async () => {
  const config = ConfigParse.schema(
    Config.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          permission: {
            "*": "ask",
            bash: { "*": "ask", "rm -rf *": "deny", "curl *": "deny" },
            grep: "allow",
            glob: "allow",
            webfetch: "ask",
            "~/.ssh/*": "deny",
          },
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.permission?.["*"]).toBe("ask")
  expect(config.permission?.grep).toBe("allow")
  expect(config.permission?.webfetch).toBe("ask")
  expect(config.permission?.["~/.ssh/*"]).toBe("deny")
  const bash = config.permission?.bash as Record<string, string>
  expect(bash?.["rm -rf *"]).toBe("deny")
  expect(bash?.["curl *"]).toBe("deny")
})

test("parseManagedPlist parses enabled_providers", async () => {
  const config = ConfigParse.schema(
    Config.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["anthropic", "google"],
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.enabled_providers).toEqual(["anthropic", "google"])
})

test("parseManagedPlist handles empty config", async () => {
  const config = ConfigParse.schema(
    Config.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(JSON.stringify({ $schema: "https://opencode.ai/config.json" })),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.$schema).toBe("https://opencode.ai/config.json")
})
