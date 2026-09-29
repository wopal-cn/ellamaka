import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpRouter } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Agent } from "../../src/agent/agent"
import { Command } from "../../src/command"
import { Format } from "../../src/format"
import { LSP } from "../../src/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Project } from "../../src/project/project"
import { InstanceLayer } from "../../src/project/instance-layer"
import { Vcs } from "../../src/project/vcs"
import { Rule } from "../../src/rule"
import { ServerAuth } from "../../src/server/auth"
import { InstanceApi } from "../../src/server/routes/instance/httpapi/groups/instance"
import { instanceHandlers } from "../../src/server/routes/instance/httpapi/handlers/instance"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { instanceContextLayer } from "../../src/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { workspaceRoutingLayer } from "../../src/server/routes/instance/httpapi/middleware/workspace-routing"
import { Session } from "../../src/session/session"
import { Skill } from "../../src/skill"
import { Tool } from "../../src/tool/tool"
import { ToolRegistry } from "../../src/tool/registry"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { workspaceLayerWithRuntimeFlags } from "../fixture/workspace"
import { testEffect } from "../lib/effect"

// Call-path probe: the discovery endpoints run against the real instance group
// handlers and middleware, but the domain services are doubles. Methods the
// discovery path must NOT touch (`Skill.available`, `ToolRegistry.tools`,
// `ToolRegistry.all`) are deliberately left unimplemented — any call dies and
// the request would fail with a non-200 instead of the expected payload.
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()).pipe(Effect.ignore))
  }),
)

const probeTool: Tool.Def = {
  id: "probe_tool",
  description: "Probe tool",
  parameters: Schema.Unknown,
  jsonSchema: {
    type: "object",
    properties: { probeArg: { type: "string" } },
  },
  execute: () => Effect.succeed({ title: "", metadata: {}, output: "" }),
}

const mockTools = Layer.mock(ToolRegistry.Service)({
  capabilityEntries: () => Effect.succeed([{ def: probeTool, source: "builtin" as const }]),
})

const mockRule = Layer.mock(Rule.Service)({
  all: () => Effect.succeed([{ name: "probe.md", source: "global" as const, location: "/probe.md" }]),
})

const mockMcp = Layer.mock(MCP.Service)({
  capabilityEntries: () => Effect.succeed([]),
})

// The production handlers are built against InstanceHttpApi's "instance" group.
// At runtime a group implementation is keyed by its group identifier alone, so
// a probe api with the same identifier consumes the real handler layer without
// any type erasure.
const ProbeApi = HttpApi.make("opencode-instance").add(InstanceApi.groups.instance)

const probeRoutes = HttpApiBuilder.layer(ProbeApi).pipe(
  Layer.provide(instanceHandlers),
  Layer.provide(instanceContextLayer),
  Layer.provide(workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))),
  Layer.provide(
    authorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer({ password: Option.none(), username: "opencode" }))),
  ),
  Layer.provide(schemaErrorLayer),
  Layer.provide(Layer.mock(Session.Service)({})),
  Layer.provide(mockTools),
  Layer.provide(mockRule),
  Layer.provide(mockMcp),
  Layer.provide(Layer.mock(Skill.Service)({})),
  Layer.provide(Layer.mock(Agent.Service)({})),
  Layer.provide(Layer.mock(Command.Service)({})),
  Layer.provide(Layer.mock(Format.Service)({})),
  Layer.provide(Layer.mock(LSP.Service)({})),
  Layer.provide(Layer.mock(Vcs.Service)({})),
)

const serve = () => HttpRouter.serve(probeRoutes, { disableListenLog: true, disableLogger: true }).pipe(Layer.build)

const it = testEffect(
  Layer.mergeAll(
    testStateLayer,
    NodeHttpServer.layerTest,
    NodeServices.layer,
    InstanceLayer.layer,
    Project.defaultLayer,
    workspaceLayerWithRuntimeFlags({ experimentalWorkspaces: true }),
  ),
)

describe("capability discovery call path", () => {
  it.live("serves /tool and /rule without calling runtime-filtered methods", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* serve()

      const tool = yield* HttpClient.get(`/tool?directory=${encodeURIComponent(dir)}`)
      expect(tool.status).toBe(200)
      expect(yield* tool.json).toEqual([
        {
          id: "probe_tool",
          description: "Probe tool",
          source: "builtin",
          parameters: [{ name: "probeArg", type: "string" }],
        },
      ])

      const rule = yield* HttpClient.get(`/rule?directory=${encodeURIComponent(dir)}`)
      expect(rule.status).toBe(200)
      expect(yield* rule.json).toEqual([{ name: "probe.md", source: "global", location: "/probe.md" }])
    }),
  )
})
