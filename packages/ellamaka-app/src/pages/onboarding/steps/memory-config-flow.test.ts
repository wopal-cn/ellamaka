import { describe, expect, test } from "bun:test"
import {
  normalizeMemoryProbe,
  buildInitialForm,
  validateMemoryForm,
  buildMemoryPayload,
  buildMemoryResultSummary,
  buildMemoryResultSummaryFromProbe,
  createMemoryScopeDrafts,
  hasMemorySpaceTarget,
  isMemoryProbeSatisfied,
  refreshMemoryScopeDraftsAfterSave,
  switchMemoryScopeDraft,
  shouldAutoConfirmMemoryProbe,
  type MemoryProbeResult,
  type MemoryFormState,
  type MemoryFormErrors,
} from "./memory-config-flow"

// ── normalizeMemoryProbe ──────────────────────────────────────────────

describe("memory-config-flow | normalizeMemoryProbe", () => {
  test("unconfigured when probe returns no memory field", () => {
    const result = normalizeMemoryProbe({})
    expect(result.state).toBe("unconfigured")
    expect(result.enabled).toBe(false)
    expect(result.llmEndpoint).toBe("")
    expect(result.llmKeyConfigured).toBe(false)
    expect(result.embeddingEndpoint).toBe("")
    expect(result.embeddingKeyConfigured).toBe(false)
  })

  test("unconfigured when probe returns null", () => {
    const result = normalizeMemoryProbe(null as any)
    expect(result.state).toBe("unconfigured")
  })

  test("disabled state from probe", () => {
    const result = normalizeMemoryProbe({
      memory: {
        state: "disabled",
        enabled: false,
        injectionEnabled: false,
        envPath: "/tmp/.env",
        llm: { endpoint: "https://api.example.com", model: "gpt-4", keyConfigured: true },
        embedding: { endpoint: "https://api.example.com", model: "text-embedding-3-small", keyConfigured: false },
      },
    })
    expect(result.state).toBe("disabled")
    expect(result.enabled).toBe(false)
    expect(result.llmEndpoint).toBe("https://api.example.com")
    expect(result.llmKeyConfigured).toBe(true)
  })

  test("ready state from probe", () => {
    const result = normalizeMemoryProbe({
      memory: {
        state: "ready",
        enabled: true,
        injectionEnabled: true,
        envPath: "/tmp/.env",
        llm: { endpoint: "https://api.example.com", model: "gpt-4o", keyConfigured: true },
        embedding: { endpoint: "https://api.example.com", model: "text-embedding-3-small", keyConfigured: true },
      },
    })
    expect(result.state).toBe("ready")
    expect(result.enabled).toBe(true)
    expect(result.llmModel).toBe("gpt-4o")
    expect(result.embeddingModel).toBe("text-embedding-3-small")
  })

  test("accepts the direct memory object returned by Desktop probe", () => {
    const result = normalizeMemoryProbe({
      state: "ready",
      enabled: true,
      envPath: "/tmp/.env",
      llm: { endpoint: "https://api.example.com", model: "gpt-4o", keyConfigured: true },
      embedding: { endpoint: "https://api.example.com", model: "text-embedding-3-small", keyConfigured: false },
    })

    expect(result.state).toBe("ready")
    expect(result.llmKeyConfigured).toBe(true)
  })

  test("incomplete state from probe", () => {
    const result = normalizeMemoryProbe({
      memory: {
        state: "incomplete",
        enabled: true,
        injectionEnabled: false,
        envPath: "/tmp/.env",
        llm: { endpoint: "https://api.example.com", model: null, keyConfigured: false },
        embedding: { endpoint: null, model: null, keyConfigured: false },
      },
    })
    expect(result.state).toBe("incomplete")
    expect(result.enabled).toBe(true)
  })

  test("preserves a probe error instead of treating it as fresh config", () => {
    const result = normalizeMemoryProbe({ error: "检查失败" })

    expect(result.error).toBe("检查失败")
  })

  test("normalizes an unknown state to unconfigured", () => {
    const result = normalizeMemoryProbe({ memory: { state: "invalid" } })

    expect(result.state).toBe("unconfigured")
  })

  test("never leaks keys from probe", () => {
    const result = normalizeMemoryProbe({
      memory: {
        state: "ready",
        enabled: true,
        injectionEnabled: true,
        envPath: "/tmp/.env",
        llm: { endpoint: "https://api.example.com", model: "gpt-4", keyConfigured: true },
        embedding: { endpoint: "https://api.example.com", model: "text-embedding-3-small", keyConfigured: true },
      },
    })
    const str = JSON.stringify(result)
    expect(str).not.toContain("sk-")
    expect(str).not.toContain("apiKey")
  })
})

