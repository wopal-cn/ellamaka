import { createSignal, onMount, Show } from "solid-js"
import { ProgressDisplay } from "../components/ProgressDisplay"
import { ResultPanel } from "../components/ResultPanel"
import { zhCN } from "../content/zh-CN"
import { useOnboardingClient } from "../onboarding-client-context"
import {
  normalizeMemoryProbe,
  validateMemoryForm,
  buildMemoryPayload,
  buildMemoryResultSummary,
  buildMemoryResultSummaryFromProbe,
  createMemoryScopeDrafts,
  hasMemorySpaceTarget,
  refreshMemoryScopeDraftsAfterSave,
  shouldAutoConfirmMemoryProbe,
  switchMemoryScopeDraft,
  type MemoryProbeResult,
  type MemoryFormState,
  type MemoryFormErrors,
  type MemoryResultSummary,
  type MemoryScope,
  type MemoryScopeDrafts,
  type MemoryScopeEditing,
} from "./memory-config-flow"

export interface StepProps {
  onStatusChange?: (status: "idle" | "working" | "success" | "error") => void
  onComplete: () => void
  onError: (msg: string | null) => void
}

export function MemoryConfigStep(props: StepProps) {
  const client = useOnboardingClient()
  const t = zhCN.memory

  const [probing, setProbing] = createSignal(true)
  const [submitting, setSubmitting] = createSignal(false)
  const [resultSummary, setResultSummary] = createSignal<MemoryResultSummary | null>(null)
  const [probeError, setProbeError] = createSignal<string | null>(null)

  const [probeResult, setProbeResult] = createSignal<MemoryProbeResult | null>(null)
  const [scope, setScope] = createSignal<"global" | "space">("global")
  const [spaceMode, setSpaceMode] = createSignal<"inherit" | "custom" | "disabled">("inherit")
  const [editing, setEditing] = createSignal(false)
  const [scopeDrafts, setScopeDrafts] = createSignal<MemoryScopeDrafts | null>(null)
  const [scopeEditing, setScopeEditing] = createSignal<MemoryScopeEditing>({
    global: false,
    space: false,
  })
  const [scopeDirty, setScopeDirty] = createSignal<MemoryScopeEditing>({
    global: false,
    space: false,
  })

  // Form state
  const [enabled, setEnabled] = createSignal(false)
  const [memoryInjectionEnabled, setMemoryInjectionEnabled] = createSignal(true)
  const [llmEndpoint, setLlmEndpoint] = createSignal("https://api.openai.com/v1")
  const [llmModel, setLlmModel] = createSignal("gpt-4o-mini")
  const [llmKey, setLlmKey] = createSignal("")
  const [embeddingEndpoint, setEmbeddingEndpoint] = createSignal("")
  const [embeddingModel, setEmbeddingModel] = createSignal("text-embedding-3-small")
  const [embeddingKey, setEmbeddingKey] = createSignal("")
  const [reuseEmbedding, setReuseEmbedding] = createSignal(true)
  const [llmKeyConfigured, setLlmKeyConfigured] = createSignal(false)
  const [embeddingKeyConfigured, setEmbeddingKeyConfigured] = createSignal(false)

  const [errors, setErrors] = createSignal<MemoryFormErrors | null>(null)

  function applyFormState(form: MemoryFormState) {
    setScope(form.scope)
    setSpaceMode(form.spaceMode)
    setEnabled(form.enabled)
    setMemoryInjectionEnabled(form.memoryInjectionEnabled)
    setLlmEndpoint(form.llmEndpoint)
    setLlmModel(form.llmModel)
    setLlmKey(form.llmKey)
    setEmbeddingEndpoint(form.embeddingEndpoint)
    setEmbeddingModel(form.embeddingModel)
    setEmbeddingKey(form.embeddingKey)
    setReuseEmbedding(form.reuseEmbedding)
    setLlmKeyConfigured(form.llmKeyConfigured)
    setEmbeddingKeyConfigured(form.embeddingKeyConfigured)
  }

  function applyProbe(p: MemoryProbeResult, targetScope?: "global" | "space") {
    setProbeResult(p)
    const storedScope = localStorage.getItem("wopal.onboarding.memoryScope")
    const preferredScope = storedScope === "space" || storedScope === "global" ? storedScope : null
    const activeScope = targetScope
      ?? (preferredScope === "space" && hasMemorySpaceTarget(p) ? "space" : "global")
    const drafts = createMemoryScopeDrafts(p)
    const editingState: MemoryScopeEditing = {
      global: !p.globalMemory,
      space: false,
    }
    setScopeDrafts(drafts)
    setScopeEditing(editingState)
    setScopeDirty({ global: false, space: false })
    applyFormState(drafts[activeScope])

    if (activeScope === "space" || p.globalMemory) {
      setResultSummary(buildMemoryResultSummaryFromProbe(p, activeScope))
      setEditing(false)
    } else {
      setResultSummary(null)
      setEditing(true)
    }
  }

  onMount(async () => {
    try {
      const raw = await client.probe("memory")
      const p = normalizeMemoryProbe(raw)
      if (p.error) {
        setProbeError(p.error)
        props.onStatusChange?.("error")
        props.onError(p.error)
        return
      }
      applyProbe(p)
      if (shouldAutoConfirmMemoryProbe(p)) {
        // Auto-confirm reuse: execute backend with current probed config to mark step done
        try {
          const form = getFormState()
          const payload = buildMemoryPayload(form)
          const res = await client.executeStep("memory-config", payload)
          if (res.status === "completed" || res.status === "reused") {
            props.onStatusChange?.("success")
          } else {
            // Backend could not confirm — still let user proceed, state will be reconciled by navigateToStep
            props.onStatusChange?.("success")
          }
        } catch {
          props.onStatusChange?.("success")
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t.probeFailed
      setProbeError(message)
      props.onStatusChange?.("error")
      props.onError(message)
    } finally {
      setProbing(false)
    }
  })

  function getFormState(): MemoryFormState {
    return {
      enabled: enabled(),
      memoryInjectionEnabled: memoryInjectionEnabled(),
      scope: scope(),
      spaceMode: spaceMode(),
      spacePath: probeResult()?.effectiveSpace?.path,
      llmEndpoint: llmEndpoint(),
      llmModel: llmModel(),
      llmKey: llmKey(),
      embeddingEndpoint: embeddingEndpoint(),
      embeddingModel: embeddingModel(),
      embeddingKey: embeddingKey(),
      reuseEmbedding: reuseEmbedding(),
      llmKeyConfigured: llmKeyConfigured(),
      embeddingKeyConfigured: embeddingKeyConfigured(),
    }
  }

  function switchScope(targetScope: MemoryScope) {
    if (targetScope === scope()) return
    const probe = probeResult()
    if (!probe) return
    if (targetScope === "space" && !hasMemorySpaceTarget(probe)) return

    localStorage.setItem("wopal.onboarding.memoryScope", targetScope)

    const currentDrafts = scopeDrafts() ?? createMemoryScopeDrafts(probe)
    const switched = editing()
      ? switchMemoryScopeDraft(currentDrafts, getFormState(), targetScope)
      : { drafts: currentDrafts, targetDraft: { ...currentDrafts[targetScope] } }
    setScopeDrafts(switched.drafts)
    applyFormState(switched.targetDraft)
    setErrors(null)

    const editingState = scopeEditing()
    const dirtyState = scopeDirty()
    if (editingState[targetScope]) {
      setResultSummary(null)
      setEditing(true)
      props.onStatusChange?.("idle")
    } else {
      setResultSummary(buildMemoryResultSummaryFromProbe(probe, targetScope))
      setEditing(false)
      props.onStatusChange?.(dirtyState.global || dirtyState.space ? "idle" : "success")
    }
  }

  function editCurrentScope() {
    const currentScope = scope()
    const draft = scopeDrafts()?.[currentScope]
    if (draft) applyFormState(draft)
    setScopeEditing((current) => ({ ...current, [currentScope]: true }))
    setResultSummary(null)
    setEditing(true)
    setErrors(null)
    props.onStatusChange?.("idle")
  }

  function markCurrentScopeDirty() {
    const currentScope = scope()
    setScopeDirty((current) => ({ ...current, [currentScope]: true }))
  }

  async function handleSave(e: Event) {
    e.preventDefault()
    props.onError(null)

    // Summary mode -> user clicks Next to confirm
    if (!editing() && resultSummary()) {
      const pendingScope = scopeDirty().global
        ? "global"
        : scopeDirty().space
          ? "space"
          : null
      if (pendingScope) {
        switchScope(pendingScope)
        return
      }
      props.onStatusChange?.("success")
      props.onComplete()
      return
    }

    const form = getFormState()
    const targetScope = form.scope
    if (targetScope === "space" && !form.spacePath) {
      props.onStatusChange?.("error")
      props.onError("未检测到可配置的工作空间，请先完成工作空间创建。")
      return
    }
    const validationErrors = validateMemoryForm(form)
    if (validationErrors) {
      setErrors(validationErrors)
      return
    }
    setErrors(null)

    props.onStatusChange?.("working")
    setSubmitting(true)
    const previousDrafts = scopeDrafts() ?? createMemoryScopeDrafts(probeResult()!)
    const previousEditing = scopeEditing()
    const previousDirty = scopeDirty()

    try {
      const payload = buildMemoryPayload(form)
      const res = await client.executeStep("memory-config", payload)

      if (res.status === "completed" || res.status === "reused") {
        const raw = await client.probe("memory")
        const p = normalizeMemoryProbe(raw)

        const refreshed = refreshMemoryScopeDraftsAfterSave(
          p,
          targetScope,
          previousDrafts,
          previousEditing,
          previousDirty,
        )
        setProbeResult(p)
        setScopeDrafts(refreshed.drafts)
        setScopeEditing(refreshed.editing)
        setScopeDirty(refreshed.dirty)
        applyFormState(refreshed.drafts[targetScope])
        setResultSummary(buildMemoryResultSummaryFromProbe(p, targetScope))

        const summary = buildMemoryResultSummary(res.result ?? {})
        if (targetScope === "space" && (summary.spaceMode === "inherit" || summary.outcome === "cleared" || !p.spaceMemory)) {
          summary.isSpaceInherited = true
          summary.spaceMode = "inherit"
          summary.enabled = Boolean(p.globalMemory ? (p.globalMemory as any).enabled : p.enabled)
        }

        if (summary.envPath || summary.llmEndpoint || summary.outcome === "cleared" || summary.enabled === false || summary.isSpaceInherited) {
          setResultSummary(summary)
        }
        setEditing(false)
        props.onStatusChange?.(refreshed.dirty.global || refreshed.dirty.space ? "idle" : "success")
      } else {
        props.onStatusChange?.("error")
        props.onError(res.error?.message ?? "记忆配置保存失败。")
      }
    } catch (err) {
      props.onStatusChange?.("error")
      props.onError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const canConfigureSpace = () => Boolean(probeResult() && hasMemorySpaceTarget(probeResult()!))
  const spaceName = () => probeResult()?.effectiveSpace?.name ?? "未检测到空间"

  const renderSummaryTitle = () => {
    if (!resultSummary()) return ""
    const s = resultSummary()!
    if (scope() === "space") {
      if (s.spaceMode === "inherit" || s.isSpaceInherited || s.outcome === "inherited" || s.outcome === "cleared") {
        return s.enabled
          ? `[${spaceName()}] 已设为继承全局通用记忆系统`
          : `[${spaceName()}] 已设为继承全局配置 (全局记忆当前未开启)`
      }
      if (s.spaceMode === "disabled" || !s.enabled) {
        return `[${spaceName()}] 专属记忆已被显式关闭`
      }
      return `[${spaceName()}] 专属记忆配置已就绪`
    }
    return s.enabled ? "全局通用记忆系统已配置就绪" : "全局通用记忆系统已禁用"
  }

  const renderSummaryLevel = () => {
    if (!resultSummary()) return ""
    const s = resultSummary()!
    if (scope() === "space") {
      if (s.spaceMode === "inherit" || s.isSpaceInherited || s.outcome === "inherited" || s.outcome === "cleared") {
        return s.enabled
          ? "继承全局通用配置 (跟随全局: 已就绪)"
          : "继承全局通用配置 (跟随全局: 当前停用)"
      }
      if (s.spaceMode === "disabled" || !s.enabled) {
        return `空间独立禁用 (WOPAL_MEMORY_ENABLED=false)`
      }
      return `空间独立重写 (${spaceName()})`
    }
    return s.enabled ? "全局继承（全工作空间共享）" : "全局记忆停用"
  }

  return (
    <form id="onboarding-step-memory-config" onSubmit={handleSave} class="ob-step-content">
      <Show when={probing()}>
        <ProgressDisplay phase="正在检查记忆系统配置…" />
      </Show>

      <Show when={!probing() && probeError()}>
        <div class="ob-memory-probe-error">{t.probeFailed}</div>
      </Show>

      <Show when={!probing() && !probeError()}>
        {/* Scope Selector Tabs */}
        <div class="ob-form-group">
          <div class="ob-scope-tabs">
            <button
              type="button"
              class={`ob-scope-tab ${scope() === "global" ? "active" : ""}`}
              disabled={submitting()}
              onClick={() => switchScope("global")}
            >
              🌐 全局通用配置 (推荐){scopeDirty().global ? " · 未保存" : ""}
            </button>
            <button
              type="button"
              class={`ob-scope-tab ${scope() === "space" ? "active" : ""}`}
              disabled={!canConfigureSpace() || submitting()}
              onClick={() => switchScope("space")}
            >
              📁 本空间 [{spaceName()}] 专属策略{scopeDirty().space ? " · 未保存" : ""}
            </button>
          </div>
        </div>

        {/* View Mode: Clean Summary Card */}
        <Show when={!editing() && resultSummary()}>
          <ResultPanel
            title={renderSummaryTitle()}
            icon={resultSummary()!.enabled ? "✓" : "⏸"}
            actions={
              <button
                type="button"
                class="ob-button ob-button-secondary"
                onClick={editCurrentScope}
              >
                修改配置
              </button>
            }
          >
            <div class="ob-result-details">
              <div class="ob-result-row">
                <span class="ob-result-label">配置策略</span>
                <span class="ob-result-value ob-result-accent">
                  {renderSummaryLevel()}
                </span>
              </div>

              <Show when={resultSummary()!.enabled}>
                <div class="ob-result-row">
                  <span class="ob-result-label">自动提示词注入</span>
                  <span class="ob-result-value">
                    {resultSummary()!.memoryInjectionEnabled ? "已开启 (WOPAL_MEMORY_INJECTION_ENABLED=true)" : "已关闭 (WOPAL_MEMORY_INJECTION_ENABLED=false)"}
                  </span>
                </div>
              </Show>

              <Show when={resultSummary()!.llmEndpoint}>
                <div class="ob-result-row">
                  <span class="ob-result-label">LLM 端点</span>
                  <span class="ob-result-value ob-result-mono">{resultSummary()!.llmEndpoint}</span>
                </div>
              </Show>
              <Show when={resultSummary()!.llmModel}>
                <div class="ob-result-row">
                  <span class="ob-result-label">LLM 模型</span>
                  <span class="ob-result-value">{resultSummary()!.llmModel}</span>
                </div>
              </Show>
              <Show when={resultSummary()!.embeddingModel}>
                <div class="ob-result-row">
                  <span class="ob-result-label">Embedding 模型</span>
                  <span class="ob-result-value">{resultSummary()!.embeddingModel}</span>
                </div>
              </Show>
              <Show when={resultSummary()!.envPath}>
                <div class="ob-result-row">
                  <span class="ob-result-label">配置文件</span>
                  <span class="ob-result-value ob-result-mono">{resultSummary()!.envPath}</span>
                </div>
              </Show>
            </div>
          </ResultPanel>
        </Show>

        {/* Edit Mode */}
        <Show when={editing()}>
          {/* Global Scope Switch */}
          <Show when={scope() === "global"}>
            <div class="ob-form-group" style={{ "margin-bottom": "12px" }}>
              <div class="ob-memory-toggle" style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                <input
                  type="checkbox"
                  id="enable-memory"
                  checked={enabled()}
                  onChange={(e) => {
                    setEnabled(e.currentTarget.checked)
                    markCurrentScopeDirty()
                  }}
                  class="ob-memory-toggle-control"
                />
                <label for="enable-memory" class="ob-memory-toggle-label" style={{ "font-size": "13px", "font-weight": "600" }}>
                  启用全局记忆系统
                </label>
              </div>
              <p style={{ "font-size": "12px", color: "var(--ob-text-subtle)", margin: "4px 0 0" }}>
                配置保存至 $WOPAL_HOME/.env，所有工作空间自动共享。
              </p>
            </div>
          </Show>

          {/* Space Scope 3-Option Mode Selector */}
          <Show when={scope() === "space"}>
            <div class="ob-form-group" style={{ "margin-bottom": "14px" }}>
              <label class="ob-label" style={{ "font-size": "12px", "font-weight": "600", "margin-bottom": "6px", display: "block" }}>
                选择本空间 [{spaceName()}] 记忆配置策略
              </label>

              <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                {/* Option 1: Inherit Global */}
                <label
                  style={{
                    display: "flex",
                    "align-items": "flex-start",
                    gap: "10px",
                    padding: "10px 12px",
                    "border-radius": "6px",
                    border: spaceMode() === "inherit" ? "1px solid var(--ob-accent)" : "1px solid rgba(255,255,255,0.1)",
                    background: spaceMode() === "inherit" ? "rgba(255,255,255,0.05)" : "transparent",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="radio"
                    name="space-mode"
                    checked={spaceMode() === "inherit"}
                    onChange={() => {
                      setSpaceMode("inherit")
                      setEnabled(Boolean(probeResult()?.globalMemory?.enabled))
                      markCurrentScopeDirty()
                    }}
                    style={{ "margin-top": "2px" }}
                  />
                  <div>
                    <div style={{ "font-size": "12px", "font-weight": "600" }}>🌐 继承全局通用配置 (推荐)</div>
                    <div style={{ "font-size": "11px", color: "var(--ob-text-subtle)", "margin-top": "2px" }}>
                      清除本空间独立配置，自动共享与跟随全局记忆系统的设置与 API 凭据。
                    </div>
                  </div>
                </label>

                {/* Option 2: Custom Space Config */}
                <label
                  style={{
                    display: "flex",
                    "align-items": "flex-start",
                    gap: "10px",
                    padding: "10px 12px",
                    "border-radius": "6px",
                    border: spaceMode() === "custom" ? "1px solid var(--ob-accent)" : "1px solid rgba(255,255,255,0.1)",
                    background: spaceMode() === "custom" ? "rgba(255,255,255,0.05)" : "transparent",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="radio"
                    name="space-mode"
                    checked={spaceMode() === "custom"}
                    onChange={() => {
                      setSpaceMode("custom")
                      setEnabled(true)
                      markCurrentScopeDirty()
                    }}
                    style={{ "margin-top": "2px" }}
                  />
                  <div>
                    <div style={{ "font-size": "12px", "font-weight": "600" }}>📁 本空间独立自定义配置</div>
                    <div style={{ "font-size": "11px", color: "var(--ob-text-subtle)", "margin-top": "2px" }}>
                      在 {spaceName()}/.wopal/.env 覆盖全局配置，独立设置模型端点与凭据。
                    </div>
                  </div>
                </label>

                {/* Option 3: Disable Space Memory */}
                <label
                  style={{
                    display: "flex",
                    "align-items": "flex-start",
                    gap: "10px",
                    padding: "10px 12px",
                    "border-radius": "6px",
                    border: spaceMode() === "disabled" ? "1px solid var(--ob-accent)" : "1px solid rgba(255,255,255,0.1)",
                    background: spaceMode() === "disabled" ? "rgba(255,255,255,0.05)" : "transparent",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="radio"
                    name="space-mode"
                    checked={spaceMode() === "disabled"}
                    onChange={() => {
                      setSpaceMode("disabled")
                      setEnabled(false)
                      markCurrentScopeDirty()
                    }}
                    style={{ "margin-top": "2px" }}
                  />
                  <div>
                    <div style={{ "font-size": "12px", "font-weight": "600" }}>🚫 强行关闭本空间记忆</div>
                    <div style={{ "font-size": "11px", color: "var(--ob-text-subtle)", "margin-top": "2px" }}>
                      在 {spaceName()}/.wopal/.env 写入 WOPAL_MEMORY_ENABLED=false，即使全局启用了记忆也在此空间关停。
                    </div>
                  </div>
                </label>
              </div>
            </div>
          </Show>

          {/* Form Fields: Show when Global enabled OR Space custom mode */}
          <Show when={(scope() === "global" && enabled()) || (scope() === "space" && spaceMode() === "custom")}>
            {/* Memory Injection Switch */}
            <div class="ob-form-group" style={{ "margin-bottom": "10px", display: "flex", "align-items": "center", gap: "8px" }}>
              <input
                type="checkbox"
                id="enable-memory-injection"
                checked={memoryInjectionEnabled()}
                onChange={(e) => {
                  setMemoryInjectionEnabled(e.currentTarget.checked)
                  markCurrentScopeDirty()
                }}
                class="ob-memory-injection-control"
                disabled={submitting()}
              />
              <label for="enable-memory-injection" style={{ "font-size": "12px", cursor: "pointer", "font-weight": "500" }}>
                自动注入检索记忆到提示词 (WOPAL_MEMORY_INJECTION_ENABLED)
              </label>
            </div>

            {/* LLM Config: 2-Column Grid */}
            <div style={{ display: "grid", "grid-template-columns": "1fr 1fr", gap: "10px", "margin-bottom": "10px" }}>
              <div class="ob-form-group" style={{ margin: 0 }}>
                <label class="ob-label" for="llm-endpoint" style={{ "font-size": "12px" }}>LLM API 端点</label>
                <input
                  type="url"
                  id="llm-endpoint"
                  class="ob-input"
                  placeholder="https://api.openai.com/v1"
                  value={llmEndpoint()}
                  onInput={(e) => {
                    setLlmEndpoint(e.currentTarget.value)
                    markCurrentScopeDirty()
                  }}
                  disabled={submitting()}
                  style={{ padding: "6px 10px", "font-size": "12px" }}
                />
                <Show when={errors()?.llmEndpoint}>
                  <p class="ob-field-error">{errors()!.llmEndpoint}</p>
                </Show>
              </div>

              <div class="ob-form-group" style={{ margin: 0 }}>
                <label class="ob-label" for="llm-model" style={{ "font-size": "12px" }}>LLM 模型</label>
                <input
                  type="text"
                  id="llm-model"
                  class="ob-input"
                  placeholder="gpt-4o-mini"
                  value={llmModel()}
                  onInput={(e) => {
                    setLlmModel(e.currentTarget.value)
                    markCurrentScopeDirty()
                  }}
                  disabled={submitting()}
                  style={{ padding: "6px 10px", "font-size": "12px" }}
                />
                <Show when={errors()?.llmModel}>
                  <p class="ob-field-error">{errors()!.llmModel}</p>
                </Show>
              </div>
            </div>

            {/* LLM Key Input */}
            <div class="ob-form-group" style={{ "margin-bottom": "10px" }}>
              <label class="ob-label" for="llm-key" style={{ "font-size": "12px" }}>LLM API Key</label>
              <input
                type="password"
                id="llm-key"
                class="ob-input"
                placeholder={llmKeyConfigured() ? t.llmKeySaved : t.llmKeyPlaceholder}
                value={llmKey()}
                onInput={(e) => {
                  setLlmKey(e.currentTarget.value)
                  markCurrentScopeDirty()
                }}
                autocomplete="off"
                disabled={submitting()}
                style={{ padding: "6px 10px", "font-size": "12px" }}
              />
              <Show when={errors()?.llmKey}>
                <p class="ob-field-error">{errors()!.llmKey}</p>
              </Show>
            </div>

            {/* Embedding Reuse Toggle */}
            <div class="ob-form-group" style={{ "margin-bottom": "8px", display: "flex", "align-items": "center", gap: "8px" }}>
              <input
                type="checkbox"
                id="reuse-embedding"
                checked={reuseEmbedding()}
                onChange={(e) => {
                  setReuseEmbedding(e.currentTarget.checked)
                  markCurrentScopeDirty()
                }}
                class="ob-memory-reuse-control"
                disabled={submitting()}
              />
              <label for="reuse-embedding" class="ob-memory-reuse-label" style={{ "font-size": "12px" }}>
                Embedding 复用 LLM API 端点与 Key
              </label>
            </div>

            {/* Embedding Config: 2-Column Grid */}
            <div style={{ display: "grid", "grid-template-columns": reuseEmbedding() ? "1fr" : "1fr 1fr", gap: "10px" }}>
              <Show when={!reuseEmbedding()}>
                <div class="ob-form-group" style={{ margin: 0 }}>
                  <label class="ob-label" for="emb-endpoint" style={{ "font-size": "12px" }}>Embedding 端点</label>
                  <input
                    type="url"
                    id="emb-endpoint"
                    class="ob-input"
                    placeholder="https://api.openai.com/v1"
                    value={embeddingEndpoint()}
                    onInput={(e) => {
                      setEmbeddingEndpoint(e.currentTarget.value)
                      markCurrentScopeDirty()
                    }}
                    disabled={submitting()}
                    style={{ padding: "6px 10px", "font-size": "12px" }}
                  />
                  <Show when={errors()?.embeddingEndpoint}>
                    <p class="ob-field-error">{errors()!.embeddingEndpoint}</p>
                  </Show>
                </div>
              </Show>

              <div class="ob-form-group" style={{ margin: 0 }}>
                <label class="ob-label" for="emb-model" style={{ "font-size": "12px" }}>Embedding 模型</label>
                <input
                  type="text"
                  id="emb-model"
                  class="ob-input"
                  placeholder="text-embedding-3-small"
                  value={embeddingModel()}
                  onInput={(e) => {
                    setEmbeddingModel(e.currentTarget.value)
                    markCurrentScopeDirty()
                  }}
                  disabled={submitting()}
                  style={{ padding: "6px 10px", "font-size": "12px" }}
                />
                <Show when={errors()?.embeddingModel}>
                  <p class="ob-field-error">{errors()!.embeddingModel}</p>
                </Show>
              </div>
            </div>

            {/* Embedding API Key Input (when not reusing LLM Key) */}
            <Show when={!reuseEmbedding()}>
              <div class="ob-form-group" style={{ "margin-top": "10px", "margin-bottom": 0 }}>
                <label class="ob-label" for="emb-key" style={{ "font-size": "12px" }}>
                  {t.embeddingKeyLabel}
                </label>
                <input
                  type="password"
                  id="emb-key"
                  class="ob-input"
                  placeholder={embeddingKeyConfigured() ? t.embeddingKeySaved : t.embeddingKeyPlaceholder}
                  value={embeddingKey()}
                  onInput={(e) => {
                    setEmbeddingKey(e.currentTarget.value)
                    markCurrentScopeDirty()
                  }}
                  autocomplete="off"
                  disabled={submitting()}
                  style={{ padding: "6px 10px", "font-size": "12px" }}
                />
                <Show when={errors()?.embeddingKey}>
                  <p class="ob-field-error">{errors()!.embeddingKey}</p>
                </Show>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
    </form>
  )
}
