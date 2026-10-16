import path from "node:path"
import { AsyncLocalStorage } from "node:async_hooks"
import { createTwoFilesPatch, diffLines } from "diff"
import {
  tool,
  type Hooks,
  type PluginInput,
  type PluginOptions,
  type ToolContext,
  type ToolDefinition,
} from "@wopal/ellamaka-plugin"
import { waitForDshToolsInitialization } from "./host.js"
export { trackDshToolsInitialization } from "./host.js"

const z = tool.schema
type ZodType = InstanceType<typeof z.ZodType>
export class DshAdapterError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`dsh-adapter: ${message}`, options)
    this.name = "DshAdapterError"
  }
}

const configSchema = z.object({
  sandbox: z.object({ enabled: z.boolean(), mode: z.enum(["read-only", "workspace-write"]).optional() }).optional(),
  escalation: z.enum(["ask", "never"]).optional(),
})
export type DshAdapterConfig = ReturnType<typeof configSchema.parse>
export type DshAdapterOptions = DshAdapterConfig

type Event = Readonly<{ type: string; seq: number; time: number; data: unknown }>
type Facade = {
  header: { id: string; cwd: string }
  readonly seq: number
  inheritedEventCount: number
  eventAt(seq: number): Event | undefined
  snapshotEvents(from?: number, to?: number): readonly Event[]
  append(type: string, data: unknown): Event
  turnDepth: number
}
type Approval = { agent?: { session?: Facade }; reason?: string; toolName?: string; callId?: string }
type ToolSchema = { name: string; description: string; parameters: JsonSchema }
type Result = {
  isError: boolean
  content?: { type: string; text?: string }[]
  error?: { message?: string }
  value?: unknown
  meta?: unknown
}
type Container = {
  get(name: "tools"): { schemas(): ToolSchema[]; execute(call: unknown): Promise<Result> } | undefined
  logger(name: string): { error(message: string, extra?: unknown): void }
  on(event: "approval/request", handler: (request: Approval, next: () => unknown) => unknown): () => void
}

const names = ["bash", "edit", "glob", "grep", "read", "str_replace_editor", "write"]
const camel: Record<string, string> = { file_path: "filePath", old_string: "oldString", new_string: "newString" }
const snake = Object.fromEntries(Object.entries(camel).map(([a, b]) => [b, a]))
type JsonSchema = {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  oneOf?: JsonSchema[]
  anyOf?: JsonSchema[]
  enum?: unknown[]
  const?: unknown
  description?: string
}

function shape(node: JsonSchema, rename = false): Record<string, ZodType> {
  return Object.fromEntries(
    Object.entries(node.properties ?? {}).map(([name, value]) => {
      let type = schema(value)
      if (!node.required?.includes(name)) type = type.optional()
      if (value.description) type = type.describe(value.description)
      return [rename ? (camel[name] ?? name) : name, type]
    }),
  )
}

function schema(node: JsonSchema): ZodType {
  const branches = node.oneOf ?? node.anyOf
  if (branches?.length) {
    const types = branches.map(schema)
    return types.length === 1 ? types[0] : z.union([types[0], types[1], ...types.slice(2)])
  }
  const values = node.enum ?? (Object.hasOwn(node, "const") ? [node.const] : undefined)
  if (
    values?.length &&
    values.every(
      (value): value is string | number | boolean | null =>
        value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean",
    )
  ) {
    const types = values.map((value) => z.literal(value))
    return types.length === 1 ? types[0] : z.union([types[0], types[1], ...types.slice(2)])
  }
  switch (node.type) {
    case "null":
      return z.null()
    case "string":
      return z.string()
    case "number":
      return z.number()
    case "integer":
      return z.number().int()
    case "boolean":
      return z.boolean()
    case "array":
      return z.array(node.items ? schema(node.items) : z.unknown())
    case "object":
      return node.properties ? z.object(shape(node)) : z.record(z.string(), z.unknown())
    default:
      return z.unknown()
  }
}

function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child)
    Object.freeze(value)
  }
  return value
}

function facade(id: string, cwd: string, mode: string, escalation: string): Facade {
  const events: Event[] = []
  const session: Facade = {
    header: { id, cwd },
    inheritedEventCount: 0,
    turnDepth: 0,
    get seq() {
      return events.length
    },
    eventAt: (seq) => events[seq],
    snapshotEvents: (from = 0, to = events.length) => Object.freeze(events.slice(from, to)),
    append(type, data) {
      const event = frozen({ type, seq: events.length, time: Date.now(), data: structuredClone(data) })
      events.push(event)
      return event
    },
  }
  session.append("sandbox/mode", { mode })
  if (escalation === "never") session.append("approval/policy", { policy: "never" })
  return session
}

