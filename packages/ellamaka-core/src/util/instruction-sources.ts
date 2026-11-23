/**
 * Protocol markers and pure parser for UI-only synthetic user parts that record
 * which baseline instruction files were attached to the system prompt.
 */
export const INSTRUCTION_SOURCES_START = "<rules-context>\n[WOPAL INSTRUCTION SOURCES]\n"
export const INSTRUCTION_SOURCES_END = "\n</rules-context>"

export function formatInstructionSources(paths: readonly string[]): string {
  return `${INSTRUCTION_SOURCES_START}${JSON.stringify(paths)}${INSTRUCTION_SOURCES_END}`
}

export function parseInstructionSourcesText(text: string): string[] | undefined {
  if (!text.startsWith(INSTRUCTION_SOURCES_START) || !text.endsWith(INSTRUCTION_SOURCES_END)) return undefined
  try {
    const parsed: unknown = JSON.parse(text.slice(INSTRUCTION_SOURCES_START.length, -INSTRUCTION_SOURCES_END.length))
    if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === "string")) {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

export type InstructionSourcePart = {
  readonly type: string
  readonly synthetic?: boolean
  readonly ignored?: boolean
  readonly text?: unknown
}

export function instructionSourcePaths(part: InstructionSourcePart): string[] | undefined {
  if (part.type !== "text") return undefined
  if (part.synthetic !== true || part.ignored !== true) return undefined
  if (typeof part.text !== "string") return undefined
  return parseInstructionSourcesText(part.text)
}
