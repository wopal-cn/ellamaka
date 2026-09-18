/**
 * Normalization for the `ontology-setup` step result summary.
 *
 * The wire contract carries `{ type, description? }` per available Space type
 * (the former `branch` field was removed server-side); the summary keeps every
 * well-formed entry and renders the optional description alongside it.
 */

export interface AvailableOntologyType {
  type: string
  description: string | null
}

export interface OntologyResultSummary {
  mode: "fork" | "clone"
  sourceType: "official" | "custom"
  remoteUrl: string
  upstreamUrl?: string
  localPath: string
  availableTypes: AvailableOntologyType[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Normalize one raw available-type entry. Returns `null` for anything without
 * a usable `type`; a missing or non-string `description` normalizes to `null`
 * so consumers can render the entry without a second presence check.
 */
export function normalizeAvailableType(value: unknown): AvailableOntologyType | null {
  if (!isRecord(value)) return null
  if (typeof value.type !== "string" || !value.type) return null
  return {
    type: value.type,
    description: typeof value.description === "string" ? value.description : null,
  }
}

/** Normalize a raw available-type list, dropping malformed entries only. */
export function normalizeAvailableTypes(value: unknown): AvailableOntologyType[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const normalized = normalizeAvailableType(item)
    return normalized ? [normalized] : []
  })
}

export function normalizeOntologyResult(
  value: unknown,
  mode: "fork" | "clone",
  sourceType: "official" | "custom",
): OntologyResultSummary {
  const data = (value ?? {}) as Record<string, unknown>
  const source = typeof data.source === "string" ? data.source : ""

  return {
    mode,
    sourceType,
    remoteUrl: typeof data.remoteUrl === "string" ? data.remoteUrl : source,
    upstreamUrl: mode === "fork"
      ? typeof data.upstreamUrl === "string" ? data.upstreamUrl : source
      : undefined,
    localPath: typeof data.ontologyPath === "string" ? data.ontologyPath : "",
    availableTypes: normalizeAvailableTypes(data.availableTypes),
  }
}
