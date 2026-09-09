import { For, Show, batch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import { useSessionProjectionWriter, useSessionStore } from "../session-store"
import { useWorkbenchState } from "../view-store"
import { mergeSessionTreeSessions } from "./session-tree-merge"
import type { WopalSpace } from "../space-store"
import { useWorkbenchActions } from "../workbench-actions"
import { scopeFromTab } from "../workbench-scope"
import { useDialog } from "@wopal/ui/context/dialog"
import { reportWorkbenchError } from "../workbench-error"
import { DialogDeleteSession, DialogRenameSession, DialogSessionDetails } from "./session-tree-dialogs"
import {
  createSessionGroupsLoader,
  fetchSessionTree,
  getPanelBadge,
  mergeTree,
  type GroupSession,
  type SessionTreeLocation,
  type WorkbenchSessionTree,
} from "./session-tree-services"
import { SessionTreeSpace } from "./session-tree-space"

type ContextMenu = { x: number; y: number; items: ContextMenuItem[] }
type ContextMenuItem = { label: string; action: () => void }
type MergedSession = { id: string; title: string; status: "idle" | "bound" | "archived" }

export function SessionTree(props: {
  spaces: WopalSpace[]
  activeSpacePath: string
  onSpaceClick: (space: WopalSpace) => void
  onSessionClick: (sessionId: string) => void
  onSessionDblClick?: (sessionId: string) => void
}) {
  const sdk = useServerSDK()
  const language = useLanguage()
  const t: typeof language.t = (key, params) => language.t(key, params)
  const sessions = useSessionStore()
  const projection = useSessionProjectionWriter()
  const wb = useWorkbenchState()
  const actions = useWorkbenchActions()
  const dialog = useDialog()
  const EXPAND_STORAGE_KEY = "workbench.tree.expanded"
  const PINNED_STORAGE_KEY = "workbench.tree.pinned"

  const readSet = (key: string) => {
    try {
      const value = localStorage.getItem(key)
      if (!value) return new Set<string>()
      const parsed = JSON.parse(value)
      return new Set<string>(Array.isArray(parsed) ? parsed : parsed.spaces ?? [])
    } catch (error) {
      reportWorkbenchError(`read ${key}`, error)
      return new Set<string>()
    }
  }

  const initialExpanded = readSet(EXPAND_STORAGE_KEY)
  initialExpanded.add(props.activeSpacePath)
  const [expandedSpaces, setExpandedSpaces] = createSignal(initialExpanded)
  const [pinnedSessions, setPinnedSessions] = createSignal(readSet(PINNED_STORAGE_KEY))
  const [selectedSessionID, setSelectedSessionID] = createSignal<string>()
  const [tree, setTree] = createSignal<WorkbenchSessionTree>({ scopes: [] })
  const [loading, setLoading] = createSignal(false)
  const [contextMenu, setContextMenu] = createSignal<ContextMenu>()
  const rowRefs = new Map<string, HTMLButtonElement>()
  // Tracks the refresh snapshot from the last successful load. A manual
  // refresh must invalidate the guard so the effect's `load()` call refetches.
  let lastRefreshKey = -1
  let lastRefreshVersion = -1

  const activeSessionID = createMemo(() => {
    const tab = wb.activeTab()
    const space = tab ? wb.spaceState(tab.path) : undefined
    const panel = space?.panels.find((candidate) => candidate.id === space.activePanelID)
    return panel?.slotState === "bound" ? panel.boundSessionId : undefined
  })

  const scopeForPath = (path: string) => tree().scopes.find((scope) => scope.path === path)
  const locationsForPath = (path: string): SessionTreeLocation[] => scopeForPath(path)?.locations ?? []
  const sessionsForPath = (path: string) => locationsForPath(path).flatMap((location) => location.sessions)

  const mergeSessions = (serverSessions: GroupSession[]): MergedSession[] =>
    mergeSessionTreeSessions(
      serverSessions.map((session) => ({ id: session.id, title: sessions.getSession(session.id)?.title ?? session.title })),
      (sessionID) => wb.findSessionBinding(sessionID) !== undefined,
      Object.values(sessions.sessions()).flat(),
    )

  const syncTree = () => {
    batch(() => {
      for (const scope of tree().scopes) {
        for (const session of scope.locations.flatMap((location) => location.sessions)) {
          projection.upsert({
            id: session.id,
            spaceName: scope.name,
            spacePath: scope.path,
            projectPath: session.directory,
            type: "chat",
            title: session.title,
            directoryHealth: session.directoryHealth,
            createdAt: session.timeCreated,
            lastActiveAt: session.timeUpdated,
          })
        }
      }
    })
  }

  const loadTree = createSessionGroupsLoader({
    fetch: () => fetchSessionTree(sdk),
    commit: (value) => {
      setTree(mergeTree(tree(), value))
      syncTree()
    },
    setLoading,
    hasData: () => tree().scopes.length > 0,
    onError: (error) => {
      // Keep the last successful tree visible while the connection is unavailable.
      reportWorkbenchError("load session tree", error)
    },
  })

  const load = async (force = false) => {
    const key = sessions.refreshKey()
    const refreshVersion = wb.refreshVersion
    if (
      !force &&
      tree().scopes.length > 0 &&
      key === lastRefreshKey &&
      refreshVersion === lastRefreshVersion
    ) return
    lastRefreshKey = key
    lastRefreshVersion = refreshVersion
    await loadTree()
  }

  createEffect(() => {
    sessions.refreshKey()
    wb.refreshVersion
    const timer = setTimeout(() => void load(), 250)
    onCleanup(() => clearTimeout(timer))
  })

  createEffect(() => {
    const active = activeSessionID()
    if (!active) return
    setSelectedSessionID(active)
    const session = sessions.getSession(active)
    const path = session?.spacePath ?? session?.spaceName
    if (!path) return
    setExpandedSpaces((previous) => previous.has(path) ? previous : new Set([...previous, path]))
  })


  createEffect(() => {
    try {
      localStorage.setItem(EXPAND_STORAGE_KEY, JSON.stringify({ spaces: [...expandedSpaces()] }))
      localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify([...pinnedSessions()]))
    } catch (error) {
      reportWorkbenchError("persist session tree", error)
    }
  })

  onMount(() => {
    const closeMenu = () => setContextMenu(undefined)
    document.addEventListener("click", closeMenu)
    onCleanup(() => {
      document.removeEventListener("click", closeMenu)
    })
  })

  const toggleSpace = (path: string) => setExpandedSpaces((previous) => {
    const next = new Set(previous)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })

  const handleSpaceClick = (space: WopalSpace) => {
    setSelectedSessionID(undefined)
    if (space.path === props.activeSpacePath) {
      toggleSpace(space.path)
      return
    }
    setExpandedSpaces((previous) => new Set([...previous, space.path]))
    props.onSpaceClick(space)
  }

  const showSessionMenu = (event: MouseEvent, session: MergedSession, spacePath: string, data: GroupSession, locationKind: SessionTreeLocation["kind"]) => {
    event.preventDefault()
    event.stopPropagation()
    const space = props.spaces.find((candidate) => candidate.path === spacePath)
    if (!space) return
    const pinned = pinnedSessions().has(session.id)
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          label: t("workbench.tree.details"),
          action: () => void dialog.show(() => (
            <DialogSessionDetails
              session={data}
              locationKind={locationKind}
            />
          )),
        },
        {
          label: t("workbench.tree.rename"),
          action: () => void dialog.show(() => (
            <DialogRenameSession
              currentTitle={session.title}
              onRename={async (title) => {
                await actions.renameSession({ scope: scopeFromTab(space), sessionID: session.id, directory: data.directory, title })
              }}
            />
          )),
        },
        {
          label: pinned ? t("workbench.tree.unpin") : t("workbench.tree.pin"),
          action: () => setPinnedSessions((previous) => {
            const next = new Set(previous)
            if (next.has(session.id)) next.delete(session.id)
            else next.add(session.id)
            return next
          }),
        },
        {
          label: t("common.delete"),
          action: () => void dialog.show(() => (
            <DialogDeleteSession
              sessionTitle={session.title}
              onDelete={async () => {
                await actions.deleteSession({ scope: scopeFromTab(space), sessionID: session.id, directory: data.directory })
              }}
            />
          )),
        },
      ],
    })
  }

  const showSpaceMenu = (event: MouseEvent, space: WopalSpace) => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [{
        label: t("workbench.tree.newSession"),
        action: async () => {
          try {
            wb.openTab(space)
            wb.ensureSpace(space.path)
            const target = wb.spaceState(space.path)?.panels.find((panel) => panel.slotState === "empty")
            if (target) await actions.createSession({ scope: scopeFromTab(space), panelID: target.id })
          } catch (error) {
            reportWorkbenchError("create session from tree", error)
          }
        },
      }],
    })
  }

  return (
    <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-1.5 workbench-tree-scroll transition-colors [will-change:scroll-position]">
      <For each={props.spaces}>
        {(space) => (
          <SessionTreeSpace
            space={space}
            isActive={space.path === props.activeSpacePath}
            loading={loading}
            locations={() => locationsForPath(space.path)}
            activeSessionId={activeSessionID}
            pinnedSessions={pinnedSessions}
            onSessionClick={props.onSessionClick}
            onSessionDblClick={props.onSessionDblClick}
            onSessionContextMenu={showSessionMenu}
            setSelectedSessionId={setSelectedSessionID}
            mergeSessions={mergeSessions}
            registerRowRef={(sessionID, element) => {
              if (element) rowRefs.set(sessionID, element)
              else rowRefs.delete(sessionID)
            }}
            t={t}
          />
        )}
      </For>

      <Show when={contextMenu()}>
        {(menu) => (
          <div
            class="fixed z-50 min-w-32 rounded-md border border-v2-border-border-base bg-v2-background-bg-base shadow-lg py-1"
            style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
            onClick={(event) => event.stopPropagation()}
          >
            <For each={menu().items}>
              {(item) => (
                <button
                  type="button"
                  class="block w-full px-3 py-1.5 text-left text-12-regular text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover"
                  onClick={() => {
                    item.action()
                    setContextMenu(undefined)
                  }}
                >
                  {item.label}
                </button>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  )
}
