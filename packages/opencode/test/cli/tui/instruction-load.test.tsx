/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { testRender, type JSX } from "@opentui/solid"
import type { Part, ToolPart } from "@wopal/ellamaka-sdk/v2"
import { PathFormatterProvider, usePathFormatter } from "../../../src/cli/cmd/tui/context/path-format"
import {
  instructionSourcePaths,
  LoadedInstructionRows,
  toolLoadedRules,
  userInstructionSourcePaths,
} from "../../../src/cli/cmd/tui/routes/session/instruction-load"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

function textPart(overrides: Partial<Extract<Part, { type: "text" }>> = {}): Extract<Part, { type: "text" }> {
  return {
    id: "prt_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "text",
    text: "hello",
    ...overrides,
  }
}

function makeToolPart(state: ToolPart["state"], tool = "edit"): ToolPart {
  return {
    id: "prt_tool_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool,
    state,
  }
}

async function renderFrame(component: () => JSX.Element, options = { width: 80, height: 10 }) {
  testSetup = await testRender(component, options)
  await testSetup.renderOnce()
  await testSetup.renderOnce()
  return testSetup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
}

function RowsHarness(props: { paths: readonly string[]; suspended?: boolean; marginTop?: number }) {
  const pathFormatter = usePathFormatter()
  return (
    <LoadedInstructionRows
      paths={props.paths}
      format={pathFormatter.format}
      suspended={props.suspended}
      marginTop={props.marginTop}
    />
  )
}

describe("TUI instructionSourcePaths", () => {
  test("parses synthetic ignored instruction source payloads and ignores non-matching parts", () => {
    const valid = textPart({
      synthetic: true,
      ignored: true,
      text: '<rules-context>\n[WOPAL INSTRUCTION SOURCES]\n["/repo/AGENTS.md","/repo/.wopal-space/REGULATIONS.md"]\n</rules-context>',
    })
    expect(instructionSourcePaths(valid)).toEqual(["/repo/AGENTS.md", "/repo/.wopal-space/REGULATIONS.md"])

    expect(instructionSourcePaths(textPart({ text: valid.text }))).toBeUndefined()
    expect(instructionSourcePaths(textPart({ synthetic: true, text: valid.text }))).toBeUndefined()
    expect(
      instructionSourcePaths(
        textPart({
          synthetic: true,
          ignored: true,
          text: "<rules-context>\n[WOPAL INSTRUCTION SOURCES]\n{bad json\n</rules-context>",
        }),
      ),
    ).toBeUndefined()
    expect(
      instructionSourcePaths(
        textPart({
          synthetic: true,
          ignored: true,
          text: '<rules-context>\n[WOPAL INSTRUCTION SOURCES]\n["/repo/AGENTS.md",123]\n</rules-context>',
        }),
      ),
    ).toBeUndefined()
  })

  test("collects and deduplicates user instruction source paths while preserving first-seen order", () => {
    const parts: Part[] = [
      textPart({ id: "p1", text: "regular prompt" }),
      textPart({
        id: "p2",
        synthetic: true,
        ignored: true,
        text: '<rules-context>\n[WOPAL INSTRUCTION SOURCES]\n["/repo/AGENTS.md","/repo/.wopal-space/STRUCTURE.md"]\n</rules-context>',
      }),
      textPart({
        id: "p3",
        synthetic: true,
        ignored: true,
        text: '<rules-context>\n[WOPAL INSTRUCTION SOURCES]\n["/repo/.wopal-space/STRUCTURE.md","/repo/.wopal-space/REGULATIONS.md"]\n</rules-context>',
      }),
    ]
    expect(userInstructionSourcePaths(parts)).toEqual([
      "/repo/AGENTS.md",
      "/repo/.wopal-space/STRUCTURE.md",
      "/repo/.wopal-space/REGULATIONS.md",
    ])
  })
})

describe("TUI toolLoadedRules", () => {
  test("extracts loaded paths and suspended state for completed non-compacted tools", () => {
    const withPaths = makeToolPart({
      status: "completed",
      input: { filePath: "/repo/src/a.ts" },
      output: "File not modified",
      title: "Instructions required",
      metadata: { loaded: ["/repo/src/AGENTS.md", "/repo/src/AGENTS.md"] },
      time: { start: 1, end: 2 },
    })
    expect(toolLoadedRules(withPaths)).toEqual({ loaded: ["/repo/src/AGENTS.md"], suspended: true })

    const deduplicatedEmpty = makeToolPart({
      status: "completed",
      input: { filePath: "/repo/src/b.ts" },
      output:
        "File not modified. Applicable instructions for this file were already attached to another tool result in this batch.",
      title: "Instructions required",
      metadata: { loaded: [] },
      time: { start: 1, end: 2 },
    })
    expect(toolLoadedRules(deduplicatedEmpty)).toEqual({ loaded: [], suspended: true })

    const compacted = makeToolPart({
      status: "completed",
      input: { filePath: "/repo/src/b.ts" },
      output: "File not modified",
      title: "Instructions required",
      metadata: { loaded: ["/repo/src/AGENTS.md"] },
      time: { start: 1, end: 2, compacted: 3 },
    })
    expect(toolLoadedRules(compacted)).toEqual({ loaded: [], suspended: false })

    const running = makeToolPart({
      status: "running",
      input: { filePath: "/repo/src/b.ts" },
      time: { start: 1 },
    })
    expect(toolLoadedRules(running)).toEqual({ loaded: [], suspended: false })
  })
})

describe("TUI LoadedInstructionRows", () => {
  test("renders baseline instruction paths formatted relative to project root", async () => {
    const frame = await renderFrame(() => (
      <PathFormatterProvider path="/repo">
        <RowsHarness paths={["/repo/AGENTS.md", "/repo/.wopal-space/REGULATIONS.md"]} />
      </PathFormatterProvider>
    ))
    expect(frame).toContain("↳ Loaded AGENTS.md")
    expect(frame).toContain("↳ Loaded .wopal-space/REGULATIONS.md")
    expect(frame).not.toContain("File not modified; retry required")
  })

  test("renders both loaded paths and retry warning when suspended with paths", async () => {
    const frame = await renderFrame(() => (
      <PathFormatterProvider path="/repo">
        <RowsHarness paths={["/repo/src/AGENTS.md"]} suspended />
      </PathFormatterProvider>
    ))
    expect(frame).toContain("↳ Loaded src/AGENTS.md")
    expect(frame).toContain("File not modified; retry required")
  })

  test("renders retry warning even when batch deduplication left paths empty", async () => {
    const frame = await renderFrame(() => (
      <PathFormatterProvider path="/repo">
        <RowsHarness paths={[]} suspended />
      </PathFormatterProvider>
    ))
    expect(frame).not.toContain("↳ Loaded")
    expect(frame).toContain("File not modified; retry required")
  })

  test("renders nothing when paths are empty and not suspended", async () => {
    const frame = await renderFrame(() => (
      <PathFormatterProvider path="/repo">
        <RowsHarness paths={[]} />
      </PathFormatterProvider>
    ))
    expect(frame).toBe("")
  })
})
