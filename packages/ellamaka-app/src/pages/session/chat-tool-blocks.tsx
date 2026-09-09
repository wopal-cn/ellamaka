import { createMemo, createSignal, For, Show, type Component, type JSX } from "solid-js"
import type { AssistantMessage, ToolPart } from "@opencode-ai/sdk/v2"
import { Icon } from "@wopal/ui/icon"
import { Collapsible } from "@wopal/ui/collapsible"
import { agentColor } from "@/utils/agent"
import { agentDisplayName, relativizeProjectPath } from "./chat-render.utils"
import { chatExpansionState } from "./chat-expansion-state"

export type OpenCodeEditRendererProps = {
  part: ToolPart
  message: AssistantMessage
  defaultOpen?: boolean
  toolOpen?: boolean
  onToolOpenChange?: (open: boolean) => void
  deferToolContent?: boolean
  virtualizeDiff?: boolean
}

/** Strips ANSI escape sequences from terminal output. */
function stripAnsi(text: string): string {
  /* eslint-disable no-control-regex */
  return text
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
  /* eslint-enable no-control-regex */
}

function toolStatusLabel(status: string) {
  if (status === "pending") return "等待执行"
  if (status === "running") return "正在运行"
  if (status === "error") return "失败"
  return status
}

/**
 * Shared tool block header. It renders the tool icon, a title, a subtitle,
 * and the chevron inside an inline click trigger button, with the status
 * label on the trailing side of the row.
 */
function ToolBlockHeader(props: {
  icon: string
  title: string
  titleColor?: string
  subtitle?: string
  args?: string[]
  status: string
  open: boolean
  toggle: (event: MouseEvent) => void
  actions?: JSX.Element
}) {
  return (
    <div data-slot="chat-tool-header">
      <button
        type="button"
        data-slot="chat-tool-trigger"
        aria-expanded={props.open}
        on:click={(event) => {
          event.stopPropagation()
          const trigger = event.currentTarget
          const scroller = trigger.closest<HTMLElement>("[data-component='chat-scroller']")
          const top = trigger.getBoundingClientRect().top
          props.toggle(event)
          if (!scroller) return
          window.requestAnimationFrame(() => {
            scroller.scrollTop += trigger.getBoundingClientRect().top - top
          })
        }}
      >
        <span style={props.titleColor ? { color: props.titleColor } : undefined} class="chat-tool-icon-wrap">
          <Icon name={props.icon as never} size="small" />
        </span>
        <span data-slot="chat-tool-title" style={props.titleColor ? { color: props.titleColor } : undefined}>
          {props.title}
        </span>
        <Show when={props.subtitle}>
          <span data-slot="chat-tool-subtitle">{props.subtitle}</span>
        </Show>
        <For each={props.args}>
          {(arg) => (
            <span data-slot="chat-tool-arg">{arg}</span>
          )}
        </For>
        <span data-slot="chat-tool-chevron" aria-hidden="true">
          <Icon name="chevron-down" size="small" />
        </span>
      </button>
      <div data-slot="chat-tool-trailing">
        <Show when={props.actions}>{props.actions}</Show>
        <span data-slot="chat-tool-status" data-status={props.status}>
          {toolStatusLabel(props.status)}
        </span>
      </div>
    </div>
  )
}

function isToolRunning(part: ToolPart) {
  return part.state.status === "running" || part.state.status === "pending"
}

/**
 * Reads a completed JSON string value from an otherwise partial tool-input
 * payload. `filePath` is enough for the compact read row, even when later
 * arguments are still streaming and the full object cannot be JSON-parsed.
 */
function filePathFromRawToolInput(raw: string): string | undefined {
  const match = /"filePath"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(raw)
  if (!match) return
  try {
    const value = JSON.parse(`"${match[1]}"`)
    return typeof value === "string" ? value : undefined
  } catch {
    return
  }
}

function useToolOpen(
  part: ToolPart,
  defaultOpen = () => isToolRunning(part) || part.state.status === "error",
  snapshot = true,
) {
  const stored = chatExpansionState.get(part.sessionID, part.tool, part.callID)
  // A settings toggle is a default for newly encountered tool calls, not a
  // live command to resize every mounted history row. Snapshot and cache the
  // resolved value so virtual-list remounts preserve the same geometry.
  // Callers that pass snapshot=false cache only explicit user toggles, so
  // auto-opened running blocks collapse again once they complete.
  const initial = stored ?? defaultOpen()
  if (snapshot && stored === undefined) chatExpansionState.set(part.sessionID, part.tool, part.callID, initial)
  const [open, setOpen] = createSignal(initial)
  const toggle = (value: boolean) => {
    setOpen(value)
    chatExpansionState.set(part.sessionID, part.tool, part.callID, value)
  }
  return { open, setOpen: toggle }
}

