import { Show } from "solid-js"

export interface ProgressDisplayProps {
  /** Determinate progress 0-100, or undefined for indeterminate */
  percent?: number
  /** Current phase description */
  phase?: string
  /** Elapsed time in seconds */
  elapsed?: number
  /** Whether to show loading spinner for indeterminate mode (default: true) */
  showSpinner?: boolean
}

export function ProgressDisplay(props: ProgressDisplayProps) {
  const formatTime = (s: number) => {
    if (s < 60) return `${Math.round(s)}s`
    const m = Math.floor(s / 60)
    const sec = Math.round(s % 60)
    return `${m}m ${sec}s`
  }

  return (
    <div class="ob-progress-container">
      <Show when={props.percent !== undefined}>
        <div class="ob-progress-bar-track">
          <div
            class="ob-progress-bar-fill"
            style={{ width: `${Math.min(100, Math.max(0, props.percent ?? 0))}%` }}
          />
        </div>
        <div class="ob-progress-text">
          {Math.round(props.percent ?? 0)}%
        </div>
      </Show>

      <Show when={props.percent === undefined && (props.showSpinner ?? true)}>
        <div class="ob-progress-indeterminate">
          <div class="ob-spinner" style={{ width: "20px", height: "20px", "border-width": "2px" }} />
        </div>
      </Show>

      <Show when={props.phase}>
        <div class="ob-progress-phase">{props.phase}</div>
      </Show>

      <Show when={props.elapsed !== undefined && props.elapsed > 3}>
        <div class="ob-progress-elapsed">{formatTime(props.elapsed!)}</div>
      </Show>
    </div>
  )
}
