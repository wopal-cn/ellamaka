import { Show, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { useWorkbenchState } from "../view-store"
import { useWorkbenchActions } from "../workbench-actions"
import { useDialog } from "@wopal/ui/context/dialog"
import { setInvisibleSessionDragPreview } from "./session-tree-drag-preview"
import { reportWorkbenchError } from "../workbench-error"
import { DialogOverwritePanel } from "./session-tree-dialogs"
import { openSessionInPanel, getSessionMarker, type GroupSession } from "./session-tree-services"
import { Icon as IconV2 } from "@wopal/ui/v2/components/icon.jsx"
import { Spinner } from "@wopal/ui/spinner"
import { useServerSync } from "@/context/server-sync"
import { useNotification } from "@/context/notification"
import { directoryKey } from "@/context/global-sync/utils"
import type { WopalSpace } from "../space-store"

type MergedSession = {
  id: string
  title: string
  status: "idle" | "bound" | "archived"
}

export function SessionMarkerIcon(props: {
  marker: "" | "directory" | "worktree"
  status: "idle" | "bound" | "archived"
  dirHealth: "healthy" | "missing" | "unavailable"
}) {
  const markerInfo = () => getSessionMarker(props.marker, props.status, props.dirHealth)

  return (
    <span class={`flex items-center justify-center shrink-0 w-5 h-4.5 select-none ${markerInfo().colorClass}`}>
      <Show
        when={markerInfo().type === "worktree"}
        fallback={
          <Show
            when={markerInfo().type === "directory"}
            fallback={
              <Show
                when={markerInfo().text !== undefined}
                fallback={
                  <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    <path d="M12 6.5l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8z" fill="currentColor" stroke="none" />
                  </svg>
                }
              >
                <span class="text-[11px] font-semibold font-mono leading-none">
                  {markerInfo().text}
                </span>
              </Show>
            }
          >
            <IconV2 name="code" class="size-3.5 shrink-0" />
          </Show>
        }
      >
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
      </Show>
    </span>
  )
}

export function SessionTreeRow(props: {
  session: MergedSession
  spaceId: string
  spaceName: string
  spacePath: string
  sessions: GroupSession[]
  activeSessionId: () => string | undefined
  pinnedSessions: () => Set<string>
  onSessionClick: (sessionId: string) => void
  onSessionDblClick?: (sessionId: string) => void
  onContextMenu: (e: MouseEvent) => void
  setSelectedSessionId: (id: string) => void
  registerRowRef?: (sessionId: string, el: HTMLButtonElement | null) => void
}) {
  const language = useLanguage()
  const t: typeof language.t = (key, params) => language.t(key, params)
  const wb = useWorkbenchState()
  const actions = useWorkbenchActions()
  const dialog = useDialog()
  const serverSync = useServerSync()
  const notification = useNotification()

  const sessionData = () => props.sessions.find((s) => s.id === props.session.id)
  const dirHealth = () =>
    props.spacePath === "" ? "healthy" : (sessionData()?.directoryHealth ?? "healthy")

  const sessionStatusType = createMemo(() => {
    const sessionID = props.session.id
    if (!sessionID) return "idle"

    const dir = sessionData()?.directory || props.spacePath
    if (dir) {
      const key = directoryKey(dir)
      const child = (key ? serverSync.children[key] : undefined) ?? serverSync.peek(dir)
      if (child && child[0].session_status[sessionID]?.type) {
        return child[0].session_status[sessionID].type
      }
    }

    for (const [_, [childStore]] of Object.entries(serverSync.children)) {
      if (childStore.session_status[sessionID]?.type) {
        return childStore.session_status[sessionID].type
      }
    }

    return "idle"
  })

  const isWorking = () => sessionStatusType() !== "idle"

  const handleSessionClick = () => {
    props.setSelectedSessionId(props.session.id)
    const binding = wb.findSessionBinding(props.session.id)
    if (binding) {
      const targetSpace = wb.tabs.find((tab) => tab.path === binding.spacePath)
      if (targetSpace) wb.openTab(targetSpace)
      wb.setActivePanel(binding.spacePath, binding.panelID)
    } else {
      wb.setStatusMessage(t("workbench.status.sessionReadyHint"))
      const targetSpace = wb.tabs.find((tab) => tab.path === props.spacePath)
      if (targetSpace) {
        wb.openTab(targetSpace)
        wb.ensureSpace(targetSpace.path)
      } else if (props.spacePath !== "") {
        // The session belongs to a space whose tab is not open yet. Create
        // the tab from the session's space identity so clicking a session
        // always navigates to its space, instead of silently doing nothing.
        wb.openTab({ id: props.spaceId, name: props.spaceName, path: props.spacePath, type: "space" })
        wb.ensureSpace(props.spacePath)
      }
    }
    props.onSessionClick(props.session.id)
  }

  const handleSessionDblClick = () => {
    props.onSessionDblClick?.(props.session.id)
    const binding = wb.findSessionBinding(props.session.id)
    if (binding) {
      handleSessionClick()
      return
    }

    void openSessionInPanel({
      session: { id: props.session.id, title: props.session.title },
      sessionDirectory: sessionData()?.directory ?? "",
      targetSpace: { id: props.spaceId, name: props.spaceName, path: props.spacePath } satisfies WopalSpace,
      wb,
      actions,
      t,
      showOverwriteDialog: (panelIndex, onConfirm) => {
        void dialog.show(() => (
          <DialogOverwritePanel
            panelIndex={panelIndex}
            onConfirm={() => {
              void onConfirm()
                .then(() => dialog.close())
                .catch((error) => reportWorkbenchError("replace session", error))
            }}
          />
        ))
      },
    })
  }

  return (
    <button
      ref={(el) => {
        props.registerRowRef?.(props.session.id, el)
      }}
      type="button"
      class="group flex w-full items-center gap-2 px-2 py-0.5 text-left text-11-regular transition-all"
      classList={{
        "bg-blue-50/80 dark:bg-blue-950/40 text-v2-text-text-strong border-l-[3px] border-v2-border-border-brand-strong rounded-l-none pl-1.25 font-semibold shadow-sm":
          props.session.id === props.activeSessionId(),
        "text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base rounded-md":
          props.session.id !== props.activeSessionId(),
      }}
      draggable={true}
      onDragStart={(e) => {
        const dataTransfer = e.dataTransfer
        if (!dataTransfer) return
        dataTransfer.setData("text/sessionId", props.session.id)
        dataTransfer.setData("text/spacePath", props.spacePath)
        dataTransfer.setData("text/spaceName", props.spaceName)
        dataTransfer.setData("text/projectPath", sessionData()?.directory ?? "")
        dataTransfer.setData("text/sessionTitle", props.session.title)
        setInvisibleSessionDragPreview(dataTransfer)
      }}
      onClick={handleSessionClick}
      onDblClick={handleSessionDblClick}
      onContextMenu={props.onContextMenu}
    >
      <SessionMarkerIcon
        marker={sessionData()?.marker ?? ""}
        status={props.session.status}
        dirHealth={dirHealth()}
      />
      <span class="flex-1 truncate">{props.session.title}</span>

      <Show when={isWorking()}>
        <Spinner class="size-3.5 shrink-0 ml-1 text-v2-icon-icon-accent" />
      </Show>

      <Show when={!isWorking() && notification.session.unseenCount(props.session.id) > 0}>
        <div class="size-2 rounded-full shrink-0 ml-1 bg-v2-icon-icon-accent" />
      </Show>

      <Show when={dirHealth() !== "healthy"}>
        <span class="text-9-regular text-v2-text-text-faint shrink-0">
          {dirHealth() === "missing" ? "缺失" : "不可用"}
        </span>
      </Show>
      <Show when={props.pinnedSessions().has(props.session.id)}>
        <svg
          class="size-3 shrink-0 text-v2-icon-icon-accent"
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
      </Show>
    </button>
  )
}
