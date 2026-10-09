import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Schema } from "effect"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { InternalHook } from "@/hook/internal-hook"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { MessageID, SessionID } from "@/session/schema"
import { SessionTools } from "@/session/tools"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

let runtimeRules: Permission.Rule[] = []
let runtimeHookError: Error | undefined
let runtimeHookCalls: Array<{ sessionID: string; agent: string; permission: string; patterns: string[] }> = []

const pluginLayer = Layer.mock(Plugin.Service)({
  trigger: (name, input, output) =>
    Effect.sync(() => {
      if (name !== "experimental.permission.rules") return output
      if (runtimeHookError) throw runtimeHookError
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generic Plugin.Service mock narrows only the contract fields this hook test consumes
      const request = input as { sessionID: string; agent: string; permission: string; patterns: string[] }
      runtimeHookCalls.push(request)
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- generic Plugin.Service mock narrows only the runtime rules output for this hook
      const result = output as { rules: Permission.Rule[] }
      result.rules.push(...runtimeRules)
      return output
    }),
})

const probeParameters = Schema.Struct({ pattern: Schema.String })

const probeTool: Tool.Def<typeof probeParameters> = {
  id: "probe",
  description: "permission probe",
  parameters: probeParameters,
  jsonSchema: {
    type: "object",
    properties: { pattern: { type: "string" } },
    required: ["pattern"],
    additionalProperties: false,
  },
  execute: (args, ctx) =>
    Effect.gen(function* () {
      yield* ctx.ask({ permission: "probe", patterns: [args.pattern], always: [args.pattern], metadata: {} })
      return { title: "probe", metadata: {}, output: "allowed" }
    }),
}

const registryLayer = Layer.mock(ToolRegistry.Service)({
  tools: () => Effect.succeed([probeTool]),
})

const mcpLayer = Layer.mock(MCP.Service)({
  tools: () => Effect.succeed({}),
})

const truncateLayer = Layer.mock(Truncate.Service)({
  output: (text: string) => Effect.succeed({ content: text, truncated: false } as Truncate.Result),
})

const it = testEffect(
  Layer.mergeAll(
    registryLayer,
    CrossSpawnSpawner.defaultLayer,
    InternalHook.defaultLayer,
    mcpLayer,
    Permission.defaultLayer,
    pluginLayer,
    truncateLayer,
  ),
)

beforeEach(() => {
  runtimeRules = []
  runtimeHookError = undefined
  runtimeHookCalls = []
})

afterEach(async () => {
  await disposeAllInstances()
})

const resolveTools = (
  sessionID: string,
  agentPermission: Permission.Rule[],
  sessionPermission: Permission.Rule[] = [],
) =>
  Effect.gen(function* () {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- structural SessionTools fixture omits unrelated provider/session fields
    const input = {
      agent: { name: "build", mode: "primary", permission: agentPermission, options: {} },
      model: { providerID: "test", api: { id: "test-model" } },
      session: { id: SessionID.make(sessionID), permission: sessionPermission },
      processor: {
        message: { id: MessageID.make(`msg_${sessionID}`) },
        updateToolCall: () => Effect.void,
        completeToolCall: () => Effect.void,
      },
      bypassAgentCheck: false,
      messages: [],
      promptOps: {},
    } as unknown as Parameters<typeof SessionTools.resolve>[0]
    return yield* SessionTools.resolve(input)
  })

const invokeProbe = (tools: Record<string, unknown>, pattern: string) =>
  Effect.promise(async () => {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- AI SDK tool surface is wider than the execute shape used by this fixture
    const probe = tools.probe as {
      execute: (args: { pattern: string }, options: unknown) => Promise<{ output: string }>
    }
    return await probe.execute(
      { pattern },
      { toolCallId: `call_${pattern}`, abortSignal: new AbortController().signal, messages: [] },
    )
  })

const seedApproved = (pattern: string) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* permission
      .ask({
        sessionID: SessionID.make("ses_seed"),
        permission: "probe",
        patterns: [pattern],
        always: [pattern],
        metadata: {},
        ruleset: [{ permission: "probe", pattern, action: "ask" }],
      })
      .pipe(Effect.forkChild)
    const request = yield* pollWithTimeout(
      Effect.gen(function* () {
        const list = yield* permission.list()
        return list[0]
      }),
      "permission request was not published",
    )
    yield* permission.reply({ requestID: request.id, reply: "always" })
    yield* Fiber.join(fiber)
  })

