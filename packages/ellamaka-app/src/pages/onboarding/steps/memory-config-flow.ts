/**
 * Memory configuration flow — pure functions for probe normalization,
 * form initialization, validation, payload construction, and result
 * summary. No UI or IPC dependencies.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface MemoryProbeResult {
  state: "unconfigured" | "disabled" | "incomplete" | "ready" | "space-custom"
  enabled: boolean
  memoryInjectionEnabled?: boolean
  envPath: string
  llmEndpoint: string
  llmModel: string
  llmKeyConfigured: boolean
  embeddingEndpoint: string
  embeddingModel: string
  embeddingKeyConfigured: boolean
  globalMemory?: Record<string, any> | null
  spaceMemory?: Record<string, any> | null
  effectiveSpace?: { name: string; path: string; type?: string | null } | null
  error?: string | null
}

export interface MemoryFormState {
  enabled: boolean
  memoryInjectionEnabled: boolean
  scope: "global" | "space"
  spaceMode: "inherit" | "custom" | "disabled"
  spacePath?: string
  llmEndpoint: string
  llmModel: string
  llmKey: string
  embeddingEndpoint: string
  embeddingModel: string
  embeddingKey: string
  reuseEmbedding: boolean
  llmKeyConfigured: boolean
  embeddingKeyConfigured: boolean
}

export type MemoryScope = "global" | "space"

export interface MemoryScopeDrafts {
  global: MemoryFormState
  space: MemoryFormState
}

export type MemoryScopeEditing = Record<MemoryScope, boolean>

export interface MemoryFormErrors {
  llmEndpoint?: string
  llmKey?: string
  llmModel?: string
  embeddingEndpoint?: string
  embeddingModel?: string
  embeddingKey?: string
}

export interface MemoryPayload {
  enabled?: boolean
  memoryInjectionEnabled?: boolean
  scope?: "global" | "space"
  spaceMode?: "inherit" | "custom" | "disabled"
  spacePath?: string
  llmEndpoint?: string
  llmKey?: string
  llmModel?: string
  embeddingEndpoint?: string
  embeddingKey?: string
  embeddingModel?: string
}

export interface MemoryResultSummary {
  enabled: boolean
  memoryInjectionEnabled?: boolean
  state: string
  outcome: string
  envPath: string
  llmEndpoint: string
  llmModel: string
  llmKeySaved: boolean
  embeddingEndpoint: string
  embeddingModel: string
  embeddingKeySaved: boolean
  isSpaceInherited?: boolean
  spaceMode?: "inherit" | "custom" | "disabled"
  spaceName?: string
}

// ── normalizeMemoryProbe ───────────────────────────────────────────────

/**
 * Normalize the raw probe response into a typed MemoryProbeResult.
 * Handles missing/partial data gracefully.
 */
export function normalizeMemoryProbe(
  raw: Record<string, unknown> | null | undefined,
): MemoryProbeResult {
  const nested = raw?.memory
  const mem = nested && typeof nested === "object"
    ? nested as Record<string, unknown>
    : (raw ?? {})
  const llm = (mem.llm ?? {}) as Record<string, unknown>
  const emb = (mem.embedding ?? {}) as Record<string, unknown>
  const states: MemoryProbeResult["state"][] = ["unconfigured", "disabled", "incomplete", "ready", "space-custom"]
  const state = states.includes(mem.state as MemoryProbeResult["state"])
    ? mem.state as MemoryProbeResult["state"]
    : "unconfigured"

  return {
    state,
    enabled: Boolean(mem.enabled),
    memoryInjectionEnabled: mem.memoryInjectionEnabled !== false,
    envPath: String(mem.envPath ?? ""),
    llmEndpoint: String(mem.llmEndpoint ?? llm.endpoint ?? ""),
    llmModel: String(mem.llmModel ?? llm.model ?? ""),
    llmKeyConfigured: Boolean(mem.hasLlmKey ?? llm.keyConfigured),
    embeddingEndpoint: String(mem.embeddingEndpoint ?? emb.endpoint ?? ""),
    embeddingModel: String(mem.embeddingModel ?? emb.model ?? ""),
    embeddingKeyConfigured: Boolean(mem.hasEmbeddingKey ?? emb.keyConfigured),
    globalMemory: (raw?.globalMemory as any) ?? null,
    spaceMemory: (raw?.spaceMemory as any) ?? null,
    effectiveSpace: (raw?.effectiveSpace as any) ?? null,
    error: typeof raw?.error === "string" ? raw.error : null,
  }
}

