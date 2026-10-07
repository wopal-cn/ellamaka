import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { InternalHook } from "@/hook/internal-hook"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { ModelID, ProviderID } from "@/provider/schema"
import { SessionTools } from "@/session/tools"
import { MessageID, SessionID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    ToolRegistry.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    InternalHook.defaultLayer,
    MCP.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Truncate.defaultLayer,
  ),
)

const withHome = <A, E, R>(home: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = home
      return previous
    }),
    () => self,
    (previous) => Effect.sync(() => (process.env.OPENCODE_TEST_HOME = previous)),
  )

const resolveTools = (agentPermission: Permission.Rule[], sessionPermission: Permission.Rule[]) =>
  Effect.gen(function* () {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- this test exercises the permission path without constructing unrelated provider and session fields
    const input = {
      agent: { name: "build", mode: "primary", permission: agentPermission, options: {} },
      model: { providerID: "test", api: { id: "test-model" } },
      session: { id: SessionID.make("ses_permission"), permission: sessionPermission },
      processor: {
        message: { id: MessageID.make("msg_permission") },
        updateToolCall: () => Effect.void,
        completeToolCall: () => Effect.void,
      },
      bypassAgentCheck: false,
      messages: [],
      promptOps: {},
    } as unknown as Parameters<typeof SessionTools.resolve>[0]
    return yield* SessionTools.resolve(input)
  })

const skillTool = (tools: Record<string, unknown>) => {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the AI SDK tool surface is wider than the fields this test consumes
  return tools.skill as {
    description: string
    execute: (args: unknown, options: unknown) => Promise<{ output: string }>
  }
}

const invokeSkill = (tools: Record<string, unknown>, name: string) =>
  Effect.promise(async () => {
    const aiTool = skillTool(tools)
    return await aiTool.execute(
      { name },
      { toolCallId: "call_skill", abortSignal: new AbortController().signal, messages: [] },
    )
  })

describe("session-tools permission overlay", () => {
  it.instance("executes a skill only when the session overlay grants that skill", () =>
    provideTmpdirInstance(
      (dir) =>
        withHome(
          dir,
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Promise.all(
                ["session-a-skill", "session-b-skill"].map((name) =>
                  Bun.write(
                    path.join(dir, ".opencode", "skill", name, "SKILL.md"),
                    `---\nname: ${name}\ndescription: ${name}.\n---\n\n# ${name}\n`,
                  ),
                ),
              ),
            )

            const agentPermission: Permission.Rule[] = [{ permission: "skill", pattern: "*", action: "deny" }]
            const agent = { name: "build", mode: "primary" as const, permission: agentPermission, options: {} }
            const sessionA: Permission.Rule[] = [{ permission: "skill", pattern: "session-a-skill", action: "allow" }]
            const sessionB: Permission.Rule[] = [{ permission: "skill", pattern: "session-b-skill", action: "allow" }]

            const toolsA = yield* resolveTools(agentPermission, sessionA)
            const toolsB = yield* resolveTools(agentPermission, sessionB)
            const toolsWithoutOverlay = yield* resolveTools(agentPermission, [])

            expect(skillTool(toolsA).description).toContain("- **session-a-skill**: session-a-skill.")
            expect(skillTool(toolsA).description).not.toContain("- **session-b-skill**:")
            expect(skillTool(toolsB).description).toContain("- **session-b-skill**: session-b-skill.")
            expect(skillTool(toolsB).description).not.toContain("- **session-a-skill**:")
            expect(skillTool(toolsWithoutOverlay).description).toContain("No skills are currently available.")

            const registry = yield* ToolRegistry.Service
            const defaultCatalog = yield* registry.tools({
              providerID: ProviderID.opencode,
              modelID: ModelID.make("test"),
              agent,
            })
            const defaultSkillTool = defaultCatalog.find((tool) => tool.id === "skill")
            if (!defaultSkillTool) throw new Error("Skill tool missing from default registry catalog")
            expect(defaultSkillTool.description).toContain("No skills are currently available.")

            expect((yield* invokeSkill(toolsA, "session-a-skill")).output).toContain("# session-a-skill")
            expect((yield* invokeSkill(toolsB, "session-b-skill")).output).toContain("# session-b-skill")
            expect(yield* invokeSkill(toolsA, "session-b-skill").pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
            expect(yield* invokeSkill(toolsB, "session-a-skill").pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
            expect(yield* invokeSkill(toolsWithoutOverlay, "session-a-skill").pipe(Effect.exit)).toMatchObject({
              _tag: "Failure",
            })
          }),
        ),
      { git: true },
    ),
  )
})
