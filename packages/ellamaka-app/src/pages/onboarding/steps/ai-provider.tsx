import { createSignal, onMount, Show } from "solid-js"
import { usePlatform } from "@/context/platform"
import { ProgressDisplay } from "../components/ProgressDisplay"
import { ResultPanel } from "../components/ResultPanel"
import { useOnboardingClient } from "../onboarding-client-context"
import { AI_SUBSCRIPTION_PLANS } from "./ai-subscription-plans"

export interface StepProps {
  onStatusChange?: (status: "working" | "success" | "error") => void
  onComplete: () => void;
  onError: (err: string | null) => void;
}

export function AiProviderStep(props: StepProps) {
  const client = useOnboardingClient()
  const platform = usePlatform()
  const plan = AI_SUBSCRIPTION_PLANS[0]
  const [apiKey, setApiKey] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [probing, setProbing] = createSignal(true)
  const [configured, setConfigured] = createSignal(false)
  const [detectedKey, setDetectedKey] = createSignal<string | null>(null)

  onMount(async () => {
    try {
      const res = await client.probe("ai-provider")
      if (res.hasKey) {
        const masked = typeof res.maskedKey === "string" ? res.maskedKey : "oc_****"
        setDetectedKey(masked)
        setConfigured(true)
        // Auto-confirm reuse: execute backend to mark step done, then user can proceed directly
        try {
          const execRes = await client.executeStep("ai-provider", {
            provider: plan.providerId,
          })
          if (execRes.status === "completed" || execRes.status === "reused") {
            props.onStatusChange?.("success")
          } else {
            // Backend could not confirm — still show configured but let user manually proceed
            props.onStatusChange?.("success")
          }
        } catch {
          props.onStatusChange?.("success")
        }
      }
    } catch {
    } finally {
      setProbing(false)
    }
  })

  const handleOpenSignup = () => {
    platform.openLink(plan.signupUrl)
  }

  const handleSubmit = async (e: Event) => {
    e.preventDefault()
    if (configured() && !apiKey().trim()) {
      props.onStatusChange?.("success")
      props.onComplete()
      return
    }

    const keyToSubmit = apiKey().trim()
    if (!keyToSubmit && !detectedKey()) {
      props.onStatusChange?.("error")
      props.onError("请填写 OpenCode Go API Key，或选择跳过本步骤。")
      return
    }
    props.onError(null)
    props.onStatusChange?.("working")
    setLoading(true)

    try {
      const res = await client.executeStep("ai-provider", {
        provider: plan.providerId,
        apiKey: keyToSubmit,
      })

      if (res.status === "completed" || res.status === "reused") {
        setConfigured(true)
        if (keyToSubmit) {
          setDetectedKey(`${keyToSubmit.slice(0, 3)}...${keyToSubmit.slice(-4)}`)
        }
        props.onStatusChange?.("success")
      } else {
        props.onStatusChange?.("error")
        props.onError(res.error?.message || "OpenCode Go API Key 配置失败。")
      }
    } catch (err) {
      props.onStatusChange?.("error")
      props.onError(String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <form id="onboarding-step-ai-provider" onSubmit={handleSubmit} class="ob-step-content">
      <Show when={probing()}>
        <ProgressDisplay phase="正在检查 OpenCode Go 配置…" />
      </Show>

      <Show when={!probing() && configured()}>
        <ResultPanel
          title="OpenCode Go 已配置"
          actions={
            <button
              type="button"
              class="ob-button ob-button-secondary"
              onClick={() => {
                setConfigured(false)
              }}
            >
              更换 API Key
            </button>
          }
        >
          <div class="ob-result-details">
            <div class="ob-result-row">
              <span class="ob-result-label">套餐</span>
              <span class="ob-result-value">{plan.name}</span>
            </div>
            <div class="ob-result-row">
              <span class="ob-result-label">API Key 状态</span>
              <span class="ob-result-value ob-result-accent">
                {detectedKey() ? `已识别可用的 API Key (${detectedKey()})` : "API Key 已配置完成"}
              </span>
            </div>
          </div>
        </ResultPanel>
      </Show>

      <Show when={!probing() && !configured()}>
        <div class="ob-plan-card">
          <div class="ob-plan-header">
            <div>
              <div class="ob-plan-name">{plan.name}</div>
              <div class="ob-plan-description">{plan.description}</div>
            </div>
            <span class="ob-plan-badge">当前优惠</span>
          </div>

          <div class="ob-plan-pricing">
            <strong>首月 ${plan.introductoryPriceUsd}</strong>
            <span>后续 ${plan.monthlyPriceUsd}/月</span>
            <span>可随时取消订阅</span>
          </div>

          <ol class="ob-plan-steps">
            <li><span>1</span>注册并订阅 OpenCode Go</li>
            <li><span>2</span>在控制台创建 API Key</li>
            <li><span>3</span>复制并填入下方输入框</li>
          </ol>

          <button type="button" class="ob-button ob-button-secondary" onClick={handleOpenSignup}>
            前往注册并订阅
          </button>
        </div>

        <Show when={detectedKey()}>
          <div class="ob-detected-key">
            <span>✓ 已检测到现有 API Key</span>
            <code>{detectedKey()}</code>
          </div>
        </Show>

        <div class="ob-form-group">
          <label class="ob-label" for="opencode-key-input">OpenCode Go API Key</label>
          <input
            type="password"
            id="opencode-key-input"
            class="ob-input"
            placeholder={detectedKey() ? `使用现有 Key（${detectedKey()}）` : "粘贴 OpenCode Go API Key"}
            value={apiKey()}
            onInput={(e) => setApiKey(e.currentTarget.value)}
            autocomplete="off"
            disabled={loading()}
          />
          <span class="ob-field-help">API Key 仅用于配置本机 Ellamaka。</span>
        </div>

      </Show>
    </form>
  )
}
