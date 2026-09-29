import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import * as InstanceState from "@/effect/instance-state"
import { Format } from "@/format"
import { Global } from "@wopal/ellamaka-core/global"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Vcs } from "@/project/vcs"
import { Rule } from "@/rule"
import { Skill } from "@/skill"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { isRecord } from "@/util/record"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ApiVcsApplyError, type ToolCapabilityInfo } from "../groups/instance"
import { markInstanceForDisposal } from "../lifecycle"

// Flat parameter summary for capability discovery: top-level names and types
// only, never the full JSON Schema body.
function parameterSummary(schema: unknown): Array<{ name: string; type: string }> | undefined {
  if (!isRecord(schema) || !isRecord(schema.properties)) return undefined
  const entries = Object.entries(schema.properties)
  if (entries.length === 0) return undefined
  return entries.map(([name, value]) => ({
    name,
    type: isRecord(value) && typeof value.type === "string" ? value.type : "unknown",
  }))
}

// Shared normalization for every tool source (registry builtin/custom and MCP
// server tools): metadata only, optional flat parameter summary.
function toolCapability(input: {
  id: string
  description: string
  source: ToolCapabilityInfo["source"]
  service?: string
  schema?: unknown
}): ToolCapabilityInfo {
  const parameters = parameterSummary(input.schema)
  return {
    id: input.id,
    description: input.description,
    source: input.source,
    ...(input.service === undefined ? {} : { service: input.service }),
    ...(parameters ? { parameters } : {}),
  }
}

export const instanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "instance", (handlers) =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const command = yield* Command.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const mcp = yield* MCP.Service
    const registry = yield* ToolRegistry.Service
    const rule = yield* Rule.Service
    const skill = yield* Skill.Service
    const vcs = yield* Vcs.Service

    const dispose = Effect.fn("InstanceHttpApi.dispose")(function* () {
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    const getPath = Effect.fn("InstanceHttpApi.path")(function* () {
      const ctx = yield* InstanceState.context
      return {
        home: Global.Path.home,
        state: Global.Path.state,
        config: Global.Path.config,
        wopalHome: Global.Path.wopalHome,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }
    })

    const getVcs = Effect.fn("InstanceHttpApi.vcs")(function* () {
      const [branch, default_branch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], {
        concurrency: "unbounded",
      })
      return { branch, default_branch }
    })

    const getVcsStatus = Effect.fn("InstanceHttpApi.vcsStatus")(function* () {
      return yield* vcs.status()
    })

    const getVcsDiff = Effect.fn("InstanceHttpApi.vcsDiff")(function* (ctx: {
      query: { mode: Vcs.Mode; context?: number }
    }) {
      return yield* vcs.diff(ctx.query.mode, { context: ctx.query.context })
    })

    const getVcsDiffRaw = Effect.fn("InstanceHttpApi.vcsDiffRaw")(function* () {
      return yield* vcs.diffRaw()
    })

    const applyVcs = Effect.fn("InstanceHttpApi.vcsApply")(function* (ctx: { payload: Vcs.ApplyInput }) {
      return yield* vcs.apply(ctx.payload).pipe(
        Effect.mapError(
          (error) =>
            new ApiVcsApplyError({
              name: "VcsApplyError",
              data: {
                message: error.message,
                reason: error.reason,
              },
            }),
        ),
      )
    })

    const getCommand = Effect.fn("InstanceHttpApi.command")(function* () {
      return yield* command.list()
    })

    const getAgent = Effect.fn("InstanceHttpApi.agent")(function* () {
      return yield* agent.list()
    })

    const getSkill = Effect.fn("InstanceHttpApi.skill")(function* () {
      return yield* skill.all()
    })

    const getRule = Effect.fn("InstanceHttpApi.rule")(function* () {
      return yield* rule.all()
    })

    // Discovery merge: the complete static registry (builtin + custom) plus
    // connected MCP servers. No agent/model input and no runtime filtering.
    const getTool = Effect.fn("InstanceHttpApi.tool")(function* () {
      const [registered, mcpEntries] = yield* Effect.all([registry.capabilityEntries(), mcp.capabilityEntries()], {
        concurrency: "unbounded",
      })
      return [
        ...registered.map(({ def, source }) =>
          toolCapability({
            id: def.id,
            description: def.description,
            source,
            schema: ToolJsonSchema.fromTool(def),
          }),
        ),
        ...mcpEntries.map((entry) =>
          toolCapability({
            id: entry.id,
            description: entry.description ?? "",
            source: "mcp",
            service: entry.service,
            schema: entry.inputSchema,
          }),
        ),
      ]
    })

    const getLsp = Effect.fn("InstanceHttpApi.lsp")(function* () {
      return yield* lsp.status()
    })

    const getFormatter = Effect.fn("InstanceHttpApi.formatter")(function* () {
      return yield* format.status()
    })

    return handlers
      .handle("dispose", dispose)
      .handle("path", getPath)
      .handle("vcs", getVcs)
      .handle("vcsStatus", getVcsStatus)
      .handle("vcsDiff", getVcsDiff)
      .handle("vcsDiffRaw", getVcsDiffRaw)
      .handle("vcsApply", applyVcs)
      .handle("command", getCommand)
      .handle("agent", getAgent)
      .handle("skill", getSkill)
      .handle("rule", getRule)
      .handle("tool", getTool)
      .handle("lsp", getLsp)
      .handle("formatter", getFormatter)
  }),
)
