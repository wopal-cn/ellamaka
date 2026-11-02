import { NodeHttpServer } from "@effect/platform-node"
import { afterEach, describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { Session } from "../../src/session/session"
import { ServerAuth } from "../../src/server/auth"
import { SessionProjection } from "../../src/workbench/session-projection"
import { SessionStatus } from "../../src/session/status"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { layer as workbenchDshUrlLayer } from "../../src/workbench/dsh-url"
import { setDshStatus } from "../../src/workbench/dsh-status"
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

const apiLayer = HttpRouter.serve(
  Layer.mergeAll(
    HttpApiBuilder.layer(RootHttpApi).pipe(
      Layer.provide([controlHandlers, globalHandlers, wopalSpaceHandlers]),
      Layer.provide(WopalSpaceHostService.layer),
      Layer.provide(SetupHostService.layer.pipe(Layer.provide(WopalSpaceHostService.layer))),
    ),
    // The Official App BFF is a private composition served on the same router.
    HttpApiBuilder.layer(AppBffRootApi).pipe(Layer.provide(workbenchHandlers)),
  ).pipe(Layer.provide([authorizationLayer, schemaErrorLayer])),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
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
  Layer.provide(ServerAuth.Config.layer({ password: Option.none(), username: "opencode" })),
  Layer.provide(SessionProjection.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(workbenchDshUrlLayer),
  // Effect's empty context is intentionally widened to close the test-only
  // layer graph; no runtime service is supplied by this cast.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  Layer.provide(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
)
const it = testEffect(apiLayer)

// `setDshStatus` mutates the process-wide holder; restore the safe default so
// later files (e.g. httpapi-sdk's health assertion) see the pristine state.
afterEach(() => {
  setDshStatus("web", "disabled")
  setDshStatus("tools", "disabled")
})

describe("global health dsh field", () => {
  it.live("reports the dsh runtime status (disabled before any mount)", () =>
    Effect.gen(function* () {
      setDshStatus("web", "disabled")
      setDshStatus("tools", "ready")
      const response = yield* HttpClient.get(GlobalPaths.health)
      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({ dsh: { web: "disabled", tools: "ready" } })
    }),
  )

  it.live("reports ready once the runtime manager publishes it", () =>
    Effect.gen(function* () {
      setDshStatus("web", "ready")
      setDshStatus("tools", "degraded")
      const response = yield* HttpClient.get(GlobalPaths.health)
      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({ dsh: { web: "ready", tools: "degraded" } })
    }),
  )
})
