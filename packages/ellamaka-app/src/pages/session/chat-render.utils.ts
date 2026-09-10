import type { AssistantMessage, Message, Part, UserMessage } from "@opencode-ai/sdk/v2"

/**
 * Part classification for the Workbench Chat render layer. Classification reads
 * both the SDK part type and the owning message role so that `file`, `agent`
 * and `subtask` parts are treated as user input while assistant activity is
 * driven by `text`, `reasoning` and `tool` parts. Unknown combinations fall
 * back to a safe generic presentation.
 */
export type PartClassification =
  | { kind: "user" }
  | { kind: "narrative" }
  | { kind: "reasoning" }
  | { kind: "context" }
  | { kind: "injection" }
  | { kind: "shell" }
  | { kind: "file-change" }
  | { kind: "subagent" }
  | { kind: "interaction" }
  | { kind: "generic" }
  | { kind: "compaction" }
  | { kind: "retry" }

const CONTEXT_TOOLS = new Set(["read", "glob", "grep", "list"])
const SHELL_TOOLS = new Set(["bash", "shell"])
const FILE_CHANGE_TOOLS = new Set(["edit", "write", "apply_patch"])

// Snapshot/patch parts are no longer produced (snapshot mechanism removed);
// they stay in the hidden set only so legacy history parts never render.
const HIDDEN_PART_TYPES = new Set(["step-start", "step-finish", "snapshot", "patch"])

/** Todo tools render in the composer todo dock, never in the transcript. */
const HIDDEN_TOOLS = new Set(["todowrite", "todoread"])

/** Shell prefixes that mark a text payload as a context injection. */
const INJECTION_SHELL_PREFIXES = ["<system-reminder>", "<rules-context>", "<memory-context>"] as const

/**
 * Returns whether a text payload is a shell-wrapped context injection.
 * Matching is content-based on the trimmed text so wopal-plugin task
 * notifications (`<system-reminder>`-wrapped parts posted without the SDK
 * `synthetic` flag) are detected identically to flagged synthetic parts.
 */
export function isInjectionText(text: string): boolean {
  const trimmed = text.trimStart()
  return INJECTION_SHELL_PREFIXES.some((shell) => trimmed.startsWith(shell))
}

/**
 * Returns whether a text part presents as a context injection: either the SDK
 * flagged it `synthetic` or its content is wrapped in a recognized injection
 * shell. Both routes render as tool-style ContextInjectionBlocks, never inside
 * the user bubble.
 */
export function isInjectionPart(part: Part): boolean {
  if (part.type !== "text") return false
  return part.synthetic === true || isInjectionText(part.text)
}

function isAssistantMessage(message: Message): message is AssistantMessage {
  return message.role === "assistant"
}

function isRunning(message: AssistantMessage): boolean {
  return typeof message.time.completed !== "number"
}

/**
 * Returns whether a part should enter the transcript. Legacy snapshot/patch
 * parts and step markers are hidden. Injection text (synthetic-flagged or
 * shell-wrapped) is always renderable: it carries plugin context injections
 * and is presented as a collapsible block regardless of the owning message
 * role or completion state. Todo tool parts are owned by the composer todo
 * dock and never enter the transcript.
 */
export function isRenderablePart(part: Part, message: Message): boolean {
  if (HIDDEN_PART_TYPES.has(part.type)) return false
  if (part.type === "tool" && HIDDEN_TOOLS.has(part.tool)) return false
  return true
}

/**
 * Classifies a part into a render category. The owning message role is used to
 * disambiguate user-input parts from assistant activity.
 */
export function classifyPart(part: Part, message: Message): PartClassification {
  if (message.role === "user") {
    if (part.type === "file" || part.type === "agent" || part.type === "subtask") return { kind: "user" }
  }

  switch (part.type) {
    case "text":
      if (isInjectionPart(part)) return { kind: "injection" }
      return { kind: "narrative" }
    case "reasoning":
      return { kind: "reasoning" }
    case "compaction":
      return { kind: "compaction" }
    case "retry":
      return { kind: "retry" }
    case "tool": {
      const tool = part.tool
      if (CONTEXT_TOOLS.has(tool)) return { kind: "context" }
      if (SHELL_TOOLS.has(tool)) return { kind: "shell" }
      if (FILE_CHANGE_TOOLS.has(tool)) return { kind: "file-change" }
      if (tool === "task" || tool === "wopal_task") return { kind: "subagent" }
      if (tool === "question") return { kind: "interaction" }
      return { kind: "generic" }
    }
    default:
      return { kind: "generic" }
  }
}

/**
 * Returns a short, descriptive title for a part. Tool parts use their tool name
 * and a best-effort input field; other parts fall back to a type label.
 */
export function partTitle(part: Part, _message: Message): string {
  if (part.type === "tool") {
    const input = part.state.input
    const command = typeof input.command === "string" ? input.command : undefined
    const filePath = typeof input.filePath === "string" ? input.filePath : undefined
    const pattern = typeof input.pattern === "string" ? input.pattern : undefined
    const detail = command ?? filePath ?? pattern
    return detail ? `${part.tool}: ${detail}` : part.tool
  }
  return part.type
}

