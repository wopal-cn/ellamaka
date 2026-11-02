import { createEffect, createSignal, For, Show } from "solid-js"

export interface LogDrawerEntry {
  text: string
  isError?: boolean
}

export interface LogDrawerProps {
  logs: LogDrawerEntry[]
  /** Current phase text, shown in the header while a step runs. */
  statusMsg?: string
  onClear?: () => void
}

const STORAGE_KEY = "wopal_onboarding_log_drawer_expanded"

/**
 * Collapsible run log for the setup wizard.
 *
 * A failed setup is exactly when the structured error banner above is least
 * useful — it carries one wrapped message, not the sequence of actions that
 * led there. The log is therefore always reachable from the wizard, and the
 * drawer remembers whether the user left it open.
 */
function initialExpanded(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "false"
  } catch {
    return true
  }
}

export function LogDrawer(props: LogDrawerProps) {
  const [expanded, setExpanded] = createSignal(initialExpanded())
  let bodyRef: HTMLDivElement | undefined
  const errorCount = () => props.logs.filter((entry) => entry.isError).length

  // Follow the tail while a step is streaming, but only when the drawer is
  // open — a collapsed body has no scroll height to pin.
  createEffect(() => {
    props.logs.length
    if (!expanded()) return
    queueMicrotask(() => {
      if (bodyRef) bodyRef.scrollTop = bodyRef.scrollHeight
    })
  })

  const toggle = () => {
    const next = !expanded()
    setExpanded(next)
    try {
      localStorage.setItem(STORAGE_KEY, String(next))
    } catch {
      // A denied localStorage must not break the drawer.
    }
  }

  const clear = (event: MouseEvent) => {
    event.stopPropagation()
    props.onClear?.()
  }

  return (
    <div class="ob-log-drawer">
      <div class="ob-log-header" onClick={toggle}>
        <div class="ob-log-header-left">
          <span class="ob-log-icon">{expanded() ? "▾" : "▸"}</span>
          <span class="ob-log-title">日志</span>
          <Show when={errorCount() > 0}>
            <span class="ob-log-error-badge">{errorCount()} 错误</span>
          </Show>
        </div>
        <div class="ob-log-header-status">{props.statusMsg ?? ""}</div>
        <div class="ob-log-header-actions" onClick={(event) => event.stopPropagation()}>
          <Show when={expanded()}>
            <button type="button" class="ob-log-action-btn" onClick={clear}>
              清空
            </button>
          </Show>
        </div>
      </div>
      <Show when={expanded()}>
        <div class="ob-log-body" ref={bodyRef}>
          <For each={props.logs}>
            {(entry) => <div class={entry.isError ? "ob-log-line ob-log-err" : "ob-log-line"}>{entry.text}</div>}
          </For>
        </div>
      </Show>
    </div>
  )
}
