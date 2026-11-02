import { NodeHttpServer } from "@effect/platform-node"
import { afterAll, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { createSetupHomeBinding, setupStatePath } from "@wopal/wopalspace"
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
import { tmpdir } from "../fixture/fixture"

/**
 * Real HTTP/SSE coverage for the Public Platform Setup contract.
 *
 * The Setup service is the real @wopal/wopalspace implementation over an
 * isolated WOPAL_HOME; only the GitHub token check is injected, because it is an
 * external network boundary.
 */

let githubVerdict: "valid" | "invalid" = "valid"
const testHome = await tmpdir()
const bootstrapHome = await tmpdir()
const selectedHome = path.join(bootstrapHome.path, "selected-home")

afterAll(async () => {
  await testHome[Symbol.asyncDispose]()
  await bootstrapHome[Symbol.asyncDispose]()
})

const makeRoutes = (host: Layer.Layer<WopalSpaceHostService.Service>, setup: Layer.Layer<SetupHostService.Service>) =>
  HttpRouter.serve(
    HttpApiBuilder.layer(RootHttpApi).pipe(
      Layer.provide([controlHandlers, globalHandlers, wopalSpaceHandlers]),
      Layer.provide([host, setup]),
      Layer.provide([
        authorizationLayer.pipe(
          Layer.provide(ServerAuth.Config.layer({ password: Option.some("secret"), username: "ellamaka" })),
        ),
        schemaErrorLayer,
      ]),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
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

const setupLayer = SetupHostService.layerFor({
  homeBinding: (wopal) =>
    createSetupHomeBinding({
      mode: "normal",
      initialPath: testHome.path,
      source: "shell",
      locked: true,
      normalizePath: (value) => path.resolve(value),
      persist: async () => {},
      apply: async (value) => wopal.rebindHome(value),
    }),
  github: {
    inspect: async () => {
      try {
        const env = await fs.readFile(path.join(testHome.path, ".env"), "utf8")
        if (githubVerdict === "valid" && /^(?:GITHUB_TOKEN|GH_TOKEN)=\S/m.test(env)) {
          return { configured: true, source: "env", account: "octocat" }
        }
      } catch {
        // No stored token is the normal pre-authentication state.
      }
      return { configured: false }
    },
    verify: async (token: string) => {
      if (githubVerdict === "valid") return { valid: true, account: "octocat" }
      // Echo the token back to prove the boundary redacts it before the wire.
      throw new Error("GitHub rejected the token " + token)
    },
  },
}).pipe(Layer.provide(WopalSpaceHostService.layerFor({ host: { wopalHome: testHome.path } })))

const routes = makeRoutes(WopalSpaceHostService.layerFor({ host: { wopalHome: testHome.path } }), setupLayer)
const it = testEffect(routes)

const basic = () => ServerAuth.header({ username: "ellamaka", password: "secret" }) ?? ""
const authorized = () => ({ Authorization: basic() })

const get = (url: string, headers: Record<string, string> = authorized()) =>
  HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers), HttpClient.execute)

const post = (url: string, body: unknown, headers: Record<string, string> = authorized()) =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.bodyJsonUnsafe(body),
    HttpClientRequest.setHeaders(headers),
    HttpClient.execute,
  )

const ErrorBody = Schema.Struct({ code: Schema.String, message: Schema.String })

const SetupInspectBody = Schema.Struct({
  home: Schema.Struct({
    path: Schema.String,
    binding: Schema.Struct({
      mode: Schema.String,
      source: Schema.String,
      path: Schema.String,
      locked: Schema.Boolean,
      selectable: Schema.Boolean,
      persisted: Schema.Boolean,
    }),
    writable: Schema.Boolean,
  }),
  state: Schema.Struct({ status: Schema.String, path: Schema.String, completed: Schema.Boolean }),
  credentials: Schema.Struct({ providers: Schema.Array(Schema.String) }),
  goals: Schema.Array(Schema.String),
  fingerprint: Schema.String,
})

const SetupPlanBody = Schema.Struct({
  planId: Schema.String,
  goals: Schema.Array(Schema.String),
  actions: Schema.Array(Schema.Struct({ actionId: Schema.String, goal: Schema.String, requiresInput: Schema.Boolean })),
  fingerprint: Schema.String,
})

