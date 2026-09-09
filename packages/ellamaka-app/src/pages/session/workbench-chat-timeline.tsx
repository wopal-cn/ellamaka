import { createEffect, createMemo, createSignal, For, Index, onCleanup, Show, type Accessor, type Component } from "solid-js"
import type { AssistantMessage, Part, SessionStatus, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import { Icon } from "@wopal/ui/icon"
import { Spinner } from "@wopal/ui/spinner"
import { useSync } from "@/context/sync"
import { createRowStabilizer, nearestUserTurnID, projectTranscript, type TranscriptRow } from "./chat-transcript"
import { resolveTurnAnchor } from "./turn-anchor"
import {
  ChatTurnFrame,
  CompactionDivider,
  ContextInjectionBlock,
  InteractionBlock,
  NarrativeBlock,
  ReasoningBlock,
  RetryOutcome,
  TurnOutcome,
  UnknownPartBlock,
  UserMessageBlock,
  type ChatUserActionLabels,
  type ChatUserActions,
} from "./chat-blocks"
import {
  ContextToolBlock,
  FileChangeBlock,
  GenericToolBlock,
  ShellActivityBlock,
  SubagentActivityBlock,
  type OpenCodeEditRendererProps,
} from "./chat-tool-blocks"
import { classifyPart, isInjectionPart } from "./chat-render.utils"
import { PromptNavigator } from "./prompt-navigator"

/**
 * Scroll port shared with PanelChat. It carries the auto-scroll user intent and
 * the current scroll state so the timeline can pause bottom-following when the
 * user scrolls up, selects text or focuses a tool block.
 */
export type MessageTimelineScrollPort = {
  overflow: boolean
  bottom: boolean
  jump: boolean
}

export type UserMessageNavigation = "first" | "previous" | "next"
export type UserMessageNavigator = (direction: UserMessageNavigation) => boolean
export type LatestScrollNavigator = () => void

export type WorkbenchChatTimelineProps = {
  sessionID: string
  userMessages: UserMessage[]
  /** Session working directory, used to relativize displayed file paths. */
  directory?: string
  historyShift: boolean
  historyMore: boolean
  historyLoading: boolean
  loadOlder: () => Promise<void>
  scroll: MessageTimelineScrollPort
  showReasoningSummaries: boolean
  shellToolPartsExpanded: boolean
  editToolPartsExpanded: boolean
  showSessionProgressBar: boolean
  editRenderer?: Component<OpenCodeEditRendererProps>
  /** Revert boundary: only messages with id < revert are projected. */
  revert?: string
  /** Test seam: render virtual rows directly instead of through the Virtualizer. */
  virtualize?: boolean
  /** Test seam: capture the Virtualizer handle for scrollToIndex assertions. */
  onVirtualizer?: (handle: VirtualizerHandle | undefined) => void
  /** Test seam: override the active turn derivation (e.g. for scroll tests). */
  activeUserMessageIDOverride?: string
  /** Exposes the timeline-aware user-message navigator to the owning panel. */
  onUserMessageNavigator?: (navigator: UserMessageNavigator | undefined) => void
  /** Exposes a virtualizer-aware latest-output navigator to the owning panel. */
  onLatestScrollNavigator?: (navigator: LatestScrollNavigator | undefined) => void
  /** Scroll port callbacks (mirrors the official MessageTimeline contract). */
  setScrollRef?: (el: HTMLDivElement | undefined) => void
  setContentRef?: (el: HTMLDivElement) => void
  onAutoScroll?: () => void
  onScheduleScrollState?: (el: HTMLDivElement) => void
  onUserScroll?: () => void
  onHistoryScroll?: () => void
  onAutoScrollInteraction?: (event: MouseEvent) => void
  onResumeScroll?: () => void
  onPauseAutoScroll?: () => void
  actions?: ChatUserActions
  actionLabels?: ChatUserActionLabels
  /** Resolves a model display name for the assistant meta footer. */
  modelName?: (providerID: string, modelID: string) => string | undefined
}

const emptyParts: Part[] = []
const idle: SessionStatus = { type: "idle" }

type LiveActivity = {
  label: string
}

function latestAssistant(messages: Array<UserMessage | AssistantMessage>) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === "assistant") return message
  }
}

