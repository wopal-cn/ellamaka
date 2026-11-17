import { beforeEach, describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Layer, Schema } from "effect"
import os from "os"
import path from "path"
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "fs"
import { Agent } from "@/agent/agent"
import { InternalHook } from "@/hook/internal-hook"
import { InstanceState } from "@/effect/instance-state"
import { LSP } from "@/lsp/lsp"
import { LSPObserver } from "@/lsp/lsp-observer"
import type { LSPClient } from "@/lsp/client"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import type { MessageV2 } from "@/session/message-v2"
import { SessionTools } from "@/session/tools"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { AppFileSystem } from "@wopal/ellamaka-core/filesystem"
import { Global } from "@wopal/ellamaka-core/global"
import { FetchHttpClient } from "effect/unstable/http"
import { Instruction } from "@/session/instruction"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestConfig } from "../fixture/config"

// ---------------------------------------------------------------------------
// Mock state shared by the pipeline mocks (reset per test).
// ---------------------------------------------------------------------------

type TouchCall = { path: string; mode: "document" | "full" | undefined }

let touchCalls: TouchCall[] = []
let diagnosticsResult: Record<string, LSPClient.Diagnostic[]> = {}
let touchStarted: Deferred.Deferred<void> | undefined
let registryTools: Tool.Def[] = []
let executions: string[] = []
let emittedEvents: InternalHook.FileOpEvent[] = []

const mockLsp = Layer.mock(LSP.Service)({
  touchFile: (input: string, mode?: "document" | "full") =>
    Effect.gen(function* () {
      touchCalls.push({ path: input, mode })
      if (touchStarted) yield* Deferred.succeed(touchStarted, undefined)
    }),
  diagnostics: () => Effect.succeed(diagnosticsResult),
})

const mockPlugin = Layer.mock(Plugin.Service)({
  trigger: (_name, _input, output) => Effect.succeed(output),
})

const mockPermission = Layer.mock(Permission.Service)({})

const mockRegistry = Layer.mock(ToolRegistry.Service)({
  tools: () => Effect.succeed(registryTools),
})

const mockMcp = Layer.mock(MCP.Service)({
  tools: () => Effect.succeed({}),
})

const mockTruncate = Layer.mock(Truncate.Service)({
  output: (text: string) => Effect.succeed({ content: text, truncated: false } as Truncate.Result),
})

const mockAgent = Layer.mock(Agent.Service)({
  get: () => Effect.succeed({ name: "build", mode: "primary", permission: [], options: {} }),
})

// SessionTools resolves directory instructions through this service, so every
// runner in this file provides it. Global points at a path that does not exist
// so user-level rules never leak into these assertions.
const noGlobal = path.join(os.tmpdir(), "opencode-test-no-global-instructions")

const instructionLayer = Instruction.layer.pipe(
  Layer.provide(TestConfig.layer()),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Global.layerWith({ home: noGlobal, config: noGlobal })),
  Layer.provide(RuntimeFlags.layer({})),
)

// Rule discovery that throws must never turn a successful read into a failure.
const failingInstructionLayer = Layer.mock(Instruction.Service)({
  inspect: () => Effect.fail(new AppFileSystem.FileSystemError({ method: "readFileString" })),
  snapshot: () => ({ text: [] }),
})

const failingIt = testEffect(
  Layer.mergeAll(
    InternalHook.defaultLayer,
    mockLsp,
    mockPlugin,
    mockPermission,
    mockRegistry,
    mockMcp,
    mockTruncate,
    AppFileSystem.defaultLayer,
    failingInstructionLayer,
  ),
)

const it = testEffect(
  Layer.mergeAll(
    InternalHook.defaultLayer,
    mockLsp,
    mockPlugin,
    mockPermission,
    mockRegistry,
    mockMcp,
    mockTruncate,
    AppFileSystem.defaultLayer,
    instructionLayer,
  ),
)

// The truncation-chain test needs the real Truncate service because the
// tool.ts wrap applies it to the tool output; the default suite mocks it away,
// so that test gets its own runner.
const truncatingIt = testEffect(
  Layer.mergeAll(
    InternalHook.defaultLayer,
    mockLsp,
    mockPlugin,
    mockPermission,
    mockRegistry,
    mockMcp,
    Truncate.defaultLayer,
    mockAgent,
    AppFileSystem.defaultLayer,
    instructionLayer,
  ),
)

beforeEach(() => {
  executions = []
  touchCalls = []
  diagnosticsResult = {}
  touchStarted = undefined
  registryTools = []
  emittedEvents = []
})

const errorDiag = (message: string): LSPClient.Diagnostic =>
  ({
    severity: 1,
    message,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  }) as LSPClient.Diagnostic

const block = (file: string, message: string) => `<diagnostics file="${file}">\nERROR [1:1] ${message}\n</diagnostics>`

const toolDef = (id: string, result: Tool.ExecuteResult): Tool.Def => ({
  id,
  description: `${id} test tool`,
  parameters: Schema.Unknown,
  jsonSchema: { type: "object", properties: {}, additionalProperties: true },
  execute: () => Effect.succeed(result),
})