// ── buildInitialForm ───────────────────────────────────────────────────

/**
 * Build the initial form state from a probe result.
 * - Fresh/unconfigured: defaults to enabled, LLM model = gpt-4o-mini
 * - Disabled: pre-fills existing values, switch off
 * - Ready/incomplete: pre-fills existing values, switch on
 * - Auto-detects reuseEmbedding when both endpoints are non-empty and equal
 */
export function buildInitialForm(probe: MemoryProbeResult): MemoryFormState {
  const isFresh = probe.state === "unconfigured"

  const llmEndpoint = isFresh ? "" : probe.llmEndpoint
  const llmModel = isFresh ? "gpt-4o-mini" : probe.llmModel
  const embeddingEndpoint = isFresh ? "" : probe.embeddingEndpoint
  const embeddingModel = isFresh ? "" : probe.embeddingModel

  const reuseEmbedding = isFresh || (
    llmEndpoint.length > 0 &&
    embeddingEndpoint.length > 0 &&
    llmEndpoint === embeddingEndpoint
  )

  let spaceMode: "inherit" | "custom" | "disabled" = "inherit"
  if (probe.spaceMemory) {
    spaceMode = (probe.spaceMemory as any).enabled === false ? "disabled" : "custom"
  }

  return {
    enabled: isFresh ? false : probe.enabled,
    memoryInjectionEnabled: probe.memoryInjectionEnabled !== false,
    scope: probe.state === "space-custom" ? "space" : "global",
    spaceMode,
    llmEndpoint,
    llmModel,
    llmKey: "",
    embeddingEndpoint,
    embeddingModel,
    embeddingKey: "",
    reuseEmbedding,
    llmKeyConfigured: probe.llmKeyConfigured,
    embeddingKeyConfigured: probe.embeddingKeyConfigured,
  }
}

function memoryRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null
}

function memoryString(source: Record<string, unknown> | null, key: string, fallback: string): string {
  const value = source?.[key]
  return typeof value === "string" && value ? value : fallback
}

export function buildMemoryScopeDraft(
  probe: MemoryProbeResult,
  scope: MemoryScope,
): MemoryFormState {
  const base = buildInitialForm(probe)
  const globalMemory = memoryRecord(probe.globalMemory)
  const spaceMemory = memoryRecord(probe.spaceMemory)
  const source = scope === "space" ? spaceMemory ?? globalMemory : globalMemory
  const spaceMode = scope === "space"
    ? !spaceMemory
      ? "inherit"
      : spaceMemory.enabled === false
        ? "disabled"
        : "custom"
    : base.spaceMode
  const llmEndpoint = memoryString(source, "llmEndpoint", base.llmEndpoint || "https://api.openai.com/v1")
  const embeddingEndpoint = memoryString(source, "embeddingEndpoint", base.embeddingEndpoint)

  return {
    enabled: typeof source?.enabled === "boolean" ? source.enabled : base.enabled,
    memoryInjectionEnabled: typeof source?.memoryInjectionEnabled === "boolean"
      ? source.memoryInjectionEnabled
      : base.memoryInjectionEnabled,
    scope,
    spaceMode,
    spacePath: scope === "space" ? probe.effectiveSpace?.path : undefined,
    llmEndpoint,
    llmModel: memoryString(source, "llmModel", base.llmModel || "gpt-4o-mini"),
    llmKey: "",
    embeddingEndpoint,
    embeddingModel: memoryString(source, "embeddingModel", base.embeddingModel || "text-embedding-3-small"),
    embeddingKey: "",
    reuseEmbedding: !embeddingEndpoint || embeddingEndpoint === llmEndpoint,
    llmKeyConfigured: typeof source?.hasLlmKey === "boolean"
      ? source.hasLlmKey
      : base.llmKeyConfigured,
    embeddingKeyConfigured: typeof source?.hasEmbeddingKey === "boolean"
      ? source.hasEmbeddingKey
      : base.embeddingKeyConfigured,
  }
}

export function createMemoryScopeDrafts(probe: MemoryProbeResult): MemoryScopeDrafts {
  return {
    global: buildMemoryScopeDraft(probe, "global"),
    space: buildMemoryScopeDraft(probe, "space"),
  }
}

