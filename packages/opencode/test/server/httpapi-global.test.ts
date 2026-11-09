import { loopbackHttpServer } from "../fixture/http-server"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { Session } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"
import { ProjectID } from "../../src/project/schema"
import { NotFoundError } from "../../src/storage/storage"
import { ServerAuth } from "../../src/server/auth"
import { SessionStatus } from "../../src/session/status"
import { SessionProjection } from "../../src/workbench/session-projection"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { layer as workbenchDshUrlLayer } from "../../src/workbench/dsh-url"
import { WorkbenchPaths } from "../../src/server/routes/instance/httpapi/groups/workbench"
import { AppBffRootApi, RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { SetupHostService } from "../../src/wopal/setup-host"
import { WopalSpaceHostService } from "../../src/wopal/wopal-space-host"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { wopalSpaceHandlers } from "../../src/server/routes/instance/httpapi/handlers/wopal-space"
import { workbenchHandlers } from "../../src/server/routes/instance/httpapi/handlers/workbench"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

const routes = HttpRouter.serve(
  Layer.mergeAll(
    HttpApiBuilder.layer(RootHttpApi).pipe(
      Layer.provide([controlHandlers, globalHandlers, wopalSpaceHandlers]),
      Layer.provide(WopalSpaceHostService.layer),
      Layer.provide(SetupHostService.layer.pipe(Layer.provide(WopalSpaceHostService.layer))),
    ),
    // The Official App BFF is a private composition served on the same router.
    HttpApiBuilder.layer(AppBffRootApi).pipe(Layer.provide(workbenchHandlers)),
  ).pipe(Layer.provide(workbenchDshUrlLayer), Layer.provide([authorizationLayer, schemaErrorLayer])),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(loopbackHttpServer),
  Layer.provide(
    Layer.mock(Session.Service)({
      get: (id) =>
        id === "ses_fixture"
          ? Effect.succeed({
              id,
              slug: "fixture",
              projectID: ProjectID.global,
              directory: "/cold",
              parentID: SessionID.make("ses_parent"),
              title: "Cold session",
              version: "test",
              time: { created: 1, updated: 1 },
            })
          : Effect.fail(new NotFoundError({ message: "missing" })),
    }),
  ),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(SessionProjection.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(workbenchDshUrlLayer),
  // Raw HttpApi routes expose an opaque handler context at the web boundary.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  Layer.provide(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
)
const workbenchRoutes = routes.pipe(
  Layer.provideMerge(
    Layer.mock(SessionStatus.Service)({
      snapshot: () =>
        Effect.succeed([{ directory: "/cold", sessionID: SessionID.make("ses_fixture"), status: { type: "busy" } }]),
    }),
  ),
)
const it = testEffect(
  workbenchRoutes.pipe(Layer.provide(ServerAuth.Config.layer({ password: Option.none(), username: "opencode" }))),
)

const itReal = testEffect(
  routes.pipe(
    Layer.provideMerge(SessionStatus.defaultLayer),
    Layer.provide(ServerAuth.Config.layer({ password: Option.none(), username: "opencode" })),
  ),
)

describe("global session snapshot uses the shared runtime owner", () => {
  itReal.instance("exposes statuses written by the actual SessionStatus service", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const status = yield* SessionStatus.Service
      yield* status.set(SessionID.make("ses_live"), { type: "busy" })
      const response = yield* HttpClient.get("/global/session/status")
      expect(response.status).toBe(200)
      expect(yield* response.json).toContainEqual({
        directory: instance.directory,
        sessionID: "ses_live",
        status: { type: "busy" },
      })
    }),
  )
})

describe("global HttpApi", () => {
  it.live("reads root session activity without a directory instance", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/global/session/status")
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual([{ directory: "/cold", sessionID: "ses_fixture", status: { type: "busy" } }])
    }),
  )

  it.live("reads session metadata and missing sessions without a directory instance", () =>
    Effect.gen(function* () {
      const found = yield* HttpClient.get("/global/session/ses_fixture")
      expect(found.status).toBe(200)
      expect(yield* found.json).toMatchObject({
        id: "ses_fixture",
        directory: "/cold",
        parentID: "ses_parent",
        title: "Cold session",
      })
      const missing = yield* HttpClient.get("/global/session/ses_missing")
      expect(missing.status).toBe(404)
      expect(yield* missing.json).toEqual({ name: "NotFoundError", data: { message: "missing" } })
    }),
  )

  it.live("exposes only the fixed App BFF session operations", () => {
    // DESIGN-workbench.md fixes the private BFF contract to createSession,
    // sessionTree, locations and dshEntry. Runtime-owned status and metadata must
    // not come back as a second private projection.
    expect(Object.keys(WorkbenchPaths).sort()).toEqual(["dshUrl", "locations", "sessionTree", "sessions"])
    // Paths are the contract surface; each one maps to exactly one operation.
    // The three removed projections must stay gone from the served surface.
    expect(Object.values(WorkbenchPaths).some((path) => path.includes("session-groups"))).toBe(false)
    expect(Object.values(WorkbenchPaths).some((path) => path.includes("session-statuses"))).toBe(false)
    expect(Object.values(WorkbenchPaths).some((path) => path.includes("session-summaries"))).toBe(false)
    return Effect.void
  })

  it.live("upgrades to latest when the request body is omitted", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.post(GlobalPaths.upgrade)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ success: true, version: "9.9.9" })
    }),
  )

  it.live("rejects malformed upgrade payloads", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.setBody(HttpBody.text("{", "application/json")),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
      expect(yield* response.json).toEqual({ success: false, error: "Invalid request body" })
    }),
  )
})