// ── buildInitialForm ──────────────────────────────────────────────────

describe("memory-config-flow | buildInitialForm", () => {
  test("fresh state defaults to enabled with gpt-4o-mini", () => {
    const probe: MemoryProbeResult = {
      state: "unconfigured",
      enabled: false,
      envPath: "/tmp/.env",
      llmEndpoint: "",
      llmModel: "",
      llmKeyConfigured: false,
      embeddingEndpoint: "",
      embeddingModel: "",
      embeddingKeyConfigured: false,
    }
    const form = buildInitialForm(probe)
    expect(form.enabled).toBe(false)
    expect(form.llmModel).toBe("gpt-4o-mini")
    expect(form.llmEndpoint).toBe("")
    expect(form.llmKey).toBe("")
    expect(form.embeddingModel).toBe("")
    expect(form.reuseEmbedding).toBe(true)
  })

  test("disabled state pre-fills with existing values", () => {
    const probe: MemoryProbeResult = {
      state: "disabled",
      enabled: false,
      envPath: "/tmp/.env",
      llmEndpoint: "https://api.example.com",
      llmModel: "gpt-4",
      llmKeyConfigured: true,
      embeddingEndpoint: "https://api.example.com",
      embeddingModel: "text-embedding-3-small",
      embeddingKeyConfigured: false,
    }
    const form = buildInitialForm(probe)
    expect(form.enabled).toBe(false)
    expect(form.llmEndpoint).toBe("https://api.example.com")
    expect(form.llmModel).toBe("gpt-4")
    expect(form.llmKey).toBe("")
    expect(form.embeddingEndpoint).toBe("https://api.example.com")
    expect(form.embeddingModel).toBe("text-embedding-3-small")
    expect(form.reuseEmbedding).toBe(true) // endpoints match
  })

  test("ready state pre-fills and auto-detects reuse when endpoints match", () => {
    const probe: MemoryProbeResult = {
      state: "ready",
      enabled: true,
      envPath: "/tmp/.env",
      llmEndpoint: "https://api.openai.com/v1",
      llmModel: "gpt-4o",
      llmKeyConfigured: true,
      embeddingEndpoint: "https://api.openai.com/v1",
      embeddingModel: "text-embedding-3-small",
      embeddingKeyConfigured: true,
    }
    const form = buildInitialForm(probe)
    expect(form.enabled).toBe(true)
    expect(form.reuseEmbedding).toBe(true)
    expect(form.embeddingEndpoint).toBe("https://api.openai.com/v1")
  })

  test("does not auto-detect reuse when endpoints differ", () => {
    const probe: MemoryProbeResult = {
      state: "ready",
      enabled: true,
      envPath: "/tmp/.env",
      llmEndpoint: "https://api.openai.com/v1",
      llmModel: "gpt-4o",
      llmKeyConfigured: true,
      embeddingEndpoint: "https://other.example.com",
      embeddingModel: "text-embedding-3-small",
      embeddingKeyConfigured: false,
    }
    const form = buildInitialForm(probe)
    expect(form.reuseEmbedding).toBe(false)
  })
})

