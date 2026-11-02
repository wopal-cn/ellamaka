import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { usePlatform } from "@/context/platform"

interface DoneStepProps {
  onRegisterLaunch?: (launch: (() => void) | null) => void
  launch: () => Promise<void>
  launching: boolean
  error?: string | null
}

export function DoneStep(props: DoneStepProps) {
  const platform = usePlatform()
  const [starred] = createSignal(false)

  const launch = () => {
    if (props.launching) return
    void props.launch()
  }

  onMount(() => props.onRegisterLaunch?.(launch))
  onCleanup(() => props.onRegisterLaunch?.(null))

  return (
    <div class="ob-done-content">
      <div class="ob-done-hero">
        <div class="ob-done-emoji">🎉</div>
        <h3 class="ob-done-title">设置完成！</h3>
        <p class="ob-done-subtitle">WopalSpace 工作目录、能力本体和空间已经准备完成。</p>
      </div>

      <div class="ob-done-card ob-done-card-warm">
        <div class="ob-done-heart">
          <span>💖</span> 感谢你使用 WopalSpace
        </div>
        <div class="ob-done-body">
          点击下方按钮后，Server 会重新检查初始化事实并保存完成状态；通过后进入 Workbench。
        </div>
      </div>

      <div class="ob-done-card ob-done-support-card">
        <div>
          <div class="ob-done-support-title">⭐ 支持 WopalSpace 开源项目</div>
          <div class="ob-done-support-desc">在浏览器中打开项目主页，了解文档与社区。</div>
        </div>
        <button
          type="button"
          class="ob-button ob-button-secondary ob-done-star-button"
          onClick={() => platform.openLink("https://github.com/wopal-cn")}
          disabled={starred()}
        >
          打开项目主页
        </button>
      </div>

      <Show when={props.error}>
        <div class="ob-done-gate-error" role="alert">
          <div class="ob-done-gate-error-title">⛔ 完成检查未通过</div>
          <div class="ob-done-gate-error-message">{props.error}</div>
          <div class="ob-done-gate-error-hint">向导会保留真实服务状态，修复后可以再次尝试。</div>
        </div>
      </Show>
    </div>
  )
}