const makeResult = (output: string, metadata: Record<string, unknown> = {}) => ({
  title: "title",
  metadata,
  output,
})

const resolveTools = Effect.fn("test.resolveTools")(function* (extra: Record<string, unknown> = {}) {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- structural pipeline input; full Agent/Session/Provider fixtures are unnecessary for the emit path
  const input = {
    agent: { name: "build" },
    model: { providerID: "test", api: { id: "test-model" } },
    session: { id: SessionID.make("ses_test"), permission: [] },
    processor: {
      message: { id: MessageID.make("msg_test") },
      updateToolCall: () => Effect.void,
      completeToolCall: () => Effect.void,
    },
    bypassAgentCheck: false,
    messages: [],
    promptOps: {},
    ...extra,
  } as unknown as Parameters<typeof SessionTools.resolve>[0]
  return yield* SessionTools.resolve(input)
})

const invoke = (tools: Record<string, unknown>, id: string, args: unknown) =>
  Effect.promise(async () => {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the AI SDK tool surface is wider than the fields this test consumes
    const aiTool = tools[id] as { execute: (args: unknown, options: unknown) => Promise<Tool.ExecuteResult> }
    return await aiTool.execute(args, {
      toolCallId: "call_test",
      abortSignal: new AbortController().signal,
      messages: [],
    })
  })

const registerObserver = Effect.gen(function* () {
  const hook = yield* InternalHook.Service
  const lsp = yield* LSP.Service
  yield* hook.register(LSPObserver.observer(lsp))
})

// Recording observer: captures the raw FileOpEvent objects the pipeline
// publishes so tests can assert the event contract directly.
const registerRecorder = Effect.gen(function* () {
  const hook = yield* InternalHook.Service
  yield* hook.register({
    id: "recorder",
    onFileOp: (event) =>
      Effect.sync(() => {
        emittedEvents.push(event)
      }),
  })
})

// A tool defined through Tool.define: Tool.init hands back a Def whose execute
// applies the real tool.ts wrap (services resolved from the test layer), so the
// output goes through the production truncation path.
const wrappedToolDef = (id: string, output: string) =>
  Effect.gen(function* () {
    const info = yield* Tool.define(
      id,
      Effect.succeed({
        description: `${id} synthetic long-output tool`,
        parameters: Schema.Unknown,
        jsonSchema: { type: "object", properties: {}, additionalProperties: true },
        execute: (): Effect.Effect<Tool.ExecuteResult> => Effect.succeed(makeResult(output)),
      }),
    )
    return yield* Tool.init(info)
  })