function inside(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

async function permission(name: string, args: Record<string, unknown>, ctx: ToolContext) {
  if (name === "bash") {
    if (typeof args.command === "string")
      await ctx.ask({ permission: "bash", patterns: [args.command], always: [args.command], metadata: {} })
    return
  }
  const search = name === "grep" || name === "glob"
  if (search) {
    await ctx.ask({
      permission: name,
      patterns: [typeof args.pattern === "string" ? args.pattern : "*"],
      always: ["*"],
      metadata: { pattern: args.pattern, path: args.path, include: args.include },
    })
  }
  const file = search ? (args.path ?? ctx.directory) : name === "str_replace_editor" ? args.path : args.file_path
  if (typeof file !== "string") return
  const action =
    name === "read" || (name === "str_replace_editor" && args.command === "view")
      ? "read"
      : ["write", "edit", "str_replace_editor"].includes(name)
        ? "edit"
        : undefined
  if (!action && !search) return
  const filepath = path.resolve(ctx.directory, file)
  if (!inside(ctx.directory, filepath) && !(ctx.worktree !== "/" && inside(ctx.worktree, filepath))) {
    const parentDir = search ? filepath : path.dirname(filepath)
    const pattern = path.join(parentDir, "*").replaceAll("\\", "/")
    await ctx.ask({
      permission: "external_directory",
      patterns: [pattern],
      always: [pattern],
      metadata: { filepath, parentDir },
    })
  }
  if (action)
    await ctx.ask({
      permission: action,
      patterns: [path.relative(ctx.worktree, filepath).replaceAll("\\", "/")],
      always: ["*"],
      metadata: {},
    })
}

function isContainer(value: unknown): value is Container {
  return (
    record(value) &&
    typeof value.get === "function" &&
    typeof value.on === "function" &&
    typeof value.logger === "function"
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function trimDiff(patch: string) {
  const content = (line: string) => /^[ +-]/.test(line) && !line.startsWith("---") && !line.startsWith("+++")
  const lines = patch.split("\n")
  const sizes = lines
    .filter(content)
    .map((line) => line.slice(1))
    .filter((line) => line.trim())
    .map((line) => /^\s*/.exec(line)![0].length)
  const indent = Math.min(...sizes)
  return !Number.isFinite(indent) || indent === 0
    ? patch
    : lines.map((line) => (content(line) ? line[0] + line.slice(1 + indent) : line)).join("\n")
}

function fileDiff(file: string, before: string, after: string) {
  if (before.length + after.length > 2_000_000) return undefined
  const changes = diffLines(before, after, { timeout: 100 })
  if (!changes) return undefined
  return {
    file,
    before,
    after,
    additions: changes.filter((item) => item.added).reduce((n, item) => n + item.count, 0),
    deletions: changes.filter((item) => item.removed).reduce((n, item) => n + item.count, 0),
  }
}

function metadata(name: string, dispatch: string, result: Result): Record<string, unknown> {
  const output: Record<string, unknown> = { source: "dsh-container", containerTool: dispatch }
  const value = result.value
  if (
    name === "edit" &&
    record(value) &&
    typeof value.path === "string" &&
    typeof value.before === "string" &&
    typeof value.after === "string"
  ) {
    const change = fileDiff(value.path, value.before, value.after)
    if (change && value.before !== value.after) {
      const patch = createTwoFilesPatch(value.path, value.path, value.before, value.after, undefined, undefined, {
        timeout: 100,
      })
      if (patch) {
        output.filediff = change
        output.diff = trimDiff(patch)
        return output
      }
    }
  }
  const diffs = record(result.meta) ? result.meta.diffs : undefined
  if (!Array.isArray(diffs) || !diffs.length) return output
  const parts = diffs.map((item: unknown) =>
    record(item) &&
    typeof item.path === "string" &&
    (item.oldText === null || typeof item.oldText === "string") &&
    typeof item.newText === "string"
      ? fileDiff(item.path, item.oldText ?? "", item.newText)
      : undefined,
  )
  if (parts.some((item) => !item)) return output
  const valid = parts.filter((item) => item !== undefined)
  output.filediff = {
    file: valid[0].file,
    before: valid.map((item) => item.before).join("\n"),
    after: valid.map((item) => item.after).join("\n"),
    additions: valid.reduce((n, item) => n + item.additions, 0),
    deletions: valid.reduce((n, item) => n + item.deletions, 0),
  }
  return output
}

/** Product-owned plugin; each invocation owns only its directory's call facade. */
export async function dshAdapter(
  input: Pick<PluginInput, "directory" | "worktree" | "pluginConfig">,
  inline?: PluginOptions,
): Promise<Hooks> {
  if (process.env.ELLAMAKA_DSH?.toLowerCase() === "0") return {}
  const configured = input.pluginConfig?.["dsh-adapter"]
  const parsed = configSchema.safeParse(configured !== undefined ? configured : (inline ?? {}))
  if (!parsed.success)
    throw new DshAdapterError(
      `config validation failed: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    )
  if (!parsed.data.sandbox?.enabled) return {}
  try {
    await waitForDshToolsInitialization()
  } catch (cause) {
    throw new DshAdapterError("host initialization failed", { cause })
  }
  const candidate: unknown = (globalThis as Record<string, unknown>).__ellamakaDshContainer
  if (!isContainer(candidate)) throw new DshAdapterError("required tool container is unavailable")
  const container = candidate
  const mode = parsed.data.sandbox.mode ?? "workspace-write"
  const sessions = new Map<string, Facade>()
  // The async call scope is shared by nested approval events, not by concurrent
  // executions with the same session id. No retained ask survives a call.
  const calls = new AsyncLocalStorage<{ session: Facade; ctx?: ToolContext }>()
  let disposed = false
  const off = container.on("approval/request", async (request, next) => {
    const call = calls.getStore()
    const ctx = call?.ctx
    if (!call || !ctx || disposed || request.agent?.session !== call.session) return next()
    ctx.abort.throwIfAborted()
    const targetMode = /^escalate sandbox to ([a-z-]+):/.exec(request.reason ?? "")?.[1]
    try {
      await ctx.ask({
        permission: "sandbox_escalation",
        patterns: [targetMode ?? "escalation"],
        always: [targetMode ?? "escalation"],
        metadata: { tool: request.toolName, callID: request.callId, justification: request.reason, targetMode },
      })
      ctx.abort.throwIfAborted()
      if (disposed || !call.ctx) throw new DshAdapterError("approval call is no longer active")
      return "allowed-once"
    } catch (error) {
      if (record(error) && (error.name === "PermissionRejectedError" || error.name === "PermissionCorrectedError"))
        return "rejected"
      throw error
    }
  })
  function live() {
    if (disposed || (globalThis as Record<string, unknown>).__ellamakaDshContainer !== container)
      throw new DshAdapterError("tool container is no longer available")
    const tools = container.get("tools")
    if (!tools) throw new DshAdapterError("required tool registry is unavailable")
    const available = new Map(tools.schemas().map((item) => [item.name, item]))
    const missing = names.filter((name) => !available.has(name) && !(name === "bash" && available.has("pwsh")))
    if (missing.length) throw new DshAdapterError(`required tools unavailable: ${missing.join(", ")}`)
    return { tools, available }
  }
  try {
    live()
  } catch (error) {
    off()
    throw error
  }
  return {
    dispose: async () => {
      disposed = true
      off()
      sessions.clear()
      calls.disable()
    },
    "tool.provider": async (_request, output) => {
      try {
        const { available } = live()
        for (const name of names) {
          const dispatch = name === "bash" && !available.has("bash") ? "pwsh" : name
          const definition = available.get(dispatch)!
          const projected: ToolDefinition = {
            description: definition.description,
            args: shape(definition.parameters, true),
            execute: async (args, ctx) => {
              const { tools } = live()
              ctx.abort.throwIfAborted()
              const converted = Object.fromEntries(
                Object.entries(args).map(([key, value]) => [snake[key] ?? key, value]),
              )
              await permission(name, converted, ctx)
              ctx.abort.throwIfAborted()
              let session = sessions.get(ctx.sessionID)
              if (!session) {
                session = facade(ctx.sessionID, ctx.directory, mode, parsed.data.escalation ?? "ask")
                sessions.set(ctx.sessionID, session)
              }
              const requested = ctx.extra?.sandboxMode
              if (requested !== undefined) {
                if (
                  typeof requested !== "string" ||
                  !["read-only", "workspace-write", "full-access"].includes(requested)
                )
                  throw new DshAdapterError("invalid message sandbox mode")
                session.append("sandbox/mode", { mode: requested === "full-access" ? "danger-full-access" : requested })
              }
              const effective = [...session.snapshotEvents()]
                .reverse()
                .find((event) => event.type === "sandbox/mode")?.data
              if (record(effective) && converted.sandbox_permissions === effective.mode) {
                delete converted.sandbox_permissions
                delete converted.justification
              }
              const active = session
              const call: { session: Facade; ctx?: ToolContext } = { session: active, ctx }
              return calls.run(call, async () => {
                if (active.turnDepth++ === 0) active.append("turn/start", {})
                try {
                  const result = await tools.execute({
                    callId: (ctx as ToolContext & { callID?: string }).callID ?? `dsh-${crypto.randomUUID()}`,
                    name: dispatch,
                    arguments: converted,
                    signal: ctx.abort,
                    agent: { session: active },
                  })
                  const text = (result.content ?? [])
                    .filter((item) => item.type === "text")
                    .map((item) => item.text ?? "")
                    .join("\n")
                  if (result.isError) {
                    container.logger("dsh-adapter").error("tool execution failed", { tool: name })
                    throw new Error(text || result.error?.message || "DSH tool failed")
                  }
                  return { output: text, title: name, metadata: metadata(name, dispatch, result) }
                } finally {
                  call.ctx = undefined
                  if (--active.turnDepth === 0) active.append("turn/end", {})
                }
              })
            },
          }
          output.tools[name] = projected
        }
      } catch (cause) {
        throw cause instanceof DshAdapterError ? cause : new DshAdapterError("tool projection failed", { cause })
      }
    },
  }
}

export default { id: "dsh-adapter", server: dshAdapter }
