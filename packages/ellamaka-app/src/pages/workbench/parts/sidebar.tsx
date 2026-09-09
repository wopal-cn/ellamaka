import { IconButtonV2 } from "@wopal/ui/v2/components/icon-button-v2.jsx"
import { Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useSpaceStore } from "../space-store"
import type { WopalSpace } from "../space-store"
import { useWorkbenchState } from "../view-store"
import { useSessionStore } from "../session-store"
import { GENERAL_SCOPE_NAME, normalizeSpacePath } from "../workbench-scope"
import { WorkbenchSettingsButton } from "./workbench-settings"
import { SessionTree } from "./session-tree"
import { ChatIcon } from "./session-tree-space"
import { Persist, persisted } from "@/utils/persist"
import { useWorkbenchRuntime } from "../workbench-runtime"
import { createFlyoutController, flyoutVisibilityClass, type FlyoutMode } from "./sidebar-flyout"
import type { SidebarNav } from "./sidebar-nav"
import { coerceSidebarNav } from "./sidebar-nav"
import { FileTreePanel } from "./file-tree-panel"
import type { FileNode } from "@opencode-ai/sdk/v2"


const MIN_WIDTH = 200
const MAX_WIDTH = 500
const DEFAULT_WIDTH = 300
const COLLAPSED_WIDTH = 44

function MaintenanceIcon(props: { class?: string }) {
  return (
    <svg class={props.class ?? "size-4"} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  )
}

function FileTreeIcon(props: { class?: string }) {
  return (
    <svg class={props.class ?? "size-4"} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 6h8" />
      <path d="M4 12h8" />
      <path d="M4 18h8" />
      <rect x="16" y="4" width="5" height="5" rx="1" />
      <rect x="16" y="15" width="5" height="5" rx="1" />
      <path d="M18.5 9v3.5a2 2 0 0 1-2 2h-4" />
    </svg>
  )
}