describe("session-tools file op emission", () => {
  it.instance("publishes a read event and never backfills the result", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      touchStarted = yield* Deferred.make<void>()
      const filePath = path.join(test.directory, "src", "foo.ts")
      registryTools = [toolDef("read", makeResult("file contents"))]
      yield* registerObserver
      yield* registerRecorder

      const tools = yield* resolveTools()
      const result = yield* invoke(tools, "read", { filePath })

      yield* awaitWithTimeout(Deferred.await(touchStarted), "touchFile was never invoked")
      expect(touchCalls).toEqual([{ path: filePath, mode: undefined }])
      expect(result["output"]).toBe("file contents")
      expect(result["metadata"]).toEqual({ loaded: [] })
      expect(emittedEvents).toHaveLength(1)
      expect(emittedEvents[0].toolId).toBe("read")
      expect(emittedEvents[0].args).toEqual({ filePath })
      expect(emittedEvents[0].filePaths).toEqual([filePath])
      expect(emittedEvents[0].sessionID).toBe("ses_test")
    }),
  )

  it.instance("publishes a write event and backfills diagnostics into the final output", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "src", "foo.ts")
      diagnosticsResult = { [filePath]: [errorDiag("boom")] }
      // CamelCase filePath is the shape the dsh adapter projects onto the
      // builtin write slot (container file_path mapped to filePath).
      registryTools = [toolDef("write", makeResult("Wrote file successfully.", { filepath: filePath }))]
      yield* registerObserver
      yield* registerRecorder

      const tools = yield* resolveTools()
      const result = yield* invoke(tools, "write", { filePath, content: "x" })

      expect(touchCalls).toEqual([{ path: filePath, mode: "document" }])
      expect(result["output"]).toBe(
        `Wrote file successfully.\n\nLSP errors detected in this file, please fix:\n${block(filePath, "boom")}`,
      )
      expect(result["metadata"]).toMatchObject({ diagnostics: diagnosticsResult, filepath: filePath })
      expect(emittedEvents).toHaveLength(1)
      expect(emittedEvents[0].toolId).toBe("write")
      expect(emittedEvents[0].args).toEqual({ filePath, content: "x" })
      expect(emittedEvents[0].filePaths).toEqual([filePath])
      expect(emittedEvents[0].sessionID).toBe("ses_test")
    }),
  )

  it.instance("extracts str_replace_editor paths from the DSH argument shape", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "src", "foo.ts")
      diagnosticsResult = { [filePath]: [errorDiag("boom")] }
      registryTools = [toolDef("str_replace_editor", makeResult("Edited src/foo.ts"))]
      yield* registerObserver
      yield* registerRecorder

      const tools = yield* resolveTools()
      const result = yield* invoke(tools, "str_replace_editor", {
        command: "str_replace",
        path: "src/foo.ts",
        old_str: "a",
        new_str: "b",
      })

      expect(touchCalls).toEqual([{ path: filePath, mode: "document" }])
      expect(result["output"]).toContain("LSP errors detected in this file, please fix:")
      // str_replace_editor extracts args.path; the raw (relative) value is
      // published, resolution happens inside the observer.
      expect(emittedEvents).toHaveLength(1)
      expect(emittedEvents[0].toolId).toBe("str_replace_editor")
      expect(emittedEvents[0].args).toEqual({
        command: "str_replace",
        path: "src/foo.ts",
        old_str: "a",
        new_str: "b",
      })
      expect(emittedEvents[0].filePaths).toEqual(["src/foo.ts"])
      expect(emittedEvents[0].sessionID).toBe("ses_test")
    }),
  )

  it.instance("treats str_replace_editor view as a read event", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      touchStarted = yield* Deferred.make<void>()
      const filePath = path.join(test.directory, "src", "foo.ts")
      diagnosticsResult = { [filePath]: [errorDiag("boom")] }
      registryTools = [toolDef("str_replace_editor", makeResult("view output"))]
      yield* registerObserver
      yield* registerRecorder

      const tools = yield* resolveTools()
      const result = yield* invoke(tools, "str_replace_editor", { command: "view", path: "src/foo.ts" })

      yield* awaitWithTimeout(Deferred.await(touchStarted), "touchFile was never invoked")
      expect(touchCalls).toEqual([{ path: filePath, mode: undefined }])
      expect(result["output"]).toBe("view output")
      expect(emittedEvents).toHaveLength(1)
      expect(emittedEvents[0].toolId).toBe("str_replace_editor")
      expect(emittedEvents[0].args).toEqual({ command: "view", path: "src/foo.ts" })
      expect(emittedEvents[0].filePaths).toEqual(["src/foo.ts"])
      expect(emittedEvents[0].sessionID).toBe("ses_test")
    }),
  )

  it.instance("extracts apply_patch targets from result metadata, skipping deletes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const ctx = yield* InstanceState.context
      const added = path.join(test.directory, "added.ts")
      const movedFrom = path.join(test.directory, "before.ts")
      const movedTo = path.join(test.directory, "after.ts")
      const deleted = path.join(test.directory, "deleted.ts")
      const rel = (file: string) => path.relative(ctx.worktree, file).replaceAll("\\", "/")
      diagnosticsResult = {
        [added]: [errorDiag("boom-a")],
        [movedTo]: [errorDiag("boom-b")],
        [deleted]: [errorDiag("boom-deleted")],
      }
      registryTools = [
        toolDef(
          "apply_patch",
          makeResult("Success. Updated the following files:\nA added.ts\nM after.ts\nD deleted.ts", {
            files: [
              { filePath: added, type: "add" },
              { filePath: movedFrom, movePath: movedTo, type: "move" },
              { filePath: deleted, type: "delete" },
            ],
          }),
        ),
      ]
      yield* registerObserver
      yield* registerRecorder

      const tools = yield* resolveTools()
      const result = yield* invoke(tools, "apply_patch", { patchText: "*** Begin Patch" })

      expect(touchCalls).toEqual([
        { path: added, mode: "document" },
        { path: movedTo, mode: "document" },
      ])
      expect(result["output"]).toContain(`LSP errors detected in ${rel(added)}, please fix:\n${block(added, "boom-a")}`)
      expect(result["output"]).toContain(
        `LSP errors detected in ${rel(movedTo)}, please fix:\n${block(movedTo, "boom-b")}`,
      )
      // The deleted file is neither touched nor backfilled, even when the
      // diagnostics map carries errors for it.
      expect(result["output"]).not.toContain("boom-deleted")
      expect(result["title"]).toBe(result["output"])
      // The event carries every non-delete target (move resolves to movePath).
      expect(emittedEvents).toHaveLength(1)
      expect(emittedEvents[0].toolId).toBe("apply_patch")
      expect(emittedEvents[0].args).toEqual({ patchText: "*** Begin Patch" })
      expect(emittedEvents[0].filePaths).toEqual([added, movedTo])
      expect(emittedEvents[0].sessionID).toBe("ses_test")
    }),
  )

  it.instance("publishes an edit event with its tool id, arguments, paths and session", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "src", "foo.ts")
      diagnosticsResult = { [filePath]: [errorDiag("boom")] }
      registryTools = [toolDef("edit", makeResult("Edit applied successfully.", { diff: "diff" }))]
      yield* registerObserver
      yield* registerRecorder

      const tools = yield* resolveTools()
      const result = yield* invoke(tools, "edit", { filePath, oldString: "a", newString: "b" })

      expect(emittedEvents).toHaveLength(1)
      expect(emittedEvents[0].toolId).toBe("edit")
      expect(emittedEvents[0].args).toEqual({ filePath, oldString: "a", newString: "b" })
      expect(emittedEvents[0].filePaths).toEqual([filePath])
      expect(emittedEvents[0].sessionID).toBe("ses_test")
      // edit is write class: the observer backfill reaches the final output.
      expect(result["output"]).toContain(`LSP errors detected in this file, please fix:\n${block(filePath, "boom")}`)
    }),
  )

  it.instance("publishes a DSH projected read event with camelCase arguments", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      touchStarted = yield* Deferred.make<void>()
      const filePath = path.join(test.directory, "src", "foo.ts")
      // The dsh adapter maps container `file_path` to model-side `filePath`
      // and shadows the builtin read slot, so the pipeline receives this shape.
      registryTools = [toolDef("read", makeResult("file contents", { source: "dsh-container", containerTool: "read" }))]
      yield* registerObserver
      yield* registerRecorder

      const tools = yield* resolveTools()
      const result = yield* invoke(tools, "read", { filePath, offset: 2, limit: 100 })

      yield* awaitWithTimeout(Deferred.await(touchStarted), "touchFile was never invoked")
      expect(emittedEvents).toHaveLength(1)
      expect(emittedEvents[0].toolId).toBe("read")
      expect(emittedEvents[0].args).toEqual({ filePath, offset: 2, limit: 100 })
      expect(emittedEvents[0].filePaths).toEqual([filePath])
      expect(emittedEvents[0].sessionID).toBe("ses_test")
      expect(result["metadata"]).toMatchObject({ source: "dsh-container", containerTool: "read" })
    }),
  )

  it.instance("publishes no paths for tools outside the extraction table", () =>
    Effect.gen(function* () {
      registryTools = [toolDef("grep", makeResult("no matches"))]
      yield* registerObserver
      yield* registerRecorder

      const tools = yield* resolveTools()
      const result = yield* invoke(tools, "grep", { pattern: "foo" })

      expect(touchCalls).toEqual([])
      expect(result["output"]).toBe("no matches")
      // The event is still published with an empty path list.
      expect(emittedEvents).toHaveLength(1)
      expect(emittedEvents[0].toolId).toBe("grep")
      expect(emittedEvents[0].args).toEqual({ pattern: "foo" })
      expect(emittedEvents[0].filePaths).toEqual([])
      expect(emittedEvents[0].sessionID).toBe("ses_test")
    }),
  )

  truncatingIt.instance("appends full diagnostics after a real truncation and keeps outputPath clean", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "src", "foo.ts")
      const otherFiles = Array.from({ length: 6 }, (_, i) => path.join(test.directory, "other", `${i}.ts`))
      diagnosticsResult = {
        [filePath]: Array.from({ length: 25 }, (_, i) => errorDiag(`boom-${i}`)),
        ...Object.fromEntries(otherFiles.map((file, i) => [file, [errorDiag(`other-${i}`)]])),
      }
      const originalOutput = Array.from({ length: Truncate.MAX_LINES + 50 }, (_, i) => `line ${i + 1}`).join("\n")
      // The tool is defined through Tool.define, so Tool.init's execute applies
      // the real tool.ts wrap and truncates the output (no forged metadata).
      registryTools = [yield* wrappedToolDef("write", originalOutput)]
      yield* registerObserver
      yield* registerRecorder

      const tools = yield* resolveTools()
      const result = yield* invoke(tools, "write", { filePath, content: "x" })

      expect(result.metadata["truncated"]).toBe(true)
      const outputPath = result.metadata["outputPath"]
      const output = result.output
      const truncatedAt = output.indexOf("lines truncated")
      const diagnosticsAt = output.indexOf("LSP errors detected in this file, please fix:")
      // Diagnostics land after the truncation marker — they are appended to the
      // preview, not truncated themselves.
      expect(truncatedAt).toBeGreaterThan(-1)
      expect(diagnosticsAt).toBeGreaterThan(truncatedAt)
      // Single file: 20 of 25 errors are reported plus the overflow summary.
      expect(output).toContain("ERROR [1:1] boom-19")
      expect(output).not.toContain("ERROR [1:1] boom-20")
      expect(output).toContain("... and 5 more")
      // Multi-file: the 5-file cap applies to the other-files summary.
      expect(output).toContain("LSP errors detected in other files:")
      expect(output).toContain("other-0")
      expect(output).toContain("other-4")
      expect(output).not.toContain("other-5")
      expect(result.metadata["diagnostics"]).toEqual(diagnosticsResult)
      // The truncation file only holds the original tool output.
      const persisted = yield* Effect.promise(() => Bun.file(outputPath).text())
      expect(persisted).toBe(originalOutput)
      expect(persisted).not.toContain("<diagnostics")
      // The pipeline published the event for this call.
      expect(emittedEvents).toHaveLength(1)
      expect(emittedEvents[0].filePaths).toEqual([filePath])
    }),
  )
})