/**
 * Derives the working-indicator label from the last streamed part. This mirrors
 * Kilo's dedicated transcript-tail status: tool rows keep their own state, and
 * the tail simultaneously explains what the agent is doing next.
 */
function deriveLiveActivity(
  currentStatus: SessionStatus,
  currentMessages: Array<UserMessage | AssistantMessage>,
  getParts: (messageID: string) => Part[],
): LiveActivity | undefined {
  if (currentStatus.type === "idle") return
  if (currentStatus.type === "retry") {
    return { label: `正在重试（第 ${currentStatus.attempt} 次）` }
  }

  const latestMessage = currentMessages.at(-1)
  const assistant = latestMessage?.role === "assistant" ? latestMessage : undefined
  if (!assistant) return { label: "正在思考" }

  const parts = getParts(assistant.id)
  const last = parts.at(-1)
  if (!last) return { label: "正在思考" }

  if (last.type === "tool") {
    if (last.state.status !== "pending" && last.state.status !== "running") {
      return { label: "正在考虑下一步" }
    }
    const tool = last.tool.toLowerCase()
    if (tool === "task") return { label: "正在委派工作" }
    if (tool === "todowrite" || tool === "todoread") return { label: "正在规划下一步" }
    if (tool === "read") return { label: "正在读取上下文" }
    if (tool === "list" || tool === "grep" || tool === "glob") return { label: "正在搜索代码库" }
    if (tool === "webfetch" || tool === "websearch") return { label: "正在搜索网页" }
    if (tool === "edit" || tool === "write" || tool === "apply_patch" || tool === "patch") {
      return { label: "正在编辑文件" }
    }
    if (tool === "bash" || tool === "shell") return { label: "正在运行命令" }
    return { label: "正在执行工具" }
  }

  if (last.type === "reasoning") {
    return { label: last.time.end === undefined ? "正在思考" : "正在考虑下一步" }
  }

  if (last.type === "text") {
    return { label: last.time?.end === undefined ? "正在组织回复" : "正在考虑下一步" }
  }

  return { label: "正在考虑下一步" }
}