/**
 * ContextToolBlock renders read/glob/grep/list activities as independent,
 * traceable blocks in SDK part order. Read renders as a non-expandable info
 * bar (Kilo Code behavior); list/glob/grep stay collapsible and collapse
 * again once they complete unless the user toggled them.
 */
export function ContextToolBlock(props: {
  part: ToolPart
  message: AssistantMessage
  defaultOpen?: boolean
  directory?: string
}) {
  const input = () => props.part.state.input
  const rawInput = () => (props.part.state.status === "pending" ? props.part.state.raw : "")
  const readPath = createMemo(() => {
    const filePath = input().filePath
    if (typeof filePath === "string") return filePath
    return filePathFromRawToolInput(rawInput())
  })
  const subtitle = createMemo(() => {
    const i = input()
    const pattern = typeof i.pattern === "string" ? i.pattern : undefined
    const path = typeof i.path === "string" ? i.path : undefined
    return readPath() ?? pattern ?? path
  })
  const output = createMemo(() => {
    const s = props.part.state
    if (s.status === "completed" && typeof s.output === "string") return s.output
    return ""
  })

  if (props.part.tool === "read") {
    const rawPath = () => readPath()
    const displayPath = () => {
      const path = rawPath()
      return path ? relativizeProjectPath(path, props.directory) : subtitle()
    }
    return (
      <div data-component="chat-context-tool" data-tool="read" data-call-id={props.part.callID}>
        <div data-slot="chat-context-info-bar">
          <span class="chat-tool-icon-wrap">
            <Icon name="glasses" size="small" />
          </span>
          <span data-slot="chat-tool-title">read</span>
          <Show when={subtitle()}>
            <span data-slot="chat-tool-subtitle">{displayPath()}</span>
          </Show>
          <span data-slot="chat-tool-status" data-status={props.part.state.status}>
            {toolStatusLabel(props.part.state.status)}
          </span>
        </div>
      </div>
    )
  }

  const { open, setOpen } = useToolOpen(
    props.part,
    () => props.part.state.status === "error" || (props.defaultOpen ?? isToolRunning(props.part)),
    false,
  )

  return (
    <div data-component="chat-context-tool" data-tool={props.part.tool} data-call-id={props.part.callID}>
      <Collapsible open={open()} onOpenChange={setOpen}>
        <ToolBlockHeader
          icon="glasses"
          title={props.part.tool}
          subtitle={subtitle()}
          status={props.part.state.status}
          open={open()}
          toggle={(_event: MouseEvent) => setOpen(!open())}
        />
        <Collapsible.Content>
          <Show when={output()}>
            <pre data-slot="chat-context-output" data-scrollable="">{output()}</pre>
          </Show>
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

/**
 * ShellActivityBlock renders bash/shell commands with their output. ANSI codes
 * are stripped and carriage returns normalized.
 */
export function ShellActivityBlock(props: { part: ToolPart; message: AssistantMessage; defaultOpen?: boolean }) {
  const { open, setOpen } = useToolOpen(
    props.part,
    () => props.part.state.status === "error" || (props.defaultOpen ?? isToolRunning(props.part)),
  )
  const input = () => props.part.state.input
  const command = createMemo(() => {
    const i = input()
    return typeof i.command === "string" ? i.command : ""
  })
  const description = createMemo(() => {
    const i = input()
    if (typeof i.description === "string" && i.description.trim()) return i.description.trim()
    const state = props.part.state as ToolPart["state"] & {
      title?: unknown
      metadata?: Record<string, unknown>
    }
    if (typeof state.metadata?.description === "string" && state.metadata.description.trim()) {
      return state.metadata.description.trim()
    }
    if (typeof state.title === "string" && state.title.trim() && state.title !== props.part.tool) {
      return state.title.trim()
    }
    return "Shell command"
  })
  const output = createMemo(() => {
    const s = props.part.state
    const raw =
      s.status === "completed" && typeof s.output === "string"
        ? s.output
        : s.status === "running" || s.status === "pending"
          ? (s as { metadata?: { output?: unknown } }).metadata?.output
          : ""
    return stripAnsi(typeof raw === "string" ? raw : "").replace(/\r\n?/g, "\n")
  })
  const error = createMemo(() => {
    const s = props.part.state
    return s.status === "error" && typeof s.error === "string" ? s.error : ""
  })
  const [copied, setCopied] = createSignal(false)
  const copy = async (event: MouseEvent) => {
    event.stopPropagation()
    const text = [`$ ${command()}`, output(), error()].filter(Boolean).join("\n\n")
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    if (!text || !clipboard?.writeText) return
    const done = await clipboard.writeText(text).then(
      () => true,
      () => false,
    )
    if (!done) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div data-component="chat-shell" data-call-id={props.part.callID}>
      <Collapsible open={open()} onOpenChange={setOpen}>
        <ToolBlockHeader
          icon="console"
          title="Shell"
          subtitle={description()}
          status={props.part.state.status}
          open={open()}
          toggle={(_event: MouseEvent) => setOpen(!open())}
        />
        <Collapsible.Content>
          <div data-slot="chat-shell-command-region">
            <pre data-slot="chat-shell-command" data-scrollable="">$ {command()}</pre>
            <button
              type="button"
              data-action="chat-shell-copy"
              aria-label={copied() ? "已复制 Shell 命令和输出" : "复制 Shell 命令和输出"}
              onMouseDown={(event) => event.preventDefault()}
              on:click={copy}
            >
              <Icon name={copied() ? "check" : "copy"} size="small" />
            </button>
          </div>
          <Show when={output()}>
            <div data-slot="chat-shell-output-region">
              <pre data-slot="chat-shell-output" data-scrollable="">{output()}</pre>
            </div>
          </Show>
          <Show when={error()}>
            <div data-slot="chat-shell-error-region">
              <pre data-slot="chat-shell-error" data-scrollable="">{error()}</pre>
            </div>
          </Show>
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

/**
 * FileChangeBlock renders edit/write/apply_patch activities. It uses the
 * exact same ToolBlockHeader as all other tools for 100% visual consistency,
 * while embedding the rich Diff/Text content via useFileComponent in its body.
 */
export function FileChangeBlock(props: {
  part: ToolPart
  message: AssistantMessage
  defaultOpen?: boolean
  directory?: string
  editRenderer?: Component<OpenCodeEditRendererProps>
}) {
  const { open, setOpen } = useToolOpen(
    props.part,
    () => props.part.state.status === "error" || (props.defaultOpen ?? isToolRunning(props.part)),
  )

  const input = () => (props.part.state.input ?? {}) as Record<string, any>
  const metadata = () => (props.part.state as { metadata?: Record<string, unknown> }).metadata ?? {}
  const fileDiff = createMemo(() => {
    const value = metadata().filediff
    if (!value || typeof value !== "object") return
    return value as {
      file?: string
      patch?: string
      before?: string
      after?: string
      additions?: number
      deletions?: number
    }
  })

  const filePath = createMemo(() => {
    const i = input()
    return fileDiff()?.file ?? (typeof i.filePath === "string" ? i.filePath : undefined)
  })

  const additions = createMemo(() => fileDiff()?.additions ?? 0)
  const deletions = createMemo(() => fileDiff()?.deletions ?? 0)

  // Title: lowercase English tool name to match read, glob, grep, shell
  const title = createMemo(() => {
    if (props.part.tool === "apply_patch") return "patch"
    return props.part.tool
  })

  const subtitle = createMemo(() => {
    const fp = filePath()
    if (fp) return relativizeProjectPath(fp, props.directory)
    if (props.part.tool === "apply_patch") {
      const files = Array.isArray(metadata().files) ? (metadata().files as unknown[]) : []
      if (files.length > 0) return `${files.length} files`
    }
    return undefined
  })

  return (
    <div data-component="chat-file-change" data-call-id={props.part.callID}>
      <Collapsible open={open()} onOpenChange={setOpen}>
        <ToolBlockHeader
          icon="code-lines"
          title={title()}
          subtitle={subtitle()}
          status={props.part.state.status}
          open={open()}
          toggle={(_event: MouseEvent) => setOpen(!open())}
          actions={
            <Show when={props.part.state.status === "completed" && (additions() > 0 || deletions() > 0)}>
              <span data-slot="chat-file-additions">+{additions()}</span>
              <span data-slot="chat-file-deletions">-{deletions()}</span>
            </Show>
          }
        />
        <Collapsible.Content>
          <Show when={props.editRenderer}>
            {(renderer) => {
              const Renderer = renderer()
              return (
                <div data-component="chat-file-change-wrapper" data-scrollable="">
                  <Renderer
                    part={props.part}
                    message={props.message}
                    defaultOpen={props.defaultOpen}
                    toolOpen={open()}
                    onToolOpenChange={setOpen}
                    deferToolContent={false}
                    virtualizeDiff={false}
                  />
                </div>
              )
            }}
          </Show>
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

/**
 * SubagentActivityBlock renders a task tool as a compact subagent activity
 * timeline. The metadata `sessionId` is the canonical child session link.
 * The header leads with the subagent name (tinted like the agent identity
 * used elsewhere) and keeps the task description as the subtitle, matching
 * the official timeline's task card information order.
 */
export function SubagentActivityBlock(props: {
  part: ToolPart
  message: AssistantMessage
  onSyncChild?: (childID: string) => void
}) {
  const { open, setOpen } = useToolOpen(props.part)
  const input = () => props.part.state.input
  const metadata = () => (props.part.state as { metadata?: Record<string, unknown> }).metadata ?? {}
  const agentRaw = createMemo(() => {
    const i = input()
    if (typeof i.subagent_type === "string" && i.subagent_type) return i.subagent_type
    if (typeof i.agent === "string" && i.agent) return i.agent
    return undefined
  })
  const title = createMemo(() => (agentRaw() ? agentDisplayName(agentRaw()!) : "Subagent"))
  const titleColor = createMemo(() => (agentRaw() ? agentColor(agentRaw()!) : undefined))
  const description = createMemo(() => {
    const i = input()
    return typeof i.description === "string" ? i.description : undefined
  })
  const sessionId = createMemo(() => {
    const m = metadata()
    return typeof m.sessionId === "string" ? m.sessionId : undefined
  })

  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (next && sessionId()) props.onSyncChild?.(sessionId()!)
  }

  return (
    <div data-component="chat-subagent" data-call-id={props.part.callID}>
      <Collapsible open={open()} onOpenChange={changeOpen}>
        <ToolBlockHeader
          icon="task"
          title={title()}
          titleColor={titleColor()}
          subtitle={description()}
          status={props.part.state.status}
          open={open()}
          toggle={(_event: MouseEvent) => changeOpen(!open())}
        />
        <Collapsible.Content>
          <Show when={sessionId()}>
            <span data-slot="chat-subagent-session">{sessionId()}</span>
          </Show>
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

/**
 * GenericToolBlock renders any tool without a dedicated renderer. It shows the
 * tool name plus a best-effort primary label extracted from the input, with the
 * remaining parameters rendered as capped arg chips — mirroring TUI's GenericTool
 * (label + args) instead of concatenating every field into one wrapping blob.
 */

const GENERIC_LABEL_KEYS = ["command", "action", "description", "query", "url", "filePath", "path", "pattern", "name"]

/** Primary label: the first non-empty descriptive field, mirroring TUI's label(). */
function genericToolLabel(input: Record<string, unknown> | undefined): string {
  if (!input) return ""
  for (const key of GENERIC_LABEL_KEYS) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

/** Arg chips: remaining params as key=value, capped to keep the header single-line. */
function genericToolArgs(input: Record<string, unknown> | undefined): string[] {
  if (!input) return []
  const skip = new Set(GENERIC_LABEL_KEYS)
  return Object.entries(input)
    .filter(([key]) => !skip.has(key))
    .flatMap(([key, value]) => {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return [`${key}=${String(value)}`]
      }
      return []
    })
    .slice(0, 3)
}

export function GenericToolBlock(props: { part: ToolPart; message: AssistantMessage; defaultOpen?: boolean }) {
  const { open, setOpen } = useToolOpen(
    props.part,
    () => props.part.state.status === "error" || (props.defaultOpen ?? isToolRunning(props.part)),
  )
  const input = () => props.part.state.input as Record<string, unknown> | undefined
  const label = createMemo(() => genericToolLabel(input()))
  const args = createMemo(() => genericToolArgs(input()))
  const output = createMemo(() => {
    const s = props.part.state
    if (s.status === "completed" && typeof s.output === "string") return s.output
    return ""
  })

  return (
    <div data-component="chat-generic-tool" data-tool={props.part.tool} data-call-id={props.part.callID}>
      <Collapsible open={open()} onOpenChange={setOpen}>
        <ToolBlockHeader
          icon="mcp"
          title={props.part.tool}
          subtitle={label() || undefined}
          args={args()}
          status={props.part.state.status}
          open={open()}
          toggle={(_event: MouseEvent) => setOpen(!open())}
        />
        <Collapsible.Content>
          <Show when={output()}>
            <pre data-slot="chat-generic-output" data-scrollable="">{output()}</pre>
          </Show>
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}