// ---------------------------------------------------------------------------
// Directory instruction mounting (SessionTools read wrapper)
// ---------------------------------------------------------------------------

const writeRule = (filepath: string, content: string) =>
  Effect.sync(() => {
    mkdirSync(path.dirname(filepath), { recursive: true })
    writeFileSync(filepath, content)
  })

// Minimal stored assistant message carrying a read result, used to frame the
// pre-transform history against the delivered request.
const storedReadMessage = (output: string): MessageV2.WithParts => {
  const messageID = MessageID.make("msg_stored-read")
  const sessionID = SessionID.make("ses_test")
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      parentID: MessageID.make("msg_parent"),
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelID.make("test-model"),
      providerID: ProviderID.make("test"),
      time: { created: 0 },
    },
    parts: [
      {
        id: PartID.make("prt_stored-read"),
        messageID,
        sessionID,
        type: "tool",
        callID: "call_stored",
        tool: "read",
        state: {
          status: "completed",
          input: {},
          output,
          title: "Read",
          metadata: {},
          time: { start: 0, end: 1 },
        },
      },
    ],
  }
}

const reminder = (rule: string, content: string) =>
  `\n\n<system-reminder>\nInstructions from: ${rule}\n${content}\n</system-reminder>`

describe("session-tools directory instructions", () => {
  it.instance("mounts nearby rules on a native read result", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const rule = path.join(test.directory, "src", "AGENTS.md")
      yield* writeRule(rule, "# Src Rule")
      registryTools = [toolDef("read", makeResult("file contents"))]

      const tools = yield* resolveTools()
      const result = yield* invoke(tools, "read", { filePath: path.join(test.directory, "src", "foo.ts") })

      expect(result["output"]).toBe(`file contents${reminder(rule, "# Src Rule")}`)
      expect(result["metadata"]).toEqual({ loaded: [rule] })
    }),
  )

  it.instance("mounts rules on a DSH projected read and keeps provider metadata", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const rule = path.join(test.directory, "src", "AGENTS.md")
      yield* writeRule(rule, "# Src Rule")
      registryTools = [
        toolDef("read", makeResult("container contents", { source: "dsh-container", containerTool: "read" })),
      ]

      const tools = yield* resolveTools()
      const result = yield* invoke(tools, "read", { filePath: path.join(test.directory, "src", "foo.ts") })

      expect(result["output"]).toBe(`container contents${reminder(rule, "# Src Rule")}`)
      expect(result["metadata"]).toMatchObject({
        source: "dsh-container",
        containerTool: "read",
        loaded: [rule],
      })
    }),
  )

  it.instance("does not repeat rules the native read already injected", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const rule = path.join(test.directory, "src", "AGENTS.md")
      yield* writeRule(rule, "# Src Rule")
      const output = `file contents${reminder(rule, "# Src Rule")}`
      registryTools = [toolDef("read", makeResult(output, { loaded: [rule] }))]

      const tools = yield* resolveTools()
      const result = yield* invoke(tools, "read", { filePath: path.join(test.directory, "src", "foo.ts") })

      expect(result["output"]).toBe(output)
      expect(result["metadata"]).toEqual({ loaded: [rule] })
    }),
  )

  it.instance("mounts rules for str_replace_editor view but not for its edit commands", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const rule = path.join(test.directory, "src", "AGENTS.md")
      yield* writeRule(rule, "# Src Rule")
      registryTools = [toolDef("str_replace_editor", makeResult("view output"))]

      const tools = yield* resolveTools()
      const viewed = yield* invoke(tools, "str_replace_editor", { command: "view", path: "src/foo.ts" })
      expect(viewed["output"]).toBe(`view output${reminder(rule, "# Src Rule")}`)

      registryTools = [toolDef("str_replace_editor", makeResult("edited"))]
      // A modification command is no longer a read: without the rules in
      // context it is suspended instead of running (Task 5).
      const editTools = yield* resolveTools()
      const edited = yield* invoke(editTools, "str_replace_editor", {
        command: "str_replace",
        path: "src/foo.ts",
        old_str: "a",
        new_str: "b",
      })
      expect(edited["output"]).toContain(rule)
      expect(edited["output"]).toMatch(/not modified|unmodified|unchanged/i)
    }),
  )

  it.instance("leaves directory listings and unreadable rules untouched", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const rule = path.join(test.directory, "src", "AGENTS.md")
      yield* writeRule(rule, "# Src Rule")
      mkdirSync(path.join(test.directory, "src", "nested"), { recursive: true })

      registryTools = [toolDef("read", makeResult("<type>directory</type>"))]
      const tools = yield* resolveTools()
      // Nested so the parent directory really owns a rule: a listing must still skip it.
      const listed = yield* invoke(tools, "read", { filePath: path.join(test.directory, "src", "nested") })
      expect(listed["output"]).toBe("<type>directory</type>")
      expect(listed["metadata"]).toEqual({ loaded: [] })

      chmodSync(rule, 0)
      registryTools = [toolDef("read", makeResult("file contents"))]
      const fileTools = yield* resolveTools()
      const unreadable = yield* invoke(fileTools, "read", { filePath: path.join(test.directory, "src", "foo.ts") })
      chmodSync(rule, 0o644)
      expect(unreadable["output"]).toBe("file contents")
      expect(unreadable["metadata"]).toEqual({ loaded: [] })
    }),
  )

  it.instance("keeps media attachments while mounting rules", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const rule = path.join(test.directory, "src", "AGENTS.md")
      yield* writeRule(rule, "# Src Rule")
      const attachment = { type: "file" as const, mime: "image/png", url: "data:image/png;base64,AAAA" }
      registryTools = [
        {
          id: "read",
          description: "read test tool",
          parameters: Schema.Unknown,
          jsonSchema: { type: "object", properties: {}, additionalProperties: true },
          execute: () => Effect.succeed({ ...makeResult("Image read successfully"), attachments: [attachment] }),
        },
      ]

      const tools = yield* resolveTools()
      const result = yield* invoke(tools, "read", { filePath: path.join(test.directory, "src", "foo.png") })

      expect(result["output"]).toBe(`Image read successfully${reminder(rule, "# Src Rule")}`)
      expect(result.attachments?.map((item) => item.mime)).toEqual(["image/png"])
    }),
  )

  it.instance("uses the batch-start context so parallel reads each mount the rule", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const rule = path.join(test.directory, "src", "AGENTS.md")
      yield* writeRule(rule, "# Src Rule")
      registryTools = [toolDef("read", makeResult("file contents"))]

      const tools = yield* resolveTools()
      const [first, second] = yield* Effect.all(
        [
          invoke(tools, "read", { filePath: path.join(test.directory, "src", "a.ts") }),
          invoke(tools, "read", { filePath: path.join(test.directory, "src", "b.ts") }),
        ],
        { concurrency: "unbounded" },
      )

      expect(first["output"]).toBe(`file contents${reminder(rule, "# Src Rule")}`)
      expect(second["output"]).toBe(`file contents${reminder(rule, "# Src Rule")}`)
    }),
  )

  it.instance("judges visibility from the caller's post-transform snapshot", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      // Rules are discovered by real path, so the reminder header must use it too.
      const root = realpathSync(test.directory)
      const rule = path.join(root, "src", "AGENTS.md")
      yield* writeRule(rule, "# Src Rule")
      registryTools = [toolDef("read", makeResult("file contents"))]

      // Pre-transform messages already carry the rule, but the request the model
      // actually received no longer does, so the wrapper must attach it again.
      const staleVisible: MessageV2.WithParts[] = [storedReadMessage(reminder(rule, "# Src Rule"))]
      const hiddenTools = yield* resolveTools({
        messages: staleVisible,
        // Filled after the caller transforms messages, so it is read lazily.
        instructionVisibility: () => ({ text: [{ text: "no rules survived the transform", loaded: [] }] }),
      })
      const hidden = yield* invoke(hiddenTools, "read", { filePath: path.join(root, "src", "foo.ts") })
      expect(hidden["output"]).toBe("file contents" + reminder(rule, "# Src Rule"))

      // The reverse: the delivered request does contain the rule, so it is not
      // attached a second time even though the stored messages look empty.
      const seenTools = yield* resolveTools({
        instructionVisibility: () => ({ text: [{ text: reminder(rule, "# Src Rule"), loaded: [rule] }] }),
      })
      const seen = yield* invoke(seenTools, "read", { filePath: path.join(root, "src", "foo.ts") })
      expect(seen["output"]).toBe("file contents")
    }),
  )

  it.instance("freezes the caller snapshot for the whole batch", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const root = realpathSync(test.directory)
      const rule = path.join(root, "src", "AGENTS.md")
      yield* writeRule(rule, "# Src Rule")
      registryTools = [toolDef("read", makeResult("file contents"))]

      // Simulate the caller publishing its post-transform snapshot only after
      // the first tool already ran: later calls must keep using that baseline.
      let snapshot: Instruction.Visibility | undefined
      const tools = yield* resolveTools({
        messages: [storedReadMessage(reminder(rule, "# Src Rule"))],
        instructionVisibility: () => snapshot,
      })

      const first = yield* invoke(tools, "read", { filePath: path.join(root, "src", "a.ts") })
      expect(first["output"]).toBe("file contents" + reminder(rule, "# Src Rule"))

      snapshot = { text: [{ text: reminder(rule, "# Src Rule"), loaded: [rule] }] }
      const [second, third] = yield* Effect.all(
        [
          invoke(tools, "read", { filePath: path.join(root, "src", "b.ts") }),
          invoke(tools, "read", { filePath: path.join(root, "src", "c.ts") }),
        ],
        { concurrency: "unbounded" },
      )
      expect(second["output"]).toBe("file contents" + reminder(rule, "# Src Rule"))
      expect(third["output"]).toBe("file contents" + reminder(rule, "# Src Rule"))
    }),
  )

  failingIt.instance("keeps a successful read intact when rule lookup throws", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const rule = path.join(test.directory, "src", "AGENTS.md")
      yield* writeRule(rule, "# Src Rule")
      const attachment = { type: "file" as const, mime: "image/png", url: "data:image/png;base64,AAAA" }
      registryTools = [
        {
          id: "read",
          description: "read test tool",
          parameters: Schema.Unknown,
          jsonSchema: { type: "object", properties: {}, additionalProperties: true },
          execute: () =>
            Effect.succeed({
              ...makeResult("Image read successfully", { preview: "Image read successfully", truncated: false }),
              attachments: [attachment],
            }),
        },
      ]
      yield* registerRecorder

      const tools = yield* resolveTools()
      const result = yield* invoke(tools, "read", { filePath: path.join(test.directory, "src", "foo.png") })

      expect(result["output"]).toBe("Image read successfully")
      expect(result["metadata"]).toEqual({ preview: "Image read successfully", truncated: false })
      expect(result.attachments?.map((item) => item.mime)).toEqual(["image/png"])
      expect(emittedEvents).toHaveLength(1)
      expect(emittedEvents[0].toolId).toBe("read")
      expect(emittedEvents[0].sessionID).toBe("ses_test")
    }),
  )

  it.instance("passes failed reads through without mounting", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const rule = path.join(test.directory, "src", "AGENTS.md")
      yield* writeRule(rule, "# Src Rule")
      registryTools = [
        {
          id: "read",
          description: "read test tool",
          parameters: Schema.Unknown,
          jsonSchema: { type: "object", properties: {}, additionalProperties: true },
          execute: () => Effect.die(new Error("read failed")),
        },
      ]

      const tools = yield* resolveTools()
      const exit = yield* invoke(tools, "read", { filePath: path.join(test.directory, "src", "foo.ts") }).pipe(
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})

