import { createEffect, createMemo, createSignal, For, onCleanup, onMount } from "solid-js"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { cleanSummary, extractPromptSummary, isInjectionPart } from "./chat-render.utils"
import { isCompactionMarker } from "./chat-transcript"

export type PromptNavigatorProps = {
  sessionID: string
  userMessages: UserMessage[]
  historyMore: boolean
  historyLoading: boolean
  loadOlder: () => Promise<void>
  onJump: (userMessageID: string) => void
  /** Active turn id for directory highlight. */
  /** The viewport-derived active turn; a container preserves reactivity in classic JSX. */
  activeUserMessageID?: string | { current: () => string | undefined }
  /** Optional part accessor for summaries. */
  getParts?: (messageID: string) => Part[]
  /** Optional assistant messages grouped by parent user message. */
  assistantByParent?: Record<string, AssistantMessage[]>
}

/**
 * PromptNavigator is the Ellamaka-native prompt navigation rail. It manages
 * only committed conversation history: each loaded user message gets a tick on
 * the rail and a two-line summary in the directory popover. It never parses SDK
 * data itself; it reads the transcript layer's prompt index and summaries.
 */
/**
 * Returns whether a user message is a prompt: it must carry at least one
 * non-injection text part (or a file/agent/subtask attachment). Structural
 * messages — compaction markers and injection-only notifications (synthetic
 * reminders, wopal-plugin task notifications posted without the synthetic
 * flag) — never surface in the prompt rail or directory.
 */
function isPromptMessage(message: UserMessage, getParts: (messageID: string) => Part[]): boolean {
  if (isCompactionMarker(message, getParts)) return false
  const parts = getParts(message.id)
  if (parts.length === 0) return true
  return parts.some((part) => {
    if (part.type === "text") return !isInjectionPart(part) && part.text.trim().length > 0
    return part.type === "file" || part.type === "agent" || part.type === "subtask"
  })
}

export function PromptNavigator(props: PromptNavigatorProps) {
  const [open, setOpen] = createSignal(false)
  let popoverRef: HTMLDivElement | undefined
  let directoryTriggerRef: HTMLButtonElement | undefined

  const getParts = (id: string) => props.getParts?.(id) ?? []
  const assistantFor = (id: string) => props.assistantByParent?.[id] ?? []
  const activeUserMessageID = () => {
    const active = props.activeUserMessageID
    return typeof active === "object" ? active.current() : active
  }

  const entries = createMemo(() =>
    props.userMessages
      // Compaction markers and injection-only notifications are structural
      // boundaries, not prompts; they never appear in the rail or directory.
      .filter((message) => isPromptMessage(message, getParts))
      .map((message) => {
        const parts = getParts(message.id)
        const assistant = assistantFor(message.id)
        const assistantText = assistant
          .flatMap((a) => getParts(a.id))
          .filter((p) => p.type === "text" && !isInjectionPart(p))
          .map((p) => (p.type === "text" ? p.text : ""))
          .map(cleanSummary)
          .filter((t) => t.trim().length > 0)
          .at(-1)
        return {
          userMessageID: message.id,
          userSummary: extractPromptSummary({ message, parts }),
          assistantSummary: assistantText ?? extractPromptSummary({ message, parts: [], assistant }),
        }
      }),
  )

  const openDirectory = () => {
    setOpen(true)
    // `loadOlder` is `useSessionHistoryLoader.loadAndReveal`, which already
    // serially hydrates pages until historyMore is false or no growth occurs.
    if (props.historyMore && !props.historyLoading) {
      const task = props.loadOlder
      if (typeof task === "function") void task()
    }
  }

  const jump = (id: string) => {
    setPreview(undefined)
    setOpen(false)
    props.onJump(id)
  }

  const [preview, setPreview] = createSignal<{ id: string; top: number }>()

  const showPreview = (id: string, tick: HTMLElement) => {
    if (open()) return
    setPreview({ id, top: tick.offsetTop })
  }

  const previewEntry = createMemo(() => {
    const current = preview()
    if (!current) return undefined
    return entries().find((e) => e.userMessageID === current.id)
  })

  onMount(() => {
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (!open()) return
      const target = event.target
      if (!(target instanceof Node)) return
      if (popoverRef?.contains(target) || directoryTriggerRef?.contains(target)) return
      setOpen(false)
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (!open() || event.key !== "Escape") return
      event.preventDefault()
      setOpen(false)
      directoryTriggerRef?.focus()
    }

    document.addEventListener("pointerdown", closeOnOutsidePointerDown)
    document.addEventListener("keydown", closeOnEscape)
    onCleanup(() => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown)
      document.removeEventListener("keydown", closeOnEscape)
    })
  })

  // happy-dom does not flush `Show` conditionals; toggle visibility via a
  // data attribute driven by createEffect so tests can observe the open state.
  createEffect(() => {
    if (!popoverRef) return
    popoverRef.setAttribute("data-open", String(open()))
  })

  return (
    <div data-component="chat-prompt-navigator">
      <div data-component="chat-prompt-rail" data-open={open()}>
        <For each={entries()}>
          {(entry) => (
            <button
              data-slot="chat-prompt-tick"
              data-message-id={entry.userMessageID}
              data-active={entry.userMessageID === activeUserMessageID()}
              on:click={(e) => {
                e.stopPropagation()
                jump(entry.userMessageID)
              }}
              on:mouseenter={(e) => showPreview(entry.userMessageID, e.currentTarget)}
              on:mouseleave={() => setPreview(undefined)}
            />
          )}
        </For>
      </div>
      <button
        type="button"
        data-component="chat-prompt-directory-trigger"
        ref={(el) => {
          directoryTriggerRef = el
        }}
        data-open={open()}
        on:click={openDirectory}
        aria-label="打开提示词导航"
      />
      <div
        data-component="chat-prompt-popover"
        ref={(el) => {
          popoverRef = el
        }}
        data-open={open()}
        role="dialog"
        aria-label="提示词导航"
      >
        <div data-slot="chat-prompt-header">
          <span>提示词导航</span>
        </div>
        <div data-slot="chat-prompt-loading" data-loading={props.historyLoading}>
          {props.historyLoading ? "正在加载更早消息…" : ""}
        </div>
        <div data-slot="chat-prompt-list">
          <For each={entries()}>
            {(entry) => (
              <button
                data-slot="chat-prompt-item"
                data-message-id={entry.userMessageID}
                data-active={entry.userMessageID === activeUserMessageID()}
                on:click={() => jump(entry.userMessageID)}
              >
                <div data-slot="chat-prompt-user">{entry.userSummary}</div>
                <div data-slot="chat-prompt-assistant">{entry.assistantSummary || "（无回复）"}</div>
              </button>
            )}
          </For>
        </div>
      </div>
      <div
        data-component="chat-prompt-preview"
        data-open={preview() !== undefined}
        style={{ "--preview-top": `${preview()?.top ?? 0}px` }}
      >
        <div data-slot="chat-prompt-preview-text">{previewEntry()?.userSummary ?? ""}</div>
      </div>
    </div>
  )
}