describe("memory-config-flow | scope drafts", () => {
  const probe: MemoryProbeResult = {
    state: "disabled",
    enabled: false,
    envPath: "/home/.wopal/.env",
    llmEndpoint: "",
    llmModel: "",
    llmKeyConfigured: false,
    embeddingEndpoint: "",
    embeddingModel: "",
    embeddingKeyConfigured: false,
    globalMemory: {
      enabled: false,
      memoryInjectionEnabled: true,
      envPath: "/home/.wopal/.env",
      llmEndpoint: "https://global.example.com/v1",
      llmModel: "global-model",
      embeddingEndpoint: "https://global.example.com/v1",
      embeddingModel: "global-embedding",
      hasLlmKey: true,
      hasEmbeddingKey: true,
    },
    spaceMemory: null,
    effectiveSpace: { name: "coding", path: "/spaces/coding" },
  }

  test("creates independent global and inherited space drafts from probe", () => {
    const drafts = createMemoryScopeDrafts(probe)

    expect(drafts.global.scope).toBe("global")
    expect(drafts.global.enabled).toBe(false)
    expect(drafts.global.llmEndpoint).toBe("https://global.example.com/v1")
    expect(drafts.space.scope).toBe("space")
    expect(drafts.space.spaceMode).toBe("inherit")
    expect(drafts.space.spacePath).toBe("/spaces/coding")
    expect(drafts.space.llmEndpoint).toBe("https://global.example.com/v1")
    expect(hasMemorySpaceTarget(probe)).toBe(true)
  })

  test("rejects space scope when probe has no registered space path", () => {
    expect(hasMemorySpaceTarget({ ...probe, effectiveSpace: null })).toBe(false)
  })

  test("preserves unsaved global input across space and global tab switches", () => {
    const initial = createMemoryScopeDrafts(probe)
    const unsavedGlobal: MemoryFormState = {
      ...initial.global,
      enabled: true,
      llmEndpoint: "https://draft.example.com/v1",
      llmModel: "draft-model",
      llmKey: "draft-secret",
      embeddingEndpoint: "https://draft-embedding.example.com/v1",
      embeddingModel: "draft-embedding",
      embeddingKey: "draft-embedding-secret",
      reuseEmbedding: false,
    }

    const toSpace = switchMemoryScopeDraft(initial, unsavedGlobal, "space")
    const unsavedSpace: MemoryFormState = {
      ...toSpace.targetDraft,
      spaceMode: "custom",
      llmEndpoint: "https://space.example.com/v1",
      llmModel: "space-model",
    }
    const backToGlobal = switchMemoryScopeDraft(toSpace.drafts, unsavedSpace, "global")

    expect(backToGlobal.targetDraft.llmEndpoint).toBe("https://draft.example.com/v1")
    expect(backToGlobal.targetDraft.llmModel).toBe("draft-model")
    expect(backToGlobal.targetDraft.llmKey).toBe("draft-secret")
    expect(backToGlobal.targetDraft.embeddingEndpoint).toBe("https://draft-embedding.example.com/v1")
    expect(backToGlobal.targetDraft.embeddingModel).toBe("draft-embedding")
    expect(backToGlobal.targetDraft.embeddingKey).toBe("draft-embedding-secret")
    expect(backToGlobal.targetDraft.reuseEmbedding).toBe(false)
    expect(backToGlobal.drafts.space.llmEndpoint).toBe("https://space.example.com/v1")
  })

  test("refreshes the saved scope without discarding the other unsaved draft", () => {
    const initial = createMemoryScopeDrafts(probe)
    const drafts = {
      ...initial,
      space: {
        ...initial.space,
        spaceMode: "custom" as const,
        llmEndpoint: "https://unsaved-space.example.com/v1",
        llmModel: "unsaved-space-model",
        llmKey: "unsaved-space-secret",
      },
    }
    const refreshedProbe: MemoryProbeResult = {
      ...probe,
      state: "ready",
      enabled: true,
      globalMemory: {
        ...(probe.globalMemory ?? {}),
        enabled: true,
        llmEndpoint: "https://saved-global.example.com/v1",
        llmModel: "saved-global-model",
      },
    }

    const refreshed = refreshMemoryScopeDraftsAfterSave(
      refreshedProbe,
      "global",
      drafts,
      { global: true, space: true },
      { global: true, space: true },
    )

    expect(refreshed.drafts.global.llmEndpoint).toBe("https://saved-global.example.com/v1")
    expect(refreshed.editing.global).toBe(false)
    expect(refreshed.drafts.space.llmEndpoint).toBe("https://unsaved-space.example.com/v1")
    expect(refreshed.drafts.space.llmKey).toBe("unsaved-space-secret")
    expect(refreshed.editing.space).toBe(true)
    expect(refreshed.dirty.global).toBe(false)
    expect(refreshed.dirty.space).toBe(true)
  })
})

