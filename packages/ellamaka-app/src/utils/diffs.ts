import type { VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { Message } from "@opencode-ai/sdk/v2/client"

function diff(value: unknown): value is VcsFileDiff {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  if (!("file" in value) || typeof value.file !== "string") return false
  if (!("patch" in value) || typeof value.patch !== "string") return false
  if (!("additions" in value) || typeof value.additions !== "number") return false
  if (!("deletions" in value) || typeof value.deletions !== "number") return false
  if (!("status" in value) || value.status === undefined) return true
  return value.status === "added" || value.status === "deleted" || value.status === "modified"
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function diffs(value: unknown): VcsFileDiff[] {
  if (Array.isArray(value) && value.every(diff)) return value
  if (Array.isArray(value)) return value.filter(diff)
  if (diff(value)) return [value]
  if (!object(value)) return []
  return Object.values(value).filter(diff)
}

// Summary diffs are legacy snapshot payload (no longer produced); only the
// display fields are normalized, the raw diffs value passes through untouched.
export function message(value: Message): Message {
  if (value.role !== "user") return value

  const raw = value.summary as unknown
  if (raw === undefined) return value
  if (!object(raw)) return { ...value, summary: undefined }

  const title = typeof raw.title === "string" ? raw.title : undefined
  const body = typeof raw.body === "string" ? raw.body : undefined

  if (title === raw.title && body === raw.body) return value

  return {
    ...value,
    summary: {
      ...(title === undefined ? {} : { title }),
      ...(body === undefined ? {} : { body }),
    } as Message["summary"],
  } as Message
}
