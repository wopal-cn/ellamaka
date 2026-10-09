import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { ModelID } from "@/provider/schema"
import { Plugin } from "@/plugin"
import { InternalHook } from "@/hook/internal-hook"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Effect } from "effect"
import { MessageV2 } from "./message-v2"
import * as Session from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import * as Log from "@wopal/ellamaka-core/util/log"
import { EffectBridge } from "@/effect/bridge"
import { isRecord } from "@/util/record"

const log = Log.create({ service: "session.tools" })

/**
 * Extract the file paths a tool call touched, for the `FileOpEvent` published
 * to internal hook observers. Sources:
 * - read/write/edit: `args.filePath` (identical for native and DSH-projected
 *   tools — the adapter maps container snake_case arguments to camelCase);
 * - str_replace_editor: `args.path`;
 * - apply_patch: `result.metadata.files` entries, `movePath ?? filePath`,
 *   skipping deletes;
 * - everything else: empty (the event is still published).
 */
export function extractFilePaths(toolId: string, args: Record<string, unknown>, result: Tool.ExecuteResult): string[] {
  switch (toolId) {
    case "read":
    case "write":
    case "edit": {
      const filePath = args["filePath"]
      return typeof filePath === "string" && filePath.length > 0 ? [filePath] : []
    }
    case "str_replace_editor": {
      const filePath = args["path"]
      return typeof filePath === "string" && filePath.length > 0 ? [filePath] : []
    }
    case "apply_patch": {
      const files = (result.metadata as { files?: unknown }).files
      if (!Array.isArray(files)) return []
      const paths: string[] = []
      for (const entry of files) {
        if (!isRecord(entry)) continue
        if (entry["type"] === "delete") continue
        const movePath = entry["movePath"]
        const target = typeof movePath === "string" && movePath.length > 0 ? movePath : entry["filePath"]
        if (typeof target === "string" && target.length > 0) paths.push(target)
      }
      return paths
    }
    default:
      return []
  }
}

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: MessageV2.WithParts[]
  promptOps: TaskPromptOps
  // Per-message dsh sandbox mode from the latest user message (composer
  // selector). Undefined falls back to the space-level default in the adapter.
  sandboxMode?: "read-only" | "workspace-write" | "full-access"
}) {
  const resolveStart = Date.now()
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service
  const internalHook = yield* InternalHook.Service

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: {
      model: input.model,
      bypassAgentCheck: input.bypassAgentCheck,
      promptOps: input.promptOps,
      ...(input.sandboxMode ? { sandboxMode: input.sandboxMode } : {}),
    },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: { start: Date.now() },
          },
        }
      }),
    ask: (req) =>
      Effect.gen(function* () {
        const runtime = { rules: [] as Permission.Rule[] }
        yield* plugin.trigger(
          "experimental.permission.rules",
          {
            sessionID: input.session.id,
            agent: input.agent.name,
            permission: req.permission,
            patterns: req.patterns,
          },
          runtime,
        )
        yield* permission.ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? [], runtime.rules),
        })
      }).pipe(Effect.orDie),
  })

  for (const item of yield* registry.tools({
    modelID: ModelID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
    sessionPermission: input.session.permission,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            const result = yield* item.execute(args, ctx)
            // Publish the file operation before building the final output:
            // observers (write class) may augment `result`, and the
            // augmentation flows into `output` below. Also before
            // `tool.execute.after`, so external plugins see the final result.
            yield* internalHook.emit({
              toolId: item.id,
              args,
              filePaths: extractFilePaths(item.id, args, result),
              result,
              sessionID: ctx.sessionID,
            })
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
              output,
            )
            if (options.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(options.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  for (const [key, item] of Object.entries(yield* mcp.tools())) {
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, schema)
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts)
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            return yield* Effect.promise(() => execute(args, opts))
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
          )
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )

          const textParts: string[] = []
          const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) textParts.push(resource.text)
              if (resource.blob) {
                attachments.push({
                  type: "file",
                  mime: resource.mimeType ?? "application/octet-stream",
                  url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
          const metadata = {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          }

          const output = {
            title: "",
            metadata,
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
          }
          if (opts.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(opts.toolCallId, output)
          }
          return output
        }),
      )
    tools[key] = item
  }

  log.debug("resolveTools", { status: "completed", duration: Date.now() - resolveStart })
  return tools
})

export * as SessionTools from "./tools"