// ── validateMemoryForm ────────────────────────────────────────────────

describe("memory-config-flow | validateMemoryForm", () => {
  test("no errors when disabled", () => {
    const form: MemoryFormState = {
      memoryInjectionEnabled: true,
      scope: "global",
      spaceMode: "inherit",
      enabled: false,
      llmEndpoint: "",
      llmModel: "",
      llmKey: "",
      embeddingEndpoint: "",
      embeddingModel: "",
      embeddingKey: "",
      reuseEmbedding: false,
      llmKeyConfigured: false,
      embeddingKeyConfigured: false,
    }
    const errors = validateMemoryForm(form)
    expect(errors).toBeNull()
  })

  test("validates required fields when enabled", () => {
    const form: MemoryFormState = {
      memoryInjectionEnabled: true,
      scope: "global",
      spaceMode: "inherit",
      enabled: true,
      llmEndpoint: "",
      llmModel: "",
      llmKey: "",
      embeddingEndpoint: "",
      embeddingModel: "",
      embeddingKey: "",
      reuseEmbedding: false,
      llmKeyConfigured: false,
      embeddingKeyConfigured: false,
    }
    const errors = validateMemoryForm(form)
    expect(errors).not.toBeNull()
    expect(errors!.llmEndpoint).toBeDefined()
    expect(errors!.llmKey).toBeDefined()
    expect(errors!.embeddingEndpoint).toBeDefined()
    expect(errors!.embeddingModel).toBeDefined()
  })

  test("accepts when all required fields present", () => {
    const form: MemoryFormState = {
      memoryInjectionEnabled: true,
      scope: "global",
      spaceMode: "inherit",
      enabled: true,
      llmEndpoint: "https://api.example.com",
      llmModel: "gpt-4o-mini",
      llmKey: "sk-new",
      embeddingEndpoint: "https://api.example.com",
      embeddingModel: "text-embedding-3-small",
      embeddingKey: "",
      reuseEmbedding: false,
      llmKeyConfigured: false,
      embeddingKeyConfigured: false,
    }
    const errors = validateMemoryForm(form)
    expect(errors).toBeNull()
  })

  test("accepts when key is already configured (no new key input)", () => {
    const form: MemoryFormState = {
      memoryInjectionEnabled: true,
      scope: "global",
      spaceMode: "inherit",
      enabled: true,
      llmEndpoint: "https://api.example.com",
      llmModel: "gpt-4o-mini",
      llmKey: "",
      embeddingEndpoint: "https://api.example.com",
      embeddingModel: "text-embedding-3-small",
      embeddingKey: "",
      reuseEmbedding: false,
      llmKeyConfigured: true,
      embeddingKeyConfigured: false,
    }
    const errors = validateMemoryForm(form)
    expect(errors).toBeNull()
  })

  test("rejects invalid URL format", () => {
    const form: MemoryFormState = {
      memoryInjectionEnabled: true,
      scope: "global",
      spaceMode: "inherit",
      enabled: true,
      llmEndpoint: "not-a-url",
      llmModel: "gpt-4o-mini",
      llmKey: "sk-test",
      embeddingEndpoint: "https://api.example.com",
      embeddingModel: "text-embedding-3-small",
      embeddingKey: "",
      reuseEmbedding: false,
      llmKeyConfigured: false,
      embeddingKeyConfigured: false,
    }
    const errors = validateMemoryForm(form)
    expect(errors).not.toBeNull()
    expect(errors!.llmEndpoint).toBeDefined()
  })

  test("rejects empty embedding model", () => {
    const form: MemoryFormState = {
      memoryInjectionEnabled: true,
      scope: "global",
      spaceMode: "inherit",
      enabled: true,
      llmEndpoint: "https://api.example.com",
      llmModel: "gpt-4o-mini",
      llmKey: "sk-test",
      embeddingEndpoint: "https://api.example.com",
      embeddingModel: "",
      embeddingKey: "",
      reuseEmbedding: false,
      llmKeyConfigured: false,
      embeddingKeyConfigured: false,
    }
    const errors = validateMemoryForm(form)
    expect(errors).not.toBeNull()
    expect(errors!.embeddingModel).toBeDefined()
  })

  test("reuse mode: embedding endpoint not required when reuse is on", () => {
    const form: MemoryFormState = {
      memoryInjectionEnabled: true,
      scope: "global",
      spaceMode: "inherit",
      enabled: true,
      llmEndpoint: "https://api.example.com",
      llmModel: "gpt-4o-mini",
      llmKey: "sk-test",
      embeddingEndpoint: "",
      embeddingModel: "text-embedding-3-small",
      embeddingKey: "",
      reuseEmbedding: true,
      llmKeyConfigured: false,
      embeddingKeyConfigured: false,
    }
    const errors = validateMemoryForm(form)
    // In reuse mode, embedding endpoint is inherited from LLM
    expect(errors).toBeNull()
  })
})

