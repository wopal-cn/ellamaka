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
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { Instruction } from "./instruction"
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
  // Snapshot of the text the model actually received for this step. The caller
  // owns it because this resolve runs before the messages transform hook; the
  // getter is read when a tool executes, after that hook produced the request.
  // Returning undefined means nothing is known to be visible yet.
  instructionVisibility?: () => Instruction.Visibility | undefined
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
  const instruction = yield* Instruction.Service
  const filesystem = yield* AppFileSystem.Service

  // Freeze the caller-supplied snapshot on the first tool execution of this
  // batch. Tools resolve before the message transform hook runs, so the value
  // cannot be read here; every call in the batch then reuses one baseline.
  let batchVisibility: Instruction.Visibility | undefined
  let batchVisibilityRead = false
  const visibilityForBatch = () => {
    if (!batchVisibilityRead) {
      batchVisibilityRead = true
      batchVisibility = input.instructionVisibility?.()
    }
    return batchVisibility
  }
  // Track rule files whose full body has already been attached to a tool result
  // in this batch. This deduplicates duplicate reminders across parallel calls
  // without changing batch-start visibility for preflight modification checks.
  const batchAttached = new Set<string>()
  const claimForBatch = (items: readonly Instruction.DirectoryInstruction[]) => {
    const fresh: Instruction.DirectoryInstruction[] = []
    for (const item of items) {
      if (batchAttached.has(item.filepath)) continue
      batchAttached.add(item.filepath)
      fresh.push(item)
    }
    return fresh
  }

  const argumentPath = (args: Record<string, unknown>, key: string) => {
    const value = args[key]
    return typeof value === "string" && value.length > 0 ? value : undefined
  }

  // Reads attach rules after the fact; modifications must prove them first.
  const readTarget = (toolId: string, args: Record<string, unknown>) =>
    toolId === "read"
      ? argumentPath(args, "filePath")
      : toolId === "str_replace_editor" && args["command"] === "view"
        ? argumentPath(args, "path")
        : undefined

  const modificationTarget = (toolId: string, args: Record<string, unknown>) => {
    if (toolId === "write" || toolId === "edit") return argumentPath(args, "filePath")
    // str_replace_editor view is a read; every other command writes.
    if (toolId === "str_replace_editor" && args["command"] !== "view") return argumentPath(args, "path")
    return undefined
  }

  // Directory rules are a session-layer concern: the native read and the
  // DSH-projected read/view both get them here, so no tool backend owns it.
  const withDirectoryInstructions = Effect.fnUntraced(function* (
    toolId: string,
    args: Record<string, unknown>,
    result: Tool.ExecuteResult,
  ) {
    const target = readTarget(toolId, args)
    if (!target) return result
    // Nothing is known to be visible only when the caller supplied a getter that
    // produced no snapshot; mounting the rules again is the safe direction.
    const visibility = input.instructionVisibility
      ? (visibilityForBatch() ?? { text: [] })
      : instruction.snapshot(input.messages)
    // A read that already succeeded stays successful. Rule discovery is a
    // side channel here, so a lookup failure only means the rules are missing
    // from this result for now.
    // Only typed lookup failures are absorbed; defects still surface so real
    // bugs are not hidden behind a silently successful read.
    const resolution = yield* instruction.inspect({ filepath: target, visibility }).pipe(
      Effect.catch(() => {
        log.warn("directory instructions lookup failed", { tool: toolId })
        return Effect.succeed(undefined)
      }),
    )
    if (!resolution) return result
    if (resolution.errors.length > 0) {
      // Count only: rule paths and contents never belong in logs.
      log.warn("directory instructions unavailable", { tool: toolId, unreadable: resolution.errors.length })
    }
    // A directory listing reports entries only; it has no file to scope rules to.
    const directory = yield* filesystem.isDir(resolution.target).pipe(Effect.orElseSucceed(() => false))
    if (directory) return { ...result, metadata: { ...result.metadata, loaded: [] } }

    // Transitional: the native read still attaches rules itself before the
    // wrapper took over attachment. Append only what this result lacks.
    const alreadyInOutput = resolution.attach.filter((item) =>
      Instruction.containsInstruction(result.output, item.filepath),
    )
    for (const item of alreadyInOutput) batchAttached.add(item.filepath)
    const missing = claimForBatch(
      resolution.attach.filter((item) => !Instruction.containsInstruction(result.output, item.filepath)),
    )
    const current = result.metadata?.["loaded"]
    const existing = Array.isArray(current) ? current.filter((item): item is string => typeof item === "string") : []
    const loaded = [...new Set([...existing, ...missing.map((item) => item.filepath)])]
    const output =
      missing.length === 0
        ? result.output
        : result.output +
          "\n\n<system-reminder>\n" +
          missing.map((item) => item.formatted).join("\n\n") +
          "\n</system-reminder>"
    return { ...result, output, metadata: { ...result.metadata, loaded } }
  })

  // A suspended modification is not an executed file operation: it returns the
  // rules and a retry instruction, and the pipeline must not treat it as a write
  // (no FileOpEvent, no diagnostics backfill, no underlying tool call).
  const suspended = (result: Tool.ExecuteResult, resolution: Instruction.Resolution): Tool.ExecuteResult => {
    const fresh = claimForBatch(resolution.attach)
    return {
      ...result,
      title: result.title || "Instructions required",
      metadata: { ...result.metadata, loaded: fresh.map((item) => item.filepath) },
      output:
        fresh.length > 0
          ? "File not modified. Instructions loaded below (no read needed); follow them and retry.\n\n" +
            fresh.map((item) => item.reminder).join("\n\n")
          : "File not modified. Instructions already attached in this batch (no read needed); follow them and retry.",
    }
  }

  const preflightModification = Effect.fnUntraced(function* (
    toolId: string,
    args: Record<string, unknown>,
  ): Effect.fn.Return<Tool.ExecuteResult | undefined> {
    const target = modificationTarget(toolId, args)
    if (!target) return undefined
    const visibility = input.instructionVisibility
      ? (visibilityForBatch() ?? { text: [] })
      : instruction.snapshot(input.messages)
    const resolution = yield* instruction.inspect({ filepath: target, visibility, operation: "modify" }).pipe(
      Effect.catch(() => {
        log.warn("directory instructions lookup failed", { tool: toolId })
        return Effect.succeed(undefined)
      }),
    )
    // Fail closed: an unreadable applicable rule must stop the write, and a
    // lookup we could not complete gives us no reason to believe it is safe.
    if (!resolution) {
      return {
        title: "Instructions unavailable",
        metadata: { loaded: [] as string[] },
        output:
          "File not modified. Instructions for this location could not be loaded, so the change was not applied. Retry once that succeeds.",
      }
    }
    if (resolution.errors.length > 0) {
      log.warn("directory instructions unavailable", { tool: toolId, unreadable: resolution.errors.length })
      return {
        title: "Instructions unavailable",
        metadata: { loaded: [] as string[] },
        output:
          "File not modified. Instructions for this location exist but could not be read, so the change was not applied. Resolve that and retry.",
      }
    }
    if (resolution.attach.length === 0) return undefined
    return suspended({ title: "", metadata: {}, output: "" }, resolution)
  })

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
            const blocked = yield* preflightModification(item.id, args)
            const raw = blocked ?? (yield* item.execute(args, ctx))
            const result = yield* withDirectoryInstructions(item.id, args, raw)
            // Publish the file operation before building the final output:
            // observers (write class) may augment `result`, and the
            // augmentation flows into `output` below. Also before
            // `tool.execute.after`, so external plugins see the final result.
            // A suspended modification touched nothing, so publishing a file
            // operation for it would tell observers a write happened.
            if (!blocked)
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
