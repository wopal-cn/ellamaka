import { loopbackHttpServer } from "../fixture/http-server"
import { afterEach, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { Global } from "@wopal/ellamaka-core/global"
import path from "node:path"
import fs from "node:fs/promises"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { SessionStatus } from "../../src/session/status"
import { Session } from "../../src/session/session"
import { ServerAuth } from "../../src/server/auth"
import { SetupHostService } from "../../src/wopal/setup-host"
import { WopalSpaceHostService } from "../../src/wopal/wopal-space-host"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { wopalSpaceHandlers } from "../../src/server/routes/instance/httpapi/handlers/wopal-space"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

/**
 * Real HTTP coverage for the Public Platform WopalSpace contract.
 *
 * These assertions replace the removed CLI-bridge handler tests: the same
 * operations are now served by the shared @wopal/wopalspace services, so the
 * checks live at the real HttpApi/auth boundary instead of a mocked registry.
 */

/** One route stack per host composition: the default one runs the production WopalSpace host. */
const makeRoutes = (host: Layer.Layer<WopalSpaceHostService.Service>) =>
  HttpRouter.serve(
    HttpApiBuilder.layer(RootHttpApi).pipe(
      Layer.provide([controlHandlers, globalHandlers, wopalSpaceHandlers]),
      Layer.provide([host, SetupHostService.layer.pipe(Layer.provide(host))]),
      Layer.provide([
        authorizationLayer.pipe(
          Layer.provide(ServerAuth.Config.layer({ password: Option.some("secret"), username: "ellamaka" })),
        ),
        schemaErrorLayer,
      ]),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(loopbackHttpServer),
    Layer.provide(SessionStatus.defaultLayer),
    Layer.provide(Layer.mock(Session.Service)({})),
    Layer.provide(Layer.mock(Auth.Service)({})),
    Layer.provide(Layer.mock(Config.Service)({})),
    Layer.provide(
      Layer.mock(Installation.Service)({
        method: () => Effect.succeed("npm"),
        latest: () => Effect.succeed("9.9.9"),
        upgrade: () => Effect.void,
      }),
    ),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Layer.succeedContext(Context.makeUnsafe<unknown>(new Map()))),
  )

const routes = makeRoutes(WopalSpaceHostService.layer)

const it = testEffect(routes)
const basic = () => ServerAuth.header({ username: "ellamaka", password: "secret" }) ?? ""
const authorized = () => ({ Authorization: basic() })

const get = (url: string, headers: Record<string, string> = authorized()) =>
  HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers), HttpClient.execute)

const getAnonymous = (url: string) => HttpClientRequest.get(url).pipe(HttpClient.execute)

const post = (url: string, body: unknown, headers: Record<string, string> = authorized()) =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.bodyJsonUnsafe(body),
    HttpClientRequest.setHeaders(headers),
    HttpClient.execute,
  )

type SpaceEntry = { path: string; name?: string; branch?: string; type?: string; ontology?: string }

/** Response shapes asserted below; decoding fails the test if the contract drifts. */
const SpaceListBody = Schema.Struct({
  items: Schema.Array(Schema.Struct({ name: Schema.String, displayName: Schema.String, path: Schema.String })),
  total: Schema.Number,
})
const SpaceFilesBody = Schema.Struct({
  items: Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String, type: Schema.String })),
})
const SpaceFileBody = Schema.Struct({ type: Schema.String, content: Schema.String })
const ErrorBody = Schema.Struct({ code: Schema.String, message: Schema.String })
const OntologyListBody = Schema.Struct({
  items: Schema.Array(Schema.Struct({ name: Schema.String, available: Schema.Boolean })),
  total: Schema.Number,
})
const SpaceResolveBody = Schema.Struct({ name: Schema.String, path: Schema.String, source: Schema.String })
const InstallBody = Schema.Struct({
  name: Schema.String,
  mode: Schema.String,
  status: Schema.String,
  upstream: Schema.String,
})

const decodeBody = Effect.fnUntraced(function* <S extends Schema.Top>(
  response: HttpClientResponse.HttpClientResponse,
  schema: S,
) {
  return yield* HttpClientResponse.schemaBodyJson(schema)(response)
})

/** Register Spaces for the current isolated WOPAL_HOME. */
async function registerSpaces(
  spaces: Record<string, SpaceEntry>,
  ontologies: Record<string, { path: string; upstream: string }> = {},
) {
  const file = path.join(Global.Path.wopalHome, "config", "settings.jsonc")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ spaces, ontologies }, null, 2))
  return async () => {
    await fs.rm(file, { force: true })
  }
}

