import { Show } from "solid-js"
import { zhCN } from "../content/zh-CN"

export interface ActionBarProps {
  /** Current step name. */
  step: string
  /** Whether the step is optional (shows skip). */
  optional?: boolean
  /** Whether an operation is currently running. */
  working?: boolean
  /** Whether the current step has a result (success or error). */
  hasResult?: boolean
  /** Whether the result was successful. */
  success?: boolean
  /** Callbacks */
  onBack?: () => void
  onNext?: () => void
  onSkip?: () => void
  onRetry?: () => void
  onCancel?: () => void
  /** Custom primary action label */
  primaryLabel?: string
  /** Hide back button */
  hideBack?: boolean
}

export function ActionBar(props: ActionBarProps) {
  const primaryLabel = () => {
    if (props.primaryLabel) return props.primaryLabel
    if (props.working) return zhCN.status.working
    if (props.hasResult && props.success) return zhCN.actions.continue
    if (props.hasResult && !props.success) return zhCN.actions.retry
    return zhCN.actions.start
  }

  const handlePrimary = () => {
    if (props.hasResult && !props.success) {
      props.onRetry?.()
    } else if (props.hasResult && props.success) {
      props.onNext?.()
    } else {
      props.onNext?.()
    }
  }

  return (
    <div class="ob-action-bar">
      <div class="ob-action-bar-left">
        <Show when={!props.hideBack && props.step !== "system-check"}>
          <button
            class="ob-button ob-button-secondary"
            onClick={() => props.onBack?.()}
            disabled={props.working}
          >
            ← {zhCN.actions.back}
          </button>
        </Show>
      </div>

      <div class="ob-action-bar-right">
        <Show when={props.optional && !props.working && !props.hasResult}>
          <button
            class="ob-button ob-button-secondary"
            onClick={() => props.onSkip?.()}
          >
            {zhCN.actions.skip}
          </button>
        </Show>

        <Show when={props.working && props.onCancel}>
          <button
            class="ob-button ob-button-secondary"
            onClick={() => props.onCancel?.()}
          >
            {zhCN.actions.cancel}
          </button>
        </Show>

        <button
          class="ob-button"
          onClick={handlePrimary}
          disabled={props.working}
        >
          <Show when={props.working}>
            <span class="ob-spinner" style={{ width: "16px", height: "16px", "border-width": "2px" }} />
          </Show>
          {primaryLabel()}
        </button>
      </div>
    </div>
  )
}
