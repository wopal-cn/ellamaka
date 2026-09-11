import type { AssistantMessage, Message, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import { isRenderablePart } from "./chat-render.utils"

/**
 * Maximum number of visible parts rendered per assistant transcript row.
 * Assistant messages with more visible parts are split into multiple stable
 * rows so a single growing message never becomes an oversized virtual row.
 */
export const ASSISTANT_SEGMENT_PARTS = 20

/**
 * A ChatTurn groups one user message with every assistant message that shares
 * its `parentID`. It is the semantic and visual boundary of a request/response
 * cycle. A `partial` turn is created when the parent user message has not been
 * loaded yet (e.g. during history pagination); it is merged into a formal turn
 * once the parent arrives.
 */
export type ChatTurn = {
  id: string
  user: UserMessage
  assistant: AssistantMessage[]
  partial?: boolean
}

/**
 * A TranscriptRow is a stable, virtualizable unit of the transcript. Rows are
 * keyed by turn, message and (for assistant segments) the first part id so they
 * can be reused across re-projection, history prepend and reactive updates.
 */
export type TranscriptRow =
  | { type: "user"; key: string; turnID: string; message: UserMessage; parts: Part[] }
  | {
      type: "assistant"
      key: string
      turnID: string
      message: AssistantMessage
      parts: Part[]
      /** Part id in this row that carries the turn-final agent meta footer. */
      metaPartID?: string
    }
  | { type: "error"; key: string; turnID: string; message: AssistantMessage }
  | { type: "compaction"; key: string; turnID: string; parts: Part[] }

/**
 * The transcript is partitioned into a stable virtual history and a directly
 * rendered live tail. Completed history and the stable prefix of the running
 * turn enter `virtual`; the still-growing assistant segment of the running turn
 * (and its following rows) stay in `direct` so high-frequency text deltas never
 * change virtual row measurements.
 */
export type TranscriptPartition = {
  virtual: TranscriptRow[]
  direct: TranscriptRow[]
}

export type TranscriptProjectionInput = {
  messages: Message[]
  getParts: (messageID: string) => Part[]
  status: SessionStatus
  /** When true the user is at the bottom and the running turn may stream. */
  live?: boolean
  /** Revert boundary: only messages with id < revert are projected. */
  revert?: string
  /** Whether reasoning parts should be included in the transcript. */
  showReasoningSummaries?: boolean
  /** Optional row identity stabilizer (see createRowStabilizer). */
  stabilize?: (rows: TranscriptRow[]) => TranscriptRow[]
}

export type TranscriptProjection = {
  turns: ChatTurn[]
  rows: TranscriptRow[]
  partition: TranscriptPartition
  /** userMessageID -> first transcript row key, used by PromptNavigator. */
  promptIndex: Map<string, string>
}

function isUserMessage(message: Message): message is UserMessage {
  return message.role === "user"
}

function isAssistantMessage(message: Message): message is AssistantMessage {
  return message.role === "assistant"
}

/**
 * Detects the server's compaction marker: a user message carrying a `compaction`
 * part and no user-visible content. The engine creates it as the structural
 * parent of a compaction run; it must never surface as an empty prompt bubble.
 */
export function isCompactionMarker(message: Message, getParts: (messageID: string) => Part[]): boolean {
  if (message.role !== "user") return false
  const parts = getParts(message.id)
  if (parts.length === 0) return false
  return parts.every((part) => part.type === "compaction")
}

function isRunning(message: AssistantMessage): boolean {
  return typeof message.time.completed !== "number"
}

function isError(message: AssistantMessage): boolean {
  return !!message.error
}

function isAborted(message: AssistantMessage): boolean {
  return message.error?.name === "MessageAbortedError"
}

function visibleParts(
  message: AssistantMessage,
  getParts: (id: string) => Part[],
  _showReasoningSummaries: boolean,
): Part[] {
  return getParts(message.id).filter((part) => isRenderablePart(part, message))
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function userRowKey(turnID: string): string {
  return `user:${turnID}`
}

function assistantRowKey(messageID: string, firstPartID: string | undefined): string {
  return `assistant:${messageID}:${firstPartID ?? "none"}`
}

function errorRowKey(messageID: string): string {
  return `error:${messageID}`
}

/**
 * Returns a stable key for a transcript row. Keys are derived only from stable
 * identifiers (turn, message, first part id) so they survive re-projection.
 */
export function rowKey(row: TranscriptRow): string {
  return row.key
}

/**
 * Resolves a mounted viewport row to the user turn that owns it. Assistant
 * segments, tool rows and outcome rows can share a turn id, so the stable row
 * key is used to preserve the exact viewport position before walking backwards.
 */
export function nearestUserTurnID(rows: TranscriptRow[], rowKey: string | undefined): string | undefined {
  if (!rowKey) return undefined
  const anchorIndex = rows.findIndex((row) => row.key === rowKey)
  for (let index = anchorIndex; index >= 0; index--) {
    const row = rows[index]
    if (row?.type === "user") return row.turnID
  }
  return undefined
}

function compactionRowKey(turnID: string): string {
  return `compaction:${turnID}`
}

function buildTurnRows(
  turn: ChatTurn,
  getParts: (id: string) => Part[],
  status: SessionStatus,
  live: boolean,
  showReasoningSummaries: boolean,
): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  const turnID = turn.id

  if (isCompactionMarker(turn.user, getParts)) {
    rows.push({ type: "compaction", key: compactionRowKey(turnID), turnID, parts: getParts(turn.user.id) })
  } else {
    const userParts = getParts(turn.user.id)
    rows.push({ type: "user", key: userRowKey(turnID), turnID, message: turn.user, parts: userParts })
  }

  for (let messageIndex = 0; messageIndex < turn.assistant.length; messageIndex++) {
    const message = turn.assistant[messageIndex]!
    const isFinalMessage = messageIndex === turn.assistant.length - 1
    const parts = visibleParts(message, getParts, showReasoningSummaries)
    const segments = chunk(parts, ASSISTANT_SEGMENT_PARTS)
    if (segments.length === 0) {
      // An assistant message with no visible parts still needs a row so the
      // turn boundary and any error/outcome can be placed.
      rows.push({ type: "assistant", key: assistantRowKey(message.id, undefined), turnID, message, parts: [] })
      continue
    }
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
      const segment = segments[segmentIndex]!
      // Only the last narrative of the turn's final assistant message carries
      // the agent/model/duration meta footer. Earlier assistant messages (the
      // pre-tool reply of a multi-message turn) stay plain.
      let metaPartID: string | undefined
      if (isFinalMessage && segmentIndex === segments.length - 1) {
        for (let index = segment.length - 1; index >= 0; index--) {
          const part = segment[index]
          if (part?.type === "text" && !part.synthetic && part.text.trim()) {
            metaPartID = part.id
            break
          }
        }
      }
      rows.push({
        type: "assistant",
        key: assistantRowKey(message.id, segment[0]?.id),
        turnID,
        message,
        parts: segment,
        metaPartID,
      })
    }
  }

  for (const message of turn.assistant) {
    if (isError(message) && !isAborted(message)) {
      rows.push({ type: "error", key: errorRowKey(message.id), turnID, message })
    }
  }

  return rows
}

