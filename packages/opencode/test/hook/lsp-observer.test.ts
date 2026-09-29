import { beforeEach, describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Schema } from "effect"
import path from "path"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { InternalHook } from "@/hook/internal-hook"
import { LSP } from "@/lsp/lsp"
import { LSPObserver } from "@/lsp/lsp-observer"
import type { LSPClient } from "@/lsp/client"
import { MessageID, SessionID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testEffect, awaitWithTimeout } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

// ---------------------------------------------------------------------------
// Shared mock state. The layer runner builds a fresh layer per test, but the
// mock closures read this module state at call time; beforeEach resets it.
// ---------------------------------------------------------------------------

type TouchCall = { path: string; mode: "document" | "full" | undefined }

let touchCalls: TouchCall[] = []
let diagnosticsResult: Record<string, LSPClient.Diagnostic[]> = {}
let touchGate: Deferred.Deferred<void> | undefined
let touchStarted: Deferred.Deferred<void> | undefined
let configValue: Config.Info = {}

const mockLsp = Layer.mock(LSP.Service)({
  touchFile: (input: string, mode?: "document" | "full") =>
    Effect.gen(function* () {
      touchCalls.push({ path: input, mode })
      if (touchStarted) yield* Deferred.succeed(touchStarted, undefined)
      if (touchGate) yield* Deferred.await(touchGate)
    }),
  diagnostics: () => Effect.succeed(diagnosticsResult),
})

const mockConfig = Layer.mock(Config.Service)({
  get: () => Effect.succeed(configValue),
})

const mockAgent = Layer.mock(Agent.Service)({
  get: () => Effect.succeed({ name: "build", mode: "primary", permission: [], options: {} }),
})

// Behavior tests register the observer explicitly; registration tests exercise
// the config-gated LSPObserver layer.
const behaviorLayer = Layer.mergeAll(InternalHook.defaultLayer, mockLsp)
const observerGraph = (configLayer: Layer.Layer<Config.Service>) =>
  LSPObserver.layer.pipe(Layer.provideMerge(Layer.mergeAll(InternalHook.defaultLayer, mockLsp, configLayer)))

const behaviorIt = testEffect(behaviorLayer)
const mockedConfigIt = testEffect(observerGraph(mockConfig))
const realConfigIt = testEffect(observerGraph(Config.defaultLayer))

// The truncation-chain test runs a tool through the real tool.ts wrap, which
// needs the real Truncate service; the behavior suite mocks LSP only, so that
// test gets its own runner.
const truncationIt = testEffect(Layer.mergeAll(InternalHook.defaultLayer, mockLsp, Truncate.defaultLayer, mockAgent))

beforeEach(() => {
  touchCalls = []
  diagnosticsResult = {}
  touchGate = undefined
  touchStarted = undefined
  configValue = {}
})

const errorDiag = (message: string): LSPClient.Diagnostic =>
  ({
    severity: 1,
    message,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  }) as LSPClient.Diagnostic

const warnDiag = (message: string): LSPClient.Diagnostic =>
  ({
    severity: 2,
    message,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  }) as LSPClient.Diagnostic

const makeResult = (output: string, metadata: Record<string, unknown> = {}) => ({
  title: "title",
  metadata,
  output,
})

const block = (file: string, message: string) => `<diagnostics file="${file}">\nERROR [1:1] ${message}\n</diagnostics>`

const registerObserver = Effect.gen(function* () {
  const hook = yield* InternalHook.Service
  const lsp = yield* LSP.Service
  yield* hook.register(LSPObserver.observer(lsp))
  return hook
})