/** Each test owns the host registry file; never leak it into the next file. */
afterEach(async () => {
  await fs.rm(path.join(Global.Path.wopalHome, "config", "settings.jsonc"), { force: true })
})

/**
 * A local Git repository shaped like an installed ontology. Fork mode is
 * exercised end to end through the real host: the fork port is injected so no
 * request reaches GitHub, while Git, the registry and assembly validation run
 * for real.
 */
async function ontologyForkFixture(root: string) {
  const { execFileSync } = await import("node:child_process")
  const gitConfig = path.join(root, "gitconfig")
  await fs.writeFile(gitConfig, "")
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_AUTHOR_NAME: "WopalSpace Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "WopalSpace Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  }
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    })
  const seed = path.join(root, "seed")
  await fs.mkdir(path.join(seed, "assembly", "archetypes"), { recursive: true })
  await fs.writeFile(
    path.join(seed, "assembly", "archetypes", "coding.yaml"),
    "version: 1\ntype: coding\nagents: []\nskills: []\nrules: []\ncommands: []\nplugins: {}\n",
  )
  git(seed, "init", "-q")
  git(seed, "add", ".")
  git(seed, "commit", "-qm", "assembly baseline")
  const upstream = path.join(root, "upstream.git")
  const fork = path.join(root, "fork.git")
  git(root, "clone", "--bare", seed, upstream)
  git(root, "clone", "--bare", seed, fork)
  // Local remotes keep the install offline: the injected fork port returns the
  // fork, and the service's later upstream fetch resolves to this bare repo.
  return { source: "file://" + upstream, fork: "file://" + fork }
}

const forkCalls: string[] = []
const forkTarget = { url: "" }

// The fork port is the only injected boundary: Git, registry writes and
// assembly validation below this line run for real against the isolated Home.
const forkRoutes = makeRoutes(
  WopalSpaceHostService.layerFor({
    fork: {
      ensure: async (source) => {
        forkCalls.push(source)
        if (!forkTarget.url) throw new Error("no fork fixture registered")
        return forkTarget.url
      },
    },
  }),
)
const forkIt = testEffect(forkRoutes)

describe("Public WopalSpace fork installation", () => {
  forkIt.live("forwards mode:fork to the host fork port and installs the fork", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fs.mkdtemp(path.join(Global.Path.wopalHome, "ontology-fork-")))
      const fixture = yield* Effect.promise(() => ontologyForkFixture(root))
      forkTarget.url = fixture.fork
      const source = fixture.source
      forkCalls.length = 0

      const installed = yield* HttpClientRequest.post("/wopal-space/ontologies").pipe(
        HttpClientRequest.bodyJsonUnsafe({ name: "forked", source, mode: "fork" }),
        HttpClientRequest.setHeaders(authorized()),
        HttpClient.execute,
      )
      expect(installed.status).toBe(200)
      const body = yield* decodeBody(installed, InstallBody)
      expect(body).toMatchObject({ name: "forked", mode: "fork", status: "created", upstream: source })
      // The handler passed mode through verbatim and the host resolved the fork.
      expect(forkCalls).toEqual([source])

      const registry = yield* Effect.promise(() =>
        fs.readFile(path.join(Global.Path.wopalHome, "config", "settings.jsonc"), "utf8"),
      )
      expect(registry).toContain("forked")
      expect(registry).toContain('"fork": true')

      yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
    }),
  )
})

