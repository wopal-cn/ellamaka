import { Binary } from "@wopal/ellamaka-core/util/binary"
import { useServerSync } from "./server-sync"
import { useSDK } from "./sdk"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { keyOf } from "./global-sync/utils"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])

function sortParts(parts: Part[]) {
  return parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id))
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

type OptimisticStore = {
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
}

type OptimisticAddInput = {
  sessionID: string
  message: Message
  parts: Part[]
}

type OptimisticRemoveInput = {
  sessionID: string
  messageID: string
}

type OptimisticItem = {
  message: Message
  parts: Part[]
}

type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
}

const hasParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return want.length === 0
  return want.every((part) => Binary.search(parts, part.id, (item) => item.id).found)
}

const mergeParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return sortParts(want)
  const next = [...parts]
  let changed = false
  for (const part of want) {
    const result = Binary.search(next, part.id, (item) => item.id)
    if (result.found) continue
    next.splice(result.index, 0, part)
    changed = true
  }
  if (!changed) return parts
  return next
}

export function mergeOptimisticPage(page: MessagePage, items: OptimisticItem[]) {
  if (items.length === 0) return { ...page, confirmed: [] as string[] }

  const session = [...page.session]
  const part = new Map(page.part.map((item) => [item.id, sortParts(item.part)]))
  const confirmed: string[] = []

  for (const item of items) {
    // The same message (same id) may already exist with a different
    // `time.created` (optimistic local time vs. confirmed server time), so
    // locate by id to avoid duplicating it; only insert when truly absent.
    const existing = session.findIndex((m) => m.id === item.message.id)
    const found = existing >= 0
    if (!found) {
      const result = Binary.search(session, keyOf(item.message), keyOf)
      session.splice(result.index, 0, item.message)
    }

    const current = part.get(item.message.id)
    if (found && hasParts(current, item.parts)) {
      confirmed.push(item.message.id)
      continue
    }

    part.set(item.message.id, mergeParts(current, item.parts))
  }

  return {
    cursor: page.cursor,
    complete: page.complete,
    session,
    part: [...part.entries()].sort((a, b) => cmp(a[0], b[0])).map(([id, part]) => ({ id, part })),
    confirmed,
  }
}

export function applyOptimisticAdd(draft: OptimisticStore, input: OptimisticAddInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    // Locate by id so an optimistic/confirmed pair never duplicates; insert by
    // the time-ordered composite key only when the message is truly absent.
    if (messages.findIndex((m) => m.id === input.message.id) < 0) {
      const result = Binary.search(messages, keyOf(input.message), keyOf)
      messages.splice(result.index, 0, input.message)
    }
  } else {
    draft.message[input.sessionID] = [input.message]
  }
  draft.part[input.message.id] = sortParts(input.parts)
}

export function applyOptimisticRemove(draft: OptimisticStore, input: OptimisticRemoveInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    // message.removed only carries the id (no time), so locate linearly.
    const index = messages.findIndex((m) => m.id === input.messageID)
    if (index >= 0) messages.splice(index, 1)
  }
  delete draft.part[input.messageID]
}

export const useSync = () => {
  const serverSync = useServerSync()
  const sdk = useSDK()

  return serverSync.createDirSyncContext(sdk.directory)
}