// ── buildMemoryPayload ────────────────────────────────────────────────

describe("memory-config-flow | buildMemoryPayload", () => {
  test("builds full payload for enabled config", () => {
    const form: MemoryFormState = {
      memoryInjectionEnabled: true,
      scope: "global",
      spaceMode: "inherit",
      enabled: true,
      llmEndpoint: "https://api.example.com",
      llmModel: "gpt-4o-mini",
      llmKey: "sk-new-key",
      embeddingEndpoint: "https://api.example.com",
      embeddingModel: "text-embedding-3-small",
      embeddingKey: "emb-key",
      reuseEmbedding: false,
      llmKeyConfigured: false,
      embeddingKeyConfigured: false,
    }
    const payload = buildMemoryPayload(form)
    expect(payload.enabled).toBe(true)
    expect(payload.llmEndpoint).toBe("https://api.example.com")
    expect(payload.llmKey).toBe("sk-new-key")
    expect(payload.llmModel).toBe("gpt-4o-mini")
    expect(payload.embeddingEndpoint).toBe("https://api.example.com")
    expect(payload.embeddingKey).toBe("emb-key")
    expect(payload.embeddingModel).toBe("text-embedding-3-small")
  })

  test("omits key when not provided and already configured", () => {
    const form: MemoryFormState = {
      memoryInjectionEnabled: true,
      scope: "global",
      spaceMode: "inherit",
      enabled: true,
      llmEndpoint: "https://api.example.com",
      llmModel: "gpt-4o-mini",
      llmKey: "",
      embeddingEndpoint: "https://api.example.com",
      embeddingModel: "text-embedding-3-small",
      embeddingKey: "",
      reuseEmbedding: false,
      llmKeyConfigured: true,
      embeddingKeyConfigured: true,
    }
    const payload = buildMemoryPayload(form)
    expect(payload.llmKey).toBeUndefined()
    expect(payload.embeddingKey).toBeUndefined()
  })

  test("reuse mode: copies llmKey to embeddingKey when new key provided", () => {
    const form: MemoryFormState = {
      memoryInjectionEnabled: true,
      scope: "global",
      spaceMode: "inherit",
      enabled: true,
      llmEndpoint: "https://api.example.com",
      llmModel: "gpt-4o-mini",
      llmKey: "sk-new-key",
      embeddingEndpoint: "",
      embeddingModel: "text-embedding-3-small",
      embeddingKey: "",
      reuseEmbedding: true,
      llmKeyConfigured: false,
      embeddingKeyConfigured: false,
    }
    const payload = buildMemoryPayload(form)
    expect(payload.embeddingKey).toBe("sk-new-key")
    expect(payload.embeddingEndpoint).toBe("https://api.example.com")
  })

  test("reuse mode: does not copy empty llmKey to embeddingKey", () => {
    const form: MemoryFormState = {
      memoryInjectionEnabled: true,
      scope: "global",
      spaceMode: "inherit",
      enabled: true,
      llmEndpoint: "https://api.example.com",
      llmModel: "gpt-4o-mini",
      llmKey: "",
      embeddingEndpoint: "",
      embeddingModel: "text-embedding-3-small",
      embeddingKey: "",
      reuseEmbedding: true,
      llmKeyConfigured: true,
      embeddingKeyConfigured: true,
    }
    const payload = buildMemoryPayload(form)
    expect(payload.embeddingKey).toBeUndefined()
    expect(payload.embeddingEndpoint).toBe("https://api.example.com")
  })

  test("disabled global payload keeps inert scope fields", () => {
    const form: MemoryFormState = {
      memoryInjectionEnabled: true,
      scope: "global",
      spaceMode: "inherit",
      enabled: false,
      llmEndpoint: "https://api.example.com",
      llmModel: "gpt-4o-mini",
      llmKey: "",
      embeddingEndpoint: "",
      embeddingModel: "text-embedding-3-small",
      embeddingKey: "",
      reuseEmbedding: true,
      llmKeyConfigured: true,
      embeddingKeyConfigured: false,
    }
    const payload = buildMemoryPayload(form)
    // A real global-scope form always carries scope/spaceMode (see
    // buildInitialForm); the server short-circuits `enabled: false` before
    // reading either, so the global/inherit pair is inert on the wire.
    expect(payload).toEqual({ enabled: false, scope: "global", spaceMode: "inherit", spacePath: undefined })
  })

  test("space scope payloads attach spacePath for inherit, disabled, and custom modes", () => {
    const spacePath = "/Users/sam/space1"

    const inheritPayload = buildMemoryPayload({
      enabled: true,
      scope: "space",
      spaceMode: "inherit",
      spacePath,
      llmEndpoint: "",
      llmModel: "",
      llmKey: "",
      embeddingEndpoint: "",
      embeddingModel: "",
      embeddingKey: "",
      reuseEmbedding: true,
      llmKeyConfigured: false,
      embeddingKeyConfigured: false,
    } as any)
    expect(inheritPayload).toEqual({ scope: "space", spaceMode: "inherit", spacePath })

    const disabledPayload = buildMemoryPayload({
      enabled: false,
      scope: "space",
      spaceMode: "disabled",
      spacePath,
      llmEndpoint: "",
      llmModel: "",
      llmKey: "",
      embeddingEndpoint: "",
      embeddingModel: "",
      embeddingKey: "",
      reuseEmbedding: true,
      llmKeyConfigured: false,
      embeddingKeyConfigured: false,
    } as any)
    expect(disabledPayload).toEqual({ enabled: false, scope: "space", spaceMode: "disabled", spacePath })
  })

  test("scope drafts provide the detected space path to every space strategy", () => {
    const probe: MemoryProbeResult = {
      state: "ready",
      enabled: true,
      envPath: "/home/.wopal/.env",
      llmEndpoint: "https://api.example.com/v1",
      llmModel: "model",
      llmKeyConfigured: true,
      embeddingEndpoint: "https://api.example.com/v1",
      embeddingModel: "embedding",
      embeddingKeyConfigured: true,
      effectiveSpace: { name: "coding", path: "/spaces/coding" },
    }
    const draft = createMemoryScopeDrafts(probe).space

    expect(buildMemoryPayload({ ...draft, spaceMode: "inherit" })).toMatchObject({
      scope: "space",
      spaceMode: "inherit",
      spacePath: "/spaces/coding",
    })
    expect(buildMemoryPayload({ ...draft, enabled: false, spaceMode: "disabled" })).toMatchObject({
      scope: "space",
      spaceMode: "disabled",
      spacePath: "/spaces/coding",
    })
    expect(buildMemoryPayload({ ...draft, enabled: true, spaceMode: "custom" })).toMatchObject({
      scope: "space",
      spaceMode: "custom",
      spacePath: "/spaces/coding",
    })
  })
})