describe("Public WopalSpace HttpApi", () => {
  it.live("rejects unauthenticated root session reads", () =>
    Effect.gen(function* () {
      expect((yield* getAnonymous("/global/session/status")).status).toBe(401)
      expect((yield* getAnonymous("/global/session/ses_fixture")).status).toBe(401)
    }),
  )

  it.live("rejects unauthenticated WopalSpace requests", () =>
    Effect.gen(function* () {
      const unauthenticated = yield* getAnonymous("/wopal-space/spaces")
      expect(unauthenticated.status).toBe(401)
      const wrong = yield* get("/wopal-space/spaces", {
        Authorization: ServerAuth.header({ username: "ellamaka", password: "wrong" }) ?? "",
      })
      expect(wrong.status).toBe(401)
      const ok = yield* get("/wopal-space/spaces")
      expect(ok.status).toBe(200)
    }),
  )

  it.live("lists registered Spaces from the shared registry", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(Global.Path.wopalHome, "space-")))
      yield* Effect.promise(() =>
        registerSpaces({
          "test-space": { path: dir, name: "测试空间", branch: "space/test-space", type: "local" },
        }),
      )
      const response = yield* get("/wopal-space/spaces")
      expect(response.status).toBe(200)
      const body = yield* decodeBody(response, SpaceListBody)
      const item = body.items.find((entry) => entry.name === "test-space")
      expect(item?.displayName).toBe("测试空间")
      expect(item?.path).toBe(dir)
      expect(body.total).toBeGreaterThanOrEqual(1)
      yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
    }),
  )

  it.live("preserves the registered Space path when it is a symlink alias", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(Global.Path.wopalHome, "space-alias-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
      )
      const target = path.join(root, "target")
      const alias = path.join(root, "alias")
      yield* Effect.promise(async () => {
        await fs.mkdir(target)
        await fs.symlink(target, alias, "dir")
        await registerSpaces({ "alias-space": { path: alias, name: "Alias", type: "local" } })
      })
      const response = yield* get("/wopal-space/spaces")
      expect(response.status).toBe(200)
      const body = yield* decodeBody(response, SpaceListBody)
      const item = body.items.find((entry) => entry.name === "alias-space")
      expect(item).toMatchObject({ name: "alias-space", displayName: "Alias", path: alias })
      expect(body.total).toBeGreaterThanOrEqual(1)
    }),
  )

  it.live("lists and reads Space files through the public contract", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(Global.Path.wopalHome, "space-files-")))
      yield* Effect.promise(() => fs.mkdir(path.join(dir, "docs"), { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(dir, "docs", "readme.md"), "# hello\n"))
      yield* Effect.promise(() =>
        registerSpaces({ "files-space": { path: dir, name: "Files", branch: "space/files-space", type: "local" } }),
      )

      const listing = yield* get("/wopal-space/spaces/files-space/files?path=docs")
      expect(listing.status).toBe(200)
      const listBody = yield* decodeBody(listing, SpaceFilesBody)
      expect(listBody.items).toMatchObject([{ name: "readme.md", path: "docs/readme.md", type: "file" }])

      const file = yield* get("/wopal-space/spaces/files-space/files/content?path=docs/readme.md")
      expect(file.status).toBe(200)
      const fileBody = yield* decodeBody(file, SpaceFileBody)
      expect(fileBody.type).toBe("text")
      expect(fileBody.content).toContain("# hello")

      yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
    }),
  )

  it.live("rejects a traversal attempt outside the registered root", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(Global.Path.wopalHome, "space-escape-")))
      yield* Effect.promise(() =>
        registerSpaces({ "escape-space": { path: dir, name: "Escape", branch: "space/escape-space", type: "local" } }),
      )
      const response = yield* get("/wopal-space/spaces/escape-space/files/content?path=../../etc/passwd")
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.status).toBeLessThan(500)
      const body = yield* decodeBody(response, ErrorBody)
      expect(body.code).toBe("SPACE_PATH_ESCAPE")
      yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
    }),
  )

  it.live("maps an unknown Space to a stable not-found error", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => registerSpaces({}).then((cleanup) => cleanup()))
      const response = yield* get("/wopal-space/spaces/missing-space/files")
      expect(response.status).toBe(404)
      const body = yield* decodeBody(response, ErrorBody)
      expect(body.code).toBe("SPACE_NOT_FOUND")
      expect(body.message).toContain("missing-space")
    }),
  )

  it.live("lists ontologies and resolves a Space by name", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(Global.Path.wopalHome, "space-resolve-")))
      const ontology = path.join(Global.Path.wopalHome, "ontologies", "wopal-space-ontology")
      yield* Effect.promise(() =>
        registerSpaces(
          { "resolve-space": { path: dir, name: "Resolve", branch: "space/resolve-space", type: "local" } },
          { "wopal-space-ontology": { path: ontology, upstream: "https://example.invalid/ontology.git" } },
        ),
      )

      const ontologies = yield* get("/wopal-space/ontologies")
      expect(ontologies.status).toBe(200)
      const list = yield* decodeBody(ontologies, OntologyListBody)
      expect(list.items.map((item) => item.name)).toContain("wopal-space-ontology")
      expect(list.total).toBeGreaterThanOrEqual(1)

      const resolved = yield* post("/wopal-space/spaces/resolve", { name: "resolve-space" })
      expect(resolved.status).toBe(200)
      const body = yield* decodeBody(resolved, SpaceResolveBody)
      expect(body).toMatchObject({ name: "resolve-space", path: dir, source: "name" })
      yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))
    }),
  )
})
