import { describe, expect } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { NodeFileSystem } from "@effect/platform-node"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { CrossSpawnSpawner } from "@wopal/ellamaka-core/cross-spawn-spawner"
import { Global } from "@wopal/ellamaka-core/global"
import { instructionSourcePaths } from "@wopal/ellamaka-core/util/instruction-sources"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InternalHook } from "@/hook/internal-hook"
import { Instruction } from "@/session/instruction"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionTools } from "@/session/tools"
import { ToolRegistry } from "@/tool/registry"
import { Plugin } from "@/plugin"
import { LSP } from "@/lsp/lsp"
import { Format } from "@/format"
import { Ripgrep } from "@/file/ripgrep"
import { RepositoryCache } from "@/reference/repository-cache"
import { Reference } from "@/reference/reference"
import { Git } from "@/git"
import { Config } from "@/config/config"
import { Bus } from "@/bus"
import { BackgroundJob } from "@/background/job"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { Skill } from "@/skill"
import { Permission } from "@/permission"
import { MCP } from "@/mcp"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import type { TaskPromptOps } from "@/tool/task"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ProviderID, ModelID } from "@/provider/schema"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { TestInstance } from "../fixture/fixture"
import { writeGlobalTestConfig, removeGlobalTestConfig } from "../fixture/fixture"

const noGlobal = path.join("/tmp", "itest-no-global")

const dsh = {
  supply: { current: {} as Record<string, unknown> },
  edits: 0,
}

const dshPlugin = Plugin.Service.of({
  init: () => Effect.void,
  // Only `tool.provider` is modelled: it publishes the dynamic definitions the
  // container would mount, and every other hook passes through untouched.
  trigger: (name, _input, output) => {
    if (name === "tool.provider") {
      const defs = Object.entries(dsh.supply.current)
      for (const [id, def] of defs) {
        if (!output || typeof output !== "object" || !("tools" in output)) continue
        const tools = output.tools
        if (!tools || typeof tools !== "object") continue
        Reflect.set(tools, id, def)
      }
    }
    return Effect.succeed(output)
  },
  list: () => Effect.succeed([]),
})
// The registry is assembled from its own layer so the DSH stand-in can replace the
// plugin service the registry resolves its `tool.provider` hooks from.
const registryLayer = ToolRegistry.layer.pipe(
  Layer.provideMerge(Layer.succeed(Plugin.Service, dshPlugin)),
  Layer.provideMerge(
    Layer.mergeAll(
      Config.defaultLayer,
      Question.defaultLayer,
      Todo.defaultLayer,
      Skill.defaultLayer,
      Agent.defaultLayer,
      Session.defaultLayer,
      BackgroundJob.defaultLayer,
      Provider.defaultLayer,
      Git.defaultLayer,
      RepositoryCache.defaultLayer,
      Reference.defaultLayer,
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(LSP.defaultLayer, Instruction.defaultLayer, AppFileSystem.defaultLayer)),
  Layer.provideMerge(Layer.mergeAll(Bus.layer, FetchHttpClient.layer, Format.defaultLayer, NodeFileSystem.layer)),
  Layer.provideMerge(Layer.mergeAll(Ripgrep.defaultLayer, Truncate.defaultLayer, RuntimeFlags.defaultLayer)),
  Layer.provideMerge(CrossSpawnSpawner.defaultLayer),
)

const layer = Layer.mergeAll(
  TestLLMServer.layer,
  SessionPrompt.defaultLayer,
  registryLayer,
  CrossSpawnSpawner.defaultLayer,
  NodeFileSystem.layer,
  InternalHook.defaultLayer,
  Session.defaultLayer,
  Instruction.defaultLayer,
  AppFileSystem.defaultLayer,
  Permission.defaultLayer,
  MCP.defaultLayer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
  Provider.defaultLayer,
  Config.defaultLayer,
).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RuntimeFlags.defaultLayer),
  Layer.provide(Global.layerWith({ home: noGlobal, config: noGlobal })),
)

const it = testEffect(layer)

// The real Provider service loads models from the global config path, so the test
// provider is registered there for the duration of each case.
const providerConfig = (baseURL: string) => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: true,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL },
    },
  },
  agent: { build: { model: "test/test-model" } },
})

