import { NodeHttpServer } from "@effect/platform-node"
import { afterAll, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { createSpaceService } from "@wopal/wopalspace"
import { createOpencodeClient } from "@wopal/ellamaka-sdk/v2"
import { execFileSync } from "node:child_process"
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
 * Real HTTP + generated-SDK coverage for the Space capability contract.
 *
 * A real Git ontology and a real Space are materialized on disk, then the
 * public HttpApi and the generated SDK client drive preview and apply against
 * the same implementation. Nothing below the transport boundary is mocked.
 */

const home = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "wopalspace-cap-http-"))
const hostGitConfig = path.join(home, "gitconfig")
await fs.writeFile(hostGitConfig, "")

const testGitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: hostGitConfig,
  GIT_AUTHOR_NAME: "WopalSpace Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "WopalSpace Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
}

const spaceGit = (cwd: string, args: readonly string[], env?: Readonly<Record<string, string>>) =>
  execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", ...args], {
    cwd,
    env: env === undefined ? testGitEnv : { ...testGitEnv, ...env },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  }).trim()

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

const host = WopalSpaceHostService.layerFor({ host: { wopalHome: home }, spaceGit })

const apiLayer = HttpApiBuilder.layer(RootHttpApi).pipe(
  Layer.provide([controlHandlers, globalHandlers, wopalSpaceHandlers]),
  Layer.provide([host, SetupHostService.layer.pipe(Layer.provide(host))]),
  Layer.provide([
    authorizationLayer.pipe(
      Layer.provide(ServerAuth.Config.layer({ password: Option.some("secret"), username: "ellamaka" })),
    ),
    schemaErrorLayer,
  ]),
)

/** Services the route stack needs beyond the WopalSpace host itself. */
const runtimeLayer = Layer.mergeAll(
  SessionStatus.defaultLayer,
  Layer.mock(Session.Service)({}),
  Layer.mock(Auth.Service)({}),
  Layer.mock(Config.Service)({}),
  Layer.mock(Installation.Service)({
    method: () => Effect.succeed("npm"),
    latest: () => Effect.succeed("9.9.9"),
    upgrade: () => Effect.void,
  }),
  AppFileSystem.defaultLayer,
  Layer.succeedContext(Context.makeUnsafe<unknown>(new Map())),
)

const routes = HttpRouter.serve(apiLayer, { disableListenLog: true, disableLogger: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(runtimeLayer),
)

const it = testEffect(routes)

const basic = () => ServerAuth.header({ username: "ellamaka", password: "secret" }) ?? ""
const authorized = () => ({ Authorization: basic() })

const get = (url: string) =>
  HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(authorized()), HttpClient.execute)
const post = (url: string, body: unknown) =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.bodyJsonUnsafe(body),
    HttpClientRequest.setHeaders(authorized()),
    HttpClient.execute,
  )

const decode = Effect.fnUntraced(function* <S extends Schema.Top>(
  response: HttpClientResponse.HttpClientResponse,
  schema: S,
) {
  return yield* HttpClientResponse.schemaBodyJson(schema)(response)
})

const CandidateBody = Schema.Struct({
  reference: Schema.String,
  path: Schema.String,
  kind: Schema.String,
  source: Schema.Literal("worktree"),
})

const SpaceStatusBody = Schema.Struct({
  selection: Schema.Struct({ include: Schema.Array(Schema.String), exclude: Schema.Array(Schema.String) }),
  assembly: Schema.Struct({
    defaults: Schema.Array(Schema.String),
    legacy: Schema.optional(
      Schema.Struct({ version: Schema.Literal(2), privateCount: Schema.Number, writable: Schema.Boolean }),
    ),
  }),
  candidates: Schema.Array(CandidateBody),
  unregistered: Schema.Array(Schema.String),
})

const CapabilityBody = Schema.Struct({
  confirm: Schema.Boolean,
  operation: Schema.Literals(["add", "remove"]),
  local: Schema.Boolean,
  items: Schema.Array(
    Schema.Struct({
      reference: Schema.String,
      capabilityPath: Schema.String,
      selection: Schema.Literals(["include", "exclude", "none"]),
      warnings: Schema.Array(Schema.String),
    }),
  ),
  stateCommit: Schema.optional(Schema.String),
  ontologyCommit: Schema.optional(Schema.String),
  syncPending: Schema.Boolean,
})

const ErrorBody = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  suggestion: Schema.optional(Schema.String),
})

/**
 * One real Git-backed ontology plus a Space materialized from it.
 *
 * The host is bound to the single process Home for the whole file, so each
 * fixture lives inside it under a per-name ontology and Space root.
 */