/**
 * Row identity stabilization. The live store rebuilds the parts array on every
 * message.part.delta even when most rows are unchanged; without stabilization
 * <For> in the transcript unmounts and remounts every row (and its markdown
 * renderer) per token, which is the visible streaming flicker. Rows are
 * fingerprinted by the content that actually affects rendering; an unchanged
 * fingerprint reuses the previous row object so Solid keeps the DOM subtree.
 *
 * The stabilizer is a factory so each timeline instance owns its cache (and
 * tests never share state across projections).
 */
export function createRowStabilizer() {
  const previous = new Map<string, { fingerprint: string; row: TranscriptRow }>()

  function partFingerprint(part: Part): string {
    const state = (part as { state?: { status?: string; raw?: string; time?: { end?: number } } }).state
    // `read` exposes a compact path while its JSON parameters stream. Preserve
    // stable rows for every other high-frequency update, but refresh this one
    // pending row when its raw input contains a newly completed file path.
    const raw = part.type === "tool" && part.tool === "read" && state?.status === "pending" ? (state.raw ?? "") : ""
    return `${part.id}:${part.type}:${state?.status ?? ""}:${state?.time?.end ?? ""}:${raw}`
  }

  function rowFingerprint(row: TranscriptRow): string {
    switch (row.type) {
      case "user": {
        const message = row.message as { id: string; time?: { updated?: number; completed?: number } }
        const time = `${message.time?.updated ?? ""}:${message.time?.completed ?? ""}`
        return `${row.type}:${message.id}:${time}:${row.parts.map(partFingerprint).join(",")}`
      }
      case "assistant": {
        const message = row.message as { id: string; time?: { updated?: number; completed?: number } }
        const time = `${message.time?.updated ?? ""}:${message.time?.completed ?? ""}`
        return `${row.type}:${message.id}:${time}:${row.metaPartID ?? ""}:${row.parts.map(partFingerprint).join(",")}`
      }
      case "error": {
        const message = row.message as { id: string; time?: { updated?: number; completed?: number } }
        const time = `${message.time?.updated ?? ""}:${message.time?.completed ?? ""}`
        return `${row.type}:${message.id}:${time}`
      }
      case "compaction":
        return `${row.type}:${row.turnID}:${row.parts.map(partFingerprint).join(",")}`
    }
  }

  return function stabilize(rows: TranscriptRow[]): TranscriptRow[] {
    const seen = new Set<string>()
    const out = rows.map((row) => {
      const fingerprint = rowFingerprint(row)
      const cached = previous.get(row.key)
      if (cached && cached.fingerprint === fingerprint) {
        seen.add(row.key)
        return cached.row
      }
      previous.set(row.key, { fingerprint, row })
      seen.add(row.key)
      return row
    })
    // Drop entries for rows that left the transcript so the cache never grows
    // unbounded across long sessions.
    for (const key of previous.keys()) {
      if (!seen.has(key)) previous.delete(key)
    }
    return out
  }
}