const useProvider = Effect.fn("test.useProvider")(function* (baseURL: string, extra?: Partial<Config.Info>) {
  return yield* Effect.acquireRelease(
    Effect.promise(() => writeGlobalTestConfig({ ...providerConfig(baseURL), ...extra })),
    (owner) => Effect.promise(() => removeGlobalTestConfig(owner)),
  )
})
const events: { toolId: string; filePaths: string[] }[] = []

const createAssistant = Effect.fn("test.createAssistant")(function* (
  sessions: Session.Interface,
  sessionID: SessionID,
) {
  const id = MessageID.ascending()
  const info: MessageV2.Assistant = {
    id,
    sessionID,
    role: "assistant",
    parentID: MessageID.make("msg_parent"),
    time: { created: Date.now() },
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelID.make("test-model"),
    providerID: ProviderID.make("test"),
  }
  yield* sessions.updateMessage(info)
  return info
})

// A user turn carrying the text the model received, plus the rule paths the tool
// pipeline recorded for it. This mirrors what the session persists.
const userTurn = (input: {
  sessionID: SessionID
  text: string
  loaded?: string[]
  metadata?: Record<string, unknown>
  id?: MessageID
}): MessageV2.WithParts[] => {
  const id = input.id ?? MessageID.ascending()
  return [
    {
      info: {
        id,
        sessionID: input.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
      },
      parts: [
        {
          id: PartID.ascending(),
          messageID: id,
          sessionID: input.sessionID,
          type: "text",
          text: input.text,
          ...(input.metadata
            ? { metadata: input.metadata }
            : input.loaded
              ? { metadata: { loaded: input.loaded } }
              : {}),
        },
      ],
    },
  ]
}
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

const isExecuteResult = (value: unknown): value is { output: string; metadata?: Record<string, unknown> } =>
  typeof value === "object" && value !== null && "output" in value && typeof value.output === "string"

const baselineSourceParts = (msg: MessageV2.WithParts) =>
  msg.parts.filter((part): part is MessageV2.TextPart => instructionSourcePaths(part) !== undefined)

// Real services supply the agent, model and session so the tool pipeline runs as it
// does for a session; only the processor callbacks are inert.
const resolveToolsWith = Effect.fn("test.resolveToolsWith")(function* (input: {
  sessionID: SessionID
  messages: MessageV2.WithParts[]
  visibility?: Instruction.Visibility
}) {
  const hook = yield* InternalHook.Service
  yield* hook.register({
    id: "recorder",
    onFileOp: (event) =>
      Effect.sync(() => {
        events.push({ toolId: event.toolId, filePaths: [...event.filePaths] })
      }),
  })
  const agents = yield* Agent.Service
  const provider = yield* Provider.Service
  const sessions = yield* Session.Service
  const agent = yield* agents.get("build").pipe(Effect.orDie)
  const model = yield* provider.getModel(ProviderID.make("test"), ModelID.make("test-model")).pipe(Effect.orDie)
  const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
  const assistant = yield* createAssistant(sessions, input.sessionID).pipe(Effect.orDie)
  const promptOps: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: () => Effect.succeed([]),
    prompt: () => Effect.die(new Error("task tool is not exercised in this regression")),
  }
  const tools = yield* Effect.gen(function* () {
    return yield* SessionTools.resolve({
      agent,
      model,
      session: { ...session, permission: [{ permission: "*", pattern: "*", action: "allow" }] },
      processor: {
        message: assistant,
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
      },
      bypassAgentCheck: false,
      messages: input.messages,
      promptOps,
      ...(input.visibility ? { instructionVisibility: () => input.visibility } : {}),
    })
  }).pipe(Effect.orDie)
  return tools
})

const resolveTools = (input: { sessionID: SessionID; messages: MessageV2.WithParts[] }) => resolveToolsWith(input)

