/* @jsxImportSource solid-js */
import { createSignal, createMemo, For, Show, onMount, onCleanup } from "solid-js"
import { Popover } from "@wopal/ui/popover"
import { Icon } from "@wopal/ui/icon"
import { useWorkbenchState, type DiagnosticMessage } from "../view-store"
import { useLanguage } from "@/context/language"

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function StatusBarDiagnosticsCenter() {
  const wb = useWorkbenchState()
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const [showDefaultHint] = createSignal(false)
  const [retryingID, setRetryingID] = createSignal<string>()

  const list = createMemo(() => wb.diagnostics)
  const latest = createMemo(() => {
    const items = list()
    return items.length > 0 ? items[items.length - 1] : undefined
  })

  const severity = createMemo(() => {
    const items = list()
    if (items.some((item) => item.type === "error")) return "error"
    if (items.some((item) => item.type === "warning")) return "warning"
    return "info"
  })

  const triggerIcon = createMemo(() => {
    const sev = severity()
    if (sev === "error") return "circle-x"
    if (sev === "warning") return "warning"
    return "bubble-5"
  })

  const triggerColorClass = createMemo(() => {
    const sev = severity()
    if (sev === "error") return "text-icon-critical-base"
    if (sev === "warning") return "text-icon-warning-base"
    return "text-v2-text-text-primary"
  })

  const retry = async (item: DiagnosticMessage) => {
    if (!item.onRetry || retryingID()) return
    setRetryingID(item.id)
    try {
      if (await item.onRetry()) wb.removeDiagnostic(item.id)
    } catch {
      return
    } finally {
      setRetryingID(undefined)
    }
  }

  return (
    <div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center z-10">
      <Show
        when={list().length > 0}
        fallback={
          <Show when={showDefaultHint()}>
            <span class="text-10-regular text-v2-text-text-muted select-none truncate max-w-[800px]">
              {language.t("workbench.status.defaultHint") || "提示：双击会话或拖拽会话到面板中即可在工作台打开"}
            </span>
          </Show>
        }
      >
        <Popover
          open={open()}
          onOpenChange={setOpen}
          placement="top"
          style={{ "max-width": "750px", width: "750px" }}
          title={language.t("workbench.status.diagnostics.title") || "异常提示中心"}
          trigger={
            <button
              class="flex items-center gap-1.5 rounded px-2 py-0.5 text-11-medium text-v2-text-text-primary hover:bg-v2-surface-surface-3 transition-colors max-w-[840px] select-none border border-transparent hover:border-v2-border-border-base cursor-pointer"
              aria-label={language.t("workbench.status.diagnostics.title") || "异常提示中心"}
            >
              <Icon name={triggerIcon()} class={`size-3.5 shrink-0 ${triggerColorClass()}`} />
              <span class="truncate max-w-[700px]">{latest()?.text}</span>
              <Show when={list().length > 1}>
                <span class="rounded-full bg-v2-surface-surface-3 px-1.5 py-0.2 text-9-medium text-v2-text-text-muted shrink-0">
                  +{list().length - 1}
                </span>
              </Show>
            </button>
          }
        >
          <div class="flex flex-col max-h-[320px] w-full">
            <div class="flex flex-col max-h-[260px] w-full overflow-y-auto divide-y divide-v2-border-border-base">
              <For each={[...list()].reverse()}>
                {(item: DiagnosticMessage) => (
                  <div class="flex items-start justify-between gap-2 py-2">
                    <div class="flex items-start gap-2 min-w-0 flex-1">
                      <div class="mt-0.5 shrink-0">
                        <Show when={item.type === "error"}>
                          <Icon name="circle-x" class="text-icon-critical-base size-3.5" />
                        </Show>
                        <Show when={item.type === "warning"}>
                          <Icon name="warning" class="text-icon-warning-base size-3.5" />
                        </Show>
                        <Show when={item.type === "info"}>
                          <Icon name="bubble-5" class="text-v2-text-text-muted size-3.5" />
                        </Show>
                      </div>
                      <div class="min-w-0 flex-1">
                        <div class="text-11-regular break-words text-v2-text-text-primary leading-relaxed">
                          {item.text}
                        </div>
                        <div class="mt-1 flex items-center gap-1.5 text-10-regular text-v2-text-text-faint">
                          <span>{formatTime(item.timestamp)}</span>
                          <Show when={item.source}>
                            <span>• {item.source}</span>
                          </Show>
                        </div>
                      </div>
                    </div>
                    <div class="flex shrink-0 items-center gap-1">
                      <Show when={item.onRetry}>
                        <button
                          class="rounded bg-v2-surface-surface-3 px-2 py-0.5 text-10-medium text-v2-text-text-primary hover:bg-v2-surface-surface-4 transition-colors cursor-pointer"
                          disabled={retryingID() === item.id}
                          onClick={() => void retry(item)}
                        >
                          {retryingID() === item.id
                            ? language.t("workbench.status.diagnostics.retrying") || "重试中…"
                            : language.t("workbench.status.diagnostics.retry") || "重试"}
                        </button>
                      </Show>
                      <button
                        class="rounded p-1 text-v2-text-text-muted hover:bg-v2-surface-surface-3 hover:text-v2-text-text-primary transition-colors cursor-pointer"
                        onClick={() => wb.removeDiagnostic(item.id)}
                        title={language.t("ui.common.close") || "关闭"}
                      >
                        <Icon name="close-small" class="size-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </div>
            <div class="mt-2 flex shrink-0 items-center justify-between border-t border-v2-border-border-base pt-2 text-10-regular">
              <span class="text-v2-text-text-muted">
                {list().length} {language.t("workbench.status.diagnostics.count") || "条消息"}
              </span>
              <button
                class="rounded px-2 py-0.5 text-10-medium text-v2-text-text-muted hover:bg-v2-surface-surface-3 hover:text-v2-text-text-primary transition-colors flex items-center gap-1 cursor-pointer"
                onClick={() => {
                  wb.clearAllDiagnostics()
                  setOpen(false)
                }}
              >
                <Icon name="trash" class="size-3" />
                <span>{language.t("workbench.status.diagnostics.clearAll") || "清除全部"}</span>
              </button>
            </div>
          </div>
        </Popover>
      </Show>
    </div>
  )
}