/**
 * Projects a flat, time-ordered message list into turns, transcript rows and a
 * virtual/direct partition. Pure function: it never mutates its inputs and
 * returns fresh objects each call, but row keys are stable so callers can reuse
 * rendered nodes across re-projection.
 */
export function projectTranscript(input: TranscriptProjectionInput): TranscriptProjection {
  const { messages, getParts, status, live = true, revert, showReasoningSummaries = true } = input

  const visible = revert
    ? messages.filter((m) => {
        if (isUserMessage(m)) return m.id < revert
        if (isAssistantMessage(m)) return m.parentID < revert
        return false
      })
    : messages

  const userByID = new Map<string, UserMessage>()
  const assistantByParent = new Map<string, AssistantMessage[]>()
  for (const message of visible) {
    if (isUserMessage(message)) {
      userByID.set(message.id, message)
      continue
    }
    if (!isAssistantMessage(message)) continue
    const list = assistantByParent.get(message.parentID)
    if (list) {
      list.push(message)
      continue
    }
    assistantByParent.set(message.parentID, [message])
  }

  const turns: ChatTurn[] = []
  const promptIndex = new Map<string, string>()

  // Build turns in message order. User messages create formal turns; assistant
  // messages whose parent is not loaded create partial turns.
  const turnByID = new Map<string, ChatTurn>()
  for (const message of visible) {
    if (isUserMessage(message)) {
      const turn: ChatTurn = { id: message.id, user: message, assistant: assistantByParent.get(message.id) ?? [] }
      turns.push(turn)
      turnByID.set(message.id, turn)
      continue
    }
    if (!isAssistantMessage(message)) continue
    if (turnByID.has(message.parentID)) continue
    const turn: ChatTurn = {
      id: message.parentID,
      user: userByID.get(message.parentID) ?? {
        id: message.parentID,
        sessionID: message.sessionID,
        role: "user",
        time: { created: message.time.created },
        agent: message.agent,
        model: { providerID: message.providerID, modelID: message.modelID },
      },
      assistant: assistantByParent.get(message.parentID) ?? [],
      partial: true,
    }
    turns.push(turn)
    turnByID.set(message.parentID, turn)
  }

  // Determine which turns are "live" (the running turn and everything after it).
  const runningTurnIndex = turns.findIndex((t) => t.assistant.some(isRunning))
  // The submitted user row is already the live turn while the Session is busy,
  // even during the short gap before its Assistant message arrives. Keeping it
  // direct from the start prevents a full row from entering Virtua and then
  // moving back out as soon as the first streamed Part is created.
  const activeTurnIndex = status.type === "idle" ? -1 : turns.length - 1
  const liveTurnIndex = runningTurnIndex !== -1 ? runningTurnIndex : activeTurnIndex
  const hasLiveTurn = liveTurnIndex !== -1

  const rows: TranscriptRow[] = []
  const virtual: TranscriptRow[] = []
  const direct: TranscriptRow[] = []

  turns.forEach((turn, index) => {
    const turnRows = buildTurnRows(turn, getParts, status, live, showReasoningSummaries)
    rows.push(...turnRows)
    if (!promptIndex.has(turn.id))
      promptIndex.set(
        turn.id,
        turnRows[0]?.key ?? (isCompactionMarker(turn.user, getParts) ? compactionRowKey(turn.id) : userRowKey(turn.id)),
      )

    const isLiveTurn = hasLiveTurn && index >= liveTurnIndex
    const turnRunning = turn.assistant.some(isRunning)
    const turnActive = index === activeTurnIndex
    const inDirect = isLiveTurn && (turnRunning || turnActive || (live && index === liveTurnIndex))

    if (inDirect) {
      direct.push(...turnRows)
    } else {
      virtual.push(...turnRows)
    }
  })

  const partition = input.stabilize
    ? { virtual: [] as TranscriptRow[], direct: [] as TranscriptRow[] }
    : { virtual, direct }
  if (input.stabilize) {
    // Stabilize across the whole partition in one pass so the cache sweep does
    // not evict rows that live in the other half of the partition.
    const all = input.stabilize([...virtual, ...direct])
    partition.virtual = all.slice(0, virtual.length)
    partition.direct = all.slice(virtual.length)
  }
  return { turns, rows, partition, promptIndex }
}