async function createFixture(name: string) {
  const root = await fs.mkdtemp(path.join(home, "fixture-" + name + "-"))
  const wopalHome = home
  const seed = path.join(root, "seed")
  const origin = path.join(root, "origin.git")
  const ontologyName = "onto-" + name
  const ontology = path.join(wopalHome, "ontologies", ontologyName)
  const spaceRoot = path.join(root, "space")
  const gitconfig = path.join(root, "gitconfig")
  await fs.writeFile(gitconfig, "")
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitconfig,
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
    }).trim()
  const write = async (cwd: string, file: string, text: string) => {
    const absolute = path.join(cwd, file)
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, text)
  }

  await write(
    seed,
    "assembly/archetypes/coding.yaml",
    "version: 1\ntype: coding\nagents: []\nskills:\n  - dev-flow\nrules: []\ncommands: []\nplugins: {}\n",
  )
  await write(
    seed,
    "assembly/schemas/coding-space-schema.yaml",
    "version: 1\nruntime:\n  path: .wopal-space\n  files: []\n  dirs: []\nspace:\n  files: []\n  dirs: []\n",
  )
  await write(seed, "assembly/templates/.keep", "")
  await write(seed, "skills/dev-flow/SKILL.md", "# dev flow\n")
  await write(seed, ".env.example", "EXAMPLE=1\n")
  git(seed, "init", "-q")
  git(seed, "add", ".")
  git(seed, "commit", "-qm", "assembly baseline")
  git(root, "clone", "--bare", seed, origin)
  git(seed, "push", "-q", origin, "main")
  await fs.mkdir(path.dirname(ontology), { recursive: true })
  git(root, "clone", "-q", origin, ontology)
  git(ontology, "remote", "set-url", "origin", "file://" + origin)

  const registryFile = path.join(wopalHome, "config", "settings.jsonc")
  const readRegistry = async () => {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(registryFile, "utf8"))
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record: Record<string, unknown> = { ...parsed }
        const ontologies = record["ontologies"]
        const entries: Record<string, unknown> = {}
        if (ontologies !== null && typeof ontologies === "object" && !Array.isArray(ontologies)) {
          for (const [key, value] of Object.entries(ontologies)) entries[key] = value
        }
        return { record, ontologies: entries }
      }
    } catch {
      // No registry yet: the fixture creates the first entry.
    }
    return { record: {} as Record<string, unknown>, ontologies: {} as Record<string, unknown> }
  }
  const registry = await readRegistry()
  registry.ontologies[ontologyName] = { path: ontology, upstream: "file://" + origin, fork: false }
  registry.record["ontologies"] = registry.ontologies
  await fs.mkdir(path.dirname(registryFile), { recursive: true })
  await fs.writeFile(registryFile, JSON.stringify(registry.record, null, 2))

  const setup = createSpaceService({ host: { wopalHome }, git: spaceGit })
  await setup.init({ name, root: spaceRoot, ontology: ontologyName, type: "coding" })
  return { root, wopalHome, ontology, spaceRoot, worktree: path.join(spaceRoot, ".wopal"), git }
}

const spaceName = (suffix: string) => "http-" + suffix