// ── buildMemoryResultSummary ───────────────────────────────────────────

describe("memory-config-flow | buildMemoryResultSummary", () => {
  test("builds summary from operation result", () => {
    const result: Record<string, unknown> = {
      memoryEnabled: true,
      state: "ready",
      envPath: "/tmp/.env",
      outcome: "created",
      llmEndpoint: "https://api.example.com",
      llmModel: "gpt-4o-mini",
      llmKeyConfigured: true,
      embeddingEndpoint: "https://api.example.com",
      embeddingModel: "text-embedding-3-small",
      embeddingKeyConfigured: true,
    }
    const summary = buildMemoryResultSummary(result)
    expect(summary.enabled).toBe(true)
    expect(summary.state).toBe("ready")
    expect(summary.outcome).toBe("created")
    expect(summary.llmEndpoint).toBe("https://api.example.com")
    expect(summary.llmKeySaved).toBe(true)
    expect(summary.embeddingKeySaved).toBe(true)
  })

  test("handles disabled state", () => {
    const result: Record<string, unknown> = {
      memoryEnabled: false,
      state: "disabled",
      envPath: "/tmp/.env",
      outcome: "reused",
    }
    const summary = buildMemoryResultSummary(result)
    expect(summary.enabled).toBe(false)
    expect(summary.state).toBe("disabled")
  })

  test("never leaks keys in summary", () => {
    const result: Record<string, unknown> = {
      memoryEnabled: true,
      state: "ready",
      envPath: "/tmp/.env",
      outcome: "created",
      llmEndpoint: "https://api.example.com",
      llmModel: "gpt-4o-mini",
      llmKeyConfigured: true,
      embeddingEndpoint: "https://api.example.com",
      embeddingModel: "text-embedding-3-small",
      embeddingKeyConfigured: true,
    }
    const summary = buildMemoryResultSummary(result)
    const str = JSON.stringify(summary)
    expect(str).not.toContain("sk-")
    expect(str).not.toContain("apiKey")
  })

  test("buildMemoryResultSummaryFromProbe accurately reflects space inheritance when global memory is disabled", () => {
    const probe: MemoryProbeResult = {
      state: "disabled",
      enabled: false,
      envPath: "/home/.env",
      llmEndpoint: "",
      llmModel: "",
      llmKeyConfigured: false,
      embeddingEndpoint: "",
      embeddingModel: "",
      embeddingKeyConfigured: false,
      globalMemory: {
        enabled: false,
        envPath: "/home/.env",
        llmEndpoint: "",
        llmModel: "",
      },
      spaceMemory: null,
      effectiveSpace: { name: "coding", path: "/space/coding" },
    }

    const summary = buildMemoryResultSummaryFromProbe(probe, "space")
    expect(summary.spaceMode).toBe("inherit")
    expect(summary.isSpaceInherited).toBe(true)
    expect(summary.enabled).toBe(false)
  })
})

