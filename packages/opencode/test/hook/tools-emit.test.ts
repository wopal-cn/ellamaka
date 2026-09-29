import { beforeEach, describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Schema } from "effect"
import path from "path"
import { Agent } from "@/agent/agent"
import { InternalHook } from "@/hook/internal-hook"
import { InstanceState } from "@/effect/instance-state"
import { LSP } from "@/lsp/lsp"
import { LSPObserver } from "@/lsp/lsp-observer"
import type { LSPClient } from "@/lsp/client"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { SessionID, MessageID } from "@/session/schema"
import { SessionTools } from "@/session/tools"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

// ---------------------------------------------------------------------------
// Mock state shared by the pipeline mocks (reset per test).
// ---------------------------------------------------------------------------

type TouchCall = { path: string; mode: "document" | "full" | undefined }

let touchCalls: TouchCall[] = []
let diagnosticsResult: Record<string, LSPClient.Diagnostic[]> = {}
let touchStarted: Deferred.Deferred<void> | undefined
let registryTools: Tool.Def[] = []
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

const it = testEffect(
  Layer.mergeAll(InternalHook.defaultLayer, mockLsp, mockPlugin, mockPermission, mockRegistry, mockMcp, mockTruncate),
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
  ),
)

beforeEach(() => {
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

const resolveTools = Effect.fn("test.resolveTools")(function* () {
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
      expect(result["metadata"]).toEqual({})
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
