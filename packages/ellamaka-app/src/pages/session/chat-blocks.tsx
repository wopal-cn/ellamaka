import { createEffect, createMemo, createSignal, onCleanup, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { Icon } from "@wopal/ui/icon"
import { Collapsible } from "@wopal/ui/collapsible"
import { useDialog } from "@wopal/ui/context/dialog"
import { getFilename } from "@wopal/ellamaka-core/util/path"
import { useLanguage } from "@/context/language"
import { agentColor } from "@/utils/agent"
import { agentDisplayName, formatTurnDuration, isInjectionPart, parseSyntheticInjection } from "./chat-render.utils"
import { chatExpansionState } from "./chat-expansion-state"
import { WorkbenchMarkdown } from "./workbench-markdown-renderer"
import { ChatImagePreview } from "./chat-image-preview"

export { ChatImagePreview } from "./chat-image-preview"

export type ChatUserActions = {
  fork?: (input: { sessionID: string; messageID: string; target: "current" | "split" }) => Promise<void> | void
  canSplit?: boolean
  revert?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
}

export type ChatUserActionLabels = {
  fork: string
  forkCurrent: string
  forkSplit: string
  revert: string
  copy: string
  copied: string
}

const defaultActionLabels: ChatUserActionLabels = {
  fork: "Fork message",
  forkCurrent: "Fork in current panel",
  forkSplit: "Fork in split panel",
  revert: "Revert message",
  copy: "Copy message",
  copied: "Copied",
}

async function writeClipboard(text: string) {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (!clipboard?.writeText) return false
  return clipboard.writeText(text).then(
    () => true,
    () => false,
  )
}

/**
 * UserMessageBlock renders the user's request bubble. It shows the prompt text
 * and, in SDK order, any file attachments, agent references and subtask
 * summaries that belong to the user input model.
 * Injection text parts (synthetic-flagged or shell-wrapped) are NOT rendered
 * here: they present as tool-style context-injection blocks at the transcript
 * row level (see TranscriptRowView), left-aligned outside the bubble. A user
 * message whose text content is only injections renders no bubble at all —
 * its row shows only the injection container.
 */
export function UserMessageBlock(props: {
  message: UserMessage
  parts: Part[]
  actions?: ChatUserActions
  actionLabels?: ChatUserActionLabels
}) {
  // Server compaction markers (a user message whose only part is `compaction`)
  // are structural boundaries, not prompts. They render nothing here; the
  // transcript layer projects them as a CompactionDivider row instead.
  if (props.parts.length > 0 && props.parts.every((p) => p.type === "compaction")) return null
  const text = createMemo(() =>
    props.parts
      .filter((p) => p.type === "text" && !isInjectionPart(p))
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n"),
  )
  const files = createMemo(() => props.parts.filter((p) => p.type === "file"))
  const agents = createMemo(() => props.parts.filter((p) => p.type === "agent"))
  const subtasks = createMemo(() => props.parts.filter((p) => p.type === "subtask"))
  const labels = () => props.actionLabels ?? defaultActionLabels
  const [busy, setBusy] = createSignal(false)
  const [forkOpen, setForkOpen] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  const dialog = useDialog()

  const openImagePreview = (url: string, filename?: string) => {
    dialog.show(() => <ChatImagePreview src={url} alt={filename} />)
  }

  const run = (action: (() => Promise<void> | void) | undefined) => {
    if (!action || busy()) return
    setBusy(true)
    void Promise.resolve().then(action).finally(() => setBusy(false))
  }

  const fork = (target: "current" | "split") => {
    setForkOpen(false)
    run(() => props.actions?.fork?.({
      sessionID: props.message.sessionID,
      messageID: props.message.id,
      target,
    }))
  }

  const copy = () => {
    if (!text()) return
    void writeClipboard(text()).then((done) => {
      if (!done) return
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div data-component="chat-user-message" data-message-id={props.message.id}>
      <Show when={files().length > 0}>
        <div data-slot="chat-user-attachments">
          <For each={files()}>
            {(file) => (
              <Show
                when={file.mime.startsWith("image/")}
                fallback={
                  <span data-slot="chat-user-attachment" data-file={file.url}>
                    <Icon name="file-tree" size="small" />
                    {file.filename ?? getFilename(file.url)}
                  </span>
                }
              >
                <button
                  type="button"
                  data-slot="chat-user-image-attachment"
                  data-file={file.url}
                  aria-label={`Preview image ${file.filename ?? getFilename(file.url)}`}
                  on:click={() => openImagePreview(file.url, file.filename ?? getFilename(file.url))}
                >
                  <img src={file.url} alt={file.filename ?? getFilename(file.url)} />
                </button>
              </Show>
            )}
          </For>
        </div>
      </Show>
      <Show when={text()}>
        <div data-slot="chat-user-text">{text()}</div>
      </Show>
      <Show when={agents().length > 0}>
        <div data-slot="chat-user-agents">
          <For each={agents()}>
            {(agent) => (
              <span data-slot="chat-user-agent" data-agent={agent.name}>
                <Icon name="task" size="small" />
                {agent.name}
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show when={subtasks().length > 0}>
        <div data-slot="chat-user-subtasks">
          <For each={subtasks()}>
            {(subtask) => (
              <span data-slot="chat-user-subtask" data-agent={subtask.agent}>
                <Icon name="task" size="small" />
                {subtask.description || subtask.prompt}
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show when={text() || props.actions?.fork || props.actions?.revert}>
        <div data-slot="chat-user-actions">
          <Show when={props.actions?.fork}>
            <div data-component="chat-user-fork">
              <button
                type="button"
                data-action="chat-user-fork"
                aria-label={labels().fork}
                title={labels().fork}
                aria-haspopup="menu"
                aria-expanded={forkOpen()}
                disabled={busy()}
                on:click={() => setForkOpen((open) => !open)}
              >
                <Icon name="fork" size="small" />
              </button>
              <Show when={forkOpen()}>
                <div data-slot="chat-user-fork-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    data-action="chat-user-fork-split"
                    disabled={busy() || props.actions?.canSplit === false}
                    on:click={() => fork("split")}
                  >
                    {labels().forkSplit}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-action="chat-user-fork-current"
                    disabled={busy()}
                    on:click={() => fork("current")}
                  >
                    {labels().forkCurrent}
                  </button>
                </div>
              </Show>
            </div>
          </Show>
          <Show when={props.actions?.revert}>
            <button
              type="button"
              data-action="chat-user-revert"
              aria-label={labels().revert}
              title={labels().revert}
              disabled={busy()}
              on:click={() => run(() => props.actions?.revert?.({
                sessionID: props.message.sessionID,
                messageID: props.message.id,
              }))}
            >
              <Icon name="reset" size="small" />
            </button>
          </Show>
          <Show when={text()}>
            <button
              type="button"
              data-action="chat-user-copy"
              aria-label={copied() ? labels().copied : labels().copy}
              title={copied() ? labels().copied : labels().copy}
              on:click={copy}
            >
              <Icon name={copied() ? "check" : "copy"} size="small" />
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}

/**
 * NarrativeBlock renders a `text` part as an unbordered Markdown document block.
 * It is the primary final-answer content of an agent reply. Streaming output
 * goes through the Workbench-owned pipeline so a long final answer never
 * rebuilds the whole document per token. The turn's final completed narrative
 * carries a subtle metadata footer (agent, model, duration) that mirrors the
 * official timeline's message meta line.
 */
export function NarrativeBlock(props: {
  part: Part
  message: AssistantMessage
  showMeta?: boolean
  modelName?: (providerID: string, modelID: string) => string | undefined
}) {
  if (props.part.type !== "text") return null
  const streaming = () => typeof props.message.time.completed !== "number"
  const meta = createMemo(() => {
    if (!props.showMeta || streaming()) return []
    const items: Array<{ type: "agent" | "model" | "duration"; value: string }> = []
    const agent = props.message.agent
    if (agent) items.push({ type: "agent", value: agentDisplayName(agent) })
    const model = props.modelName?.(props.message.providerID, props.message.modelID) ?? props.message.modelID
    if (model) items.push({ type: "model", value: model })
    const completed = props.message.time.completed
    if (typeof completed === "number") {
      const duration = formatTurnDuration(completed - props.message.time.created)
      if (duration) items.push({ type: "duration", value: duration })
    }
    return items
  })
  return (
    <div data-component="chat-narrative" data-part-id={props.part.id}>
      <WorkbenchMarkdown text={props.part.text} cacheKey={props.part.id} streaming={streaming()} />
      <Show when={meta().length > 0}>
        <div data-slot="chat-narrative-meta">
          <For each={meta()}>
            {(item, index) => (
              <>
                <Show when={index() > 0}>
                  <span data-slot="chat-narrative-meta-sep" aria-hidden="true">
                    ·
                  </span>
                </Show>
                <span
                  data-slot={`chat-narrative-meta-${item.type}`}
                  style={
                    item.type === "agent"
                      ? ({ "--chat-agent-color": agentColor(item.value) } as JSX.CSSProperties)
                      : undefined
                  }
                >
                  <Show when={item.type === "agent"}>
                    <span data-slot="chat-narrative-meta-dot" aria-hidden="true" />
                  </Show>
                  {item.value}
                </span>
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

/**
 * ContextInjectionBlock renders an injection text part (synthetic-flagged or
 * shell-wrapped) as a collapsible "context injection" document. The header
 * carries the i18n label plus the injection shell tag (reminder/rules/memory);
 * the body shows the tag-stripped inner content as Markdown. Blocks default to
 * collapsed and remember manual toggles across virtual-list remounts, mirroring
 * ReasoningBlock's expansion policy.
 */
export function ContextInjectionBlock(props: { part: Part }) {
  const language = useLanguage()
  if (!isInjectionPart(props.part)) return null
  const injection = createMemo(() =>
    parseSyntheticInjection(props.part.type === "text" ? props.part.text : ""),
  )
  const stored = () => chatExpansionState.get(props.part.sessionID, "injection", props.part.id)
  const [selected, setSelected] = createSignal(stored())
  const open = () => selected() ?? false
  const setOpen = (next: boolean) => {
    setSelected(next)
    chatExpansionState.set(props.part.sessionID, "injection", props.part.id, next)
  }

  return (
    <div
      data-component="chat-injection"
      data-part-id={props.part.id}
      data-injection-tag={injection().tag}
    >
      <Collapsible open={open()} onOpenChange={setOpen}>
        <Collapsible.Trigger data-slot="chat-injection-trigger" aria-expanded={open()}>
          <div data-slot="chat-injection-header-left">
            <Icon name="archive" size="small" />
            <span data-slot="chat-injection-label">{language.t("workbench.chat.injection")}</span>
          </div>
          <span data-slot="chat-injection-tag">{injection().tag}</span>
        </Collapsible.Trigger>
        <Collapsible.Content data-slot="chat-injection-content">
          <WorkbenchMarkdown text={injection().body} cacheKey={props.part.id} streaming={false} />
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

/**
 * ReasoningBlock renders a collapsible thinking block. It stays expanded while
 * the owning assistant message is running (if defaultOpen or running). When
 * collapsed, it displays a single-line header whose preview always shows the
 * latest tail of the reasoning stream (a bounded trailing window), so newly
 * streamed tokens appear immediately and stay pinned at the tail. A manual
 * toggle always wins and is remembered across virtual-list remounts.
 */
const REASONING_PREVIEW_MAX = 140

export function ReasoningBlock(props: { part: Part; message: AssistantMessage; defaultOpen?: boolean }) {
  const language = useLanguage()
  if (props.part.type !== "reasoning") return null
  const running = () => typeof props.message.time.completed !== "number"
  const stored = () => chatExpansionState.get(props.part.sessionID, "reasoning", props.part.id)
  const [selected, setSelected] = createSignal(stored())
  const [followStream, setFollowStream] = createSignal(true)
  const open = () => selected() ?? (props.defaultOpen ?? running())
  const reasoningText = () => (props.part.type === "reasoning" ? props.part.text : "")
  let content: HTMLDivElement | undefined
  let frame: number | undefined
  let observedScrollTop = 0
  const setOpen = (next: boolean) => {
    setSelected(next)
    chatExpansionState.set(props.part.sessionID, "reasoning", props.part.id, next)
  }

  const updateFollowStream = (event: Event) => {
    const element = event.currentTarget as HTMLDivElement
    // A capped region can dispatch `scroll` merely because its content grew
    // past max-height. Only a real position change represents the user's
    // intent to inspect earlier reasoning and should pause tail-following.
    if (Math.abs(element.scrollTop - observedScrollTop) <= 1) return
    observedScrollTop = element.scrollTop
    setFollowStream(element.scrollHeight - element.clientHeight - element.scrollTop <= 2)
  }

  // Reasoning is capped to a scrollable region. Keep that nested viewport at
  // the newest tokens while it is streaming, but stop as soon as the user
  // scrolls away so inspecting an earlier thought is never overridden.
  createEffect(() => {
    reasoningText()
    if (!running() || !open() || !followStream() || !content) return
    if (frame !== undefined) cancelAnimationFrame(frame)
    const element = content
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (!running() || !open() || !followStream() || content !== element) return
      element.scrollTop = element.scrollHeight
      observedScrollTop = element.scrollTop
    })
  })
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })

  // Always a bounded trailing window of the latest reasoning text: the newest
  // tokens are what the user wants to see, and they stay pinned at the tail.
  const previewText = createMemo(() => {
    const raw = props.part.type === "reasoning" ? props.part.text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim() : ""
    if (raw.length <= REASONING_PREVIEW_MAX) return raw
    return `…${raw.slice(-REASONING_PREVIEW_MAX + 1)}`
  })

  return (
    <div
      data-component="chat-reasoning"
      data-part-id={props.part.id}
      data-streaming={running() ? "" : undefined}
    >
      <Collapsible open={open()} onOpenChange={setOpen}>
        <Collapsible.Trigger data-slot="chat-reasoning-trigger" aria-expanded={open()}>
          <div data-slot="chat-reasoning-header-left">
            <Icon name="brain" size="small" />
            <span data-slot="chat-reasoning-label">{language.t("workbench.chat.reasoning")}</span>
          </div>
          <Show when={!open() && previewText().length > 0}>
            <div data-slot="chat-reasoning-preview">{previewText()}</div>
          </Show>
        </Collapsible.Trigger>
        <Collapsible.Content
          data-slot="chat-reasoning-content"
          ref={(element: HTMLDivElement) => {
            content = element
            observedScrollTop = element.scrollTop
          }}
          on:scroll={updateFollowStream}
        >
          <div data-slot="chat-reasoning-text">{props.part.text}</div>
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}

/**
 * TurnOutcome renders an assistant error that cannot be attributed to a
 * specific activity block. It appears at the end of the reply.
 */
export function TurnOutcome(props: { message: AssistantMessage }) {
  const error = createMemo(() => {
    const e = props.message.error
    if (!e) return undefined
    const data = e.data as { message?: unknown } | undefined
    const message = typeof data?.message === "string" ? data.message : ""
    return message || e.name
  })

  return (
    <Show when={error()}>
      <div data-component="chat-outcome" data-message-id={props.message.id}>
        <Icon name="circle-x" size="small" />
        <span data-slot="chat-outcome-error">{error()}</span>
      </div>
    </Show>
  )
}

/**
 * ChatTurnFrame is the visual boundary shared by all transcript rows of one
 * turn. It provides the vertical rhythm that groups a user request with its
 * agent response.
 */
export function ChatTurnFrame(props: { turnID: string; children: JSX.Element }) {
  return (
    <div data-component="chat-turn-frame" data-turn-id={props.turnID}>
      {props.children}
    </div>
  )
}

/**
 * CompactionDivider renders a labeled horizontal divider for context
 * compression boundaries.
 */
export function CompactionDivider(props: { part: Part }) {
  const language = useLanguage()
  if (props.part.type !== "compaction") return null
  return (
    <div data-component="chat-compaction" data-part-id={props.part.id}>
      <span data-slot="chat-compaction-label">{language.t("workbench.chat.compaction")}</span>
    </div>
  )
}

/**
 * RetryOutcome renders a model retry record.
 */
export function RetryOutcome(props: { part: Part }) {
  const language = useLanguage()
  if (props.part.type !== "retry") return null
  return (
    <div data-component="chat-retry" data-part-id={props.part.id}>
      <Icon name="reset" size="small" />
      <span data-slot="chat-retry-attempt">{language.t("workbench.chat.retry", { attempt: props.part.attempt })}</span>
    </div>
  )
}

/**
 * Extracts a human-readable clean answer from question tool output/metadata.
 * Strips the internal LLM prompt envelope ("User has answered your questions: ...").
 */
export function extractQuestionAnswer(part: Extract<Part, { type: "tool" }>): string {
  const state = part.state
  const metadata = "metadata" in state ? (state.metadata as { answers?: string[][] } | undefined) : undefined
  if (Array.isArray(metadata?.answers) && metadata.answers.length > 0) {
    const flat = metadata.answers.map((a) => (Array.isArray(a) ? a.join(", ") : String(a))).filter(Boolean)
    if (flat.length > 0) return flat.join("; ")
  }

  const raw = state.status === "completed" && typeof state.output === "string" ? state.output : ""
  if (!raw) return ""

  // Match pattern: User has answered your questions: "..."="Answer". You can now continue...
  const match = raw.match(/="([^"]+)"/)
  if (match?.[1]) return match[1]

  // Fallback: strip the standard prefix/suffix if present
  const cleaned = raw
    .replace(/^User has answered your questions:\s*/i, "")
    .replace(/\.\s*You can now continue with the user's answers in mind\.?$/i, "")
    .trim()

  return cleaned || raw
}

/**
 * InteractionBlock renders a completed question tool as a read-only summary.
 */
export function InteractionBlock(props: { part: Part; message: AssistantMessage }) {
  if (props.part.type !== "tool" || props.part.tool !== "question") return null
  const language = useLanguage()
  const state = props.part.state
  const input = () => (state.input ?? {}) as Record<string, unknown>

  const question = createMemo(() => {
    const i = input()
    if (typeof i.question === "string" && i.question.trim()) return i.question.trim()
    if (Array.isArray(i.questions)) {
      const first = i.questions[0]
      if (typeof first === "string" && first.trim()) return first.trim()
      if (first && typeof first === "object" && typeof (first as Record<string, unknown>).question === "string") {
        return ((first as Record<string, unknown>).question as string).trim()
      }
    }
    return undefined
  })

  const answer = createMemo(() => {
    if (props.part.type !== "tool") return ""
    return extractQuestionAnswer(props.part as Extract<Part, { type: "tool" }>)
  })

  return (
    <div data-component="chat-interaction" data-part-id={props.part.id}>
      <div data-slot="chat-interaction-header">
        <span data-slot="chat-interaction-icon">
          <Icon name="speech-bubble" size="small" />
        </span>
        <span data-slot="chat-interaction-label">{language.t("workbench.chat.question")}</span>
        <Show when={question()}>
          <span data-slot="chat-interaction-question">{question()}</span>
        </Show>
      </div>
      <div data-slot="chat-interaction-answer">
        <span data-slot="chat-interaction-answer-label">{language.t("workbench.chat.answer")}</span>
        <span data-slot="chat-interaction-answer-text">{answer() || "—"}</span>
      </div>
    </div>
  )
}

/**
 * UnknownPartBlock renders a safe fallback for parts the render layer does not
 * recognize. It shows the part type and a safe text/JSON representation.
 */
export function UnknownPartBlock(props: { part: Part }) {
  const text = createMemo(() => {
    const p = props.part as Part & { text?: unknown }
    if (typeof p.text === "string" && p.text) return p.text
    try {
      return JSON.stringify(props.part)
    } catch {
      return String(props.part)
    }
  })
  return (
    <div data-component="chat-unknown-part" data-part-type={props.part.type}>
      <span data-slot="chat-unknown-type">{props.part.type}</span>
      <pre data-slot="chat-unknown-text">{text()}</pre>
    </div>
  )
}
