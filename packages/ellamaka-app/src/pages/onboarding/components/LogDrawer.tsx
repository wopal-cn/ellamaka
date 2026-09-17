import { createSignal, Show, For, createEffect } from "solid-js"
import { zhCN } from "../content/zh-CN"

export interface LogEntry {
  text: string
  isError?: boolean
  timestamp?: string
}

export interface LogDrawerProps {
  logs: LogEntry[]
  statusMsg?: string
  onClear?: () => void
  onCopy?: () => void
}

const STORAGE_KEY = "wopal_onboarding_log_drawer_expanded"

function getInitialExpandedState(): boolean {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved !== null) {
      return saved === "true"
    }
  } catch {
    // ignore localStorage errors
  }
  return false // Default collapsed per user requirement
}

function saveExpandedState(expanded: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, String(expanded))
  } catch {
    // ignore localStorage write errors
  }
}

export function LogDrawer(props: LogDrawerProps) {
  const [expanded, setExpandedSignal] = createSignal(getInitialExpandedState())
  const errorCount = () => props.logs.filter((l) => l.isError).length
  let bodyRef: HTMLDivElement | undefined

  const toggleExpanded = () => {
    const next = !expanded()
    setExpandedSignal(next)
    saveExpandedState(next)
  }

  // Auto-scroll to bottom when logs change
  createEffect(() => {
    props.logs.length
    if (bodyRef && expanded()) {
      bodyRef.scrollTop = bodyRef.scrollHeight
    }
  })

  const handleCopy = async (e: MouseEvent) => {
    e.stopPropagation()
    const text = props.logs.map((l) => l.text).join("\n")
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // fallback: select text
    }
    props.onCopy?.()
  }

  const handleClear = (e: MouseEvent) => {
    e.stopPropagation()
    props.onClear?.()
  }

  return (
    <div class="ob-log-drawer">
      <div class="ob-log-header" onClick={toggleExpanded} style={{ cursor: "pointer" }}>
        <div class="ob-log-header-left">
          <span class="ob-log-icon">{expanded() ? "▼" : "▲"}</span>
          <span class="ob-log-title">日志</span>
          <Show when={errorCount() > 0}>
            <span class="ob-log-error-badge">{errorCount()} 错误</span>
          </Show>
        </div>
        <div class="ob-log-header-status">
          {props.statusMsg || ""}
        </div>
        <div class="ob-log-header-actions" onClick={(e) => e.stopPropagation()}>
          <Show when={expanded()}>
            <button class="ob-log-action-btn" onClick={handleCopy} title={zhCN.actions.copy}>
              {zhCN.actions.copy}
            </button>
            <button class="ob-log-action-btn" onClick={handleClear} title={zhCN.actions.clear}>
              {zhCN.actions.clear}
            </button>
          </Show>
        </div>
      </div>
      <Show when={expanded()}>
        <div class="ob-log-body" ref={bodyRef}>
          <For each={props.logs}>
            {(log) => (
              <div class={log.isError ? "ob-log-line ob-log-err" : "ob-log-line"}>
                {log.text}
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