const toolContext = (): Tool.Context => ({
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

describe("lsp-observer", () => {
  describe("read class", () => {
    behaviorIt.instance("read touches the file without diagnostics and leaves the result alone", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        touchStarted = yield* Deferred.make<void>()
        const hook = yield* registerObserver
        const result = makeResult("file contents")
        const filePath = path.join(test.directory, "src", "foo.ts")

        yield* hook.emit({
          toolId: "read",
          args: { filePath: "src/foo.ts" },
          filePaths: ["src/foo.ts"],
          result,
          sessionID: "ses_test",
        })

        yield* awaitWithTimeout(Deferred.await(touchStarted), "touchFile was never invoked")
        expect(touchCalls).toEqual([{ path: filePath, mode: undefined }])
        expect(result.output).toBe("file contents")
        expect(result.metadata).toEqual({})
      }),
    )

    behaviorIt.instance("read forks touchFile without blocking the emit call", () =>
      Effect.gen(function* () {
        touchGate = yield* Deferred.make<void>()
        touchStarted = yield* Deferred.make<void>()
        const hook = yield* registerObserver
        const result = makeResult("file contents")

        yield* hook.emit({
          toolId: "read",
          args: { filePath: "src/foo.ts" },
          filePaths: ["src/foo.ts"],
          result,
          sessionID: "ses_test",
        })

        // emit returned while touchFile is still held at the gate.
        yield* awaitWithTimeout(Deferred.await(touchStarted), "touchFile was never invoked")
        expect(result.output).toBe("file contents")
        yield* Deferred.succeed(touchGate, undefined)
      }),
    )

    behaviorIt.instance("str_replace_editor view is read class: no diagnostics, no backfill", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        touchStarted = yield* Deferred.make<void>()
        diagnosticsResult = { [path.join(test.directory, "src", "foo.ts")]: [errorDiag("boom")] }
        const hook = yield* registerObserver
        const result = makeResult("view output")

        yield* hook.emit({
          toolId: "str_replace_editor",
          args: { command: "view", path: "src/foo.ts" },
          filePaths: ["src/foo.ts"],
          result,
          sessionID: "ses_test",
        })

        yield* awaitWithTimeout(Deferred.await(touchStarted), "touchFile was never invoked")
        expect(touchCalls).toEqual([{ path: path.join(test.directory, "src", "foo.ts"), mode: undefined }])
        expect(result.output).toBe("view output")
        expect(result.metadata).toEqual({})
      }),
    )
  })

  describe("write class", () => {
    behaviorIt.instance("write blocks on diagnostics and backfills this-file errors", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filePath = path.join(test.directory, "src", "foo.ts")
        diagnosticsResult = { [filePath]: [errorDiag("boom")] }
        const hook = yield* registerObserver
        const result = makeResult("Wrote file successfully.", { filepath: filePath, exists: false })

        yield* hook.emit({
          toolId: "write",
          args: { filePath, content: "x" },
          filePaths: [filePath],
          result,
          sessionID: "ses_test",
        })

        expect(touchCalls).toEqual([{ path: filePath, mode: "document" }])
        expect(result.output).toBe(
          `Wrote file successfully.\n\nLSP errors detected in this file, please fix:\n${block(filePath, "boom")}`,
        )
        expect(result.metadata["diagnostics"]).toEqual(diagnosticsResult)
        expect(result.metadata["filepath"]).toBe(filePath)
      }),
    )

    behaviorIt.instance("write summarizes other files with the 5-file cap and skips non-error files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filePath = path.join(test.directory, "src", "foo.ts")
        const others = Array.from({ length: 6 }, (_, i) => path.join(test.directory, "other", `${i}.ts`))
        diagnosticsResult = {
          [others[0]]: [warnDiag("warning only")],
          [others[1]]: [errorDiag("one")],
          [others[2]]: [errorDiag("two")],
          [others[3]]: [errorDiag("three")],
          [others[4]]: [errorDiag("four")],
          [others[5]]: [errorDiag("five")],
          [filePath]: [errorDiag("boom")],
          [path.join(test.directory, "other", "6.ts")]: [errorDiag("six")],
        }
        const hook = yield* registerObserver
        const result = makeResult("Wrote file successfully.")

        yield* hook.emit({
          toolId: "write",
          args: { filePath },
          filePaths: [filePath],
          result,
          sessionID: "ses_test",
        })

        // The warn-only file yields no block and does not consume the cap; the
        // sixth error file is skipped.
        expect(result.output).toContain(`LSP errors detected in this file, please fix:\n${block(filePath, "boom")}`)
        const summarized = [
          [others[1], "one"],
          [others[2], "two"],
          [others[3], "three"],
          [others[4], "four"],
          [others[5], "five"],
        ] as const
        for (const [file, message] of summarized) {
          expect(result.output).toContain(`LSP errors detected in other files:\n${block(file, message)}`)
        }
        expect(result.output).not.toContain("six")
        expect(result.output).not.toContain("warning only")
        expect(result.metadata["diagnostics"]).toEqual(diagnosticsResult)
      }),
    )

    behaviorIt.instance("edit backfills this-file errors", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filePath = path.join(test.directory, "src", "foo.ts")
        diagnosticsResult = { [filePath]: [errorDiag("boom")] }
        const hook = yield* registerObserver
        const result = makeResult("Edit applied successfully.", { diff: "diff" })

        yield* hook.emit({
          toolId: "edit",
          args: { filePath },
          filePaths: [filePath],
          result,
          sessionID: "ses_test",
        })

        expect(touchCalls).toEqual([{ path: filePath, mode: "document" }])
        expect(result.output).toBe(
          `Edit applied successfully.\n\nLSP errors detected in this file, please fix:\n${block(filePath, "boom")}`,
        )
        expect(result.metadata["diagnostics"]).toEqual(diagnosticsResult)
        expect(result.metadata["diff"]).toBe("diff")
      }),
    )

    behaviorIt.instance("str_replace_editor non-view commands use edit semantics", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filePath = path.join(test.directory, "src", "foo.ts")
        diagnosticsResult = { [filePath]: [errorDiag("boom")] }
        const hook = yield* registerObserver
        const result = makeResult("Edited src/foo.ts")

        yield* hook.emit({
          toolId: "str_replace_editor",
          args: { command: "str_replace", path: "src/foo.ts" },
          filePaths: ["src/foo.ts"],
          result,
          sessionID: "ses_test",
        })

        expect(touchCalls).toEqual([{ path: filePath, mode: "document" }])
        expect(result.output).toBe(
          `Edited src/foo.ts\n\nLSP errors detected in this file, please fix:\n${block(filePath, "boom")}`,
        )
        expect(result.metadata["diagnostics"]).toEqual(diagnosticsResult)
      }),
    )

    behaviorIt.instance("apply_patch backfills every file and keeps title equal to output", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ctx = yield* InstanceState.context
        const first = path.join(test.directory, "a.ts")
        const second = path.join(test.directory, "moved.ts")
        const rel = (file: string) => path.relative(ctx.worktree, file).replaceAll("\\", "/")
        diagnosticsResult = {
          [first]: [errorDiag("boom-a")],
          [second]: [errorDiag("boom-b")],
        }
        const hook = yield* registerObserver
        const result = makeResult("Success. Updated the following files:\nA a.ts\nM moved.ts")

        yield* hook.emit({
          toolId: "apply_patch",
          args: { patchText: "*** Begin Patch" },
          filePaths: [first, second],
          result,
          sessionID: "ses_test",
        })

        expect(touchCalls).toEqual([
          { path: first, mode: "document" },
          { path: second, mode: "document" },
        ])
        expect(result.output).toBe(
          [
            "Success. Updated the following files:\nA a.ts\nM moved.ts",
            `LSP errors detected in ${rel(first)}, please fix:\n${block(first, "boom-a")}`,
            `LSP errors detected in ${rel(second)}, please fix:\n${block(second, "boom-b")}`,
          ].join("\n\n"),
        )
        expect(result.title).toBe(result.output)
        expect(result.metadata["diagnostics"]).toEqual(diagnosticsResult)
      }),
    )

    behaviorIt.instance("empty diagnostics still collect and do not append text", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filePath = path.join(test.directory, "src", "foo.ts")
        diagnosticsResult = {}
        const hook = yield* registerObserver
        const result = makeResult("Wrote file successfully.")

        yield* hook.emit({
          toolId: "write",
          args: { filePath },
          filePaths: [filePath],
          result,
          sessionID: "ses_test",
        })

        expect(touchCalls).toEqual([{ path: filePath, mode: "document" }])
        expect(result.output).toBe("Wrote file successfully.")
        expect(result.metadata["diagnostics"]).toEqual({})
      }),
    )

    behaviorIt.instance("reports at most 20 errors per file with an overflow summary", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filePath = path.join(test.directory, "src", "foo.ts")
        diagnosticsResult = {
          [filePath]: Array.from({ length: 25 }, (_, i) => errorDiag(`boom-${i}`)),
        }
        const hook = yield* registerObserver
        const result = makeResult("Wrote file successfully.")

        yield* hook.emit({
          toolId: "write",
          args: { filePath },
          filePaths: [filePath],
          result,
          sessionID: "ses_test",
        })

        expect(result.output).toContain("ERROR [1:1] boom-19")
        expect(result.output).not.toContain("ERROR [1:1] boom-20")
        expect(result.output).toContain("... and 5 more")
      }),
    )

    truncationIt.instance("appends diagnostics after a real tool truncation and never touches outputPath", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filePath = path.join(test.directory, "src", "foo.ts")
        const originalOutput = Array.from({ length: Truncate.MAX_LINES + 20 }, (_, i) => `line ${i + 1}`).join("\n")
        // Real wrap: Tool.define/Tool.init route the tool output through the
        // production tool.ts truncation path (this output exceeds the line cap),
        // so the truncated state is produced by the engine, not forged.
        const info = yield* Tool.define(
          "write",
          Effect.succeed({
            description: "synthetic long-output write tool",
            parameters: Schema.Unknown,
            jsonSchema: { type: "object", properties: {}, additionalProperties: true },
            execute: (): Effect.Effect<Tool.ExecuteResult> => Effect.succeed(makeResult(originalOutput)),
          }),
        )
        const tool = yield* Tool.init(info)
        const result = yield* tool.execute({ filePath, content: "x" }, toolContext())

        expect(result.metadata["truncated"]).toBe(true)
        const outputPath = result.metadata["outputPath"]
        diagnosticsResult = { [filePath]: Array.from({ length: 25 }, (_, i) => errorDiag(`boom-${i}`)) }
        const hook = yield* registerObserver

        yield* hook.emit({
          toolId: "write",
          args: { filePath, content: "x" },
          filePaths: [filePath],
          result,
          sessionID: "ses_test",
        })

        expect(touchCalls).toEqual([{ path: filePath, mode: "document" }])
        const truncatedAt = result.output.indexOf("lines truncated")
        const diagnosticsAt = result.output.indexOf("LSP errors detected in this file, please fix:")
        // Backfill lands after the truncation marker: diagnostics are appended
        // to the preview and are not truncated themselves.
        expect(truncatedAt).toBeGreaterThan(-1)
        expect(diagnosticsAt).toBeGreaterThan(truncatedAt)
        expect(result.output).toContain("ERROR [1:1] boom-19")
        expect(result.output).not.toContain("ERROR [1:1] boom-20")
        expect(result.output).toContain("... and 5 more")
        expect(result.metadata["diagnostics"]).toEqual(diagnosticsResult)
        // The truncation file only holds the original tool output.
        const persisted = yield* Effect.promise(() => Bun.file(outputPath).text())
        expect(persisted).toBe(originalOutput)
        expect(persisted).not.toContain("<diagnostics")
      }),
    )
  })

  describe("registration", () => {
    const writeEvent = (filePath: string) => ({
      toolId: "write",
      args: { filePath },
      filePaths: [filePath],
      result: makeResult("Wrote file successfully."),
      sessionID: "ses_test",
    })

    mockedConfigIt.instance("does not register when lsp is unset", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        configValue = {}
        const observer = yield* LSPObserver.Service
        const hook = yield* InternalHook.Service
        yield* observer.init()

        yield* hook.emit(writeEvent(path.join(test.directory, "src", "foo.ts")))

        expect(touchCalls).toEqual([])
      }),
    )

    mockedConfigIt.instance("does not register when lsp is false", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        configValue = { lsp: false }
        const observer = yield* LSPObserver.Service
        const hook = yield* InternalHook.Service
        yield* observer.init()

        yield* hook.emit(writeEvent(path.join(test.directory, "src", "foo.ts")))

        expect(touchCalls).toEqual([])
      }),
    )

    mockedConfigIt.instance("registers when lsp is true", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filePath = path.join(test.directory, "src", "foo.ts")
        configValue = { lsp: true }
        const observer = yield* LSPObserver.Service
        const hook = yield* InternalHook.Service
        yield* observer.init()

        yield* hook.emit(writeEvent(filePath))

        expect(touchCalls).toEqual([{ path: filePath, mode: "document" }])
      }),
    )

    mockedConfigIt.instance("registers when lsp is a server config object", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filePath = path.join(test.directory, "src", "foo.ts")
        configValue = { lsp: { eslint: { disabled: true } } }
        const observer = yield* LSPObserver.Service
        const hook = yield* InternalHook.Service
        yield* observer.init()

        yield* hook.emit(writeEvent(filePath))

        expect(touchCalls).toEqual([{ path: filePath, mode: "document" }])
      }),
    )

    realConfigIt.instance(
      "registers through the real config when lsp is true",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const filePath = path.join(test.directory, "src", "foo.ts")
          const observer = yield* LSPObserver.Service
          const hook = yield* InternalHook.Service
          yield* observer.init()

          yield* hook.emit(writeEvent(filePath))

          expect(touchCalls).toEqual([{ path: filePath, mode: "document" }])
        }),
      { config: { lsp: true } },
    )
  })
})
