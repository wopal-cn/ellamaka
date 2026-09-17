import { createSignal, onMount, Show, For } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useOnboardingClient } from "../onboarding-client-context"

interface DoneStepProps {
  onLaunchingChange?: (launching: boolean) => void
  onErrorChange?: (err: string | null) => void
}

export function DoneStep(props: DoneStepProps = {}) {
  const client = useOnboardingClient()
  const navigate = useNavigate()
  const [isLaunching, setIsLaunching] = createSignal<boolean>(false)
  const [warnings, setWarnings] = createSignal<string[]>([])
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null)
  const [starred, setStarred] = createSignal<boolean>(false)

  const setLaunching = (val: boolean) => {
    setIsLaunching(val)
    props.onLaunchingChange?.(val)
  }

  const setError = (msg: string | null) => {
    setErrorMsg(msg)
    props.onErrorChange?.(msg)
  }

  onMount(async () => {
    try {
      // 1. Deep inspection check on runtime readiness. The server state view
      // carries no warnings list; runtime diagnostics surface below.
      const runtimeRes = await client.probe("runtime")
      if (runtimeRes.ready === false && runtimeRes.error) {
        setWarnings((prev) => [...prev, String(runtimeRes.error)])
      }
    } catch {
      // ignore non-fatal probe error
    }
  })

  const handleManualStar = async () => {
    try {
      const res = await client.executeStep("done", { action: "star" })
      if (res.status === "completed" || res.status === "reused") {
        setStarred(true)
      }
    } catch {
      // ignore
    }
  }

  const handleLaunch = async () => {
    setLaunching(true)
    setError(null)
    try {
      // 2. Final Gatekeeper: mark onboarding complete, then hand the user to
      // the workbench over the SPA router (no reload, no window swap).
      await client.complete()
      navigate("/workbench")
    } catch (err) {
      setError(err instanceof Error ? err.message : "启动工作台失败，请手动重启应用。")
      setLaunching(false)
    }
  }

  return (
    <div class="ob-done-content">
      {/* Warm Main Greeting */}
      <div class="ob-done-hero">
        <div class="ob-done-emoji">🎉</div>
        <h3 class="ob-done-title">设置完成！</h3>
        <p class="ob-done-subtitle">
          WopalSpace 智能助手环境已全面准备就绪。点击下方按钮即可开启属于你的超级个体创作之旅。
        </p>
      </div>

      {/* Warm Thank You Card — Replaces cold technical details table */}
      <div class="ob-done-card ob-done-card-warm">
        <div class="ob-done-heart">
          <span>💖</span> 感谢你使用 WopalSpace
        </div>
        <div class="ob-done-body">
          每一位创作者与超级个体都是时代独特的闪耀星光。全套 AI 智能助手与能力工具链已把关完毕，愿 WopalSpace
          伴你构建卓越产品，享受纯粹的创作与构建乐趣。
        </div>
      </div>

      {/* Community Support Card — NO Auto Star */}
      <div class="ob-done-card ob-done-support-card">
        <div>
          <div class="ob-done-support-title">⭐ 支持 WopalSpace 开源项目</div>
          <div class="ob-done-support-desc">点亮 GitHub Star，支持团队持续交付下一代 AI 智能助手与工具链。</div>
        </div>
        <button
          type="button"
          class="ob-button ob-button-secondary ob-done-star-button"
          onClick={handleManualStar}
          disabled={starred()}
        >
          {starred() ? "已支持 ⭐" : "⭐ 点亮 Star"}
        </button>
      </div>

      {/* Warnings & Diagnostics Slot */}
      <Show when={warnings().length > 0}>
        <div class="ob-done-warning">
          <div class="ob-done-warning-title">⚠️ 检查提醒</div>
          <ul class="ob-done-warning-list">
            <For each={warnings()}>{(w) => <li>{w}</li>}</For>
          </ul>
        </div>
      </Show>

      {/* Error Message Slot */}
      <Show when={errorMsg()}>
        <div class="ob-done-error">❌ {errorMsg()}</div>
      </Show>

      {/* Launch Workbench Button */}
      <div class="ob-done-launch">
        <button class="ob-button ob-done-launch-button" onClick={handleLaunch} disabled={isLaunching()}>
          <Show when={isLaunching()} fallback={<span>🚀 启动工作台</span>}>
            <span class="ob-spinner" style={{ width: "18px", height: "18px", "border-width": "2px" }} />
            <span>正在启动…</span>
          </Show>
        </button>
      </div>
    </div>
  )
}
