import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { ServerAuth } from "../../src/server/auth"
import { CliContract } from "../../src/wopal/cli-contract"
import { SpaceRegistry } from "../../src/wopal/space-registry"
import { InstanceRef } from "../../src/effect/instance-ref"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionProjection } from "../../src/workbench/session-projection"
import { SpaceFiles } from "../../src/workbench/space-files"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { layer as workbenchDshUrlLayer } from "../../src/workbench/dsh-url"
import { WorkbenchPaths } from "../../src/server/routes/instance/httpapi/groups/workbench"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { wopalSpaceHandlers } from "../../src/server/routes/instance/httpapi/handlers/wopal-space"
import { workbenchHandlers } from "../../src/server/routes/instance/httpapi/handlers/workbench"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const routes = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, globalHandlers, wopalSpaceHandlers, workbenchHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(CliContract.defaultLayer),
  Layer.provide(SessionProjection.defaultLayer),
  Layer.provide(SpaceFiles.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(SpaceRegistry.defaultLayer),
  Layer.provide(workbenchDshUrlLayer),
  // Raw HttpApi routes expose an opaque handler context at the web boundary.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  Layer.provide(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
)
const workbenchRoutes = routes.pipe(Layer.provideMerge(SessionStatus.defaultLayer))
const it = testEffect(
  workbenchRoutes.pipe(Layer.provide(ServerAuth.Config.layer({ password: Option.none(), username: "opencode" }))),
)
const itSecret = testEffect(
  workbenchRoutes.pipe(
    Layer.provide(ServerAuth.Config.layer({ password: Option.some("secret"), username: "opencode" })),
  ),
)

const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""

describe("global HttpApi", () => {
  it.live("reads initialized workbench statuses without a directory or instance bootstrap", () =>
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const instance = {
        directory: "/already-initialized",
        worktree: "/",
        project: { id: "global" },
      } as never
      yield* status.set(SessionID.make("ses_busy"), { type: "busy" }).pipe(Effect.provideService(InstanceRef, instance))
      yield* status.set(SessionID.make("ses_idle"), { type: "idle" }).pipe(Effect.provideService(InstanceRef, instance))

      const response = yield* HttpClient.get(WorkbenchPaths.sessionStatuses)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual([
        { directory: "/already-initialized", sessionID: "ses_busy", status: { type: "busy" } },
      ])
    }),
  )

  itSecret.live("requires root authorization before returning workbench statuses", () =>
    Effect.gen(function* () {
      const missing = yield* HttpClient.get(WorkbenchPaths.sessionStatuses)
      const authorized = yield* HttpClientRequest.get(WorkbenchPaths.sessionStatuses).pipe(
        HttpClientRequest.setHeader("authorization", basic("opencode", "secret")),
        HttpClient.execute,
      )

      expect(missing.status).toBe(401)
      expect(authorized.status).toBe(200)
    }),
  )

  it.live("returns a missing session summary as null without a directory or instance bootstrap", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(WorkbenchPaths.sessionSummary.replace(":sessionID", "ses_missing"))

      expect(response.status).toBe(200)
      expect(yield* response.json).toBeNull()
    }),
  )

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
