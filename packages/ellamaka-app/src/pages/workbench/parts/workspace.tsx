import { Icon as IconV2 } from "@wopal/ui/v2/components/icon.jsx"
import { IconButtonV2 } from "@wopal/ui/v2/components/icon-button-v2.jsx"
import { Button } from "@wopal/ui/button"
import { Dialog } from "@wopal/ui/dialog"
import { useDialog } from "@wopal/ui/context/dialog"
import { For, Show, createEffect, createMemo, batch, Suspense, ErrorBoundary } from "solid-js"
import { useLanguage } from "@/context/language"
import { useWorkbenchState } from "../view-store"
import { Panel } from "./panel"
import { useWorkbenchActions } from "../workbench-actions"
import { scopeFromTab, GENERAL_SCOPE_NAME } from "../workbench-scope"
import { WorkbenchPanelDirectoryProvider } from "../workbench-directory-provider"

import type { WorkbenchPanel } from "../view-store"

export function Workspace() {
  const wb = useWorkbenchState()
  const language = useLanguage()
  const t = (k: string) => language.t(k)

  const dialog = useDialog()

  const activePath = createMemo(() => wb.activeTab()?.path ?? "")

  createEffect(() => {
    const path = activePath()
    if (wb.activeTab()) wb.ensureSpace(path)
  })

  const currentSpace = () => {
    if (!wb.activeTab()) return undefined
    return wb.spaceState(activePath())
  }

  const currentPanels = () => currentSpace()?.panels ?? []

  const handlePanelResizeStart = (
    e: MouseEvent & { currentTarget: HTMLDivElement },
    leftIndex: number,
    path: string,
    tabPanels: WorkbenchPanel[]
  ) => {
    e.preventDefault()
    e.stopPropagation()
    const handleEl = e.currentTarget
    const container = handleEl.closest(".tab-container")
    if (!(container instanceof HTMLElement)) return

    const panelElements = Array.from(container.querySelectorAll<HTMLElement>("[data-panel-id]"))
    const leftPanelEl = panelElements[leftIndex]
    const rightPanelEl = panelElements[leftIndex + 1]
    if (!leftPanelEl || !rightPanelEl) return

    const leftPanelID = leftPanelEl.getAttribute("data-panel-id")!
    const rightPanelID = rightPanelEl.getAttribute("data-panel-id")!

    const startX = e.clientX
    const leftStartWidth = leftPanelEl.getBoundingClientRect().width
    const rightStartWidth = rightPanelEl.getBoundingClientRect().width
    const totalWidth = leftStartWidth + rightStartWidth

    const leftStartFlex = tabPanels[leftIndex].width
    const rightStartFlex = tabPanels[leftIndex + 1].width
    const flexSum = leftStartFlex + rightStartFlex

    leftPanelEl.style.transition = "none"
    rightPanelEl.style.transition = "none"
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"

    let rafId: number | null = null

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        const deltaX = moveEvent.clientX - startX

        let newLeftWidth = leftStartWidth + deltaX
        let newRightWidth = rightStartWidth - deltaX

        if (newLeftWidth < 280) {
          newLeftWidth = 280
          newRightWidth = totalWidth - 280
        } else if (newRightWidth < 280) {
          newRightWidth = 280
          newLeftWidth = totalWidth - 280
        }

        const newLeftFlex = (newLeftWidth / totalWidth) * flexSum
        const newRightFlex = (newRightWidth / totalWidth) * flexSum

        leftPanelEl.style.flex = `${newLeftFlex}`
        rightPanelEl.style.flex = `${newRightFlex}`
      })
    }

    const onMouseUp = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      leftPanelEl.style.transition = ""
      rightPanelEl.style.transition = ""

      const finalLeftFlex = parseFloat(leftPanelEl.style.flex)
      const finalRightFlex = parseFloat(rightPanelEl.style.flex)

      if (!isNaN(finalLeftFlex) && !isNaN(finalRightFlex)) {
        batch(() => {
          wb.setPanelWidth(path, leftPanelID, finalLeftFlex)
          wb.setPanelWidth(path, rightPanelID, finalRightFlex)
        })
      }
    }

    document.addEventListener("mousemove", onMouseMove, { passive: true })
    document.addEventListener("mouseup", onMouseUp)
  }

  const handleCloseTab = (name: string, path: string) => {
    void dialog.show(() => <DialogCloseTab name={name} path={path} />)
  }

  return (
    <main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-v2-background-bg-base relative z-10">
      <div class="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <Show when={wb.tabs.length === 0}>
          <div class="flex flex-1 items-center justify-center text-v2-text-text-muted">
            <span class="text-12-regular">{t("workbench.workspace.empty")}</span>
          </div>
        </Show>
        <For each={wb.tabs}>
          {(tab) => {
            const isTabActive = () => tab.path === activePath()
            const tabSpace = () => wb.spaceState(tab.path)
            const tabPanels = () => tabSpace()?.panels ?? []
            const tabActivePanelID = () => tabSpace()?.activePanelID ?? tabPanels()[0]?.id ?? ""

            return (
              <div
                class={`tab-container ${
                  isTabActive()
                    ? "flex min-h-0 min-w-0 flex-1 overflow-hidden"
                    : "absolute inset-0 opacity-0 pointer-events-none invisible -z-10 overflow-hidden flex"
                }`}
                inert={!isTabActive()}
              >
                <For each={tabPanels()}>
                  {(panel, index) => (
                    <div class="contents">
                      <Suspense>
                        <WorkbenchPanelDirectoryProvider panelID={panel.id} directory={panel.directory}>
                          {() => (
                            <ErrorBoundary
                              fallback={(error, reset) => (
                                <PanelErrorFallback error={error} reset={reset} />
                              )}
                            >
                              <Panel
                                panel={panel}
                                spaceName={tab.name}
                                spacePath={tab.path}
                                isActive={panel.id === tabActivePanelID()}
                                panelCount={tabPanels().length}
                                panelIndex={index()}
                                onActivate={() => wb.setActivePanel(tab.path, panel.id)}
                                onModeChange={(mode) => wb.setPanelMode(tab.path, panel.id, mode)}
                              />
                            </ErrorBoundary>
                          )}
                        </WorkbenchPanelDirectoryProvider>
                      </Suspense>
                      <Show when={index() < tabPanels().length - 1}>
                        <div
                          class="w-px z-20 cursor-col-resize bg-v2-border-border-base hover:bg-v2-icon-icon-brand/30 transition-colors flex-shrink-0"
                          onMouseDown={(e) => handlePanelResizeStart(e, index(), tab.path, tabPanels())}
                          onDblClick={() => wb.resetPanelWidths(tab.path)}
                          title="双击恢复等宽"
                        />
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            )
          }}
        </For>
      </div>
    </main>
  )
}



export function DialogCloseTab(props: { name: string; path: string }) {
  const wb = useWorkbenchState()
  const actions = useWorkbenchActions()
  const language = useLanguage()
  const t = (k: string, params?: Record<string, string | number | boolean>) => language.t(k, params)
  const dialog = useDialog()

  const spaceName = () => props.name
  const panelCount = () => wb.spaceState(props.path)?.panels.length ?? 0
  const boundCount = () =>
    wb.spaceState(props.path)?.panels.filter((p) => p.slotState === "bound").length ?? 0

  const handleConfirm = async () => {
    await actions.closeSpace(scopeFromTab({ name: props.name, path: props.path }))
    dialog.close()
  }

  return (
    <Dialog title={t("workbench.tabClose.title")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3 min-w-[380px]">
        <div class="flex flex-col gap-3">
          <span class="text-14-medium text-v2-text-text-strong">
            {t("workbench.tabClose.confirm", { name: spaceName() })}
          </span>
          <div class="flex flex-col gap-2 rounded-lg border border-v2-border-border-base bg-v2-background-bg-deep p-3 text-12-regular text-v2-text-text-muted">
            <span class="text-12-medium text-v2-text-text-base mb-1">
              {t("workbench.tabClose.desc")}
            </span>
            <span>
              {t("workbench.tabClose.consequencePanels", { count: panelCount() })}
            </span>
            <Show when={boundCount() > 0}>
              <span>
                {t("workbench.tabClose.consequenceSessions", { count: boundCount() })}
              </span>
            </Show>
            <span class="text-amber-500/95 dark:text-amber-400/90 font-medium">
              {t("workbench.tabClose.consequenceTerminals")}
            </span>
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" onClick={handleConfirm}>
            {t("workbench.tabClose.confirmButton")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function PanelErrorFallback(props: { error: Error; reset: () => void }) {
  // Per-panel error boundary fallback. A single panel throwing must not
  // bring down the whole workbench — siblings keep running and the user
  // gets an inline retry affordance.
  const language = useLanguage()
  const t: typeof language.t = (key, params) => language.t(key, params)
  return (
    <div class="flex h-full flex-col items-center justify-center gap-3 bg-v2-background-bg-deep text-v2-text-text-base p-6">
      <div class="text-center max-w-sm">
        <div class="text-14-medium text-v2-text-text-strong mb-2">{t("workbench.error.panelLoadFailed")}</div>
        <div class="text-12-regular text-v2-text-text-muted mb-4 break-words">
          {props.error.message || t("workbench.error.unknownError")}
        </div>
        <button
          type="button"
          class="rounded-md bg-v2-icon-icon-brand px-3 py-1.5 text-12-bold text-white hover:opacity-90 transition-opacity"
          onClick={() => props.reset()}
        >
          {t("workbench.error.retry")}
        </button>
      </div>
    </div>
  )
}