export function hasMemorySpaceTarget(probe: MemoryProbeResult): boolean {
  return Boolean(probe.effectiveSpace?.path?.trim())
}

export function switchMemoryScopeDraft(
  drafts: MemoryScopeDrafts,
  currentDraft: MemoryFormState,
  targetScope: MemoryScope,
): { drafts: MemoryScopeDrafts; targetDraft: MemoryFormState } {
  const nextDrafts = {
    ...drafts,
    [currentDraft.scope]: { ...currentDraft },
  }
  return {
    drafts: nextDrafts,
    targetDraft: { ...nextDrafts[targetScope] },
  }
}

export function refreshMemoryScopeDraftsAfterSave(
  probe: MemoryProbeResult,
  savedScope: MemoryScope,
  previousDrafts: MemoryScopeDrafts,
  previousEditing: MemoryScopeEditing,
  previousDirty: MemoryScopeEditing,
): { drafts: MemoryScopeDrafts; editing: MemoryScopeEditing; dirty: MemoryScopeEditing } {
  const drafts = createMemoryScopeDrafts(probe)
  const otherScope: MemoryScope = savedScope === "global" ? "space" : "global"
  if (previousDirty[otherScope]) {
    drafts[otherScope] = { ...previousDrafts[otherScope] }
  }
  return {
    drafts,
    editing: {
      ...previousEditing,
      [savedScope]: false,
    },
    dirty: {
      ...previousDirty,
      [savedScope]: false,
    },
  }
}

// ── validateMemoryForm ─────────────────────────────────────────────────

const URL_PATTERN = /^https?:\/\/.+/i

/**
 * Validate the form state. Returns null if valid, or an object with
 * per-field error messages. Only validates when enabled and custom.
 */
export function validateMemoryForm(
  form: MemoryFormState,
): MemoryFormErrors | null {
  if (!form.enabled) return null
  if (form.scope === "space" && form.spaceMode && form.spaceMode !== "custom") return null

  const errors: MemoryFormErrors = {}

  // LLM endpoint: required, must be a valid URL
  if (!form.llmEndpoint.trim()) {
    errors.llmEndpoint = "请输入 LLM API 端点地址"
  } else if (!URL_PATTERN.test(form.llmEndpoint.trim())) {
    errors.llmEndpoint = "请输入有效的 URL（以 http:// 或 https:// 开头）"
  }

  // LLM key: required if not already configured
  if (!form.llmKey.trim() && !form.llmKeyConfigured) {
    errors.llmKey = "请输入 LLM API Key"
  }

  // LLM model: required
  if (!form.llmModel.trim()) {
    errors.llmModel = "请输入 LLM 模型名称"
  }

  // Embedding endpoint: required unless reuse is on
  if (!form.reuseEmbedding) {
    if (!form.embeddingEndpoint.trim()) {
      errors.embeddingEndpoint = "请输入 Embedding API 端点地址"
    } else if (!URL_PATTERN.test(form.embeddingEndpoint.trim())) {
      errors.embeddingEndpoint = "请输入有效的 URL（以 http:// 或 https:// 开头）"
    }
  }

  // Embedding model: always required
  if (!form.embeddingModel.trim()) {
    errors.embeddingModel = "请输入 Embedding 模型名称"
  }

  return Object.keys(errors).length > 0 ? errors : null
}

// ── buildMemoryPayload ─────────────────────────────────────────────────

/**
 * Build the IPC payload from the form state.
 */
export function buildMemoryPayload(form: MemoryFormState): MemoryPayload {
  const spacePath = form.scope === "space" ? form.spacePath : undefined

  if (form.scope === "space" && form.spaceMode === "inherit") {
    return { scope: "space", spaceMode: "inherit", spacePath }
  }
  if (form.scope === "space" && form.spaceMode === "disabled") {
    return { enabled: false, scope: "space", spaceMode: "disabled", spacePath }
  }
  if (!form.enabled) {
    return { enabled: false, scope: form.scope, spaceMode: form.spaceMode, spacePath }
  }

  const payload: MemoryPayload = {
    enabled: true,
    memoryInjectionEnabled: form.memoryInjectionEnabled,
    scope: form.scope,
    spaceMode: form.scope === "space" ? form.spaceMode : undefined,
    spacePath,
    llmEndpoint: form.llmEndpoint.trim() || undefined,
    llmModel: form.llmModel.trim() || undefined,
  }

  // LLM key: only send if user typed a new one
  if (form.llmKey.trim()) {
    payload.llmKey = form.llmKey.trim()
  }

  if (form.reuseEmbedding) {
    payload.embeddingEndpoint = form.llmEndpoint.trim() || undefined
    if (form.llmKey.trim()) {
      payload.embeddingKey = form.llmKey.trim()
    }
  } else {
    if (form.embeddingEndpoint.trim()) {
      payload.embeddingEndpoint = form.embeddingEndpoint.trim()
    }
    if (form.embeddingKey.trim()) {
      payload.embeddingKey = form.embeddingKey.trim()
    }
  }

  if (form.embeddingModel.trim()) {
    payload.embeddingModel = form.embeddingModel.trim()
  }

  return payload
}