/**
 * Default expansion policy for a part. Running blocks and errors stay expanded;
 * completed history collapses. User manual selection overrides this via the
 * bounded expansion state.
 */
export function defaultExpanded(part: Part, message: Message): boolean {
  if (part.type === "tool") {
    if (part.state.status === "running") return true
    if (part.state.status === "error") return true
    return false
  }
  if (part.type === "reasoning") {
    return isAssistantMessage(message) && isRunning(message)
  }
  return true
}

/**
 * A parsed synthetic context injection. `tag` identifies the plugin shell the
 * content arrived in; `body` is the tag-stripped markdown payload.
 */
export type SyntheticInjection = {
  tag: "reminder" | "rules" | "memory"
  body: string
}

const INJECTION_SHELLS: Array<{ tag: SyntheticInjection["tag"]; open: string; close: string }> = [
  { tag: "reminder", open: INJECTION_SHELL_PREFIXES[0], close: "</system-reminder>" },
  { tag: "rules", open: INJECTION_SHELL_PREFIXES[1], close: "</rules-context>" },
  { tag: "memory", open: INJECTION_SHELL_PREFIXES[2], close: "</memory-context>" },
]

/**
 * Parses a synthetic text part's content into its injection shell tag and
 * tag-stripped markdown body. Only the outer shell is removed; nested content
 * is preserved verbatim and trimmed. A part without a recognized leading shell
 * falls back to the `reminder` presentation so unknown injections never lose
 * content.
 */
export function parseSyntheticInjection(text: string): SyntheticInjection {
  const trimmed = text.trim()
  for (const shell of INJECTION_SHELLS) {
    if (!trimmed.startsWith(shell.open)) continue
    const rest = trimmed.slice(shell.open.length)
    const end = rest.lastIndexOf(shell.close)
    if (end !== -1) {
      return { tag: shell.tag, body: rest.slice(0, end).trim() }
    }
    // Unterminated shell (streaming): render the tail as-is.
    return { tag: shell.tag, body: rest.trim() }
  }
  return { tag: "reminder", body: trimmed }
}

/**
 * Extracts a stable prompt summary for the PromptNavigator. The user summary
 * prefers the first valid non-injection text part (synthetic-flagged or
 * shell-wrapped payloads never summarize as prompt text); the assistant
 * summary prefers the last narrative text block. Empty, running or error
 * replies produce a stable status summary.
 */
export function extractPromptSummary(input: {
  message: UserMessage
  parts: Part[]
  assistant?: AssistantMessage[]
}): string {
  const { parts, assistant } = input

  const userText = parts
    .filter((p) => p.type === "text" && p.messageID === input.message.id && !isInjectionPart(p))
    .map((p) => (p.type === "text" ? p.text : ""))
    .map(cleanSummary)
    .find((t) => t.length > 0)

  if (userText) return userText

  if (assistant && assistant.length > 0) {
    const running = assistant.some(isRunning)
    if (running) return "正在回复…"
    const error = assistant.find((m) => m.error && m.error.name !== "MessageAbortedError")
    if (error) return error.error?.name ?? "回复出错"
  }

  return ""
}

export function cleanSummary(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~#]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Returns a display path for a tool argument relative to the session working
 * directory, mirroring the official timeline's `relativizeProjectPath`. Files
 * inside the directory render as a relative path; files outside it keep their
 * full absolute path so the user always sees which file the agent touched.
 */
export function relativizeProjectPath(path: string, directory?: string): string {
  if (!path) return ""
  if (!directory) return path
  if (directory === "/" || directory === "\\") return path
  if (path === directory) return ""
  const separator = directory.includes("\\") ? "\\" : "/"
  const prefix = directory.endsWith(separator) ? directory : directory + separator
  if (!path.startsWith(prefix)) return path
  let rel = path.slice(directory.length)
  if (rel.startsWith(separator)) rel = rel.slice(separator.length)
  return rel
}

/**
 * Capitalizes an agent identifier for display, matching the official
 * timeline's agent header convention (`fae` → `Fae`).
 */
export function agentDisplayName(agent: string): string {
  if (!agent) return ""
  return agent[0]!.toUpperCase() + agent.slice(1)
}

/**
 * Formats a completed turn duration as compact seconds/minutes (`45s`,
 * `2m 13s`). Negative or non-finite inputs produce an empty string.
 */
export function formatTurnDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ""
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

/**
 * A bounded, in-memory map for transient expansion state. Only user-selected
 * overrides are stored; the map evicts the oldest entry when it exceeds its
 * limit. Session data, WorkbenchStore and localStorage never carry this state.
 */
export function createBoundedExpansionState(limit: number) {
  const map = new Map<string, boolean>()

  const key = (sessionID: string, tool: string, callID: string) => `${sessionID}\n${tool}\n${callID}`

  return {
    get(sessionID: string, tool: string, callID: string): boolean | undefined {
      return map.get(key(sessionID, tool, callID))
    },
    set(sessionID: string, tool: string, callID: string, value: boolean) {
      const k = key(sessionID, tool, callID)
      if (map.has(k)) map.delete(k)
      map.set(k, value)
      while (map.size > limit) {
        const first = map.keys().next().value
        if (first === undefined) break
        map.delete(first)
      }
    },
  }
}