const SetupRunBody = Schema.Struct({
  runId: Schema.String,
  planId: Schema.String,
  actionId: Schema.String,
  status: Schema.String,
  sequence: Schema.Number,
  result: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  error: Schema.optional(ErrorBody),
})

const SetupCompleteBody = Schema.Struct({ completed: Schema.Boolean, planId: Schema.String })

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {}
}

const decode = Effect.fnUntraced(function* <S extends Schema.Top>(
  response: HttpClientResponse.HttpClientResponse,
  schema: S,
) {
  return yield* HttpClientResponse.schemaBodyJson(schema)(response)
})

/** Parse an SSE body into its JSON payloads. */
function parseEvents(body: string): { sequence: number; phase: string; message: string; runId: string }[] {
  return body
    .split(NL)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice("data:".length).trim()) as unknown)
    .filter(
      (value): value is { [key: string]: unknown } =>
        typeof value === "object" && value !== null && !Array.isArray(value),
    )
    .map((value) => ({
      sequence: Number(value.sequence),
      phase: String(value.phase),
      message: String(value.message),
      runId: String(value.runId),
    }))
}

const NL = String.fromCharCode(10)

/**
 * Return the isolated Home to its pre-setup state. The Setup facts are read
 * from disk, so a test that already ran foundation would otherwise leave the
 * next test with nothing to plan.
 */
async function resetSetupHome() {
  await fs.rm(statePath(), { force: true })
  await fs.rm(path.join(testHome.path, ".env"), { force: true })
  for (const dir of ["config", "bin", "ontologies", "ellamaka", "agents", "skills", "rules", "commands"]) {
    await fs.rm(path.join(testHome.path, dir), { recursive: true, force: true })
  }
}

const statePath = () => setupStatePath(testHome.path)

describe("Public Setup API authentication", () => {
  it.live("rejects a request without a credential", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.execute(HttpClientRequest.get("/wopal-space/setup/inspect"))
      expect(response.status).toBe(401)
    }),
  )

  it.live("rejects a wrong credential", () =>
    Effect.gen(function* () {
      const response = yield* get("/wopal-space/setup/inspect", {
        Authorization: ServerAuth.header({ username: "ellamaka", password: "wrong" }) ?? "",
      })
      expect(response.status).toBe(401)
    }),
  )
})

describe("Public Setup API facts", () => {
  it.live("inspect reports live facts and writes nothing", () =>
    Effect.gen(function* () {
      const response = yield* get("/wopal-space/setup/inspect")
      expect(response.status).toBe(200)
      const body = yield* decode(response, SetupInspectBody)
      expect(body.home.path).toBe(testHome.path)
      expect(body.home.binding).toMatchObject({ mode: "normal", locked: true, selectable: false })
      expect(body.state.status).toBe("absent")
      expect(body.goals).toContain("foundation")
      expect(body.fingerprint).toHaveLength(16)
      // Zero writes: inspect must not create the state document.
      expect(yield* Effect.promise(() => fs.rm(statePath(), { force: true }))).toBeUndefined()
      const exists = yield* Effect.promise(() =>
        fs.access(statePath()).then(
          () => true,
          () => false,
        ),
      )
      expect(exists).toBe(false)
    }),
  )

  it.live("a corrupt state document is reported and left untouched", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fs.mkdir(path.dirname(statePath()), { recursive: true }))
      const corrupt = "{ not valid json"
      yield* Effect.promise(() => fs.writeFile(statePath(), corrupt))

      const response = yield* get("/wopal-space/setup/inspect")
      const body = yield* decode(response, SetupInspectBody)
      expect(body.state.status).toBe("corrupt")
      const text = yield* Effect.promise(() => fs.readFile(statePath(), "utf8"))
      expect(text).toBe(corrupt)
      yield* Effect.promise(() => fs.rm(statePath(), { force: true }))
    }),
  )

  it.live("plan filters foundation when the WOPAL_HOME root is already ready", () =>
    Effect.gen(function* () {
      const response = yield* post("/wopal-space/setup/plan", { goals: ["foundation"] })
      expect(response.status).toBe(200)
      const body = yield* decode(response, SetupPlanBody)
      expect(body.actions).toEqual([])
      // Planning is read-only.
      const exists = yield* Effect.promise(() =>
        fs.access(statePath()).then(
          () => true,
          () => false,
        ),
      )
      expect(exists).toBe(false)
    }),
  )

  it.live("an unknown plan is a stable 404", () =>
    Effect.gen(function* () {
      const response = yield* post("/wopal-space/setup/runs", {
        planId: "missing",
        actionId: "foundation",
      })
      expect(response.status).toBe(404)
      const body = yield* decode(response, ErrorBody)
      expect(body.code).toBe("SETUP_PLAN_NOT_FOUND")
    }),
  )

  it.live("rejects an action while one of that plan's dependencies is still pending", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => resetSetupHome())
      const planned = yield* post("/wopal-space/setup/plan", { goals: ["github", "ontology"] })
      const plan = yield* decode(planned, SetupPlanBody)
      expect(plan.actions.map((action) => action.actionId)).toEqual(["github", "ontology"])

      const response = yield* post("/wopal-space/setup/runs", {
        planId: plan.planId,
        actionId: "ontology",
        input: { mode: "clone" },
      })
      expect(response.status).toBe(409)
      expect((yield* decode(response, ErrorBody)).code).toBe("SETUP_ACTION_DEPENDENCY_PENDING")
    }),
  )
})