describe("session-tools runtime permission hook", () => {
  it.instance("preserves Agent + Session behavior when the hook contributes no rules", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools(
        "ses_no_hook",
        [{ permission: "probe", pattern: "*", action: "allow" }],
        [{ permission: "probe", pattern: "blocked", action: "deny" }],
      )

      expect((yield* invokeProbe(tools, "open")).output).toBe("allowed")
      expect(yield* invokeProbe(tools, "blocked").pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
    }),
  )

  it.instance("appends runtime allow after Agent and Session rules and isolates pattern/session", () =>
    Effect.gen(function* () {
      runtimeRules = [{ permission: "probe", pattern: "target", action: "allow" }]
      const denied = [{ permission: "probe", pattern: "*", action: "deny" }] satisfies Permission.Rule[]
      const toolsA = yield* resolveTools("ses_a", denied)

      expect((yield* invokeProbe(toolsA, "target")).output).toBe("allowed")
      expect(yield* invokeProbe(toolsA, "other").pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
      expect(runtimeHookCalls.map((call) => [call.sessionID, call.permission, call.patterns])).toEqual([
        ["ses_a", "probe", ["target"]],
        ["ses_a", "probe", ["other"]],
      ])

      runtimeRules = []
      const toolsB = yield* resolveTools("ses_b", denied)
      expect(yield* invokeProbe(toolsB, "target").pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
    }),
  )

  it.instance("recomputes runtime rules for every ask without persistence", () =>
    Effect.gen(function* () {
      const denied = [{ permission: "probe", pattern: "*", action: "deny" }] satisfies Permission.Rule[]
      const tools = yield* resolveTools("ses_recompute", denied)

      runtimeRules = [{ permission: "probe", pattern: "target", action: "allow" }]
      expect((yield* invokeProbe(tools, "target")).output).toBe("allowed")

      runtimeRules = []
      expect(yield* invokeProbe(tools, "target").pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
      expect(runtimeHookCalls).toHaveLength(2)
    }),
  )

  it.instance("feeds runtime deny and ask into the existing evaluator", () =>
    Effect.gen(function* () {
      const allowed = [{ permission: "probe", pattern: "*", action: "allow" }] satisfies Permission.Rule[]
      const tools = yield* resolveTools("ses_actions", allowed)

      runtimeRules = [{ permission: "probe", pattern: "deny-me", action: "deny" }]
      expect(yield* invokeProbe(tools, "deny-me").pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })

      runtimeRules = [{ permission: "probe", pattern: "ask-me", action: "ask" }]
      const fiber = yield* invokeProbe(tools, "ask-me").pipe(Effect.forkChild)
      const permission = yield* Permission.Service
      const request = yield* pollWithTimeout(
        Effect.gen(function* () {
          const list = yield* permission.list()
          return list.find((item) => item.patterns.includes("ask-me"))
        }),
        "runtime ask did not reach the permission service",
      )
      yield* permission.reply({ requestID: request.id, reply: "once" })
      expect((yield* Fiber.join(fiber)).output).toBe("allowed")
    }),
  )

  it.instance("fails the current tool call when the runtime hook throws", () =>
    Effect.gen(function* () {
      runtimeHookError = new Error("runtime hook failed")
      const tools = yield* resolveTools("ses_error", [{ permission: "probe", pattern: "*", action: "allow" }])

      const exit = yield* invokeProbe(tools, "target").pipe(Effect.exit)
      expect(exit).toMatchObject({ _tag: "Failure" })
    }),
  )

  it.instance("keeps the project approved pool after runtime rules in precedence", () =>
    Effect.gen(function* () {
      yield* seedApproved("target")
      runtimeRules = [{ permission: "probe", pattern: "target", action: "deny" }]
      const tools = yield* resolveTools("ses_approved", [{ permission: "probe", pattern: "*", action: "allow" }])

      expect((yield* invokeProbe(tools, "target")).output).toBe("allowed")
      expect(runtimeHookCalls).toHaveLength(1)
    }),
  )
})
