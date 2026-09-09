import { Icon as IconV2 } from "@wopal/ui/v2/components/icon.jsx"
import { IconButtonV2 } from "@wopal/ui/v2/components/icon-button-v2.jsx"
import { useDialog } from "@wopal/ui/context/dialog"
import { Show, For, createMemo, createSignal, onCleanup } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSessionStore } from "../session-store"
import { useWorkbenchState } from "../view-store"
import { useWorkbenchActions } from "../workbench-actions"
import { scopeFromTab } from "../workbench-scope"
import { getPanelHeaderViews } from "./panel-header-views"
import { listViews } from "../view-registry"
import { DialogClosePanel } from "./session-tree-dialogs"
import { SessionContextHeaderTrigger } from "./session-context-header-trigger"
import { reportWorkbenchError } from "../workbench-error"
import type { WorkbenchPanel } from "../view-store"

export function PanelHeader(props: {
  panel: WorkbenchPanel
  spaceName: string
  spacePath: string
  isActive: boolean
  panelCount: number
  panelIndex?: number
  onToggleSplit: () => void
}) {
  const language = useLanguage()
  const t: typeof language.t = (key, params) => language.t(key, params)
  const wb = useWorkbenchState()
  const actions = useWorkbenchActions()
  const sessionStore = useSessionStore()
  const dialog = useDialog()
  const panelScope = () => scopeFromTab({ name: props.spaceName, path: props.spacePath })

  const canRemove = () => {
    if (props.panel.slotState === "empty" && props.panelCount <= 1) return false
    return true
  }
  const title = () => {
    if (props.panel.slotState === "bound") {
      const session = sessionStore.getSession(props.panel.boundSessionId ?? "")
      return session?.title ?? t("workbench.panel.untitledSession")
    }
    let num = props.panelIndex !== undefined ? props.panelIndex + 1 : 0
    if (!num) {
      const panels = wb.spaceState(props.spacePath)?.panels ?? []
      const idx = panels.findIndex((p) => p.id === props.panel.id)
      num = idx !== -1 ? idx + 1 : 1
    }
    return t("workbench.panel.number", { number: num })
  }
  const headerViews = () => getPanelHeaderViews(listViews(), props.panel.slotState, props.panel.tuiPtyId)
  const hasOpenSplitPty = createMemo(() => !!props.panel.splitPtyId)

  const handleClose = () => {
    const spacePath = props.spacePath
    if (spacePath === undefined || spacePath === null) return
    void actions.closePanel({ scope: panelScope(), panelID: props.panel.id }).catch((error) =>
      reportWorkbenchError("close panel", error),
    )
  }

  return (
    <div
      class="flex h-7 shrink-0 items-center gap-1 px-2 border-b relative transition-colors duration-200"
      classList={{
        "bg-v2-background-bg-layer-03 border-v2-border-border-strong": props.isActive,
        "bg-v2-background-bg-base border-v2-border-border-base": !props.isActive,
      }}
    >
      <Show when={props.isActive}>
        <div class="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-v2-icon-icon-accent pointer-events-none" />
      </Show>

      <span
        class="size-2 rounded-full shrink-0"
        classList={{
          "bg-green-500": props.panel.slotState === "bound",
          "bg-v2-text-text-faint": props.panel.slotState === "empty",
        }}
      />

      <span
        class="truncate max-w-40 ml-0.5 transition-colors duration-200"
        classList={{
          "text-11-bold text-v2-text-text-strong font-semibold": props.isActive,
          "text-10-regular text-v2-text-text-muted": !props.isActive,
        }}
      >
        {title()}
      </span>

      <div class="grow" />

      <Show when={props.panel.slotState === "bound"}>
        <IconButtonV2
          variant="ghost"
          size="small"
          style={{ color: hasOpenSplitPty() ? "var(--v2-icon-icon-accent)" : undefined }}
          state={props.panel.splitTerminal ? "pressed" : undefined}
          icon={<IconV2 name="terminal" />}
          aria-label={t(props.panel.splitTerminal ? "workbench.panel.splitTerminal.hide" : "workbench.panel.splitTerminal.show")}
          title={t(props.panel.splitTerminal ? "workbench.panel.splitTerminal.hide" : "workbench.panel.splitTerminal.show")}
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            e.preventDefault()
            props.onToggleSplit()
          }}
        />
      </Show>

      <For each={headerViews()}>
        {(view) => {
          const spacePath = props.spacePath
          const isActiveView = () => props.panel.viewMode === view.id
          // Context 视图按钮替换为 context 占用百分比触发器：hover 显示
          // tokens 摘要，点击行为不变（切换到 Context 视图）。会话未绑定时退回原按钮。
          if (view.id === "context") {
            const content = (
              <Show
                when={props.panel.boundSessionId}
                keyed
                fallback={
                  <button
                    type="button"
                    class="h-5 inline-flex items-center justify-center gap-1 px-1.5 rounded-md text-10-medium transition-all select-none cursor-pointer"
                    classList={{
                      "text-v2-text-text-faint cursor-not-allowed": view.disabled,
                      "cursor-pointer": !view.disabled,
                      "bg-v2-overlay-simple-overlay-pressed text-v2-text-text-strong font-semibold shadow-xs": isActiveView() && !view.disabled,
                      "text-v2-text-text-muted hover:text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover font-normal": !isActiveView() && !view.disabled,
                    }}
                    disabled={view.disabled}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (view.disabled) return
                      wb.setPanelViewMode(spacePath, props.panel.id, view.id)
                    }}
                  >
                    <span>{view.label}</span>
                  </button>
                }
              >
                {(sessionId) => (
                  <SessionContextHeaderTrigger
                    sessionId={sessionId}
                    directory={props.panel.directory}
                    active={isActiveView()}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (view.disabled) return
                      wb.setPanelViewMode(spacePath, props.panel.id, view.id)
                    }}
                  />
                )}
              </Show>
            )
            return content
          }
          return (
            <button
              type="button"
              class="h-5 inline-flex items-center justify-center gap-1 px-1.5 rounded-md text-10-medium transition-all select-none"
              classList={{
                "text-v2-text-text-faint cursor-not-allowed": view.disabled,
                "cursor-pointer": !view.disabled,
                "bg-v2-overlay-simple-overlay-pressed text-v2-text-text-strong font-semibold shadow-xs": isActiveView() && !view.disabled,
                "text-v2-text-text-muted hover:text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover font-normal": !isActiveView() && !view.disabled,
              }}
              disabled={view.disabled}
              onClick={(e) => {
                e.stopPropagation()
                if (view.disabled) return
                wb.setPanelViewMode(spacePath, props.panel.id, view.id)
              }}
            >
              <span class={view.hasOpenTui && !isActiveView() ? "text-v2-icon-icon-accent" : undefined}>{view.label}</span>
            </button>
          )
        }}
      </For>

      <Show when={canRemove()}>
        <IconButtonV2
          variant="ghost"
          size="small"
          icon={<IconV2 name="xmark-small" />}
          aria-label={t("workbench.panel.close")}
          onClick={(e: MouseEvent) => {
            e.stopPropagation()
            e.preventDefault()
            if (props.panel.slotState === "bound") {
              const session = sessionStore.getSession(props.panel.boundSessionId ?? "")
              const sessionTitle = session?.title ?? t("workbench.panelClose.title")
              void dialog.show(() => (
                <DialogClosePanel
                  sessionTitle={sessionTitle}
                  onClose={async () => {
                    await actions.closePanel({ scope: panelScope(), panelID: props.panel.id })
                  }}
                />
              ))
            } else {
              setTimeout(() => handleClose(), 0)
            }
          }}
        />
      </Show>
    </div>
  )
}

export function PanelMenu(props: {
  x: number
  y: number
  canAddPanel: boolean
  addPanelLabel: string
  addPanelHint: string
  onAddPanel: () => void
  onClose: () => void
}) {
  const handleOutside = () => props.onClose()

  window.addEventListener("click", handleOutside, { once: true })
  onCleanup(() => window.removeEventListener("click", handleOutside))

  return (
    <div
      class="fixed z-50 min-w-44 rounded-md border border-v2-border-border-base bg-v2-background-bg-base shadow-lg py-1 select-none"
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        type="button"
        class="flex items-center gap-2 w-full px-3 py-1.5 text-left text-11-medium text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-40 disabled:cursor-not-allowed"
        disabled={!props.canAddPanel}
        title={props.canAddPanel ? undefined : props.addPanelHint}
        onClick={() => {
          if (!props.canAddPanel) return
          props.onAddPanel()
        }}
      >
        <svg
          class="size-3.5 text-v2-icon-icon-accent shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <line x1="12" y1="3" x2="12" y2="21" />
          <path d="M16 9v6" />
          <path d="M13 12h6" />
        </svg>
        <span>{props.addPanelLabel}</span>
      </button>
    </div>
  )
}