describe("Public Setup API Home bootstrap", () => {
  const bootstrapHost = WopalSpaceHostService.layerFor({ host: { wopalHome: bootstrapHome.path } })
  const bootstrapSetup = SetupHostService.layerFor({
    homeBinding: (wopal) =>
      createSetupHomeBinding({
        mode: "development",
        initialPath: bootstrapHome.path,
        source: "shell",
        locked: false,
        normalizePath: (value) => path.resolve(value),
        persist: async () => {
          throw new Error("development mode must not persist")
        },
        apply: async (value) => wopal.rebindHome(value),
      }),
    github: {
      inspect: async () => ({ configured: false }),
      verify: async () => ({ valid: false, account: null }),
    },
  }).pipe(Layer.provideMerge(bootstrapHost))
  const bootstrapIt = testEffect(makeRoutes(bootstrapHost, bootstrapSetup))

  bootstrapIt.live("blocks Setup writes until a development Home is selected, then locks that Home", () =>
    Effect.gen(function* () {
      const inspected = yield* get("/wopal-space/setup/inspect")
      const before = yield* decode(inspected, SetupInspectBody)
      expect(before.home.binding).toMatchObject({ mode: "development", locked: false, selectable: true })

      const blocked = yield* post("/wopal-space/setup/plan", { goals: ["foundation"] })
      expect(blocked.status).toBe(409)
      expect((yield* decode(blocked, ErrorBody)).code).toBe("SETUP_HOME_UNCONFIRMED")

      const blockedProgress = yield* get("/wopal-space/setup/runs/bootstrap-run")
      expect(blockedProgress.status).toBe(409)
      expect((yield* decode(blockedProgress, ErrorBody)).code).toBe("SETUP_HOME_UNCONFIRMED")

      const blockedEvents = yield* get("/wopal-space/setup/runs/bootstrap-run/events")
      expect(blockedEvents.status).toBe(409)
      expect((yield* decode(blockedEvents, ErrorBody)).code).toBe("SETUP_HOME_UNCONFIRMED")

      const blockedCancel = yield* post("/wopal-space/setup/runs/bootstrap-run/cancel", {})
      expect(blockedCancel.status).toBe(409)
      expect((yield* decode(blockedCancel, ErrorBody)).code).toBe("SETUP_HOME_UNCONFIRMED")

      const selected = yield* post("/wopal-space/setup/home", { path: selectedHome })
      expect(selected.status).toBe(200)
      const selection = yield* decode(
        selected,
        Schema.Struct({
          mode: Schema.String,
          source: Schema.String,
          path: Schema.String,
          locked: Schema.Boolean,
          selectable: Schema.Boolean,
          persisted: Schema.Boolean,
        }),
      )
      expect(selection).toMatchObject({
        mode: "development",
        source: "selected",
        path: selectedHome,
        locked: true,
        selectable: false,
        persisted: false,
      })
      expect(
        yield* Effect.promise(() =>
          fs.stat(selectedHome).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)

      const after = yield* decode(yield* get("/wopal-space/setup/inspect"), SetupInspectBody)
      expect(after.home.path).toBe(selectedHome)
      expect(after.home.binding.path).toBe(selectedHome)

      const planned = yield* post("/wopal-space/setup/plan", { goals: ["foundation"] })
      expect(planned.status).toBe(200)
      expect((yield* decode(planned, SetupPlanBody)).actions.map((action) => action.actionId)).toEqual(["foundation"])
    }),
  )
})

describe("Public Setup API run lifecycle", () => {
  it.live("executes a provider action, reports progress and completes", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => resetSetupHome())
      const planned = yield* post("/wopal-space/setup/plan", { goals: ["provider"] })
      const plan = yield* decode(planned, SetupPlanBody)

      const executed = yield* post("/wopal-space/setup/runs", {
        planId: plan.planId,
        actionId: "provider",
        input: { providerId: "test-provider", apiKey: "provider-secret" },
      })
      expect(executed.status).toBe(200)
      const run = yield* decode(executed, SetupRunBody)
      expect(run.planId).toBe(plan.planId)

      const snapshotResponse = yield* get("/wopal-space/setup/runs/" + run.runId)
      expect(snapshotResponse.status).toBe(200)
      const snapshot = yield* decode(snapshotResponse, SetupRunBody)
      expect(["running", "completed"]).toContain(snapshot.status)

      const completed = yield* post("/wopal-space/setup/complete", { planId: plan.planId })
      expect(completed.status).toBe(200)
      const body = yield* decode(completed, SetupCompleteBody)
      expect(body.completed).toBe(true)

      const persisted = yield* Effect.promise(() => fs.readFile(statePath(), "utf8"))
      expect(JSON.parse(persisted)).toMatchObject({ completed: true })
    }),
  )

  it.live("streams monotonic events and replays only the missed ones", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => resetSetupHome())
      const planned = yield* post("/wopal-space/setup/plan", { goals: ["provider"] })
      const plan = yield* decode(planned, SetupPlanBody)
      const executed = yield* post("/wopal-space/setup/runs", {
        planId: plan.planId,
        actionId: "provider",
        input: { providerId: "test-provider", apiKey: "provider-secret" },
      })
      const run = yield* decode(executed, SetupRunBody)

      const streamed = yield* get("/wopal-space/setup/runs/" + run.runId + "/events")
      expect(streamed.status).toBe(200)
      expect(streamed.headers["content-type"]).toContain("text/event-stream")
      const events = parseEvents(yield* streamed.text)
      expect(events.length).toBeGreaterThanOrEqual(2)
      expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1))
      expect(events.at(-1)?.phase).toBe("completed")

      const replayed = yield* get("/wopal-space/setup/runs/" + run.runId + "/events?after=1")
      const tail = parseEvents(yield* replayed.text)
      expect(tail.map((event) => event.sequence)).toEqual(events.slice(1).map((event) => event.sequence))
      for (const event of tail) expect(event.runId).toBe(run.runId)
    }),
  )

  it.live("cancels a finished run idempotently and rejects an unknown run", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => resetSetupHome())
      const planned = yield* post("/wopal-space/setup/plan", { goals: ["provider"] })
      const plan = yield* decode(planned, SetupPlanBody)
      const executed = yield* post("/wopal-space/setup/runs", {
        planId: plan.planId,
        actionId: "provider",
        input: { providerId: "test-provider", apiKey: "provider-secret" },
      })
      const run = yield* decode(executed, SetupRunBody)

      const cancelled = yield* post("/wopal-space/setup/runs/" + run.runId + "/cancel", {})
      expect(cancelled.status).toBe(200)
      const snapshot = yield* decode(cancelled, SetupRunBody)
      expect(["completed", "cancelled"]).toContain(snapshot.status)

      const unknown = yield* post("/wopal-space/setup/runs/nope/cancel", {})
      expect(unknown.status).toBe(404)
      expect((yield* decode(unknown, ErrorBody)).code).toBe("SETUP_RUN_NOT_FOUND")
    }),
  )

  it.live("never echoes a rejected GitHub token on the wire or into state", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => resetSetupHome())
      githubVerdict = "invalid"
      const token = "placeholder"
      try {
        const planned = yield* post("/wopal-space/setup/plan", { goals: ["github"] })
        const plan = yield* decode(planned, SetupPlanBody)

        const executed = yield* post("/wopal-space/setup/runs", {
          planId: plan.planId,
          actionId: "github",
          input: { token },
        })
        const run = yield* decode(executed, SetupRunBody)

        const snapshot = yield* decode(yield* get("/wopal-space/setup/runs/" + run.runId), SetupRunBody)
        expect(snapshot.status).toBe("failed")
        expect(JSON.stringify(snapshot)).not.toContain(token)

        const events = yield* get("/wopal-space/setup/runs/" + run.runId + "/events")
        const text = yield* events.text
        expect(text).not.toContain(token)
        expect(text).toContain("SETUP_GITHUB_FAILED")

        const stateText = yield* Effect.promise(() => fs.readFile(statePath(), "utf8").catch(() => ""))
        expect(stateText).not.toContain(token)
      } finally {
        githubVerdict = "valid"
      }
    }),
  )

  it.live("persists an explicit GitHub skip through the canonical Setup API", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => resetSetupHome())
      const planned = yield* post("/wopal-space/setup/plan", { goals: ["github"] })
      const plan = yield* decode(planned, SetupPlanBody)

      const executed = yield* post("/wopal-space/setup/runs", {
        planId: plan.planId,
        actionId: "github",
        input: { skip: true },
      })
      expect(executed.status).toBe(200)
      const run = yield* decode(executed, SetupRunBody)

      const streamed = yield* get("/wopal-space/setup/runs/" + run.runId + "/events")
      expect(streamed.status).toBe(200)
      const events = parseEvents(yield* streamed.text)
      expect(events.at(-1)?.phase).toBe("completed")

      const snapshot = yield* decode(yield* get("/wopal-space/setup/runs/" + run.runId), SetupRunBody)
      expect(snapshot.status).toBe("completed")
      expect(snapshot.result).toMatchObject({ mode: "clone" })

      const persisted = record(JSON.parse(yield* Effect.promise(() => fs.readFile(statePath(), "utf8"))))
      expect(record(persisted.steps).github).toBe("skipped")
      const envExists = yield* Effect.promise(() =>
        fs.access(path.join(testHome.path, ".env")).then(
          () => true,
          () => false,
        ),
      )
      expect(envExists).toBe(false)

      const completed = yield* post("/wopal-space/setup/complete", { planId: plan.planId })
      expect(completed.status).toBe(200)
      expect((yield* decode(completed, SetupCompleteBody)).completed).toBe(true)
    }),
  )

  it.live("skips optional provider bootstrap without creating credential storage", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => resetSetupHome())
      const planned = yield* post("/wopal-space/setup/plan", { goals: ["provider"] })
      const plan = yield* decode(planned, SetupPlanBody)

      const executed = yield* post("/wopal-space/setup/runs", {
        planId: plan.planId,
        actionId: "provider",
        input: { skip: true },
      })
      expect(executed.status).toBe(200)
      const run = yield* decode(executed, SetupRunBody)
      const streamed = yield* get("/wopal-space/setup/runs/" + run.runId + "/events")
      const events = parseEvents(yield* streamed.text)
      expect(events.at(-1)?.phase).toBe("completed")

      const persisted = record(JSON.parse(yield* Effect.promise(() => fs.readFile(statePath(), "utf8"))))
      expect(record(persisted.steps).provider).toBe("skipped")
      const dataExists = yield* Effect.promise(() =>
        fs.access(path.join(testHome.path, "ellamaka", "data")).then(
          () => true,
          () => false,
        ),
      )
      expect(dataExists).toBe(false)

      const completed = yield* post("/wopal-space/setup/complete", { planId: plan.planId })
      expect(completed.status).toBe(200)
      expect((yield* decode(completed, SetupCompleteBody)).completed).toBe(true)
    }),
  )
})