export function SpaceRail(props: { onFileClick?: (file: FileNode) => void }) {
  const store = useSpaceStore()
  const wb = useWorkbenchState()
  const sessionStore = useSessionStore()
  const runtime = useWorkbenchRuntime()
  const language = useLanguage()
  const t: typeof language.t = (k, p) => language.t(k, p)

  const expanded = createMemo(() => wb.display().showSpaceRail)
  const [widthStore, setWidthStore] = persisted(
    Persist.global("workbench.sidebarWidth", []),
    createStore({ width: DEFAULT_WIDTH }),
  )

  const sidebarWidth = () => (expanded() ? widthStore.width : COLLAPSED_WIDTH)

  const [activeNavStore, setActiveNavStore] = persisted(
    Persist.global("workbench.sidebarNav", []),
    createStore({ nav: "sessions" as SidebarNav }),
  )
  const activeNav = () => coerceSidebarNav(activeNavStore.nav)
  const setActiveNav = (nav: SidebarNav) => setActiveNavStore({ nav })

  let asideRef: HTMLElement | undefined
  let resizeHandleRef: HTMLElement | undefined
  let resizing = false

  function startResize(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (!asideRef || !resizeHandleRef) return
    resizing = true
    const startX = e.clientX
    const startWidth = widthStore.width
    asideRef.style.transition = "none"

    let rafId: number | null = null

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!resizing || !asideRef || !resizeHandleRef) return
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        const delta = moveEvent.clientX - startX
        let newWidth = startWidth + delta
        if (newWidth < MIN_WIDTH) newWidth = MIN_WIDTH
        if (newWidth > MAX_WIDTH) newWidth = MAX_WIDTH
        asideRef!.style.width = `${newWidth}px`
        resizeHandleRef!.style.left = `${newWidth}px`
      })
    }

    const onMouseUp = () => {
      resizing = false
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""

      if (!asideRef) return
      asideRef.style.transition = ""
      const finalWidth = parseFloat(asideRef.style.width)
      if (!isNaN(finalWidth)) {
        setWidthStore("width", finalWidth)
      }
    }

    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    document.addEventListener("mousemove", onMouseMove, { passive: true })
    document.addEventListener("mouseup", onMouseUp)
  }

  function handleSpaceClick(space: WopalSpace) {
    if (space.path === wb.activeTabPath) return
    wb.openTab(space)
  }

  const [refreshing, setRefreshing] = createSignal(false)

  function handleRefresh() {
    if (!runtime.canUseSpaceControl()) return
    if (refreshing()) return
    setRefreshing(true)
    wb.triggerRefresh()
    wb.setStatusMessage(t("workbench.sidebar.refreshing"))
    setTimeout(() => {
      setRefreshing(false)
      wb.setStatusMessage(t("workbench.sidebar.refreshed"))
    }, 600)
  }

  function handleSessionClick(sessionId: string) {
    const session = sessionStore.getSession(sessionId)
    if (!session) return
    const isBound = wb.isSessionBound(sessionId)
    const boundPanelId = wb.boundPanelIdForSession(sessionId)
    const sessionSpacePath = session.spacePath ? normalizeSpacePath(session.spacePath) : ""
    const tab = wb.tabs.find((tab) => normalizeSpacePath(tab.path) === sessionSpacePath)
    if (tab) {
      wb.openTab(tab)
      if (isBound && boundPanelId) {
        wb.setActivePanel(tab.path, boundPanelId)
      }
      return
    }
    if (sessionSpacePath !== "") {
      const space = store.spaces().find((candidate) => normalizeSpacePath(candidate.path) === sessionSpacePath)
      wb.openTab(space ?? { id: sessionSpacePath, name: session.spaceName ?? sessionSpacePath, path: sessionSpacePath, type: "space" })
      wb.ensureSpace(sessionSpacePath)
    }
  }

  // 单空间会话隔离：仅过滤当前激活空间的 WopalSpace 节点
  const activeSpaces = createMemo(() => {
    const allSpaces = [
      { name: GENERAL_SCOPE_NAME, id: GENERAL_SCOPE_NAME, path: "", type: "general" },
      ...store.spaces(),
    ]
    const currentPath = normalizeSpacePath(wb.activeTabPath)
    const filtered = allSpaces.filter((space) => normalizeSpacePath(space.path) === currentPath)
    return filtered.length > 0 ? filtered : [allSpaces[0]]
  })

  const [flyoutOpen, setFlyoutOpen] = createSignal(false)
  const [flyoutMode, setFlyoutMode] = createSignal<FlyoutMode>("sessions")
  const flyout = createFlyoutController({
    pinned: () => expanded(),
    onChange: (mode) => {
      setFlyoutMode(mode)
      setFlyoutOpen(flyout.isOpen())
    },
  })
  onCleanup(() => flyout.destroy())

  // The flyout stays open on click: closing it synchronously would swallow the
  // second click of a double-click (the row's dblclick opens a new panel).
  // closeSoon defers the hide past the OS double-click interval; requestClose
  // fires when a double-click completes so the flyout hides immediately then.
  function handleFlyoutSessionClick(sessionId: string) {
    flyout.closeSoon()
    handleSessionClick(sessionId)
  }

  function handleFlyoutSessionDblClick(sessionId: string) {
    flyout.requestClose()
  }

  // Flyout must not cover the titlebar or the status bar: it is clamped to the
  // live bounding rect of the aside, which sits between those two chrome bars.
  // top/bottom are reactive so titlebar/statusbar toggles re-clamp the flyout.
  const [flyoutTop, setFlyoutTop] = createSignal(8)
  const [flyoutBottom, setFlyoutBottom] = createSignal(8)
  createEffect(
    on(
      flyoutOpen,
      () => {
        if (!asideRef) return
        const rect = asideRef.getBoundingClientRect()
        setFlyoutTop(Math.max(rect.top + 8, 8))
        setFlyoutBottom(Math.max(window.innerHeight - rect.bottom + 8, 8))
      },
    ),
  )

  return (
    <>
      <aside
        ref={(el) => { asideRef = el }}
        class="flex shrink-0 border-r border-v2-border-border-base bg-v2-background-bg-deep overflow-hidden select-none"
        style={{ width: `${sidebarWidth()}px`, transition: resizing ? "none" : "width 0.15s" }}
      >
        {/* 固定 44px 竖向 Activity Bar */}
        <div class="w-11 shrink-0 flex flex-col items-center py-2.5 border-r border-v2-border-border-base bg-v2-background-bg-deep h-full z-10">
          <div class="flex flex-col gap-2.5 items-center">
            {/* 会话 Icon：折叠时悬停以浮层临时展开会话树，点击固定展开/收起 */}
            <div
              onMouseEnter={() => flyout.onTriggerEnter("sessions")}
              onMouseLeave={() => flyout.onTriggerLeave()}
            >
              <IconButtonV2
                variant={activeNav() === "sessions" && expanded() ? "neutral" : "ghost-muted"}
                size="normal"
                class={`size-8 p-0 flex items-center justify-center ${activeNav() === "sessions" && expanded() ? "text-v2-icon-icon-accent bg-v2-overlay-simple-overlay-hover" : ""}`}
                icon={<ChatIcon class="size-4" />}
                aria-label="Sessions"
                title="Sessions"
                onClick={() => {
                  flyout.close()
                  if (activeNav() === "sessions") {
                    wb.setDisplay("showSpaceRail", !expanded())
                  } else {
                    setActiveNav("sessions")
                    wb.setDisplay("showSpaceRail", true)
                  }
                }}
              />
            </div>
            {/* 文件树 Icon：折叠时悬停以浮层临时展开文件树，点击固定展开/收起 */}
            <div
              onMouseEnter={() => flyout.onTriggerEnter("files")}
              onMouseLeave={() => flyout.onTriggerLeave()}
            >
              <IconButtonV2
                variant={activeNav() === "files" && expanded() ? "neutral" : "ghost-muted"}
                size="normal"
                class={`size-8 p-0 flex items-center justify-center ${activeNav() === "files" && expanded() ? "text-v2-icon-icon-accent bg-v2-overlay-simple-overlay-hover" : ""}`}
                icon={<FileTreeIcon class="size-4" />}
                aria-label={t("workbench.sidebar.filesTab")}
                title={t("workbench.sidebar.filesTab")}
                onClick={() => {
                  flyout.close()
                  if (activeNav() === "files") {
                    wb.setDisplay("showSpaceRail", !expanded())
                  } else {
                    setActiveNav("files")
                    wb.setDisplay("showSpaceRail", true)
                  }
                }}
              />
            </div>
          </div>

          <div class="mt-auto flex flex-col items-center">
            <WorkbenchSettingsButton />
          </div>
        </div>

        {/* 侧栏面板内容 (DOM 常驻，通过 CSS 显隐保持状态与 Scroll 位置) */}
        <div class={`flex-1 min-w-0 flex flex-col h-full bg-v2-background-bg-base ${expanded() ? "" : "hidden"}`}>
          <header class="flex h-7 shrink-0 items-center justify-between px-3 border-b border-v2-border-border-base bg-v2-background-bg-base">
            <div class="flex items-center gap-1.5 min-w-0 flex-1">
              <span class="text-11-medium text-v2-text-text-strong truncate">
                {activeNav() === "sessions" ? t("workbench.sidebar.spaces") : activeNav() === "files" ? t("workbench.sidebar.files") : t("workbench.sidebar.maintenance")}
              </span>
              <IconButtonV2
                variant="ghost-muted"
                size="small"
                class="size-5 flex items-center justify-center p-0 shrink-0"
                icon={
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class={refreshing() ? "workbench-spinner" : ""}
                    style={{ "transform-origin": "center" }}
                  >
                    <path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89L13.5 5.5M13.5 5.5V2m0 3.5H10" />
                  </svg>
                }
                aria-label={t("workbench.sidebar.refresh")}
                disabled={!runtime.canUseSpaceControl()}
                onClick={handleRefresh}
              />
            </div>
          </header>

            <div class={`flex-1 min-h-0 flex flex-col min-w-0 py-1 ${activeNav() === "sessions" ? "" : "hidden"}`}>
              <Show
                when={store.spaces() !== undefined}
                fallback={<div class="px-3 py-6 text-12-regular text-v2-text-text-muted">{t("common.loading")}</div>}
              >
                <SessionTree
                  spaces={activeSpaces()}
                  activeSpacePath={wb.activeTabPath}
                  onSpaceClick={handleSpaceClick}
                  onSessionClick={handleSessionClick}
                />
              </Show>
            </div>

            <div class={`flex-1 min-h-0 flex flex-col min-w-0 overflow-y-auto ${activeNav() === "files" ? "" : "hidden"}`}>
              <FileTreePanel directory={wb.activeTabPath} onFileClick={props.onFileClick ?? (() => {})} />
            </div>

            <div class={`flex-1 min-h-0 flex flex-col min-w-0 ${activeNav() === "maintenance" ? "" : "hidden"}`}>
              <div class="p-3 text-12-regular text-v2-text-text-muted">
                <div class="flex items-center gap-1.5 font-medium text-v2-text-text-base mb-1">
                  <MaintenanceIcon class="size-4" />
                  <span>{t("workbench.sidebar.maintenance")}</span>
                </div>
                <p>{t("workbench.sidebar.activeSpace", { name: wb.activeSpaceName })}</p>
                <p class="mt-2 text-11-regular text-v2-text-text-faint">{t("workbench.sidebar.maintenanceDesc")}</p>
              </div>
            </div>
        </div>
      </aside>

      <Show when={expanded()}>
        <div
          ref={(el) => { resizeHandleRef = el }}
          class="absolute top-0 bottom-0 w-2 cursor-col-resize bg-transparent hover:bg-v2-icon-icon-brand/30 z-30"
          style={{ left: `${sidebarWidth()}px` }}
          onMouseDown={startResize}
          title={t("workbench.sidebar.resizeHandle")}
        />
      </Show>

      {/* 折叠态悬停浮层：DOM 常驻，通过 CSS 显隐保持树状态与 Scroll 位置 */}
      <Portal>
        <div
          data-component="space-rail-flyout"
          class={`fixed z-40 flex flex-col min-h-0 rounded-lg border border-v2-border-border-base bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)] overflow-hidden transition-opacity duration-150 ${flyoutVisibilityClass(flyoutOpen())}`}
          style={{ left: `${COLLAPSED_WIDTH}px`, width: `${widthStore.width}px`, top: `${flyoutTop()}px`, bottom: `${flyoutBottom()}px` }}
          onMouseEnter={() => flyout.onFlyoutEnter()}
          onMouseLeave={() => flyout.onFlyoutLeave()}
        >
          <header class="flex h-7 shrink-0 items-center px-3 border-b border-v2-border-border-base">
            <span class="text-11-medium text-v2-text-text-strong truncate">
              {flyoutMode() === "files" ? t("workbench.sidebar.files") : t("workbench.sidebar.spaces")}
            </span>
          </header>
          <div
            class={`flex-1 min-h-0 flex flex-col min-w-0 py-1 overflow-y-auto ${flyoutMode() === "sessions" ? "" : "hidden"}`}
          >
            <Show
              when={store.spaces() !== undefined}
              fallback={<div class="px-3 py-6 text-12-regular text-v2-text-text-muted">{t("common.loading")}</div>}
            >
              <SessionTree
                spaces={activeSpaces()}
                activeSpacePath={wb.activeTabPath}
                onSpaceClick={handleSpaceClick}
                onSessionClick={handleSessionClick}
                onSessionDblClick={handleFlyoutSessionDblClick}
              />
            </Show>
          </div>
          <div
            class={`flex-1 min-h-0 flex flex-col min-w-0 overflow-y-auto ${flyoutMode() === "files" ? "" : "hidden"}`}
          >
            <FileTreePanel
              directory={wb.activeTabPath}
              onFileClick={(file) => {
                flyout.close()
                ;(props.onFileClick ?? (() => {}))(file)
              }}
            />
          </div>
        </div>
      </Portal>
    </>
  )
}