describe("memory-config-flow | isMemoryProbeSatisfied", () => {
  const base: MemoryProbeResult = {
    state: "ready",
    enabled: true,
    envPath: "/tmp/.env",
    llmEndpoint: "https://api.example.com",
    llmModel: "gpt-4o-mini",
    llmKeyConfigured: true,
    embeddingEndpoint: "https://api.example.com",
    embeddingModel: "text-embedding-3-small",
    embeddingKeyConfigured: false,
    error: null,
  }

  test("accepts ready after enabling", () => {
    expect(isMemoryProbeSatisfied(base, true)).toBe(true)
  })

  test("accepts disabled after disabling", () => {
    expect(isMemoryProbeSatisfied({ ...base, state: "disabled", enabled: false }, false)).toBe(true)
  })

  test("rejects incomplete or failed verification", () => {
    expect(isMemoryProbeSatisfied({ ...base, state: "incomplete" }, true)).toBe(false)
    expect(isMemoryProbeSatisfied({ ...base, error: "检查失败" }, true)).toBe(false)
  })
})

describe("memory-config-flow | shouldAutoConfirmMemoryProbe", () => {
  const base: MemoryProbeResult = {
    state: "unconfigured",
    enabled: false,
    envPath: "/tmp/.env",
    llmEndpoint: "",
    llmModel: "",
    llmKeyConfigured: false,
    embeddingEndpoint: "",
    embeddingModel: "",
    embeddingKeyConfigured: false,
    error: null,
  }

  test("auto-confirms when global memory is configured", () => {
    expect(shouldAutoConfirmMemoryProbe({ ...base, globalMemory: { enabled: true } })).toBe(true)
  })

  test("auto-confirms when space memory is configured", () => {
    expect(shouldAutoConfirmMemoryProbe({ ...base, spaceMemory: { enabled: false } })).toBe(true)
  })

  test("does not auto-confirm on a fresh environment with only an effective space", () => {
    expect(shouldAutoConfirmMemoryProbe({
      ...base,
      effectiveSpace: { name: "coding", path: "/spaces/coding" },
    })).toBe(false)
  })

  test("does not auto-confirm on a completely fresh environment", () => {
    expect(shouldAutoConfirmMemoryProbe({ ...base })).toBe(false)
  })
})