function formatElapsed(start: number, current: number) {
  const seconds = Math.max(0, Math.floor((current - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function ToolPartBlock(props: {
  part: ToolPart
  message: AssistantMessage
  shellToolPartsExpanded: boolean
  editToolPartsExpanded: boolean
  directory?: string
  editRenderer?: Component<OpenCodeEditRendererProps>
  onSyncChild?: (childID: string) => void
}) {
  const kind = createMemo(() => classifyPart(props.part, props.message).kind)
  return (
    <Show
      when={kind() === "context"}
      fallback={
        <Show
          when={kind() === "shell"}
          fallback={
            <Show
              when={kind() === "file-change"}
              fallback={
                <Show
                  when={kind() === "subagent"}
                  fallback={
                    <Show when={kind() === "interaction"} fallback={<GenericToolBlock part={props.part} message={props.message} defaultOpen={props.shellToolPartsExpanded} />}>
                      <InteractionBlock part={props.part} message={props.message} />
                    </Show>
                  }
                >
                  <SubagentActivityBlock part={props.part} message={props.message} onSyncChild={props.onSyncChild} />
                </Show>
              }
            >
              <FileChangeBlock
                part={props.part}
                message={props.message}
                defaultOpen={props.editToolPartsExpanded}
                directory={props.directory}
                editRenderer={props.editRenderer}
              />
            </Show>
          }
        >
          <ShellActivityBlock
            part={props.part}
            message={props.message}
            defaultOpen={props.shellToolPartsExpanded}
          />
        </Show>
      }
    >
      <ContextToolBlock part={props.part} message={props.message} defaultOpen={props.shellToolPartsExpanded} directory={props.directory} />
    </Show>
  )
}

function AssistantPartBlock(props: {
  part: Part
  message: AssistantMessage
  showMeta?: boolean
  showReasoningSummaries?: boolean
  modelName?: (providerID: string, modelID: string) => string | undefined
}) {
  const kind = createMemo(() => classifyPart(props.part, props.message).kind)
  return (
    <Show
      when={kind() === "narrative"}
      fallback={
        <Show
          when={kind() === "injection"}
          fallback={
            <Show
              when={kind() === "reasoning"}
              fallback={
                <Show
                  when={kind() === "compaction"}
                  fallback={
                    <Show
                      when={kind() === "retry"}
                      fallback={
                        <Show
                          when={kind() === "interaction"}
                          fallback={<UnknownPartBlock part={props.part} />}
                        >
                          <InteractionBlock part={props.part} message={props.message} />
                        </Show>
                      }
                    >
                      <RetryOutcome part={props.part} />
                    </Show>
                  }
                >
                  <CompactionDivider part={props.part} />
                </Show>
              }
            >
              <ReasoningBlock part={props.part} message={props.message} defaultOpen={props.showReasoningSummaries} />
            </Show>
          }
        >
          <ContextInjectionBlock part={props.part} />
        </Show>
      }
    >
      <NarrativeBlock part={props.part} message={props.message} showMeta={props.showMeta} modelName={props.modelName} />
    </Show>
  )
}

/**
 * UserRowContent splits a user row's parts into two presentation channels:
 * injection text parts (synthetic-flagged or shell-wrapped) render as
 * tool-style left-aligned ContextInjectionBlocks in a full-width container,
 * and everything else renders via UserMessageBlock (the right-aligned bubble).
 *
 * A user message whose text content is ONLY injections (a noReply notification
 * such as a sandbox-mode reminder or a wopal-plugin task notification) renders
 * no bubble at all — just the injection container, mirroring how compaction
 * markers suppress the empty prompt bubble.
 */
function UserRowContent(props: {
  row: Extract<TranscriptRow, { type: "user" }>
  actions?: ChatUserActions
  actionLabels?: ChatUserActionLabels
}) {
  const parts = () => props.row.parts
  const injections = createMemo(() => parts().filter((part) => isInjectionPart(part)))
  const bubbleParts = createMemo(() => parts().filter((part) => !isInjectionPart(part)))
  const hasBubbleContent = createMemo(() =>
    bubbleParts().some((part) => {
      if (part.type === "text") return part.text.trim().length > 0
      return true
    }),
  )

  return (
    <>
      <Show when={hasBubbleContent()}>
        <UserMessageBlock
          message={props.row.message}
          parts={bubbleParts()}
          actions={props.actions}
          actionLabels={props.actionLabels}
        />
      </Show>
      <Show when={injections().length > 0}>
        <div data-slot="chat-turn-injections">
          <For each={injections()}>
            {(part) => (
              <Show when={part.id} keyed>
                <ContextInjectionBlock part={part} />
              </Show>
            )}
          </For>
        </div>
      </Show>
    </>
  )
}

/**
 * TranscriptRowView renders a single transcript row. User rows render the user
 * bubble; assistant rows render the agent response part stream; diff and error
 * rows render their summaries. All rows share the ChatTurnFrame boundary.
 */
function TranscriptRowView(props: {
  row: TranscriptRow | Accessor<TranscriptRow>
  getParts: (id: string) => Part[]
  activeUserMessageID?: string | { current: () => string | undefined }
  shellToolPartsExpanded: boolean
  editToolPartsExpanded: boolean
  directory?: string
  editRenderer?: Component<OpenCodeEditRendererProps>
  actions?: ChatUserActions
  actionLabels?: ChatUserActionLabels
  onSyncChild?: (childID: string) => void
  modelName?: (providerID: string, modelID: string) => string | undefined
  showReasoningSummaries: boolean
}) {
  const row = () => {
    const value = props.row
    return typeof value === "function" ? value() : value
  }
  const activeUserMessageID = () => {
    const active = props.activeUserMessageID
    return typeof active === "object" ? active.current() : active
  }
  const userRow = () => {
    const r = row()
    return r.type === "user" ? r : undefined
  }
  const assistantRow = () => {
    const r = row()
    return r.type === "assistant" ? r : undefined
  }
  const errorRow = () => {
    const r = row()
    return r.type === "error" ? r : undefined
  }
  const compactionRow = () => {
    const r = row()
    return r.type === "compaction" ? r : undefined
  }
  const metaPartID = createMemo(() => assistantRow()?.metaPartID)
  return (
    <ChatTurnFrame turnID={row().turnID}>
      <div
        data-row-key={row().key}
        data-row-type={row().type}
        data-turn-id={row().turnID}
        data-active={row().turnID === activeUserMessageID()}
      >
        <Show when={compactionRow()}>
          {(current) => (
            <Index each={current().parts}>
              {(part) => (
                <Show when={part().id} keyed>
                  <CompactionDivider part={part()} />
                </Show>
              )}
            </Index>
          )}
        </Show>
        <Show when={userRow()}>
          {(current) => (
            <UserRowContent
              row={current()}
              actions={props.actions}
              actionLabels={props.actionLabels}
            />
          )}
        </Show>
        <Show when={assistantRow()}>
          {(current) => (
            <Index each={current().parts}>
              {(part) => {
                const toolPart = () => {
                  const value = part()
                  return value.type === "tool" ? value : undefined
                }
                return (
                  <Show when={part().id} keyed>
                    <Show
                      when={toolPart()}
                      fallback={<AssistantPartBlock part={part()} message={current().message} showMeta={part().id === metaPartID()} showReasoningSummaries={props.showReasoningSummaries} modelName={props.modelName} />}
                    >
                      {(tool) => (
                        <ToolPartBlock
                          part={tool()}
                          message={current().message}
                          shellToolPartsExpanded={props.shellToolPartsExpanded}
                          editToolPartsExpanded={props.editToolPartsExpanded}
                          directory={props.directory}
                          editRenderer={props.editRenderer}
                          onSyncChild={props.onSyncChild}
                        />
                      )}
                    </Show>
                  </Show>
                )
              }}
            </Index>
          )}
        </Show>
        <Show when={errorRow()}>
          {(current) => <TurnOutcome message={current().message} />}
        </Show>
      </div>
    </ChatTurnFrame>
  )
}

/**
 * VirtualHistory renders the stable, completed transcript rows inside the
 * Virtualizer. It only receives stable rows so high-frequency text deltas never
 * change virtual row measurements.
 */
function VirtualHistory(props: {
  rows: TranscriptRow[]
  getParts: (id: string) => Part[]
  historyShift: boolean
  scrollRef: HTMLDivElement
  virtualize?: boolean
  onVirtualizer?: (handle: VirtualizerHandle | undefined) => void
  activeUserMessageID?: string | { current: () => string | undefined }
  shellToolPartsExpanded: boolean
  editToolPartsExpanded: boolean
  directory?: string
  editRenderer?: Component<OpenCodeEditRendererProps>
  actions?: ChatUserActions
  actionLabels?: ChatUserActionLabels
  onSyncChild?: (childID: string) => void
  modelName?: (providerID: string, modelID: string) => string | undefined
  showReasoningSummaries: boolean
}) {
  if (props.virtualize === false) {
    // Provide a stub handle so the seam is testable without a real Virtualizer.
    props.onVirtualizer?.({
      scrollToIndex: () => {},
    } as unknown as VirtualizerHandle)
    return (
      <div data-component="chat-virtual-history">
        <For each={props.rows}>
          {(row) => (
            <TranscriptRowView
              row={row}
              getParts={props.getParts}
              activeUserMessageID={props.activeUserMessageID}
              shellToolPartsExpanded={props.shellToolPartsExpanded}
              editToolPartsExpanded={props.editToolPartsExpanded}
              directory={props.directory}
              editRenderer={props.editRenderer}
              actions={props.actions}
              actionLabels={props.actionLabels}
              onSyncChild={props.onSyncChild}
              modelName={props.modelName}
              showReasoningSummaries={props.showReasoningSummaries}
            />
          )}
        </For>
      </div>
    )
  }
  return (
    <div data-component="chat-virtual-history">
      <Virtualizer
        data={props.rows}
        itemSize={60}
        scrollRef={props.scrollRef}
        shift={props.historyShift}
        ref={props.onVirtualizer}
      >
        {(row) => (
          <TranscriptRowView
            row={row}
            getParts={props.getParts}
            activeUserMessageID={props.activeUserMessageID}
            shellToolPartsExpanded={props.shellToolPartsExpanded}
            editToolPartsExpanded={props.editToolPartsExpanded}
            directory={props.directory}
            editRenderer={props.editRenderer}
            actions={props.actions}
            actionLabels={props.actionLabels}
            onSyncChild={props.onSyncChild}
            modelName={props.modelName}
            showReasoningSummaries={props.showReasoningSummaries}
          />
        )}
      </Virtualizer>
    </div>
  )
}

/**
 * LiveTranscriptTail renders the still-growing assistant segment of the running
 * turn directly, outside the Virtualizer, so streaming deltas never cause
 * measurement jumps.
 */
function LiveTranscriptTail(props: {
  rows: Accessor<TranscriptRow[]>
  getParts: (id: string) => Part[]
  activeUserMessageID?: string | { current: () => string | undefined }
  shellToolPartsExpanded: boolean
  editToolPartsExpanded: boolean
  directory?: string
  editRenderer?: Component<OpenCodeEditRendererProps>
  actions?: ChatUserActions
  actionLabels?: ChatUserActionLabels
  onSyncChild?: (childID: string) => void
  modelName?: (providerID: string, modelID: string) => string | undefined
  showReasoningSummaries: boolean
}) {
  return (
    <div data-component="chat-live-tail">
      <Index each={props.rows()}>
        {(row) => (
          <Show when={row().key} keyed>
            <TranscriptRowView
              row={row}
              getParts={props.getParts}
              activeUserMessageID={props.activeUserMessageID}
              shellToolPartsExpanded={props.shellToolPartsExpanded}
              editToolPartsExpanded={props.editToolPartsExpanded}
              directory={props.directory}
              editRenderer={props.editRenderer}
              actions={props.actions}
              actionLabels={props.actionLabels}
              onSyncChild={props.onSyncChild}
              modelName={props.modelName}
              showReasoningSummaries={props.showReasoningSummaries}
            />
          </Show>
        )}
      </Index>
    </div>
  )
}

/**
 * WorkbenchChatTimeline is the Workbench-specific chat transcript. It reads the
 * current directory SDK projection and partitions the transcript into a stable
 * virtual history and a directly rendered live tail. It does not import the
 * Workbench Store, Panel ID or Space identity.
 */
export function WorkbenchChatTimeline(props: WorkbenchChatTimelineProps) {
  const sync = useSync()

  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const getParts = (messageID: string) => sync.data.part[messageID] ?? emptyParts
  const status = createMemo(() => sync.data.session_status[props.sessionID] ?? idle)
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (status().type === "idle") return
    setNow(Date.now())
    const clock = window.setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => window.clearInterval(clock))
  })

  const assistantByParent = createMemo(() => {
    const result = new Map<string, AssistantMessage[]>()
    for (const message of messages()) {
      if (message.role !== "assistant") continue
      const list = result.get(message.parentID)
      if (list) {
        list.push(message)
        continue
      }
      result.set(message.parentID, [message])
    }
    return Object.fromEntries(result)
  })

  const stabilize = createRowStabilizer()
  const projection = createMemo(() =>
    projectTranscript({
      messages: messages(),
      getParts,
      status: status(),
      live: props.scroll.bottom,
      revert: props.revert,
      showReasoningSummaries: props.showReasoningSummaries,
      stabilize,
    }),
  )

  const virtualRows = createMemo(() => projection().partition.virtual)
  const directRows = createMemo(() => projection().partition.direct)
  const liveActivity = createMemo(() => deriveLiveActivity(status(), messages(), getParts))
  const busyTurnStartedAt = createMemo(() => {
    const current = messages()
    for (let index = current.length - 1; index >= 0; index--) {
      const message = current[index]
      if (message?.role === "user") return message.time.created
    }
    return latestAssistant(current)?.time.created ?? now()
  })

  const visibleUserMessages = createMemo(() =>
    props.revert ? props.userMessages.filter((m) => m.id < props.revert!) : props.userMessages,
  )

  const [scroller, setScroller] = createSignal<HTMLDivElement>()
  const [scrollTop, setScrollTop] = createSignal(0)
  const [jumpTargetTurnID, setJumpTargetTurnID] = createSignal<string | undefined>()
  let jumpHistorySuppressUntil = 0
  let virtualizer: VirtualizerHandle | undefined
  let pointerScrollPending = false
  let pointerScrollMoved = false
  let latestScrollFrame: number | undefined

  const cancelLatestScroll = () => {
    if (latestScrollFrame === undefined) return
    cancelAnimationFrame(latestScrollFrame)
    latestScrollFrame = undefined
  }

  const scrollToLatest: LatestScrollNavigator = () => {
    cancelLatestScroll()
    if (typeof virtualizer?.measure === "function") virtualizer.measure()

    let passes = 0
    const pin = () => {
      const el = scroller()
      if (!el) return
      el.scrollTop = el.scrollHeight
      props.onScheduleScrollState?.(el)
      passes += 1
      if (passes >= 8) {
        latestScrollFrame = undefined
        return
      }
      latestScrollFrame = requestAnimationFrame(pin)
    }
    pin()
  }

  const viewportRowKey = () => {
    const root = scroller()
    if (!root) return undefined

    const viewport = root.getBoundingClientRect()
    const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-row-type][data-turn-id]"))
    const visible = rows.find((row) => {
      const rect = row.getBoundingClientRect()
      return rect.bottom > viewport.top + 1 && rect.top < viewport.bottom
    })
    return visible?.dataset.rowKey
  }

  // Derive the active turn from the current viewport anchor. Prefer the
  // mounted DOM anchor when possible so the directly-rendered live tail is
  // included. The Virtualizer index only covers virtual history and therefore
  // cannot identify the active user message while a turn is streaming.
  const activeUserMessageID = createMemo(() => {
    if (props.activeUserMessageIDOverride) return props.activeUserMessageIDOverride
    // Keep the memo reactive to scrolling even when the DOM-anchor branch is
    // available. The anchor is measured imperatively, so without this read a
    // PgUp/PgDn event could reuse the previous viewport's active turn.
    const viewportOffset = scrollTop()
    // An in-flight programmatic jump owns the anchor until the scroll lands;
    // deriving it from the stale viewport made rapid PgUp repeat or skip.
    const pendingJump = jumpTargetTurnID()
    if (pendingJump) return pendingJump
    const direct = directRows()
    // Streaming rows live outside the Virtualizer. At the bottom, their
    // newest user row is the authoritative anchor and avoids forcing a layout
    // measurement on every token delta.
    if (props.scroll.bottom) {
      for (let i = direct.length - 1; i >= 0; i--) {
        if (direct[i]?.type === "user") return direct[i].turnID
      }
    }

    const allRows = projection().rows
    // When the user has scrolled up, a running direct row can still be visible
    // even though the virtual history's index points at the preceding turn.
    // Consult the mounted anchor only in that mixed direct/virtual state.
    if (direct.some((row) => row.type === "user")) {
      const domRowKey = viewportRowKey()
      if (domRowKey) {
        const nearestUser = nearestUserTurnID(allRows, domRowKey)
        if (nearestUser) return nearestUser
      }
    }

    const rows = virtualRows()
    if (rows.length === 0) return visibleUserMessages()[0]?.id
    let candidateIndex = 0
    if (virtualizer && typeof virtualizer.findItemIndex === "function") {
      candidateIndex = virtualizer.findItemIndex(viewportOffset)
    } else {
      candidateIndex = Math.floor(viewportOffset / 60)
    }
    // A revert can shrink `rows` before Virtua refreshes its internal item
    // count. Clamp the transient stale index to the current projection so the
    // active-turn lookup never dereferences a row that has already disappeared.
    const anchorIndex = Math.min(rows.length - 1, Math.max(0, Number.isFinite(candidateIndex) ? candidateIndex : 0))
    // Walk back to the nearest user row at or above the anchor.
    for (let i = anchorIndex; i >= 0; i--) {
      if (rows[i].type === "user") return rows[i].turnID
    }
    return visibleUserMessages()[0]?.id
  })

  const bindScroller = (el: HTMLDivElement | undefined) => {
    setScroller(el)
    props.setScrollRef?.(el)
  }

  const nestedScrollable = (target: EventTarget | null) => {
    const root = scroller()
    const element = target instanceof Element ? target : undefined
    const nested = element?.closest("[data-scrollable]")
    return !!nested && nested !== root
  }

  const startPointerScroll = (event: PointerEvent) => {
    if (event.button !== undefined && event.button !== 0) return
    if (nestedScrollable(event.target)) return
    pointerScrollPending = true
    pointerScrollMoved = false
  }

  const markPointerScroll = () => {
    if (!pointerScrollPending) return
    pointerScrollMoved = true
  }

  const stopPointerScroll = () => {
    pointerScrollPending = false
    pointerScrollMoved = false
  }

  // A drag can end outside the scroller where pointerup does not bubble back
  // to it; window-level release events clear the pending gesture so a later
  // streaming auto-scroll is never mistaken for user scrolling.
  const endPointerScroll = (event: PointerEvent) => {
    if (!pointerScrollPending) return
    if (event.target instanceof Element && scroller()?.contains(event.target)) return
    stopPointerScroll()
  }

  createEffect(() => {
    if (typeof window === "undefined") return
    window.addEventListener("pointerup", endPointerScroll)
    window.addEventListener("pointercancel", endPointerScroll)
    onCleanup(() => {
      window.removeEventListener("pointerup", endPointerScroll)
      window.removeEventListener("pointercancel", endPointerScroll)
    })
  })

  const pauseForWheelScroll = (event: WheelEvent) => {
    if (event.deltaY >= 0 || nestedScrollable(event.target)) return
    cancelLatestScroll()
    props.onUserScroll?.()
  }

  const handleScroll = () => {
    const el = scroller()
    if (!el) return
    props.onAutoScroll?.()
    setScrollTop(el.scrollTop)
    if (jumpTargetTurnID()) setJumpTargetTurnID(undefined)
    props.onScheduleScrollState?.(el)
    props.onHistoryScroll?.()
    if (pointerScrollPending && pointerScrollMoved) {
      pointerScrollPending = false
      pointerScrollMoved = false
      cancelLatestScroll()
      props.onUserScroll?.()
    }
    if (
      el.scrollTop < 200 &&
      props.historyMore &&
      !props.historyLoading &&
      Date.now() > jumpHistorySuppressUntil
    ) {
      const task = props.loadOlder
      if (typeof task === "function") void task()
    }
  }

  const jumpToPrompt = (userMessageID: string) => {
    cancelLatestScroll()
    // Pause auto-scroll so the jump is not overridden by bottom-following.
    props.onPauseAutoScroll?.()
    setJumpTargetTurnID(userMessageID)
    // A jump can land near the top where handleScroll would page in older
    // history mid-flight. Virtua's shift-mode reflow during that load is a
    // visible second jump, so hold the loader off until the jump settles.
    jumpHistorySuppressUntil = Date.now() + 400
    const index = virtualRows().findIndex((row) => row.turnID === userMessageID)
    if (index !== -1 && virtualizer) {
      // Re-measure mounted rows first so scrollToIndex works from real
      // heights instead of the 60px estimate; the stale-estimate second
      // correction after the jump was the visible full-viewport flicker.
      if (typeof virtualizer.measure === "function") virtualizer.measure()
      virtualizer.scrollToIndex(index, { align: "start" })
      return
    }
    // Fall back to the live tail DOM anchor, scoped to this panel's scroller.
    // A document-wide query can match the same turn in another keep-alive
    // panel and scroll the wrong container.
    const anchor = resolveTurnAnchor(scroller(), userMessageID)
    anchor?.scrollIntoView({ block: "start" })
  }

  let loadingFirstUserMessage = false
  const jumpToFirstUserMessage = async () => {
    if (loadingFirstUserMessage) return
    loadingFirstUserMessage = true
    try {
      let firstID = visibleUserMessages()[0]?.id
      // History is paged in from newest to oldest. Home has a global meaning,
      // so keep loading until there is no earlier page before making the final
      // jump instead of stopping at the first currently mounted row.
      try {
        while (props.historyMore) {
          await props.loadOlder()
          const nextID = visibleUserMessages()[0]?.id
          if (!nextID || nextID === firstID) break
          firstID = nextID
        }
      } catch {
        // Preserve the best available target if history retrieval fails.
      }
      if (firstID) jumpToPrompt(firstID)
    } finally {
      loadingFirstUserMessage = false
    }
  }

  const navigateUserMessage: UserMessageNavigator = (direction) => {
    const messages = visibleUserMessages()
    if (messages.length === 0) return false

    if (direction === "first" && props.historyMore) {
      void jumpToFirstUserMessage()
      return true
    }

    const currentIndex = messages.findIndex((message) => message.id === activeUserMessageID())
    const targetIndex =
      direction === "first"
        ? 0
        : direction === "previous"
          ? currentIndex - 1
          : currentIndex + 1

    if (targetIndex < 0 || targetIndex >= messages.length) return false
    const target = messages[targetIndex]
    if (!target) return false
    jumpToPrompt(target.id)
    return true
  }

  createEffect(() => {
    const register = props.onUserMessageNavigator
    if (!register) return
    register(navigateUserMessage)
    onCleanup(() => register(undefined))
  })

  createEffect(() => {
    const register = props.onLatestScrollNavigator
    if (!register) return
    register(scrollToLatest)
    onCleanup(() => register(undefined))
  })

  onCleanup(cancelLatestScroll)

  const syncChild = (childID: string) => {
    void sync.session.sync(childID)
  }

  return (
    <div data-component="chat-timeline" style="display:flex; position:relative; height:100%; min-width:0; isolation:isolate;">
      <Show when={props.showSessionProgressBar && status().type !== "idle"}>
        <div data-component="session-progress" data-state="showing" aria-hidden="true">
          <div
            data-component="session-progress-bar"
            style={{
              background: "var(--icon-interactive-base)",
              animation: "session-progress-whip 900ms infinite",
            }}
          />
        </div>
      </Show>
      <PromptNavigator
        sessionID={props.sessionID}
        userMessages={visibleUserMessages()}
        historyMore={props.historyMore}
        historyLoading={props.historyLoading}
        loadOlder={props.loadOlder}
        onJump={jumpToPrompt}
        getParts={getParts}
        assistantByParent={assistantByParent()}
        activeUserMessageID={{ current: activeUserMessageID }}
      />
      <Show when={props.scroll.overflow && props.scroll.jump}>
        <div data-component="chat-resume-scroll">
          <button type="button" data-action="chat-resume-scroll" aria-label="Scroll to bottom" on:click={() => props.onResumeScroll?.()}>
            <Icon name="arrow-down-to-line" size="normal" />
          </button>
        </div>
      </Show>
      <div
        data-component="chat-scroller"
        ref={bindScroller}
        onScroll={handleScroll}
        on:pointerdown={startPointerScroll}
        on:pointermove={markPointerScroll}
        on:pointerup={stopPointerScroll}
        on:pointercancel={stopPointerScroll}
        on:wheel={pauseForWheelScroll}
        on:click={(event) => props.onAutoScrollInteraction?.(event)}
        style="flex:1; height:100%; overflow:auto; min-width:0;"
      >
        <div data-component="chat-content" ref={(el) => props.setContentRef?.(el)}>
          <Show when={virtualRows().length > 0 && (props.virtualize === false || scroller())}>
            <VirtualHistory
              rows={virtualRows()}
              getParts={getParts}
              historyShift={props.historyShift}
              scrollRef={scroller()!}
              virtualize={props.virtualize}
              activeUserMessageID={{ current: activeUserMessageID }}
              shellToolPartsExpanded={props.shellToolPartsExpanded}
              editToolPartsExpanded={props.editToolPartsExpanded}
              directory={props.directory}
              editRenderer={props.editRenderer}
              actions={props.actions}
              actionLabels={props.actionLabels}
              onVirtualizer={(handle) => {
                virtualizer = handle
                props.onVirtualizer?.(handle)
              }}
              onSyncChild={syncChild}
              modelName={props.modelName}
              showReasoningSummaries={props.showReasoningSummaries}
            />
          </Show>
          <Show when={directRows().length > 0}>
            <LiveTranscriptTail
              rows={directRows}
              getParts={getParts}
              activeUserMessageID={{ current: activeUserMessageID }}
              shellToolPartsExpanded={props.shellToolPartsExpanded}
              editToolPartsExpanded={props.editToolPartsExpanded}
              directory={props.directory}
              editRenderer={props.editRenderer}
              actions={props.actions}
              actionLabels={props.actionLabels}
              onSyncChild={syncChild}
              modelName={props.modelName}
              showReasoningSummaries={props.showReasoningSummaries}
            />
          </Show>
          <div data-component="chat-live-activity-slot">
            <Show when={liveActivity()}>
              {(activity) => (
                <div data-component="chat-live-activity" role="status" aria-live="polite">
                  <Spinner class="size-3.5 shrink-0 text-v2-icon-icon-accent" />
                  <span data-slot="chat-live-activity-label">{activity().label}</span>
                  <span data-slot="chat-live-activity-elapsed">
                    {formatElapsed(busyTurnStartedAt(), now())}
                  </span>
                </div>
              )}
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
