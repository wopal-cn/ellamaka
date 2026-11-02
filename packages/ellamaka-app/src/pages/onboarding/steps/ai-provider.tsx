import { createSignal, For, Show } from "solid-js"
import { usePlatform } from "@/context/platform"
import { ResultPanel } from "../components/ResultPanel"
import type { SetupInspect } from "../setup-client"
import { AI_SUBSCRIPTION_PLANS } from "./ai-subscription-plans"

export interface ProviderStepProps {
  facts: SetupInspect
  working: boolean
  onSubmit: (input: { providerId: string; apiKey: string }) => void
  onSkip: () => void
}

export function AiProviderStep(props: ProviderStepProps) {
  const platform = usePlatform()
  const plan = AI_SUBSCRIPTION_PLANS[0]
  const [apiKey, setApiKey] = createSignal("")
  const [error, setError] = createSignal<string | null>(null)

  const configured = () => props.facts.credentials.providers.length > 0

  const submit = (event: Event) => {
    event.preventDefault()
    if (props.working || configured()) return
    const key = apiKey().trim()
    if (!key) {
      setError("请填写 API Key，或跳过此可选步骤。")
      return
    }
    setError(null)
    props.onSubmit({ providerId: plan.providerId, apiKey: key })
    setApiKey("")
  }

  return (
    <form id="onboarding-step-ai-provider" onSubmit={submit} class="ob-step-content">
      <Show when={configured()}>
        <ResultPanel title="已检测到 AI Provider 配置">
          <div class="ob-result-details">
            <For each={props.facts.credentials.providers}>
              {(provider) => <div class="ob-result-row">{provider}</div>}
            </For>
          </div>
        </ResultPanel>
      </Show>

      <Show when={!configured()}>
        <div class="ob-plan-card">
          <div class="ob-plan-header">
            <div>
              <div class="ob-plan-name">{plan.name}</div>
              <div class="ob-plan-description">{plan.description}</div>
            </div>
            <span class="ob-plan-badge">可选</span>
          </div>
          <button type="button" class="ob-button ob-button-secondary" onClick={() => platform.openLink(plan.signupUrl)}>
            前往注册并获取 API Key
          </button>
        </div>

        <div class="ob-form-group">
          <label class="ob-label" for="opencode-key-input">
            OpenCode Go API Key
          </label>
          <input
            type="password"
            id="opencode-key-input"
            class="ob-input"
            placeholder="粘贴 OpenCode Go API Key"
            value={apiKey()}
            onInput={(event) => {
              setApiKey(event.currentTarget.value)
              setError(null)
            }}
            autocomplete="off"
            disabled={props.working}
          />
          <span class="ob-field-help">API Key 只进入本次 Setup execute 请求。</span>
          <Show when={error()}>
            <p class="ob-field-error">{error()}</p>
          </Show>
        </div>

        <button type="button" class="ob-button ob-button-secondary" onClick={props.onSkip} disabled={props.working}>
          跳过 Provider 配置
        </button>
      </Show>
    </form>
  )
}
