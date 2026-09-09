import type { Agent, Project, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import { NormalizedProviderListResponse } from "@wopal/ui/context"
export { pathKey as directoryKey, type PathKey as DirectoryKey } from "@/utils/path-key"

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

type TimeOrdered = { id: string; time?: { created: number } }

// Compare messages by recency. MessageID is monotonic only within a 2^36 ms
// window; once it wraps the lexical id order diverges from time order.
// `time.created` is a required absolute ms timestamp, so compare it first and
// fall back to id only when timestamps are equal (tie-breaker).
export const cmpMessage = (a: TimeOrdered, b: TimeOrdered) => {
  if (a.time?.created && b.time?.created && a.time.created !== b.time.created) {
    return a.time.created - b.time.created
  }
  return cmp(a.id, b.id)
}

// Composite ordering key for a message array maintained in time order:
// fixed-width hex of `time.created` (so string order == numeric order) plus id
// as tie-breaker. Used for Binary.search/insert on the time-ordered array.
export const keyOf = (m: TimeOrdered) => {
  const created = typeof m.time?.created === "number" ? m.time.created : 0
  return `${created.toString(16).padStart(14, "0")}:${m.id}`
}

function isAgent(input: unknown): input is Agent {
  if (!input || typeof input !== "object") return false
  const item = input as { name?: unknown; mode?: unknown }
  if (typeof item.name !== "string") return false
  return item.mode === "subagent" || item.mode === "primary" || item.mode === "all"
}

export function normalizeAgentList(input: unknown): Agent[] {
  if (Array.isArray(input)) return input.filter(isAgent)
  if (isAgent(input)) return [input]
  if (!input || typeof input !== "object") return []
  return Object.values(input).filter(isAgent)
}

export function normalizeProviderList(input: ProviderListResponse): NormalizedProviderListResponse {
  return {
    ...input,
    all: new Map(
      input.all.map(
        (provider) =>
          [
            provider.id,
            {
              ...provider,
              models: Object.fromEntries(
                Object.entries(provider.models).filter(([, info]) => info.status !== "deprecated"),
              ),
            },
          ] as const,
      ),
    ),
  }
}

export function sanitizeProject(project: Project) {
  if (!project.icon?.url && !project.icon?.override) return project
  return {
    ...project,
    icon: {
      ...project.icon,
      url: undefined,
      override: undefined,
    },
  }
}