// ---------------------------------------------------------------------------
// Modification preflight (write / edit / str_replace_editor)
// ---------------------------------------------------------------------------

const countingTool = (id: string, result: Tool.ExecuteResult): Tool.Def => ({
  id,
  description: id + " test tool",
  parameters: Schema.Unknown,
  jsonSchema: { type: "object", properties: {}, additionalProperties: true },
  execute: () =>
    Effect.sync(() => {
      executions.push(id)
      return result
    }),
})

describe("session-tools modification preflight", () => {
  it.instance("pauses a write whose directory rules the model has not seen", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const rule = path.join(test.directory, "src", "AGENTS.md")
      yield* writeRule(rule, "# Src Rule")
      const filePath = path.join(test.directory, "src", "foo.ts")
      diagnosticsResult = { [filePath]: [errorDiag("boom")] }
      registryTools = [countingTool("write", makeResult("Wrote file successfully."))]
      yield* registerRecorder

      const tools = yield* resolveTools()
      const result = yield* invoke(tools, "write", { filePath, content: "x" })

      expect(executions).toEqual([])
      expect(emittedEvents).toEqual([])
      expect(touchCalls).toEqual([])
      expect(result.metadata).toMatchObject({ loaded: [rule] })
      expect(result.output).toContain(rule)
      expect(result.output).toContain("# Src Rule")
      expect(result.output).toMatch(/not modified|unmodified|unchanged/i)
    }),
  )

  it.instance("pauses an edit and a str_replace_editor modification the same way", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const rule = path.join(test.directory, "src", "AGENTS.md")
      yield* writeRule(rule, "# Src Rule")
      registryTools = [
        countingTool("edit", makeResult("Edit applied successfully.")),
        countingTool("str_replace_editor", makeResult("Edited")),
      ]
      yield* registerRecorder

      const tools = yield* resolveTools()
      const edit = yield* invoke(tools, "edit", {
        filePath: path.join(test.directory, "src", "a.ts"),
        oldString: "a",
        newString: "b",
      })
      const replace = yield* invoke(tools, "str_replace_editor", {
        command: "str_replace",
        path: "src/b.ts",
        old_str: "a",
        new_str: "b",
      })

      expect(executions).toEqual([])
      expect(emittedEvents).toEqual([])
      expect(edit.output).toContain(rule)
      expect(replace.output).toContain(rule)
    }),
  )

  it.instance("allows the retry once the rules are visible in the next request", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const root = realpathSync(test.directory)
      const rule = path.join(root, "src", "AGENTS.md")
      yield* writeRule(rule, "# Src Rule")
      registryTools = [countingTool("write", makeResult("Wrote file successfully."))]
      yield* registerRecorder

      const first = yield* resolveTools()
      const paused = yield* invoke(first, "write", { filePath: path.join(root, "src", "a.ts"), content: "x" })
      expect(executions).toEqual([])
      expect(paused.output).toContain(rule)

      const retry = yield* resolveTools({
        instructionVisibility: () => ({ text: [{ text: reminder(rule, "# Src Rule"), loaded: [rule] }] }),
      })
      const applied = yield* invoke(retry, "write", { filePath: path.join(root, "src", "a.ts"), content: "x" })

      expect(executions).toEqual(["write"])
      expect(applied.output).toBe("Wrote file successfully.")
      expect(emittedEvents).toHaveLength(1)
      expect(emittedEvents[0].toolId).toBe("write")
    }),
  )

  it.instance("does not let a parallel read of the same batch authorize a write", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const root = realpathSync(test.directory)
      const rule = path.join(root, "src", "AGENTS.md")
      yield* writeRule(rule, "# Src Rule")
      registryTools = [
        countingTool("read", makeResult("file contents")),
        countingTool("write", makeResult("Wrote file successfully.")),
      ]
      yield* registerRecorder

      const tools = yield* resolveTools({ instructionVisibility: () => ({ text: [] }) })
      const [read, write] = yield* Effect.all(
        [
          invoke(tools, "read", { filePath: path.join(root, "src", "a.ts") }),
          invoke(tools, "write", { filePath: path.join(root, "src", "a.ts"), content: "x" }),
        ],
        { concurrency: "unbounded" },
      )

      expect(read.output).toContain(rule)
      expect(write.output).toContain(rule)
      expect(executions).toEqual(["read"])
      expect(emittedEvents.map((event) => event.toolId)).toEqual(["read"])
    }),
  )

  it.instance("rejects a modification when an applicable rule cannot be read", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const rule = path.join(test.directory, "src", "AGENTS.md")
      yield* writeRule(rule, "# Src Rule")
      chmodSync(rule, 0)
      const filePath = path.join(test.directory, "src", "foo.ts")
      registryTools = [countingTool("write", makeResult("Wrote file successfully."))]
      yield* registerRecorder

      const tools = yield* resolveTools()
      const result = yield* invoke(tools, "write", { filePath, content: "x" })
      chmodSync(rule, 0o644)

      expect(executions).toEqual([])
      expect(emittedEvents).toEqual([])
      expect(result.output).toMatch(/not modified|unmodified|unchanged/i)
      expect(result.output).not.toContain("# Src Rule")
    }),
  )

  it.instance("runs a modification normally when the directory has no extra rules", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      registryTools = [countingTool("write", makeResult("Wrote file successfully."))]
      yield* registerRecorder

      const tools = yield* resolveTools()
      const result = yield* invoke(tools, "write", { filePath: path.join(test.directory, "plain.ts"), content: "x" })

      expect(executions).toEqual(["write"])
      expect(result.output).toBe("Wrote file successfully.")
      expect(emittedEvents).toHaveLength(1)
    }),
  )

  it.instance("checks the rule before overwriting that rule file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const rule = path.join(test.directory, "src", "AGENTS.md")
      yield* writeRule(rule, "# Src Rule")
      registryTools = [countingTool("write", makeResult("Wrote file successfully."))]
      yield* registerRecorder

      const first = yield* resolveTools()
      const paused = yield* invoke(first, "write", { filePath: rule, content: "replacement" })

      expect(executions).toEqual([])
      expect(emittedEvents).toEqual([])
      expect(paused.metadata).toMatchObject({ loaded: [rule] })
      expect(paused.output).toContain(rule)
      expect(paused.output).toMatch(/not modified|unmodified|unchanged/i)

      const retry = yield* resolveTools({
        instructionVisibility: () => ({ text: [{ text: reminder(rule, "# Src Rule"), loaded: [rule] }] }),
      })
      const applied = yield* invoke(retry, "write", { filePath: rule, content: "replacement" })

      expect(executions).toEqual(["write"])
      expect(emittedEvents).toHaveLength(1)
      expect(applied.output).toBe("Wrote file successfully.")
    }),
  )

  it.instance("rejects a write when an applicable baseline rule cannot be read", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const rule = path.join(test.directory, "AGENTS.md")
      yield* writeRule(rule, "# Root Rule")
      const filePath = path.join(test.directory, "plain.ts")
      registryTools = [countingTool("write", makeResult("Wrote file successfully."))]
      yield* registerRecorder

      chmodSync(rule, 0)
      const tools = yield* resolveTools()
      const paused = yield* invoke(tools, "write", { filePath, content: "x" })
      chmodSync(rule, 0o644)

      expect(executions).toEqual([])
      expect(emittedEvents).toEqual([])
      expect(paused.output).toMatch(/not modified|unmodified|unchanged/i)
      expect(paused.output).not.toContain("# Root Rule")

      const applied = yield* invoke(tools, "write", { filePath, content: "x" })
      expect(executions).toEqual(["write"])
      expect(emittedEvents).toHaveLength(1)
      expect(applied.output).toBe("Wrote file successfully.")
    }),
  )

  it.instance("keeps a request-time baseline failure after the rule becomes readable", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const rule = path.join(test.directory, "AGENTS.md")
      yield* writeRule(rule, "# Root Rule")
      const filePath = path.join(test.directory, "plain.ts")
      registryTools = [countingTool("write", makeResult("Wrote file successfully."))]
      yield* registerRecorder
      const instruction = yield* Instruction.Service

      chmodSync(rule, 0)
      const request = yield* instruction.systemResult()
      chmodSync(rule, 0o644)
      expect(request.baseline.errors.map((item) => item.filepath)).toEqual([rule])

      const tools = yield* resolveTools({
        instructionVisibility: () => ({ text: [], baseline: request.baseline }),
      })
      const paused = yield* invoke(tools, "write", { filePath, content: "x" })

      expect(executions).toEqual([])
      expect(emittedEvents).toEqual([])
      expect(paused.output).toMatch(/not modified|unmodified|unchanged/i)
    }),
  )
})
