import { describe, expect, test } from "bun:test"
import {
  formatInstructionSources,
  INSTRUCTION_SOURCES_END,
  INSTRUCTION_SOURCES_START,
  instructionSourcePaths,
  parseInstructionSourcesText,
} from "../../src/util/instruction-sources"

describe("instruction sources protocol", () => {
  test("round-trips path lists through formatInstructionSources and parseInstructionSourcesText", () => {
    const paths = ["/repo/AGENTS.md", "/repo/.wopal-space/REGULATIONS.md"]
    const encoded = formatInstructionSources(paths)
    expect(encoded.startsWith(INSTRUCTION_SOURCES_START)).toBe(true)
    expect(encoded.endsWith(INSTRUCTION_SOURCES_END)).toBe(true)
    expect(parseInstructionSourcesText(encoded)).toEqual(paths)
    expect(formatInstructionSources([])).toBe(`${INSTRUCTION_SOURCES_START}[]${INSTRUCTION_SOURCES_END}`)
    expect(parseInstructionSourcesText(formatInstructionSources([]))).toEqual([])
  })

  test("rejects malformed or mismatched text payloads", () => {
    expect(parseInstructionSourcesText("<rules-context>normal rules</rules-context>")).toBeUndefined()
    expect(
      parseInstructionSourcesText(`${INSTRUCTION_SOURCES_START}{bad json${INSTRUCTION_SOURCES_END}`),
    ).toBeUndefined()
    expect(parseInstructionSourcesText(`${INSTRUCTION_SOURCES_START}{}${INSTRUCTION_SOURCES_END}`)).toBeUndefined()
    expect(
      parseInstructionSourcesText(`${INSTRUCTION_SOURCES_START}["/repo/AGENTS.md",123]${INSTRUCTION_SOURCES_END}`),
    ).toBeUndefined()
  })

  test("instructionSourcePaths accepts only ignored synthetic text parts", () => {
    const validText = formatInstructionSources(["/repo/AGENTS.md", "/repo/.wopal-space/STRUCTURE.md"])
    expect(
      instructionSourcePaths({
        type: "text",
        synthetic: true,
        ignored: true,
        text: validText,
      }),
    ).toEqual(["/repo/AGENTS.md", "/repo/.wopal-space/STRUCTURE.md"])

    expect(instructionSourcePaths({ type: "text", text: validText })).toBeUndefined()
    expect(instructionSourcePaths({ type: "text", synthetic: true, text: validText })).toBeUndefined()
    expect(instructionSourcePaths({ type: "text", ignored: true, text: validText })).toBeUndefined()
    expect(instructionSourcePaths({ type: "tool", synthetic: true, ignored: true, text: validText })).toBeUndefined()
    expect(instructionSourcePaths({ type: "text", synthetic: true, ignored: true, text: 42 })).toBeUndefined()
  })
})
