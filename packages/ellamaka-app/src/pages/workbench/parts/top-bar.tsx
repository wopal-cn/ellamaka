import { Icon as IconV2 } from "@wopal/ui/v2/components/icon.jsx"
import { IconButtonV2 } from "@wopal/ui/v2/components/icon-button-v2.jsx"
import { ButtonV2 } from "@wopal/ui/v2/components/button-v2.jsx"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import { useWorkbenchState } from "../view-store"
import { useSpaceStore } from "../space-store"
import { useWorkbenchSurface } from "../workbench-surface-context"
import { useDialog } from "@wopal/ui/context/dialog"
import { useSessionStore } from "../session-store"
import { DialogCloseTab } from "./workspace"
import { useSync } from "@/context/sync"
import { useServerSync } from "@/context/server-sync"
import { useNotification } from "@/context/notification"
import { pathKey } from "@/utils/path-key"
import { SpaceIcon } from "./session-tree-space"
import { Spinner } from "@wopal/ui/spinner"
import { createFlyoutController } from "./sidebar-flyout"
import { activateSpaceTab } from "./space-tab-activation"

function PinIcon(props: { class?: string }) {
  return (
    <svg
      class={props.class ?? "size-3.5"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-.44-1.24l-2.78-3.55A2 2 0 0 1 15 9.24V5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v4.24c0 .43-.14.85-.4 1.21L5.8 13.97A2 2 0 0 0 5 15.24V17z" />
    </svg>
  )
}

// 文件查看面板图标 (Panel Right style)
function FileViewerPanelIcon(props: { class?: string }) {
  return (
    <svg class={props.class ?? "size-4"} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  )
}

function CheckIcon(props: { class?: string }) {
  return (
    <svg class={props.class ?? "size-3.5 shrink-0"} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

type TabContextMenu = { x: number; y: number; tab: { name: string; path: string; pinned?: boolean } }

const displaySpaceName = (name: string) => /^[\x00-\x7F]+$/.test(name) ? name.toUpperCase() : name

export function WorkbenchTitlebar() {
  const wb = useWorkbenchState()
  const spaceStore = useSpaceStore()
  const sessionStore = useSessionStore()
  const surface = useWorkbenchSurface()
  const language = useLanguage()
  const dialog = useDialog()
  const notification = useNotification()
  const t = (k: string, params?: Record<string, string | number | boolean>) => language.t(k, params)

  let sync: ReturnType<typeof useSync> | undefined
  let serverSync: ReturnType<typeof useServerSync> | undefined
  try {
    sync = useSync()
    serverSync = useServerSync()
  } catch {
    // Safe fallback when rendered outside SyncProvider
  }

  const activePath = () => wb.activeTabPath

  const getTabForDirectory = (dirPath: string): string => {
    const dirKey = pathKey(dirPath ?? "").toLowerCase()
    if (!dirKey) return ""
    if (dirKey === "general") return ""

    for (const tab of wb.tabs) {
      if (!tab.path) continue
      const tabDir = pathKey(tab.path).toLowerCase()
      if (dirKey === tabDir || dirKey.startsWith(tabDir + "/") || dirKey.startsWith(tabDir + "\\")) {
        return tab.path
      }
    }
    return ""
  }

  const isSpaceWorking = (tabPath: string, _tabName?: string) => {
    if (!serverSync) return false
    const targetPath = tabPath ?? ""

    for (const [rawKey, [childStore]] of Object.entries(serverSync.children)) {
      if (getTabForDirectory(rawKey) === targetPath) {
        if (Object.keys(childStore.session_status).some((id) => childStore.session_working(id))) {
          return true
        }
      }
    }
    return false
  }

  // 未读蓝点：严格由本空间在 SessionStore 中是否存在【未读会话 (unseenCount > 0)】动态计算。
  // 与侧边栏 Session 列表蓝点使用同一事实源，避免孤立目录通知造成空间 Tab 蓝点常亮。
  const isSpaceUnread = (tabPath: string, tabName?: string) => {
    const isGeneral = tabPath === ""
    const allSpaces = sessionStore.sessions()
    const targetPath = pathKey(tabPath ?? "").toLowerCase()
    const targetName = (tabName ?? "").toLowerCase()

    for (const [spaceKey, sessions] of Object.entries(allSpaces)) {
      const keyLower = pathKey(spaceKey).toLowerCase()
      let isMatch = false

      if (isGeneral) {
        if (spaceKey === "" || keyLower === "general" || keyLower === "sessions") {
          isMatch = true
        }
      } else {
        if (
          (targetPath && keyLower === targetPath) ||
          (targetName && keyLower === targetName)
        ) {
          isMatch = true
        }
      }

      for (const s of sessions) {
        if (!isMatch) {
          const sPath = pathKey(s.spacePath ?? "").toLowerCase()
          const sName = (s.spaceName ?? "").toLowerCase()
          if (
            (!isGeneral && ((targetPath && sPath === targetPath) || (targetName && sName === targetName))) ||
            (isGeneral && (sPath === "" || sName === "general" || sName === "sessions"))
          ) {
            if (notification.session.unseenCount(s.id) > 0) return true
          }
        } else {
          if (notification.session.unseenCount(s.id) > 0) return true
        }
      }
    }
    return false
  }

  const [showSpaceMenu, setShowSpaceMenu] = createSignal(false)
  const [tabMenu, setTabMenu] = createSignal<TabContextMenu>()
  let spaceMenuRef: HTMLDivElement | undefined

  // 悬停展开空间列表：移出后延迟收起，点击按钮仍可固定切换
  const spaceMenuFlyout = createFlyoutController({
    pinned: () => false,
    onChange: () => setShowSpaceMenu(spaceMenuFlyout.isOpen()),
  })
  onCleanup(() => spaceMenuFlyout.destroy())

  onMount(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (spaceMenuRef && !spaceMenuRef.contains(e.target as Node)) {
        spaceMenuFlyout.close()
      }
      setTabMenu(undefined)
    }
    document.addEventListener("click", handleClickOutside)
    onCleanup(() => document.removeEventListener("click", handleClickOutside))
  })

  const handleCloseTab = (name: string, path: string) => {
    void dialog.show(() => <DialogCloseTab name={name} path={path} />)
  }

  const handleTabContextMenu = (e: MouseEvent, tab: { name: string; path: string; pinned?: boolean }) => {
    e.preventDefault()
    e.stopPropagation()
    setTabMenu({ x: e.clientX, y: e.clientY, tab })
  }

  return (
    <header class="relative z-50 flex shrink-0 flex-col bg-v2-background-bg-base border-b border-v2-border-border-base select-none">
      <div data-tauri-drag-region class="workbench-macos-window-chrome shrink-0" />
      <div data-tauri-drag-region class="workbench-titlebar-toolbar relative flex h-10 items-center justify-between px-3">
        {/* Brand Logo - Left side */}
        <div class="flex items-center gap-6 text-v2-text-text-strong [font-weight:530] text-14-regular shrink-0 z-20">
          <div class="flex items-center gap-2">
            <img src="/favicon-96x96.png" class="w-5 h-5 object-contain" alt="Icon" />
            <img src="/ellamaka-text-logo.png?v=2" class="h-5 w-auto object-contain ellamaka-logo-invert" alt="Logo" />
          </div>
        </div>

        {/* Space Tabs Bar */}
        <div
          role="tablist"
          class="absolute left-1/2 top-1/2 -translate-y-1/2 -translate-x-1/2 flex items-center gap-0.5 rounded-lg overflow-x-auto max-w-[60%] scrollbar-none z-10"
          style={{ "-webkit-app-region": "no-drag" }}
        >
          <For each={wb.tabs}>
            {(tab) => {
              const isGeneral = tab.path === ""
              const isActive = () => {
                if (wb.activeTabPath === tab.path) return true
                if (tab.path !== undefined && wb.activeTabPath !== undefined) {
                  return pathKey(wb.activeTabPath).toLowerCase() === pathKey(tab.path).toLowerCase()
                }
                return false
              }
              const isPinned = () => isGeneral || !!tab.pinned

              return (
                <div
                  role="tab"
                  tabIndex={0}
                  aria-selected={isActive()}
                  class="relative grid h-8 w-max grid-cols-[1rem_max-content_1rem] items-center rounded-md px-2 cursor-pointer shrink-0 transition-colors"
                  classList={{
                    "text-v2-text-text-strong font-semibold": isActive(),
                    "text-v2-text-text-muted hover:text-v2-text-text-base font-medium": !isActive(),
                  }}
                  style={{ "-webkit-app-region": "no-drag" }}
                  onClick={() => activateSpaceTab(wb, tab.path)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      activateSpaceTab(wb, tab.path)
                    }
                  }}
                  onContextMenu={(e: MouseEvent) => {
                    if (isGeneral) {
                      e.preventDefault()
                      return
                    }
                    handleTabContextMenu(e, tab)
                  }}
                >
                  <Show when={isActive()}>
                    <span class="absolute top-0 inset-x-6 h-[2px] rounded-full bg-v2-icon-icon-accent" />
                  </Show>

                  <span class="flex size-4 items-center justify-center">
                    <Show when={isPinned()}>
                      <PinIcon class={`size-3.5 ${isActive() ? "text-v2-text-text-strong" : "text-v2-text-text-muted"}`} />
                    </Show>
                  </span>

                  <span class="whitespace-nowrap inline-flex items-center text-center text-11-medium leading-none">
                    {isGeneral ? t("workbench.sidebar.sessions") : displaySpaceName(tab.name)}
                  </span>

                  <span class="flex size-4 items-center justify-center">
                    <Show when={isSpaceWorking(tab.path, tab.name)}>
                      <Spinner class="size-3.5 text-v2-icon-icon-accent" />
                    </Show>
                    <Show when={!isSpaceWorking(tab.path, tab.name) && isSpaceUnread(tab.path, tab.name)}>
                      <div class="size-2 rounded-full bg-v2-icon-icon-accent" />
                    </Show>
                  </span>

                </div>
              )
            }}
          </For>
        </div>

        {/* Right Nav: Space Selector & Split Panel Button */}
        <div class="flex items-center gap-1.5 shrink-0 z-20">
          {/* 选择空间 下拉选择框：悬停展开，移出延迟收起 */}
          <div
            class="relative"
            ref={(el) => { spaceMenuRef = el }}
            onMouseEnter={() => spaceMenuFlyout.onTriggerEnter("sessions")}
            onMouseLeave={() => spaceMenuFlyout.onTriggerLeave()}
          >
            <ButtonV2
              variant="ghost"
              size="small"
              class="h-7 px-2.5 text-11-medium text-v2-text-text-muted hover:text-v2-text-text-strong gap-1.5"
              onClick={(e: MouseEvent) => {
                e.stopPropagation()
                if (showSpaceMenu()) {
                  spaceMenuFlyout.close()
                } else {
                  spaceMenuFlyout.onTriggerEnter("sessions")
                }
              }}
            >
              <SpaceIcon class="size-3.5" />
              <span class="text-11-medium leading-none">{t("workbench.topbar.selectSpace")}</span>
              <IconV2 name="outline-chevron-down" class="size-3.5" />
            </ButtonV2>

            <Show when={showSpaceMenu()}>
              <div
                class="absolute right-0 top-full mt-1 z-50 min-w-48 max-h-64 overflow-y-auto rounded-lg border border-v2-border-border-base bg-v2-background-bg-base p-1 shadow-[var(--v2-elevation-floating)]"
                onMouseEnter={() => spaceMenuFlyout.onFlyoutEnter()}
                onMouseLeave={() => spaceMenuFlyout.onFlyoutLeave()}
              >
                <div class="px-2 py-1 text-11-medium text-v2-text-text-muted">
                  {t("workbench.topbar.selectSpace")}
                </div>
                <For each={spaceStore.spaces()}>
                  {(sp) => {
                    const isOpen = () => wb.tabs.some((t) => t.path === sp.path)
                    const isActive = () => wb.activeTabPath === sp.path

                    return (
                      <button
                        type="button"
                        classList={{
                          "w-full flex items-center justify-between px-2.5 py-1.5 text-left text-11-medium rounded transition-colors": true,
                          "bg-v2-overlay-simple-overlay-hover text-v2-text-text-strong font-semibold": isActive(),
                          "text-v2-text-text-strong font-medium hover:bg-v2-overlay-simple-overlay-hover": isOpen() && !isActive(),
                          "text-v2-text-text-muted hover:text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover": !isOpen(),
                        }}
                        onClick={() => {
                          wb.openTab(sp)
                          spaceMenuFlyout.close()
                        }}
                      >
                        <div class="flex items-center gap-2 truncate">
                          <SpaceIcon
                            class={`size-3.5 shrink-0 ${isOpen() ? "text-v2-icon-icon-accent" : "text-v2-text-text-muted"}`}
                          />
                          <span class="truncate">{displaySpaceName(sp.name.replace(/[\s+*]+$/, "").trim())}</span>
                        </div>
                        <Show when={isActive()}>
                          <CheckIcon class="size-3.5 text-v2-icon-icon-accent shrink-0" />
                        </Show>
                      </button>
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>

          {/* 文件查看面板 toggle (最右侧，使用 FileViewerPanelIcon)。
              Mirrors the panel-header terminal icon convention: blue when the
              inspector holds tabs, grey and inert when it does not. Visible
              tabs stay intact across show/hide; the Shell owns the toggle.
              data-inspector-toggle: the inspector outside-click dismiss must
              treat presses here as the toggle's own click, not a dismissal. */}
          <IconButtonV2
            variant="ghost"
            size="small"
            class="text-v2-text-text-base hover:text-v2-text-text-strong"
            disabled={!surface.hasTabs()}
            style={{ color: surface.hasTabs() ? "var(--v2-icon-icon-accent)" : undefined }}
            state={surface.visible() ? "pressed" : undefined}
            data-inspector-toggle="true"
            icon={<FileViewerPanelIcon class="size-4" />}
            aria-label={t(wb.display().showFileViewer ? "workbench.topbar.fileViewer.hide" : "workbench.topbar.fileViewer.show")}
            title={t(wb.display().showFileViewer ? "workbench.topbar.fileViewer.hide" : "workbench.topbar.fileViewer.show")}
            onClick={() => surface.toggleVisibility()}
          />
        </div>
      </div>

      {/* Right Click Tab Context Menu */}
      <Show when={tabMenu()}>
        {(menu) => {
          const tab = menu().tab
          const isGeneral = tab.path === ""
          const isPinned = isGeneral || !!tab.pinned

          return (
            <div
              class="fixed z-50 min-w-36 rounded-md border border-v2-border-border-base bg-v2-background-bg-base shadow-lg py-1 select-none"
              style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
              onClick={(e) => e.stopPropagation()}
            >
              <Show when={!isGeneral}>
                <button
                  type="button"
                  class="flex items-center gap-2 w-full px-3 py-1.5 text-left text-11-medium text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover"
                  onClick={() => {
                    if (tab.pinned) wb.unpinTab(tab.path)
                    else wb.pinTab(tab.path)
                    setTabMenu(undefined)
                  }}
                >
                  <PinIcon class="size-3.5 text-v2-icon-icon-accent" />
                  <span>{tab.pinned ? "取消钉住 Tab" : "钉住 Tab"}</span>
                </button>
                <div class="my-1 border-t border-v2-border-border-base" />
                <button
                  type="button"
                  class="flex items-center gap-2 w-full px-3 py-1.5 text-left text-11-medium text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-40"
                  disabled={isPinned}
                  onClick={() => {
                    if (!isPinned) handleCloseTab(tab.name, tab.path)
                    setTabMenu(undefined)
                  }}
                >
                  <IconV2 name="xmark-small" class="size-3.5" />
                  <span>关闭 Tab</span>
                </button>
              </Show>
            </div>
          )
        }}
      </Show>
    </header>
  )
}