const invoke = (tools: Record<string, unknown>, id: string, args: unknown) =>
  Effect.promise(async () => {
    const aiTool = tools[id]
    if (!aiTool || typeof aiTool !== "object" || !("execute" in aiTool)) throw new Error(`missing tool ${id}`)
    const execute = aiTool.execute
    if (typeof execute !== "function") throw new Error(`missing execute for ${id}`)
    const result: unknown = await execute(args, {
      toolCallId: "call_test",
      abortSignal: new AbortController().signal,
      messages: [],
    })
    if (!isExecuteResult(result)) throw new Error(`unexpected result for ${id}`)
    return result
  })

describe("instruction loading integration", () => {
  it.instance("pauses an unseen write and applies it once the rule is visible", () =>
    Effect.gen(function* () {
      yield* useProvider("http://localhost:1/v1")
      dsh.supply.current = {}
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const rule = path.join(test.directory, "src", "AGENTS.md")
      const target = path.join(test.directory, "src", "new.ts")
      yield* fs.writeWithDirs(rule, "# Src Rule").pipe(Effect.orDie)

      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      events.length = 0
      const tools = yield* resolveTools({ sessionID: session.id, messages: [] })
      const paused = yield* invoke(tools, "write", { filePath: target, content: "export const x = 1" })

      const state = paused
      expect(state.output).toContain(rule)
      expect(state.metadata).toMatchObject({ loaded: [rule] })
      expect(yield* fs.existsSafe(target)).toBe(false)
      expect(events.filter((item) => item.toolId === "write")).toHaveLength(0)

      // Persist the paused result exactly as the pipeline records it, then read it back
      // through the same snapshot the next request would use.
      const nextMessages = userTurn({
        sessionID: session.id,
        text: state.output,
        metadata: state.metadata,
      })
      const visibility = Instruction.snapshot(nextMessages)
      expect(visibility.text.length).toBe(1)

      const retryTools = yield* resolveToolsWith({ sessionID: session.id, messages: nextMessages, visibility })
      const applied = yield* invoke(retryTools, "write", { filePath: target, content: "export const x = 1" })
      expect(applied.output).toContain("Wrote file")
      expect(yield* fs.existsSafe(target)).toBe(true)
      expect(events.filter((item) => item.toolId === "write")).toHaveLength(1)
    }),
  )

  it.instance("mounts the rule on a real read and lets the next write proceed", () =>
    Effect.gen(function* () {
      yield* useProvider("http://localhost:1/v1")
      dsh.supply.current = {}
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const rule = path.join(test.directory, "src", "AGENTS.md")
      const readTarget = path.join(test.directory, "src", "a.ts")
      const writeTarget = path.join(test.directory, "src", "b.ts")
      yield* fs.writeWithDirs(rule, "# Src Rule").pipe(Effect.orDie)
      yield* fs.writeWithDirs(readTarget, "export const a = 1").pipe(Effect.orDie)

      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      events.length = 0

      const readTools = yield* resolveTools({ sessionID: session.id, messages: [] })
      const read = yield* invoke(readTools, "read", { filePath: readTarget })
      const readOutput = read.output
      expect(readOutput).toContain("Instructions from: " + rule)
      expect(readOutput).toContain("export const a = 1")

      // The read result plus its reminder is what the model received this step.
      const messages = userTurn({
        sessionID: session.id,
        text: readOutput,
        metadata: read.metadata,
      })

      const writeTools = yield* resolveToolsWith({
        sessionID: session.id,
        messages,
        visibility: Instruction.snapshot(messages),
      })
      const applied = yield* invoke(writeTools, "write", { filePath: writeTarget, content: "export const b = 2" })
      expect(applied.output).toContain("Wrote file")
      expect(yield* fs.existsSafe(writeTarget)).toBe(true)
      expect(events.filter((item) => item.toolId === "write")).toHaveLength(1)
    }),
  )

  it.instance("does not let a read from the same batch authorize a parallel write", () =>
    Effect.gen(function* () {
      yield* useProvider("http://localhost:1/v1")
      dsh.supply.current = {}
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const rule = path.join(test.directory, "src", "AGENTS.md")
      const target = path.join(test.directory, "src", "batch.ts")
      yield* fs.writeWithDirs(rule, "# Src Rule").pipe(Effect.orDie)
      yield* fs.writeWithDirs(path.join(test.directory, "src", "seed.ts"), "export const seed = 1").pipe(Effect.orDie)

      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      events.length = 0

      // The batch starts before either result reaches the model: the snapshot is empty.
      const tools = yield* resolveToolsWith({
        sessionID: session.id,
        messages: [],
        visibility: Instruction.snapshot([]),
      })
      const [, written] = yield* Effect.all(
        [
          invoke(tools, "read", { filePath: path.join(test.directory, "src", "seed.ts") }),
          invoke(tools, "write", { filePath: target, content: "export const batch = 1" }),
        ],
        { concurrency: "unbounded" },
      )

      expect(written.output).toContain("File not modified")
      expect(yield* fs.existsSafe(target)).toBe(false)
      expect(events.filter((item) => item.toolId === "write")).toHaveLength(0)
    }),
  )

  it.instance("pauses again when compaction drops the message that carried the rule", () =>
    Effect.gen(function* () {
      yield* useProvider("http://localhost:1/v1")
      dsh.supply.current = {}
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const rule = path.join(test.directory, "src", "AGENTS.md")
      const target = path.join(test.directory, "src", "later.ts")
      yield* fs.writeWithDirs(rule, "# Src Rule").pipe(Effect.orDie)

      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      events.length = 0

      const carrying = userTurn({
        sessionID: session.id,
        text: "<system-reminder>\nInstructions from: " + rule + "\n# Src Rule\n</system-reminder>",
        loaded: [rule],
      })

      // While it is visible the write runs.
      const before = yield* resolveToolsWith({
        sessionID: session.id,
        messages: carrying,
        visibility: Instruction.snapshot(carrying),
      })
      expect((yield* invoke(before, "write", { filePath: target, content: "x" })).output).toContain("Wrote file")

      // After compaction the rule is no longer in the model input: a summary or a
      // stale path marker is not the rule body.
      const compacted = Instruction.snapshot(
        userTurn({
          sessionID: session.id,
          text: "Summary: the project has a src/AGENTS.md with rules.",
          loaded: [rule],
        }),
      )

      const after = yield* resolveToolsWith({ sessionID: session.id, messages: [], visibility: compacted })
      const again = yield* invoke(after, "write", { filePath: target, content: "y" })
      expect(again.output).toContain("File not modified")
      expect(again.output).toContain("# Src Rule")
    }),
  )

  it.instance("shares one rule between a real read and a later edit", () =>
    Effect.gen(function* () {
      yield* useProvider("http://localhost:1/v1")
      dsh.supply.current = {}
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const rule = path.join(test.directory, "src", "AGENTS.md")
      const file = path.join(test.directory, "src", "shared.ts")
      yield* fs.writeWithDirs(rule, "# Src Rule").pipe(Effect.orDie)
      yield* fs.writeWithDirs(file, "export const shared = 1").pipe(Effect.orDie)

      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      events.length = 0

      const first = yield* resolveTools({ sessionID: session.id, messages: [] })
      const native = yield* invoke(first, "read", { filePath: file })
      const nativeOutput = native.output
      const loaded = isStringArray(native.metadata?.loaded) ? native.metadata.loaded : []
      expect(loaded).toEqual([rule])

      const messages = userTurn({ sessionID: session.id, text: nativeOutput, loaded })
      const visibility = Instruction.snapshot(messages)

      const second = yield* resolveToolsWith({ sessionID: session.id, messages, visibility })
      // The same rule body is still in the request, so the edit runs without a second copy.
      const applied = yield* invoke(second, "edit", {
        filePath: file,
        oldString: "export const shared = 1",
        newString: "export const shared = 2",
      })
      expect(applied.output).toContain("Edit applied")
      expect(events.filter((item) => item.toolId === "edit")).toHaveLength(1)
      expect(yield* fs.readFileString(file)).toContain("export const shared = 2")
    }),
  )

  it.instance("carries user text and media attachment rules into the model request", () =>
    Effect.gen(function* () {
      yield* useProvider("http://localhost:1/v1")
      dsh.supply.current = {}
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const rule = path.join(test.directory, "docs", "AGENTS.md")
      const note = path.join(test.directory, "docs", "note.md")
      const pdf = path.join(test.directory, "docs", "brief.pdf")
      yield* fs.writeWithDirs(rule, "# Docs Rule").pipe(Effect.orDie)
      yield* fs.writeWithDirs(note, "note body").pipe(Effect.orDie)
      yield* fs.writeWithDirs(pdf, "%PDF-1.4\n%%EOF").pipe(Effect.orDie)

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const first = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "file", mime: "text/plain", url: pathToFileURL(note).href, filename: "note.md" }],
      })
      if (first.info.role !== "user") throw new Error("expected user message")
      const textStored = yield* MessageV2.get({ sessionID: session.id, messageID: first.info.id })
      expect(textStored.parts.some((part) => part.type === "text" && part.text.includes("note body"))).toBe(true)
      expect(
        textStored.parts.some((part) => part.type === "text" && part.text.includes("Instructions from: " + rule)),
      ).toBe(true)

      const second = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "file", mime: "application/pdf", url: pathToFileURL(pdf).href, filename: "brief.pdf" }],
      })
      if (second.info.role !== "user") throw new Error("expected user message")
      const pdfStored = yield* MessageV2.get({ sessionID: session.id, messageID: second.info.id })
      // The rule is still visible from the previous message, so the PDF turn adds no copy.
      expect(
        pdfStored.parts.filter((part) => part.type === "text" && part.text.includes("Instructions from: " + rule)),
      ).toHaveLength(0)
      expect(pdfStored.parts.some((part) => part.type === "file" && part.filename === "brief.pdf")).toBe(true)

      const converted = yield* MessageV2.toModelMessagesEffect(
        [textStored, pdfStored],
        yield* (yield* Provider.Service).getModel(ProviderID.make("test"), ModelID.make("test-model")),
      ).pipe(Effect.orDie)
      const payload = JSON.stringify(converted)
      expect(payload).toContain("# Docs Rule")
      expect(payload).toContain("note body")
    }),
  )

  it.instance("runs the real loop: a write pauses, then applies once the rules are in the request", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      dsh.supply.current = {}
      yield* useProvider(llm.url)
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const rule = path.join(test.directory, "src", "AGENTS.md")
      const target = path.join(test.directory, "src", "looped.ts")
      yield* fs.writeWithDirs(rule, "# Src Rule").pipe(Effect.orDie)

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      events.length = 0
      const hook = yield* InternalHook.Service
      yield* hook.register({
        id: "loop-recorder",
        onFileOp: (event) =>
          Effect.sync(() => {
            events.push({ toolId: event.toolId, filePaths: [...event.filePaths] })
          }),
      })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "create the file" }],
      })

      // First model turn asks for the write; the rule has not been seen yet.
      yield* llm.tool("write", { filePath: target, content: "export const looped = 1" })
      // Second turn repeats the same call after the paused result entered the request.
      yield* llm.tool("write", { filePath: target, content: "export const looped = 1" })
      yield* llm.text("done")

      yield* prompt.loop({ sessionID: session.id })

      expect(yield* fs.existsSafe(target)).toBe(true)
      expect(yield* fs.readFileString(target).pipe(Effect.orDie)).toBe("export const looped = 1")

      const requests = (yield* llm.inputs).map((input) => JSON.stringify(input))
      expect(requests.some((body) => body.includes("File not modified"))).toBe(true)
      const applied = events.filter((item) => item.toolId === "write")
      expect(applied).toHaveLength(1)
    }),
  )

  it.instance("mounts rules through a DSH-projected read and str_replace_editor view", () =>
    Effect.gen(function* () {
      yield* useProvider("http://localhost:1/v1")
      dsh.supply.current = {}
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const rule = path.join(test.directory, "src", "AGENTS.md")
      const file = path.join(test.directory, "src", "projected.ts")
      yield* fs.writeWithDirs(rule, "# Src Rule").pipe(Effect.orDie)
      yield* fs.writeWithDirs(file, "export const projected = 1").pipe(Effect.orDie)

      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      events.length = 0
      dsh.supply.current = {
        read: {
          description: "dsh read",
          args: {},
          execute: async () => ({ output: "container contents", metadata: { source: "dsh" } }),
        },
        str_replace_editor: {
          description: "dsh editor",
          args: {},
          execute: async (args: Record<string, unknown>) =>
            args.command === "view"
              ? { output: "export const projected = 1", metadata: { source: "dsh-view" } }
              : { output: "Edited" },
        },
      }

      // With nothing projected the registry has no str_replace_editor at all: the entry
      // only exists through the adapter's `tool.provider` hook.
      dsh.supply.current = {}
      const nativeTools = yield* resolveToolsWith({ sessionID: session.id, messages: [] })
      expect(Object.keys(nativeTools)).not.toContain("str_replace_editor")

      dsh.supply.current = {
        read: {
          description: "dsh read",
          args: {},
          execute: async () => ({ output: "container contents", metadata: { source: "dsh" } }),
        },
        str_replace_editor: {
          description: "dsh editor",
          args: {},
          execute: async (args: Record<string, unknown>) =>
            args.command === "view"
              ? { output: "export const projected = 1", metadata: { source: "dsh-view" } }
              : { output: "Edited" },
        },
      }

      const readTools = yield* resolveToolsWith({ sessionID: session.id, messages: [] })
      const read = yield* invoke(readTools, "read", { filePath: file })
      expect(read.output).toContain("Instructions from: " + rule)
      expect(read.output).toContain("container contents")
      expect(read.metadata).toMatchObject({ source: "dsh", loaded: [rule] })

      // A parallel str_replace_editor view in the same batch does not re-attach the rule.
      const sameBatchView = yield* invoke(readTools, "str_replace_editor", { command: "view", path: file })
      expect(sameBatchView.output).not.toContain("# Src Rule")
      expect(sameBatchView.metadata).toMatchObject({ source: "dsh-view", loaded: [] })

      // view in a fresh batch without visible rules mounts the rule itself.
      const viewTools = yield* resolveToolsWith({ sessionID: session.id, messages: [] })
      const view = yield* invoke(viewTools, "str_replace_editor", { command: "view", path: file })
      expect(view.output).toContain("Instructions from: " + rule)
      expect(view.metadata).toMatchObject({ source: "dsh-view", loaded: [rule] })
    }),
  )

  it.instance("pauses a DSH str_replace_editor modification until its rules are visible", () =>
    Effect.gen(function* () {
      yield* useProvider("http://localhost:1/v1")
      dsh.supply.current = {}
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const rule = path.join(test.directory, "src", "AGENTS.md")
      const file = path.join(test.directory, "src", "edit-me.ts")
      yield* fs.writeWithDirs(rule, "# Src Rule").pipe(Effect.orDie)
      yield* fs.writeWithDirs(file, "export const before = 1").pipe(Effect.orDie)

      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      events.length = 0
      dsh.supply.current = {
        str_replace_editor: {
          description: "dsh editor",
          args: {},
          execute: async () => {
            dsh.edits += 1
            return { output: "Edited" }
          },
        },
      }

      const tools = yield* resolveToolsWith({ sessionID: session.id, messages: [] })
      const paused = yield* invoke(tools, "str_replace_editor", {
        command: "str_replace",
        path: file,
        old_str: "before",
        new_str: "after",
      })
      expect(paused.output).toContain("File not modified")
      expect(paused.output).toContain("# Src Rule")
      expect(dsh.edits).toBe(0)
      expect(events.filter((item) => item.toolId === "str_replace_editor")).toHaveLength(0)

      // Next request carries the rule body, so the same call is allowed through.
      const visible = userTurn({
        sessionID: session.id,
        text: paused.output,
        loaded: isStringArray(paused.metadata?.loaded) ? paused.metadata.loaded : [],
      })
      const retry = yield* resolveToolsWith({
        sessionID: session.id,
        messages: visible,
        visibility: Instruction.snapshot(visible),
      })
      const applied = yield* invoke(retry, "str_replace_editor", {
        command: "str_replace",
        path: file,
        old_str: "before",
        new_str: "after",
      })
      expect(applied.output).toContain("Edited")
      expect(dsh.edits).toBe(1)
      expect(events.filter((item) => item.toolId === "str_replace_editor")).toHaveLength(1)
    }),
  )

  it.instance("records baseline instruction sources once across turns and again after compaction", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      dsh.supply.current = {}
      yield* useProvider(llm.url)
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const rootRule = path.join(test.directory, "AGENTS.md")
      yield* fs.writeWithDirs(rootRule, "# Root Rule").pipe(Effect.orDie)

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // Turn 1: baseline instruction sources are recorded once.
      const turn1 = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "turn 1" }],
      })
      yield* llm.text("reply 1")
      yield* prompt.loop({ sessionID: session.id })

      const afterTurn1 = yield* sessions.messages({ sessionID: session.id })
      const turn1Stored = afterTurn1.find((item) => item.info.id === turn1.info.id)
      expect(turn1Stored).toBeDefined()
      const turn1Sources = baselineSourceParts(turn1Stored!)
      expect(turn1Sources).toHaveLength(1)
      expect(instructionSourcePaths(turn1Sources[0])).toContain(rootRule)

      // Turn 2 (e.g. background progress notification): must not repeat baseline sources.
      const turn2 = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "<system-reminder>[WOPAL TASK PROGRESS] running</system-reminder>" }],
      })
      yield* llm.text("reply 2")
      yield* prompt.loop({ sessionID: session.id })

      const afterTurn2 = yield* sessions.messages({ sessionID: session.id })
      const turn2Stored = afterTurn2.find((item) => item.info.id === turn2.info.id)
      expect(turn2Stored).toBeDefined()
      expect(baselineSourceParts(turn2Stored!)).toHaveLength(0)

      // Completed compaction clears earlier messages from model visibility.
      const compactionUserID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: compactionUserID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: compactionUserID,
        type: "compaction",
        auto: true,
      })
      const summaryAssistantID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: summaryAssistantID,
        sessionID: session.id,
        role: "assistant",
        parentID: compactionUserID,
        time: { created: Date.now() },
        mode: "compaction",
        agent: "compaction",
        path: { cwd: test.directory, root: test.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test"),
        summary: true,
        finish: "stop",
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: summaryAssistantID,
        type: "text",
        text: "compacted summary",
      })

      // Turn 3 after compaction: baseline sources are recorded again, compaction marker untouched.
      const turn3 = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "after compaction" }],
      })
      yield* llm.text("reply 3")
      yield* prompt.loop({ sessionID: session.id })

      const afterTurn3 = yield* sessions.messages({ sessionID: session.id })
      const compactionStored = afterTurn3.find((item) => item.info.id === compactionUserID)
      expect(compactionStored?.parts.map((part) => part.type)).toEqual(["compaction"])
      const turn3Stored = afterTurn3.find((item) => item.info.id === turn3.info.id)
      expect(baselineSourceParts(turn3Stored!)).toHaveLength(1)

      // Turn 4 after compaction: must not repeat again.
      const turn4 = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "turn 4" }],
      })
      yield* llm.text("reply 4")
      yield* prompt.loop({ sessionID: session.id })

      const afterTurn4 = yield* sessions.messages({ sessionID: session.id })
      const turn4Stored = afterTurn4.find((item) => item.info.id === turn4.info.id)
      expect(baselineSourceParts(turn4Stored!)).toHaveLength(0)
    }),
  )

  it.instance("records baseline instruction sources after in-loop auto compaction when step > 1", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      dsh.supply.current = {}
      yield* useProvider(llm.url)
      const test = yield* TestInstance
      const fs = yield* AppFileSystem.Service
      const rootRule = path.join(test.directory, "AGENTS.md")
      yield* fs.writeWithDirs(rootRule, "# Root Rule").pipe(Effect.orDie)

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // Turn 1 gets the initial baseline record.
      const turn1 = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "turn 1" }],
      })
      yield* llm.text("reply 1")
      yield* prompt.loop({ sessionID: session.id })

      // Enqueue a pending auto-compaction user message and run the loop:
      // step=1 runs compaction (producing summary + continueMsg), step=2 runs the model call.
      const compactionUserID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: compactionUserID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: compactionUserID,
        type: "compaction",
        auto: true,
      })

      yield* llm.text("summary text")
      yield* llm.text("continued reply")
      yield* prompt.loop({ sessionID: session.id })

      const msgs = yield* sessions.messages({ sessionID: session.id })
      const compactionStored = msgs.find((item) => item.info.id === compactionUserID)
      expect(compactionStored?.parts.map((part) => part.type)).toEqual(["compaction"])

      const continueMsg = msgs.find(
        (item) =>
          item.info.role === "user" &&
          item.info.id !== turn1.info.id &&
          item.info.id !== compactionUserID &&
          item.parts.some((part) => part.type === "text" && part.metadata?.compaction_continue === true),
      )
      expect(continueMsg).toBeDefined()
      expect(baselineSourceParts(continueMsg!)).toHaveLength(1)
    }),
  )

  it.instance(
    "keeps a single baseline sources part across multi-step loops and updates in place when baseline changes",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        dsh.supply.current = {}
        yield* useProvider(llm.url, { instructions: ["extra/*.md"] })
        const test = yield* TestInstance
        const fs = yield* AppFileSystem.Service
        const rootRule = path.join(test.directory, "AGENTS.md")
        const note = path.join(test.directory, "note.ts")
        const extraSecond = path.join(test.directory, "extra", "second.md")
        const extraThird = path.join(test.directory, "extra", "third.md")
        yield* fs.writeWithDirs(rootRule, "# Root Rule").pipe(Effect.orDie)
        yield* fs.writeWithDirs(note, "export const note = 1").pipe(Effect.orDie)

        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })

        // Turn 1 runs two loop steps while the baseline stays unchanged -> still one part.
        const turn1 = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "turn 1" }],
        })
        yield* llm.tool("read", { filePath: note })
        yield* llm.text("done 1")
        yield* prompt.loop({ sessionID: session.id })

        const afterTurn1 = yield* sessions.messages({ sessionID: session.id })
        const turn1Stored = afterTurn1.find((item) => item.info.id === turn1.info.id)
        expect(turn1Stored).toBeDefined()
        const turn1Sources = baselineSourceParts(turn1Stored!)
        expect(turn1Sources).toHaveLength(1)
        expect(instructionSourcePaths(turn1Sources[0])).toEqual([rootRule])

        // Turn 2 grows the configured baseline twice inside the same user turn's loop:
        // step 1 unchanged -> step 2 writes Turn 2's part -> step 3 updates that same part in place.
        const turn2 = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "turn 2" }],
        })
        yield* llm.tool("write", { filePath: extraSecond, content: "# Second" })
        yield* llm.tool("write", { filePath: extraThird, content: "# Third" })
        yield* llm.text("done 2")
        yield* prompt.loop({ sessionID: session.id })

        const afterTurn2 = yield* sessions.messages({ sessionID: session.id })
        const turn1AfterTurn2 = afterTurn2.find((item) => item.info.id === turn1.info.id)
        const turn1SourcesAfter = baselineSourceParts(turn1AfterTurn2!)
        expect(turn1SourcesAfter).toHaveLength(1)
        expect(instructionSourcePaths(turn1SourcesAfter[0])).toEqual([rootRule])

        const turn2Stored = afterTurn2.find((item) => item.info.id === turn2.info.id)
        expect(turn2Stored).toBeDefined()
        const turn2Sources = baselineSourceParts(turn2Stored!)
        expect(turn2Sources).toHaveLength(1)
        const turn2Paths = instructionSourcePaths(turn2Sources[0])
        expect(turn2Paths).toContain(rootRule)
        expect(turn2Paths).toContain(extraSecond)
        expect(turn2Paths).toContain(extraThird)

        // Turn 3 sees the expanded baseline already recorded on Turn 2 -> no duplicate part.
        const turn3 = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "turn 3" }],
        })
        yield* llm.text("done 3")
        yield* prompt.loop({ sessionID: session.id })

        const afterTurn3 = yield* sessions.messages({ sessionID: session.id })
        const turn3Stored = afterTurn3.find((item) => item.info.id === turn3.info.id)
        expect(turn3Stored).toBeDefined()
        expect(baselineSourceParts(turn3Stored!)).toHaveLength(0)
      }),
  )
})
