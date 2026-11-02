import { createSignal, Show } from "solid-js"
import { usePlatform } from "@/context/platform"
import type { SetupInspect } from "../setup-client"

export interface FoundationStepProps {
  facts: SetupInspect
  working: boolean
  onRun: (homePath?: string) => void
}

export function FoundationStep(props: FoundationStepProps) {
  const platform = usePlatform()
  const [homePath, setHomePath] = createSignal(props.facts.home.binding.path || props.facts.home.path)
  const [formError, setFormError] = createSignal<string | null>(null)
  const selectable = () => props.facts.home.binding.selectable
  const ready = () => props.facts.home.binding.locked && props.facts.home.foundation.ready && props.facts.home.writable

  const submit = (event: Event) => {
    event.preventDefault()
    if (props.working) return
    if (!selectable()) return props.onRun()
    const path = homePath().trim()
    if (!path) {
      setFormError("请选择或输入 Wopal Home 目录。")
      return
    }
    setFormError(null)
    props.onRun(path)
  }

  const browse = async () => {
    if (!platform.openDirectoryPickerDialog) return
    try {
      const result = await platform.openDirectoryPickerDialog({ title: "选择 Wopal Home 目录" })
      const selected = typeof result === "string" ? result : Array.isArray(result) ? result[0] : undefined
      if (selected) {
        setHomePath(selected)
        setFormError(null)
      }
    } catch {
      // Dialog cancellation is not an error.
    }
  }

  return (
    <form id="onboarding-step-system-check" class="ob-syscheck-content" onSubmit={submit}>
      <div class="ob-syscheck-hero">
        <div class="ob-syscheck-emoji">👋</div>
        <h3 class="ob-syscheck-title">欢迎来到 WopalSpace</h3>
      </div>

      <div class="ob-syscheck-card">
        <Show
          when={selectable()}
          fallback={
            <>
              <div class="ob-result-row">
                <span class="ob-result-label">工作主目录</span>
                <span class="ob-result-value ob-result-mono">{props.facts.home.binding.path}</span>
              </div>
              <div class="ob-result-subtitle">当前 Host 已锁定该 WOPAL_HOME；如需更改，请修改用户环境后重启。</div>
            </>
          }
        >
          <div class="ob-form-group">
            <label class="ob-label" for="wopal-home-input">
              Wopal Home
            </label>
            <input
              id="wopal-home-input"
              class="ob-input"
              value={homePath()}
              disabled={props.working}
              placeholder="例如 ~/.wopal"
              onInput={(event) => {
                setHomePath(event.currentTarget.value)
                setFormError(null)
              }}
            />
            <Show when={platform.openDirectoryPickerDialog !== undefined}>
              <button type="button" class="ob-button ob-button-secondary" onClick={browse} disabled={props.working}>
                选择目录…
              </button>
            </Show>
            <div class="ob-result-subtitle">
              {props.facts.home.binding.mode === "development"
                ? "开发测试模式：本次选择只对当前进程树生效，不会修改你的 Shell 环境。"
                : "首次确认后会写入当前用户的 WOPAL_HOME；后续启动将直接使用该目录。"}
            </div>
            <Show when={formError()}>{(message) => <p class="ob-field-error">{message()}</p>}</Show>
          </div>
        </Show>
        <Show when={props.facts.home.binding.locked}>
          <div class="ob-result-row">
            <span class="ob-result-label">目录权限</span>
            <span class="ob-result-value">{props.facts.home.writable ? "可写" : "不可写"}</span>
          </div>
        </Show>
      </div>

      <Show when={props.facts.home.binding.locked && !ready() && props.facts.home.foundation.missing.length > 0}>
        <div class="ob-syscheck-card">
          <div class="ob-result-label">工作主目录尚未准备</div>
          <div class="ob-result-subtitle">
            本步骤只创建 WOPAL_HOME 根目录，不预建配置、能力目录或 Runtime 私有目录。
          </div>
        </div>
      </Show>

      <Show when={ready()}>
        <div class="ob-syscheck-card">
          <div class="ob-result-title">工作目录已经就绪</div>
          <div class="ob-result-subtitle">继续检查能力本体与工作空间。</div>
        </div>
      </Show>
    </form>
  )
}