describe("Public Space capability contract over the real HttpApi", () => {
  it.live("reports candidates, defaults and a two-set selection with no private field", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => createFixture(spaceName("status")))
      yield* Effect.promise(() =>
        fs
          .mkdir(path.join(fixture.worktree, "skills", "new-skill"), { recursive: true })
          .then(() => fs.writeFile(path.join(fixture.worktree, "skills", "new-skill", "SKILL.md"), "# new\n")),
      )

      const response = yield* get("/wopal-space/spaces/" + spaceName("status") + "/status")
      expect(response.status).toBe(200)
      const body = yield* decode(response, SpaceStatusBody)
      expect(body.selection).toEqual({ include: [], exclude: [] })
      expect(body.selection).not.toHaveProperty("private")
      expect(body.assembly.defaults).toContain("skill:dev-flow")
      expect(body.candidates).toEqual([
        { reference: "skill:new-skill", path: "skills/new-skill", kind: "skill", source: "worktree" },
      ])
      expect(body.unregistered).not.toContain("skills/new-skill/SKILL.md")
      expect(body.assembly.legacy).toBeUndefined()
    }),
  )

  it.live("previews with zero writes and applies through the same decision", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => createFixture(spaceName("apply")))
      const skill = path.join(fixture.worktree, "skills", "new-skill", "SKILL.md")
      yield* Effect.promise(() =>
        fs.mkdir(path.dirname(skill), { recursive: true }).then(() => fs.writeFile(skill, "# new\n")),
      )
      const branchBefore = fixture.git(fixture.ontology, "rev-parse", "space/" + spaceName("apply"))
      const metaBefore = yield* Effect.promise(() =>
        fs.readFile(path.join(fixture.spaceRoot, ".wopal-space/space-meta.json"), "utf8"),
      )

      const preview = yield* post("/wopal-space/spaces/" + spaceName("apply") + "/capabilities", {
        references: ["skill:new-skill"],
        local: true,
        confirm: false,
      })
      expect(preview.status).toBe(200)
      const planned = yield* decode(preview, CapabilityBody)
      expect(planned.confirm).toBe(false)
      expect(planned.items[0]).toMatchObject({ reference: "skill:new-skill", selection: "include" })
      expect(planned.syncPending).toBe(true)
      expect(planned.ontologyCommit).toBeUndefined()
      expect(planned.stateCommit).toBeUndefined()
      // Preview wrote nothing.
      expect(fixture.git(fixture.ontology, "rev-parse", "space/" + spaceName("apply"))).toBe(branchBefore)
      expect(
        yield* Effect.promise(() => fs.readFile(path.join(fixture.spaceRoot, ".wopal-space/space-meta.json"), "utf8")),
      ).toBe(metaBefore)

      const applied = yield* post("/wopal-space/spaces/" + spaceName("apply") + "/capabilities", {
        references: ["skill:new-skill"],
        local: true,
        confirm: true,
      })
      expect(applied.status).toBe(200)
      const result = yield* decode(applied, CapabilityBody)
      expect(result.confirm).toBe(true)
      expect(result.items[0]?.selection).toBe("include")
      expect(result.syncPending).toBe(true)
      expect(result.ontologyCommit).toBe(fixture.git(fixture.ontology, "rev-parse", "space/" + spaceName("apply")))
      expect(result.stateCommit).toBeDefined()

      const status = yield* get("/wopal-space/spaces/" + spaceName("apply") + "/status")
      const facts = yield* decode(status, SpaceStatusBody)
      expect(facts.selection.include).toEqual(["skill:new-skill"])
      expect(facts.candidates).toEqual([])
    }),
  )

  it.live("maps a retired private hold to a conflict with an actionable suggestion", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => createFixture(spaceName("legacy")))
      const metaPath = path.join(fixture.spaceRoot, ".wopal-space/space-meta.json")
      const meta = JSON.parse(yield* Effect.promise(() => fs.readFile(metaPath, "utf8")))
      yield* Effect.promise(() =>
        fs.writeFile(
          metaPath,
          JSON.stringify({ ...meta, version: 2, private: ["rule:private-rule.md"] }, null, 2) + "\n",
        ),
      )

      const status = yield* get("/wopal-space/spaces/" + spaceName("legacy") + "/status")
      expect(status.status).toBe(200)
      const facts = yield* decode(status, SpaceStatusBody)
      expect(facts.assembly.legacy).toEqual({ version: 2, privateCount: 1, writable: false })

      const refused = yield* post("/wopal-space/spaces/" + spaceName("legacy") + "/capabilities", {
        references: ["skill:dev-flow"],
        local: true,
        confirm: true,
      })
      expect(refused.status).toBe(409)
      const error = yield* decode(refused, ErrorBody)
      expect(error.code).toBe("SPACE_META_LEGACY_PRIVATE")
      expect(error.message).toContain("rule:private-rule.md")
      expect(error.suggestion).toContain("Back up")
    }),
  )
})

describe("Generated SDK consumes the same Space capability contract", () => {
  it.live("reads candidates and applies an include with the same result shape", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => createFixture(spaceName("sdk")))
      const skill = path.join(fixture.worktree, "skills", "sdk-skill", "SKILL.md")
      yield* Effect.promise(() =>
        fs.mkdir(path.dirname(skill), { recursive: true }).then(() => fs.writeFile(skill, "# sdk\n")),
      )

      const handler = HttpRouter.toWebHandler(apiLayer.pipe(Layer.provide(runtimeLayer)), {
        disableLogger: true,
      }).handler
      const client = createOpencodeClient({
        baseUrl: "http://localhost",
        headers: authorized(),
        fetch: Object.assign(
          async (request: RequestInfo | URL, init?: RequestInit) =>
            await handler(request instanceof Request ? request : new Request(request, init)),
          { preconnect: globalThis.fetch.preconnect },
        ),
      })

      const status = yield* Effect.promise(() => client.wopalSpace.space.status({ name: spaceName("sdk") }))
      expect(status.data?.candidates).toEqual([
        { reference: "skill:sdk-skill", path: "skills/sdk-skill", kind: "skill", source: "worktree" },
      ])
      expect(status.data?.selection).toEqual({ include: [], exclude: [] })

      const applied = yield* Effect.promise(() =>
        client.wopalSpace.space.capability.add({
          name: spaceName("sdk"),
          references: ["skill:sdk-skill"],
          local: true,
          confirm: true,
        }),
      )
      expect(applied.data?.items[0]?.selection).toBe("include")
      expect(applied.data?.syncPending).toBe(true)
      expect(applied.data?.ontologyCommit).toBeDefined()
      expect(applied.data?.stateCommit).toBeDefined()
    }),
  )
})
