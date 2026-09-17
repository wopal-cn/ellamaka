export interface AvailableOntologyType {
  type: string
  branch: string
}

export interface OntologyResultSummary {
  mode: "fork" | "clone"
  sourceType: "official" | "custom"
  remoteUrl: string
  upstreamUrl?: string
  localPath: string
  availableTypes: AvailableOntologyType[]
}

export function normalizeOntologyResult(
  value: unknown,
  mode: "fork" | "clone",
  sourceType: "official" | "custom",
): OntologyResultSummary {
  const data = (value ?? {}) as Record<string, unknown>
  const availableTypes = Array.isArray(data.availableTypes)
    ? data.availableTypes.filter((item): item is AvailableOntologyType => {
        if (!item || typeof item !== "object") return false
        const candidate = item as Record<string, unknown>
        return typeof candidate.type === "string" && typeof candidate.branch === "string"
      })
    : []
  const source = typeof data.source === "string" ? data.source : ""

  return {
    mode,
    sourceType,
    remoteUrl: typeof data.remoteUrl === "string" ? data.remoteUrl : source,
    upstreamUrl: mode === "fork"
      ? typeof data.upstreamUrl === "string" ? data.upstreamUrl : source
      : undefined,
    localPath: typeof data.ontologyPath === "string" ? data.ontologyPath : "",
    availableTypes,
  }
}
