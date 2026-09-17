import { Show, type JSX, type ParentProps } from "solid-js"

export interface ResultPanelProps {
  title: string
  variant?: "success" | "working" | "error"
  icon?: JSX.Element
  message?: JSX.Element
  actions?: JSX.Element
}

export function ResultPanel(props: ParentProps<ResultPanelProps>) {
  const variant = () => props.variant ?? "success"

  return (
    <section class={`ob-result-panel ob-result-panel-${variant()}`}>
      <div class="ob-result-panel-status">
        <Show
          when={variant() === "working"}
          fallback={<div class="ob-result-panel-icon">{props.icon ?? (variant() === "error" ? "✗" : "✓")}</div>}
        >
          <span class="ob-spinner ob-result-panel-spinner" />
        </Show>
        <h3 class="ob-result-panel-title">{props.title}</h3>
        <Show when={props.message}>
          <p class="ob-result-panel-message">{props.message}</p>
        </Show>
      </div>
      <div class="ob-result-panel-body">
        {props.children}
        <Show when={props.actions}>
          <div class="ob-result-panel-actions">{props.actions}</div>
        </Show>
      </div>
    </section>
  )
}
