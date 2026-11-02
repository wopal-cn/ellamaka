import { createSignal, For, Show } from "solid-js"
import { ResultPanel } from "../components/ResultPanel"
import type { SetupInspect } from "../setup-client"
import { defaultOntologyMode, ontologyModes, ONTOLOGY_SOURCES } from "./ontology-options"

export interface OntologySetupInput {
  mode: "fork" | "clone"
  source?: string
}

export interface OntologyStepProps {
  facts: SetupInspect
  working: boolean
  onRun: (input: OntologySetupInput) => void
}

type SourceType = "official" | "custom"

export function OntologySetupStep(props: OntologyStepProps) {
  const existing = () => props.facts.ontology.items[0]
  const [mode, setMode] = createSignal<"fork" | "clone">(
    existing()?.mode ?? defaultOntologyMode(props.facts.credentials.github.configured),
  )
  const [sourceType, setSourceType] = createSignal<SourceType>("official")
  const [customUrl, setCustomUrl] = createSignal("")
  const [sourceError, setSourceError] = createSignal<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = createSignal(false)

  const repositoryReady = () => props.facts.ontology.status === "ready" && props.facts.ontology.items.length > 0
  const ready = () =>
    repositoryReady() &&
    props.facts.home.settings.valid &&
    props.facts.home.settings.ellamaka.valid &&
    props.facts.home.capabilities.ready
  const modes = () => ontologyModes(props.facts.credentials.github.configured)

  const submit = (event: Event) => {
    event.preventDefault()
    if (props.working || ready() || props.facts.ontology.status === "broken") return
    setSourceError(null)
    const current = existing()
    const source = !current && sourceType() === "custom" ? customUrl().trim() : undefined
    if (!current && sourceType() === "custom" && !source) {
      setSourceError("请输入 Git 仓库地址。")
      return
    }
    props.onRun({ mode: current?.mode ?? mode(), ...(source ? { source } : {}) })
  }

  return (
    <form id="onboarding-step-ontology-setup" onSubmit={submit} class="ob-step-content">
      <Show when={ready()}>
        <ResultPanel title="能力本体已经就绪">
          <div class="ob-result-details">
            <For each={props.facts.ontology.items}>
              {(item) => (
                <div class="ob-result-row">
                  <span class="ob-result-label">{item.name}</span>
                  <span class="ob-result-value ob-result-location">{item.path}</span>
                </div>
              )}
            </For>
          </div>
        </ResultPanel>
      </Show>

      <Show when={repositoryReady() && !ready()}>
        <ResultPanel title="能力本体仓库已经就绪">
          <div class="ob-result-subtitle">
            当前仓库保持 {existing()?.mode === "fork" ? "Fork" : "Clone"} 模式。下一步只补齐 Home
            基础配置和能力目录，不改变仓库同步方式。
          </div>
        </ResultPanel>
      </Show>

      <Show when={props.facts.ontology.status === "broken"}>
        <ResultPanel title="现有能力本体不可用" variant="error">
          <div class="ob-result-subtitle">
            {props.facts.ontology.diagnostic ?? "目录存在，但不是可复用的能力本体仓库。"}
          </div>
          <div class="ob-result-subtitle">请先修复该目录，向导不会覆盖或删除现有内容。</div>
        </ResultPanel>
      </Show>

      <Show when={!repositoryReady() && props.facts.ontology.status !== "broken"}>
        <div class="ob-ontology-section">
          <div class="ob-ontology-section-title">能力来源</div>
          <button
            type="button"
            class={`ob-source-option ${sourceType() === "official" ? "active" : ""}`}
            disabled={props.working}
            onClick={() => setSourceType("official")}
          >
            <span>
              <strong>{ONTOLOGY_SOURCES[0].name}</strong>
              <small>{ONTOLOGY_SOURCES[0].description}</small>
            </span>
            <span class="ob-plan-badge">默认</span>
          </button>
          <button
            type="button"
            class="ob-advanced-toggle"
            aria-expanded={advancedOpen()}
            disabled={props.working}
            onClick={() => {
              const next = !advancedOpen()
              setAdvancedOpen(next)
              if (!next) setSourceType("official")
            }}
          >
            <span>使用其他 Git 仓库</span>
            <span>{advancedOpen() ? "收起" : "高级"}</span>
          </button>
          <Show when={advancedOpen()}>
            <div class="ob-custom-source">
              <label class="ob-label" for="ontology-source-url">
                Git 仓库地址
              </label>
              <input
                id="ontology-source-url"
                type="url"
                class="ob-input"
                placeholder="https://github.com/example/ontology.git"
                value={customUrl()}
                disabled={props.working}
                onFocus={() => setSourceType("custom")}
                onInput={(event) => {
                  setSourceType("custom")
                  setCustomUrl(event.currentTarget.value)
                  setSourceError(null)
                }}
              />
              <Show when={sourceError()}>
                <p class="ob-field-error">{sourceError()}</p>
              </Show>
            </div>
          </Show>
        </div>

        <div class="ob-ontology-section">
          <div class="ob-ontology-section-title">同步方式</div>
          <div class="ob-mode-options">
            <For each={modes()}>
              {(option) => (
                <button
                  type="button"
                  class={`ob-mode-option ${mode() === option.id ? "active" : ""}`}
                  disabled={props.working}
                  onClick={() => setMode(option.id)}
                >
                  <span class="ob-mode-option-title">
                    <strong>{option.name}</strong>
                    <Show when={option.recommended}>
                      <span>推荐</span>
                    </Show>
                  </span>
                  <small>{option.summary}</small>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </form>
  )
}
