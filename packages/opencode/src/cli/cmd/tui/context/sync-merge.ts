import type { Message } from "@opencode-ai/sdk/v2"
import { Binary } from "@wopal/ellamaka-core/util/binary"
import * as Log from "@wopal/ellamaka-core/util/log"

/**
 * Build the ordering key for a message. MessageID is monotonic only within a
 * 2^36 ms window; once it wraps the lexical id order diverges from time order,
 * so sorting by id alone reorders messages across a wrap-around. The composite
 * key `${time.created 的定长十六进制}:${id}` orders by the required absolute
 * `time.created` first (fixed-width hex keeps string ordering equal to numeric
 * ordering) and uses `id` only as a tie-breaker.
 */
function keyOf(message: Message): string {
  const created = typeof message.time?.created === "number" ? message.time.created : 0
  return `${created.toString(16).padStart(14, "0")}:${message.id}`
}
/** Exported for reuse by the sync.tsx realtime event handlers. */
export { keyOf }

/**
 * Return the id of the last assistant message that has not completed, or
 * `undefined` when the trailing assistant is finished (or there is none).
 *
 * The QUEUED badge is driven by the *last* open turn: only a trailing
 * unfinished assistant represents an active turn. A historical orphan (an
 * assistant killed mid-stream with no `time.completed`) buried earlier in the
 * array must not mark every later user message as QUEUED, so we inspect only
 * the last assistant rather than scanning for any unfinished one.
 */
export function activeTurnAssistantID(messages: Message[]): string | undefined {
  const last = messages.findLast((x) => x.role === "assistant")
  if (!last) return undefined
  return last.time.completed == null ? last.id : undefined
}

/**
 * Merge an API snapshot (`incoming`) into the current store array (`existing`)
 * while preserving the time-ordered sort contract required by
 * `Binary.search`/`Binary.insert`.
 *
 * The API response is ordered by `(time_created, id)`. Every incoming message
 * is upserted by its composite key:
 * - found in `existing` → replaced with the incoming (API) version
 * - not found → inserted at the correct time-ordered position
 * - messages in `existing` that are absent from `incoming` are kept (they were
 *   added by realtime events after the API snapshot was taken)
 *
 * Before returning, the array is validated to be strictly time-ascending. A
 * violation is recorded through the Log module (never console.warn, which
 * pollutes TUI rendering) as a runtime observer for the ordering contract.
 *
 * On a key conflict the two sources (realtime event vs API snapshot) cannot be
 * told apart by version or timestamp, so the assistant lifecycle is used as a
 * monotonic guard: `time.completed` is a one-way state (undefined → number,
 * never written back). If the existing (event-side) message is a completed
 * assistant and the incoming (snapshot-side) message lacks `completed`, the
 * snapshot was taken before completion landed and is stale for that field —
 * keep the existing message whole so a stale snapshot can never regress a
 * finished assistant into a permanently QUEUED one. All other conflicts use
 * the incoming (API-authoritative) version.
 */
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const result = existing.slice()
  for (const message of incoming) {
    const match = Binary.search(result, keyOf(message), keyOf)
    if (match.found) {
      const current = result[match.index]!
      if (keepExisting(current, message)) {
        continue
      }
      result[match.index] = message
    } else {
      Binary.insert(result, message, keyOf)
    }
  }
  assertOrdered(result)
  return result
}

/**
 * Decide whether an id conflict should keep the existing (event-side) message
 * instead of the incoming (snapshot-side) one. Returns true only when the
 * existing message is a completed assistant and the incoming one lacks
 * `time.completed` — the stale-snapshot regression case.
 */
function keepExisting(existing: Message, incoming: Message): boolean {
  if (existing.role !== "assistant") return false
  if (existing.time.completed == null) return false
  if (incoming.role !== "assistant") return false
  return incoming.time.completed == null
}

function assertOrdered(messages: Message[]) {
  for (let i = 1; i < messages.length; i++) {
    if (keyOf(messages[i]!) <= keyOf(messages[i - 1]!)) {
      Log.Default.warn("tui message array lost time ordering", {
        index: i,
        prev: keyOf(messages[i - 1]!),
        current: keyOf(messages[i]!),
      })
      break
    }
  }
}
