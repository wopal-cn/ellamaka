import { For, Show, createMemo, createSignal } from "solid-js"
import { Icon as IconV2 } from "@wopal/ui/v2/components/icon.jsx"
import type { WopalSpace } from "../space-store"
import type { GroupSession, SessionTreeLocation } from "./session-tree-services"
import { SessionTreeRow } from "./session-tree-row"
import { useWorkbenchState } from "../view-store"
import { useLanguage } from "@/context/language"

type MergedSession = {
  id: string
  title: string
  status: "idle" | "bound" | "archived"
}

// 专属空间 (Space / Workspace) 图形 Icon
export function SpaceIcon(props: { class?: string }) {
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
      <path d="M12 2L2 7l10 5 10-5-10-5z" fill="currentColor" fill-opacity="0.15" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  )
}

export function ChatIcon(props: { class?: string }) {
  return (
    <svg class={props.class ?? "size-3.5"} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function FolderIcon(props: { class?: string }) {
  return (
    <svg class={props.class ?? "size-3.5"} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

// 日期专用日历图标 (Calendar Icon)
function CalendarIcon(props: { class?: string }) {
  return (
    <svg class={props.class ?? "size-3.5"} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  )
}


type DateGroup = {
  key: string
  title: string
  sessions: GroupSession[]
}

function groupSessionsByDate(locations: SessionTreeLocation[]): DateGroup[] {
  const allSessions = locations.flatMap((loc) => loc.sessions)
  if (allSessions.length === 0) return []

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86400000
  const weekStart = todayStart - 6 * 86400000

  const groups: Record<string, GroupSession[]> = {
    today: [],
    yesterday: [],
    week: [],
    earlier: [],
  }

  for (const session of allSessions) {
    const time = session.timeUpdated || session.timeCreated || 0
    if (time >= todayStart) {
      groups.today.push(session)
    } else if (time >= yesterdayStart) {
      groups.yesterday.push(session)
    } else if (time >= weekStart) {
      groups.week.push(session)
    } else {
      groups.earlier.push(session)
    }
  }

  const result: DateGroup[] = []
  for (const key of ["today", "yesterday", "week", "earlier"] as const) {
    if (groups[key].length > 0) {
      result.push({
        key,
        title: key,
        sessions: groups[key],
      })
    }
  }

  return result
}

function sortSessionsByPanelAndPin(
  merged: MergedSession[],
  pinnedSet: Set<string>,
  spacePath: string,
  wb: ReturnType<typeof useWorkbenchState>,
): MergedSession[] {
  const space = wb.spaceState(spacePath)
  const panelIndexMap = new Map<string, number>()
  if (space) {
    space.panels.forEach((panel, index) => {
      if (panel.slotState === "bound" && panel.boundSessionId) {
        panelIndexMap.set(panel.boundSessionId, index)
      }
    })
  }
  const getPanelIndex = (sessionID: string) => panelIndexMap.get(sessionID) ?? 999

  return [...merged].sort((a, b) => {
    const aPinned = pinnedSet.has(a.id)
    const bPinned = pinnedSet.has(b.id)

    // 1. Pinned 优先排在最上方
    if (aPinned && !bPinned) return -1
    if (!aPinned && bPinned) return 1
    if (aPinned && bPinned) return 0

    // 2. Bound (已打开挂载) 排在 Pinned 之下，按 Panel 序号 1 -> 2 -> 3 升序
    const aBound = a.status === "bound"
    const bBound = b.status === "bound"

    if (aBound && !bBound) return -1
    if (!aBound && bBound) return 1

    if (aBound && bBound) {
      return getPanelIndex(a.id) - getPanelIndex(b.id)
    }

    // 3. Idle 会话排在最后，保持原序
    return 0
  })
}

function DateLocationItem(props: {
  group: DateGroup
  space: WopalSpace
  activeSessionId: () => string | undefined
  pinnedSessions: () => Set<string>
  onSessionClick: (sessionId: string) => void
  onSessionDblClick?: (sessionId: string) => void
  onSessionContextMenu: (e: MouseEvent, session: MergedSession, spacePath: string, sessionData: GroupSession, locationKind: SessionTreeLocation["kind"]) => void
  setSelectedSessionId: (id: string) => void
  mergeSessions: (serverSessions: GroupSession[]) => MergedSession[]
  registerRowRef?: (sessionId: string, el: HTMLButtonElement | null) => void
}) {
  const wb = useWorkbenchState()
  const language = useLanguage()
  const [expanded, setExpanded] = createSignal(true)
  const groupTitle = () => language.t(`workbench.dateGroup.${props.group.key}` as any)
  const merged = createMemo(() =>
    sortSessionsByPanelAndPin(
      props.mergeSessions(props.group.sessions),
      props.pinnedSessions(),
      props.space.path,
      wb,
    ),
  )

  return (
    <div class="mb-1.5">
      <button
        type="button"
        class="flex w-full items-center justify-between px-2 py-1 text-10-medium text-v2-text-text-muted hover:text-v2-text-text-strong uppercase tracking-wider select-none font-semibold cursor-pointer rounded hover:bg-v2-overlay-simple-overlay-hover transition-colors"
        onClick={() => setExpanded(!expanded())}
      >
        <div class="flex items-center gap-1.5 truncate">
          <CalendarIcon class="size-3.5 text-v2-text-text-muted shrink-0" />
          <span class="truncate">{groupTitle()}</span>
          <span class="text-9-regular text-v2-text-text-faint font-normal">({merged().length})</span>
        </div>
        <svg
          class={`size-2.5 text-v2-text-text-muted transition-transform duration-200 shrink-0 ${expanded() ? "" : "-rotate-90"}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      <Show when={expanded()}>
        <div class="mt-0.5">
          <For each={merged()}>
            {(session) => (
              <SessionTreeRow
                session={session}
                spaceId={props.space.id}
                spaceName={props.space.name}
                spacePath={props.space.path}
                sessions={props.group.sessions}
                activeSessionId={props.activeSessionId}
                pinnedSessions={props.pinnedSessions}
                onSessionClick={props.onSessionClick}
                onSessionDblClick={props.onSessionDblClick}
                onContextMenu={(event) => {
                  const sessionData = props.group.sessions.find((candidate) => candidate.id === session.id)
                  if (sessionData) props.onSessionContextMenu(event, session, props.space.path, sessionData, "general-date")
                }}
                setSelectedSessionId={props.setSelectedSessionId}
                registerRowRef={props.registerRowRef}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

const [collapsedLocations, setCollapsedLocations] = createSignal<Set<string>>(new Set())
const [collapsedGroupHeaders, setCollapsedGroupHeaders] = createSignal<Set<string>>(new Set())
const isGroupExpanded = (key: string) => !collapsedGroupHeaders().has(key)
const toggleGroup = (key: string) => {
  setCollapsedGroupHeaders((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
}

function ProjectLocationItem(props: {
  location: SessionTreeLocation
  space: WopalSpace
  activeSessionId: () => string | undefined
  pinnedSessions: () => Set<string>
  onSessionClick: (sessionId: string) => void
  onSessionDblClick?: (sessionId: string) => void
  onSessionContextMenu: (e: MouseEvent, session: MergedSession, spacePath: string, sessionData: GroupSession, locationKind: SessionTreeLocation["kind"]) => void
  setSelectedSessionId: (id: string) => void
  mergeSessions: (serverSessions: GroupSession[]) => MergedSession[]
  registerRowRef?: (sessionId: string, el: HTMLButtonElement | null) => void
}) {
  const wb = useWorkbenchState()
  const locationKey = () => `${props.space.path}:${props.location.key}`
  const expanded = () => !collapsedLocations().has(locationKey())
  const toggleExpanded = () => {
    const key = locationKey()
    setCollapsedLocations((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const merged = createMemo(() =>
    sortSessionsByPanelAndPin(
      props.mergeSessions(props.location.sessions),
      props.pinnedSessions(),
      props.space.path,
      wb,
    ),
  )
  const projectLabel = () => props.location.label || props.location.relativePath || "项目"

  return (
    <div class="mb-1.5">
      <Show when={projectLabel() && projectLabel() !== props.space.name}>
        <button
          type="button"
          class="flex w-full items-center justify-between px-2 py-0.5 text-10-medium text-v2-text-text-muted hover:text-v2-text-text-base select-none cursor-pointer rounded hover:bg-v2-overlay-simple-overlay-hover transition-colors font-mono"
          onClick={toggleExpanded}
        >
          <div class="flex items-center gap-1.5 truncate">
            <IconV2 name="code" class="size-3.5 text-v2-text-text-muted shrink-0" />
            <span class="truncate">{projectLabel()}</span>
            <span class="text-9-regular text-v2-text-text-faint">({merged().length})</span>
          </div>
          <svg
            class={`size-2.5 text-v2-text-text-muted transition-transform duration-200 shrink-0 ${expanded() ? "" : "-rotate-90"}`}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      </Show>

      <Show when={expanded()}>
        <div class="mt-0.5">
          <For each={merged()}>
            {(session) => (
              <SessionTreeRow
                session={session}
                spaceId={props.space.id}
                spaceName={props.space.name}
                spacePath={props.space.path}
                sessions={props.location.sessions}
                activeSessionId={props.activeSessionId}
                pinnedSessions={props.pinnedSessions}
                onSessionClick={props.onSessionClick}
                onSessionDblClick={props.onSessionDblClick}
                onContextMenu={(event) => {
                  const sessionData = props.location.sessions.find((candidate) => candidate.id === session.id)
                  if (sessionData) props.onSessionContextMenu(event, session, props.space.path, sessionData, props.location.kind)
                }}
                setSelectedSessionId={props.setSelectedSessionId}
                registerRowRef={props.registerRowRef}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

export function SessionTreeSpace(props: {
  space: WopalSpace
  isActive: boolean
  loading: () => boolean
  locations: () => SessionTreeLocation[]
  activeSessionId: () => string | undefined
  pinnedSessions: () => Set<string>
  onSessionClick: (sessionId: string) => void
  onSessionDblClick?: (sessionId: string) => void
  onSessionContextMenu: (e: MouseEvent, session: MergedSession, spacePath: string, sessionData: GroupSession, locationKind: SessionTreeLocation["kind"]) => void
  setSelectedSessionId: (id: string) => void
  mergeSessions: (serverSessions: GroupSession[]) => MergedSession[]
  registerRowRef?: (sessionId: string, el: HTMLButtonElement | null) => void
  t: (key: string, params?: Record<string, string | number | boolean>) => string
}) {
  const wb = useWorkbenchState()
  const spaceGroupKey = () => `space:${props.space.path}`
  const projectsGroupKey = () => `projects:${props.space.path}`

  const spaceExpanded = () => isGroupExpanded(spaceGroupKey())
  const projectExpanded = () => isGroupExpanded(projectsGroupKey())

  const isGeneralScope = () => props.space.path === ""

  const dateGroups = createMemo(() => {
    if (!isGeneralScope()) return []
    return groupSessionsByDate(props.locations())
  })

  const spaceLocations = createMemo(() =>
    props.locations().filter((loc) => loc.kind === "space-root"),
  )

  const projectLocations = createMemo(() =>
    props.locations().filter((loc) => loc.kind !== "space-root"),
  )

  const hasSessions = createMemo(() =>
    props.locations().some((loc) => loc.sessions.length > 0),
  )

  return (
    <div class="flex flex-col gap-2 py-1">
      <Show
        when={!props.loading()}
        fallback={<div class="px-3 py-4 text-12-regular text-v2-text-text-muted">{props.t("common.loading")}</div>}
      >
        <Show
          when={hasSessions()}
          fallback={
            <div class="px-3 py-6 text-12-regular text-v2-text-text-faint text-center">
              {props.t("workbench.tree.noSessions")}
            </div>
          }
        >
          {/* A. 日常对话模式 (General Scope) — 纯按日期分组展示 */}
          <Show when={isGeneralScope()}>
            <div class="flex flex-col gap-1">
              <For each={dateGroups()}>
                {(group) => (
                  <DateLocationItem
                    group={group}
                    space={props.space}
                    activeSessionId={props.activeSessionId}
                    pinnedSessions={props.pinnedSessions}
                    onSessionClick={props.onSessionClick}
                    onSessionDblClick={props.onSessionDblClick}
                    onSessionContextMenu={props.onSessionContextMenu}
                    setSelectedSessionId={props.setSelectedSessionId}
                    mergeSessions={props.mergeSessions}
                    registerRowRef={props.registerRowRef}
                  />
                )}
              </For>
            </div>
          </Show>

          {/* B. 空间模式 (Space Tabs) — 区分 空间会话 与 项目会话 */}
          <Show when={!isGeneralScope()}>
            {/* 1. 空间会话 (Space Sessions) */}
            <Show when={spaceLocations().some((loc) => loc.sessions.length > 0)}>
              <div>
                <button
                  type="button"
                  class="flex w-full items-center justify-between px-2 py-1 text-10-medium text-v2-text-text-muted hover:text-v2-text-text-strong uppercase tracking-wider select-none font-semibold cursor-pointer rounded hover:bg-v2-overlay-simple-overlay-hover transition-colors"
                  onClick={() => toggleGroup(spaceGroupKey())}
                >
                  <div class="flex items-center gap-1.5">
                    <SpaceIcon class="size-3.5 text-v2-text-text-muted" />
                    <span>{props.t("workbench.tree.group.spaceSessions")}</span>
                  </div>
                  <svg
                    class={`size-3 text-v2-text-text-muted transition-transform duration-200 ${spaceExpanded() ? "" : "-rotate-90"}`}
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M4 6l4 4 4-4" />
                  </svg>
                </button>

                <Show when={spaceExpanded()}>
                  <div class="mt-0.5">
                    <For each={spaceLocations()}>
                      {(location) => {
                        const merged = createMemo(() =>
                          sortSessionsByPanelAndPin(
                            props.mergeSessions(location.sessions),
                            props.pinnedSessions(),
                            props.space.path,
                            wb,
                          ),
                        )
                        return (
                          <For each={merged()}>
                            {(session) => (
                              <SessionTreeRow
                                session={session}
                                spaceId={props.space.id}
                                spaceName={props.space.name}
                                spacePath={props.space.path}
                                sessions={location.sessions}
                                activeSessionId={props.activeSessionId}
                                pinnedSessions={props.pinnedSessions}
                                onSessionClick={props.onSessionClick}
                                onSessionDblClick={props.onSessionDblClick}
                                onContextMenu={(event) => {
                                  const sessionData = location.sessions.find((candidate) => candidate.id === session.id)
                                  if (sessionData) props.onSessionContextMenu(event, session, props.space.path, sessionData, location.kind)
                                }}
                                setSelectedSessionId={props.setSelectedSessionId}
                                registerRowRef={props.registerRowRef}
                              />
                            )}
                          </For>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>

            {/* 2. 项目会话 (Project Sessions) */}
            <Show when={projectLocations().some((loc) => loc.sessions.length > 0)}>
              <div>
                <button
                  type="button"
                  class="flex w-full items-center justify-between px-2 py-1 text-10-medium text-v2-text-text-muted hover:text-v2-text-text-strong uppercase tracking-wider select-none font-semibold cursor-pointer rounded hover:bg-v2-overlay-simple-overlay-hover transition-colors"
                  onClick={() => toggleGroup(projectsGroupKey())}
                >
                  <div class="flex items-center gap-1.5">
                    <FolderIcon class="size-3.5 text-v2-text-text-muted" />
                    <span>{props.t("workbench.tree.group.projectSessions")}</span>
                  </div>
                  <svg
                    class={`size-3 text-v2-text-text-muted transition-transform duration-200 ${projectExpanded() ? "" : "-rotate-90"}`}
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M4 6l4 4 4-4" />
                  </svg>
                </button>

                <Show when={projectExpanded()}>
                  <div class="mt-0.5">
                    <For each={projectLocations()}>
                      {(location) => (
                        <ProjectLocationItem
                          location={location}
                          space={props.space}
                          activeSessionId={props.activeSessionId}
                          pinnedSessions={props.pinnedSessions}
                          onSessionClick={props.onSessionClick}
                          onSessionDblClick={props.onSessionDblClick}
                          onSessionContextMenu={props.onSessionContextMenu}
                          setSelectedSessionId={props.setSelectedSessionId}
                          mergeSessions={props.mergeSessions}
                          registerRowRef={props.registerRowRef}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  )
}