// ── buildMemoryResultSummary ───────────────────────────────────────────

/**
 * Build a display-friendly result summary from the operation result.
 * Never includes actual key values.
 */
export function buildMemoryResultSummary(
  result: Record<string, unknown>,
): MemoryResultSummary {
  return {
    enabled: Boolean(result.memoryEnabled),
    memoryInjectionEnabled: result.memoryInjectionEnabled !== false,
    state: String(result.state ?? "unknown"),
    outcome: String(result.outcome ?? "unknown"),
    envPath: String(result.envPath ?? ""),
    llmEndpoint: String(result.llmEndpoint ?? ""),
    llmModel: String(result.llmModel ?? ""),
    llmKeySaved: Boolean(result.llmKeyConfigured),
    embeddingEndpoint: String(result.embeddingEndpoint ?? ""),
    embeddingModel: String(result.embeddingModel ?? ""),
    embeddingKeySaved: Boolean(result.embeddingKeyConfigured),
    spaceMode: (result.spaceMode as any) ?? undefined,
  }
}

export function buildMemoryResultSummaryFromProbe(
  probe: MemoryProbeResult,
  targetScope: "global" | "space" = "global",
): MemoryResultSummary {
  const isSpace = targetScope === "space"
  const isInherited = isSpace && !probe.spaceMemory
  const mem = isSpace
    ? (probe.spaceMemory || probe.globalMemory || probe)
    : (probe.globalMemory || probe)

  let spaceMode: "inherit" | "custom" | "disabled" | undefined = undefined
  if (isSpace) {
    if (!probe.spaceMemory) spaceMode = "inherit"
    else if ((probe.spaceMemory as any).enabled === false) spaceMode = "disabled"
    else spaceMode = "custom"
  }

  const effectiveEnabled = isInherited
    ? Boolean(probe.globalMemory ? (probe.globalMemory as any).enabled : false)
    : Boolean((mem as any).enabled ?? probe.enabled)

  return {
    enabled: effectiveEnabled,
    memoryInjectionEnabled: (mem as any).memoryInjectionEnabled !== false,
    state: String((mem as any).state ?? probe.state),
    outcome: isInherited ? "inherited" : "reused",
    envPath: String((mem as any).envPath ?? probe.envPath ?? ""),
    llmEndpoint: String((mem as any).llmEndpoint ?? probe.llmEndpoint ?? ""),
    llmModel: String((mem as any).llmModel ?? probe.llmModel ?? ""),
    llmKeySaved: Boolean((mem as any).hasLlmKey ?? probe.llmKeyConfigured),
    embeddingEndpoint: String((mem as any).embeddingEndpoint ?? probe.embeddingEndpoint ?? ""),
    embeddingModel: String((mem as any).embeddingModel ?? probe.embeddingModel ?? ""),
    embeddingKeySaved: Boolean((mem as any).hasEmbeddingKey ?? probe.embeddingKeyConfigured),
    isSpaceInherited: isInherited,
    spaceMode,
  }
}

export function isMemoryProbeSatisfied(
  probe: MemoryProbeResult,
  expectedEnabled: boolean,
): boolean {
  if (probe.error) return false
  return expectedEnabled
    ? probe.state === "ready" && probe.enabled
    : probe.state === "disabled" && !probe.enabled
}

/**
 * Decide whether the memory step may auto-confirm by reusing the probed
 * configuration. Only true when a memory configuration actually exists
 * (global or space). A fresh environment with just an effective space
 * must NOT auto-confirm — the user still needs to configure memory
 * explicitly via the form.
 */
export function shouldAutoConfirmMemoryProbe(probe: MemoryProbeResult): boolean {
  return Boolean(probe.globalMemory || probe.spaceMemory)
}
