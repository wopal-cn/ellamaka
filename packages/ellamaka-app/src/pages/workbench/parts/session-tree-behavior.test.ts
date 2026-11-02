import { describe, expect, test } from "bun:test"
import {
  fetchSessionGroups,
  fetchSessionTree,
  createSessionGroupsLoader,
  resolveTargetPanel,
  openSessionInPanel,
  getPanelBadge,
  mergeTree,
  getSessionMarker,
  type SessionGroupsSDK,
  type SessionTreeSDK,
  type SessionGroup,
  type SessionTreeScope,
  type WorkbenchSessionTree,
  type OpenSessionWB,
} from "./session-tree-services"
import { mergeSessionTreeSessions } from "./session-tree-merge"
import type { Session } from "../session-store"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function panel(
  overrides: Partial<{
    id: string
    slotState: "empty" | "bound"
    boundSessionId: string
    viewMode: string
    mode: "" | "tui" | "chat"
    directory: string
    width: number
  }> = {},
) {
  return {
    id: "p-1",
    slotState: "empty" as const,
    boundSessionId: undefined,
    viewMode: undefined,
    mode: "" as const,
    directory: "/",
    width: 1,
    ...overrides,
  }
}

function wbWithPanels(spacePath: string, panels: ReturnType<typeof panel>[], activeTabPath?: string): OpenSessionWB {
  const spaces: Record<string, { panels: typeof panels; activePanelID: string }> = {
    [spacePath]: { panels, activePanelID: panels[0]?.id ?? "" },
  }
  return {
    spaces,
    openTab: () => {},
    ensureSpace: () => {},
    setStatusMessage: () => {},
    activeTab: () => (activeTabPath !== undefined ? { id: "test", name: "test", path: activeTabPath } : undefined),
    findSessionBinding: (sessionID) => {
      for (const [path, space] of Object.entries(spaces)) {
        const panel = space.panels.find(
          (candidate) => candidate.slotState === "bound" && candidate.boundSessionId === sessionID,
        )
        if (panel) return { spacePath: path, panelID: panel.id }
      }
      return undefined
    },
  }
}

// ── fetchSessionGroups ──────────────────────────────────────────────────────

describe("fetchSessionGroups", () => {
  type TreeScope = Parameters<NonNullable<SessionTreeSDK["bff"]["workbench"]["sessionTree"]>>[0] extends never
    ? never
    : NonNullable<Awaited<ReturnType<SessionTreeSDK["bff"]["workbench"]["sessionTree"]>>["data"]>["scopes"]
  const treeOf = (scopes: NonNullable<TreeScope>): SessionGroupsSDK => ({
    bff: {
      workbench: {
        locations: async ({ spacePath }) => ({ data: { scopePath: spacePath } }),
        sessionTree: async () => ({ data: { scopes } }),
      },
    },
  })

  test("projects the canonical session tree into Space/General groups", async () => {
    const sdk = treeOf([
      {
        path: "",
        name: "General",
        kind: "general",
        sessionCount: 1,
        truncated: false,
        locations: [
          {
            key: "general-date:2026-07-16",
            kind: "general-date",
            name: "2026-07-16",
            path: "",
            sessionCount: 1,
            sessions: [
              {
                id: "s1",
                title: "Session 1",
                directory: "/a",
                directoryHealth: "healthy",
                marker: "",
                timeCreated: 1000,
                timeUpdated: 2000,
              },
            ],
          },
        ],
      },
      {
        path: "/space-a",
        name: "Space A",
        kind: "space",
        sessionCount: 2,
        truncated: false,
        locations: [
          {
            key: "space:/space-a:root",
            kind: "space-root",
            name: "Root",
            path: "/space-a",
            sessionCount: 1,
            sessions: [
              {
                id: "s2",
                title: "Session 2",
                directory: "/space-a",
                directoryHealth: "missing",
                marker: "",
                timeCreated: 3,
                timeUpdated: 4,
              },
            ],
          },
        ],
      },
    ])

    const result = await fetchSessionGroups(sdk)

    expect(result.map((group) => [group.id, group.type, group.sessionCount])).toEqual([
      ["", "general", 1],
      ["/space-a", "space", 2],
    ])
    // Sessions from every location of a scope stay in that scope.
    expect(result[1]?.sessions.map((session) => session.id)).toEqual(["s2"])
    expect(result[1]?.sessions[0]).toMatchObject({ directory: "/space-a", directoryHealth: "missing" })
  })

  test("an empty tree returns no groups", async () => {
    expect(await fetchSessionGroups(treeOf([]))).toEqual([])
  })

  test("missing tree data returns no groups", async () => {
    const sdk: SessionGroupsSDK = {
      bff: {
        workbench: {
          locations: async () => ({ data: undefined }),
          sessionTree: async () => ({ data: undefined }),
        },
      },
    }
    expect(await fetchSessionGroups(sdk)).toEqual([])
  })

  test("a failing tree propagates the error", async () => {
    const sdk: SessionGroupsSDK = {
      bff: {
        workbench: {
          locations: async ({ spacePath }) => ({ data: { scopePath: spacePath } }),
          sessionTree: async () => {
            throw new Error("Network failure")
          },
        },
      },
    }
    await expect(fetchSessionGroups(sdk)).rejects.toThrow("Network failure")
  })

  test("a non-numeric scope count normalizes to 0 and missing locations normalize to none", async () => {
    const sdk = treeOf([{ path: "/p", name: "P", kind: "space", sessionCount: "not-a-number", truncated: false }])
    const result = await fetchSessionGroups(sdk)
    expect(result[0]?.sessionCount).toBe(0)
    expect(result[0]?.sessions).toEqual([])
  })
})

describe("fetchSessionTree", () => {
  test("preserves General and same-name Spaces by their path identity and locations", async () => {
    const tree = await fetchSessionTree({
      bff: {
        workbench: {
          locations: async ({ spacePath }) => ({ data: { scopePath: spacePath } }),
          sessionTree: async () => ({
            data: {
              scopes: [
                {
                  key: "general",
                  kind: "general" as const,
                  name: "General",
                  path: "",
                  sessionCount: 1,
                  truncated: false,
                  locations: [
                    {
                      key: "general-date:2026-07-16",
                      kind: "general-date" as const,
                      name: "2026-07-16",
                      path: "",
                      sessionCount: 1,
                      sessions: [
                        {
                          id: "general-session",
                          title: "General",
                          directory: "/home/.wopal/general_tasks/2026-07-16",
                          directoryHealth: "healthy" as const,
                          marker: "",
                          timeCreated: 1,
                          timeUpdated: 2,
                        },
                      ],
                    },
                  ],
                },
                {
                  key: "space:/fixtures/two",
                  kind: "space" as const,
                  name: "Shared",
                  path: "/fixtures/two",
                  sessionCount: 1,
                  truncated: false,
                  locations: [
                    {
                      key: "space:/fixtures/two:root",
                      kind: "space-root" as const,
                      name: "Root",
                      path: "/fixtures/two",
                      sessionCount: 1,
                      sessions: [
                        {
                          id: "space-session",
                          title: "Space",
                          directory: "/fixtures/two",
                          directoryHealth: "healthy" as const,
                          marker: "",
                          timeCreated: 3,
                          timeUpdated: 4,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          }),
        },
      },
    })

    expect(tree.scopes.map((scope) => scope.path)).toEqual(["", "/fixtures/two"])
    expect(tree.scopes[1]?.locations[0]).toMatchObject({ kind: "space-root", label: "Root" })
  })

  test("preserves marker, relativePath, and branch fields for project and worktree sessions", async () => {
    const tree = await fetchSessionTree({
      bff: {
        workbench: {
          locations: async ({ spacePath }) => ({ data: { scopePath: spacePath } }),
          sessionTree: async () => ({
            data: {
              scopes: [
                {
                  key: "space:/proj",
                  kind: "space" as const,
                  name: "P",
                  path: "/proj",
                  sessionCount: 3,
                  truncated: false,
                  locations: [
                    {
                      key: "project:/proj/repo",
                      kind: "project" as const,
                      name: "repo",
                      path: "/proj/repo",
                      sessionCount: 3,
                      sessions: [
                        {
                          id: "root",
                          title: "R",
                          directory: "/proj/repo",
                          directoryHealth: "healthy" as const,
                          marker: "",
                          timeCreated: 1,
                          timeUpdated: 1,
                        },
                        {
                          id: "wt",
                          title: "W",
                          directory: "/outside/wt",
                          directoryHealth: "healthy" as const,
                          marker: "worktree",
                          relativePath: undefined,
                          branch: "feature/x",
                          timeCreated: 2,
                          timeUpdated: 2,
                        },
                        {
                          id: "sub",
                          title: "S",
                          directory: "/proj/repo/pkg",
                          directoryHealth: "healthy" as const,
                          marker: "directory",
                          relativePath: "pkg",
                          timeCreated: 3,
                          timeUpdated: 3,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          }),
        },
      },
    })

    const sessions = tree.scopes[0].locations[0].sessions
    expect(sessions.map((s) => [s.id, s.marker, s.relativePath, s.branch])).toEqual([
      ["root", "", undefined, undefined],
      ["wt", "worktree", undefined, "feature/x"],
      ["sub", "directory", "pkg", undefined],
    ])
  })
})

describe("createSessionGroupsLoader", () => {
  test("keeps the newest response when overlapping requests resolve out of order", async () => {
    const first = deferred<SessionGroup[]>()
    const second = deferred<SessionGroup[]>()
    const commits: string[] = []
    let request = 0

    const loader = createSessionGroupsLoader({
      fetch: () => {
        request += 1
        if (request === 1) return first.promise
        return second.promise
      },
      commit: (groups) => commits.push(groups[0]?.title ?? "empty"),
      setLoading: () => {},
      onError: () => {},
    })

    const initial = loader()
    const refresh = loader()
    second.resolve([{ id: "second", title: "Latest", type: "general", sessionCount: 0, sessions: [] }])
    await refresh
    first.resolve([{ id: "first", title: "Stale", type: "general", sessionCount: 0, sessions: [] }])
    await initial

    expect(commits).toEqual(["Latest"])
  })

  test("skips setLoading(true) when hasData reports existing data (silent refresh)", async () => {
    const loadingEvents: boolean[] = []
    const first = deferred<SessionGroup[]>()
    const second = deferred<SessionGroup[]>()
    let request = 0
    let hasData = false

    const loader = createSessionGroupsLoader({
      fetch: () => {
        request += 1
        return request === 1 ? first.promise : second.promise
      },
      commit: () => {
        hasData = true
      },
      setLoading: (v) => {
        loadingEvents.push(v)
      },
      onError: () => {},
      hasData: () => hasData,
    })

    const initial = loader()
    first.resolve([])
    await initial
    loadingEvents.length = 0

    const refresh = loader()
    second.resolve([])
    await refresh

    // Silent refresh: no loading toggle at all when data already exists
    expect(loadingEvents).toEqual([])
  })

  test("sets loading on first load when no data exists yet", async () => {
    const loadingEvents: boolean[] = []
    const first = deferred<SessionGroup[]>()

    const loader = createSessionGroupsLoader({
      fetch: () => first.promise,
      commit: () => {},
      setLoading: (v) => {
        loadingEvents.push(v)
      },
      onError: () => {},
      hasData: () => false,
    })

    const task = loader()
    first.resolve([])
    await task

    expect(loadingEvents).toEqual([true, false])
  })
})

function makeScope(overrides: Partial<SessionTreeScope> = {}): SessionTreeScope {
  return {
    path: "/space",
    name: "Space",
    kind: "space",
    sessionCount: 1,
    truncated: false,
    locations: [
      {
        key: "space:/space:root",
        label: "Root",
        kind: "space-root",
        sessions: [
          {
            id: "s1",
            title: "Session 1",
            directory: "/space",
            directoryHealth: "healthy",
            timeCreated: 1,
            timeUpdated: 2,
          },
        ],
      },
    ],
    ...overrides,
  }
}

describe("mergeTree", () => {
  test("returns next unchanged when prev is empty (initial load)", () => {
    const next: WorkbenchSessionTree = { scopes: [makeScope()] }
    const merged = mergeTree({ scopes: [] }, next)
    expect(merged).toBe(next)
  })

  test("returns prev unchanged when scope/loc/session fields all match", () => {
    const prev: WorkbenchSessionTree = { scopes: [makeScope()] }
    // Reconstruct a structurally equal but reference-distinct tree
    const next: WorkbenchSessionTree = {
      scopes: [
        {
          path: "/space",
          name: "Space",
          kind: "space",
          sessionCount: 1,
          truncated: false,
          locations: [
            {
              key: "space:/space:root",
              label: "Root",
              kind: "space-root",
              sessions: [
                {
                  id: "s1",
                  title: "Session 1",
                  directory: "/space",
                  directoryHealth: "healthy",
                  timeCreated: 1,
                  timeUpdated: 2,
                },
              ],
            },
          ],
        },
      ],
    }
    const merged = mergeTree(prev, next)
    // Identity preserved at every level
    expect(merged).toBe(prev)
    expect(merged.scopes[0]).toBe(prev.scopes[0])
    expect(merged.scopes[0].locations[0]).toBe(prev.scopes[0].locations[0])
    expect(merged.scopes[0].locations[0].sessions[0]).toBe(prev.scopes[0].locations[0].sessions[0])
  })

  test("reuses unchanged session refs and only swaps the one whose title changed", () => {
    const prev: WorkbenchSessionTree = { scopes: [makeScope()] }
    const next: WorkbenchSessionTree = {
      scopes: [
        {
          path: "/space",
          name: "Space",
          kind: "space",
          sessionCount: 2,
          truncated: false,
          locations: [
            {
              key: "space:/space:root",
              label: "Root",
              kind: "space-root",
              sessions: [
                {
                  id: "s1",
                  title: "Session 1 RENAMED",
                  directory: "/space",
                  directoryHealth: "healthy",
                  timeCreated: 1,
                  timeUpdated: 3,
                },
                {
                  id: "s2",
                  title: "Session 2",
                  directory: "/space",
                  directoryHealth: "healthy",
                  timeCreated: 4,
                  timeUpdated: 5,
                },
              ],
            },
          ],
        },
      ],
    }
    const merged = mergeTree(prev, next)
    expect(merged).not.toBe(prev) // sessionCount changed → new scope
    expect(merged.scopes[0]).not.toBe(prev.scopes[0])
    expect(merged.scopes[0].locations[0]).not.toBe(prev.scopes[0].locations[0])
    // s1 changed title → new ref
    const mergedS1 = merged.scopes[0].locations[0].sessions.find((s) => s.id === "s1")
    const prevS1 = prev.scopes[0].locations[0].sessions.find((s) => s.id === "s1")
    expect(mergedS1).not.toBe(prevS1)
    expect(mergedS1?.title).toBe("Session 1 RENAMED")
    // s2 is new, never in prev
    expect(merged.scopes[0].locations[0].sessions.find((s) => s.id === "s2")?.title).toBe("Session 2")
  })

  test("returns next when scope count differs (structural change)", () => {
    const prev: WorkbenchSessionTree = { scopes: [makeScope()] }
    const next: WorkbenchSessionTree = { scopes: [makeScope(), makeScope({ path: "/other" })] }
    expect(mergeTree(prev, next)).toBe(next)
  })
})

describe("mergeSessionTreeSessions", () => {
  test("uses the current session projection title before a group refetch completes", () => {
    const local: Session = {
      id: "session-1",
      spaceName: "Space A",
      projectPath: "/space-a",
      type: "chat",
      title: "After",
      directoryHealth: "healthy",
      createdAt: 1,
      lastActiveAt: 1,
    }

    const merged = mergeSessionTreeSessions([{ id: "session-1", title: "Before" }], () => false, [local])

    expect(merged).toEqual([{ id: "session-1", title: "After", status: "idle" }])
  })
})

// ── resolveTargetPanel ──────────────────────────────────────────────────────

describe("resolveTargetPanel", () => {
  test("empty panel exists → returns empty panel for direct load", () => {
    const panels = [
      panel({ id: "p1", slotState: "bound", boundSessionId: "s1" }),
      panel({ id: "p2", slotState: "empty" }),
    ]
    const result = resolveTargetPanel(panels, "p1", 3)
    expect(result).toEqual({ kind: "empty", panel: panels[1] })
  })

  test("no empty panel, < maxPanels → returns new", () => {
    const panels = [
      panel({ id: "p1", slotState: "bound", boundSessionId: "s1" }),
      panel({ id: "p2", slotState: "bound", boundSessionId: "s2" }),
    ]
    const result = resolveTargetPanel(panels, "p1", 3)
    expect(result).toEqual({ kind: "new" })
  })

  test("no empty panel, = maxPanels → returns overwrite with active panel", () => {
    const panels = [
      panel({ id: "p1", slotState: "bound", boundSessionId: "s1" }),
      panel({ id: "p2", slotState: "bound", boundSessionId: "s2" }),
      panel({ id: "p3", slotState: "bound", boundSessionId: "s3" }),
    ]
    const result = resolveTargetPanel(panels, "p2", 3)
    expect(result).toEqual({ kind: "overwrite", panel: panels[1], index: 2 })
  })

  test("no empty panel, = maxPanels, active panel not found → overwrite first panel", () => {
    const panels = [
      panel({ id: "p1", slotState: "bound", boundSessionId: "s1" }),
      panel({ id: "p2", slotState: "bound", boundSessionId: "s2" }),
    ]
    const result = resolveTargetPanel(panels, "nonexistent", 2)
    expect(result).toEqual({ kind: "overwrite", panel: panels[0], index: 1 })
  })

  test("single empty panel in 3-panel space → returns empty", () => {
    const panels = [
      panel({ id: "p1", slotState: "bound", boundSessionId: "s1" }),
      panel({ id: "p2", slotState: "bound", boundSessionId: "s2" }),
      panel({ id: "p3", slotState: "empty" }),
    ]
    const result = resolveTargetPanel(panels, "p1", 3)
    expect(result).toEqual({ kind: "empty", panel: panels[2] })
  })
})

// ── getPanelBadge ───────────────────────────────────────────────────────────

describe("getPanelBadge", () => {
  test("returns badge for bound session in active space", () => {
    const wb = wbWithPanels(
      "/space",
      [
        panel({ id: "p1", slotState: "bound", boundSessionId: "s1" }),
        panel({ id: "p2", slotState: "bound", boundSessionId: "s2" }),
      ],
      "/space",
    )
    expect(getPanelBadge(wb, "s2")).toBe("P2")
  })

  test("returns badge from non-active space as fallback", () => {
    const wb = wbWithPanels(
      "/other",
      [
        panel({ id: "p1", slotState: "bound", boundSessionId: "s1" }),
        panel({ id: "p2", slotState: "bound", boundSessionId: "s2" }),
      ],
      "/active",
    )
    // Also register /active space so the fallback scan can find the session
    wb.spaces["/active"] = {
      panels: [panel({ id: "pa", slotState: "empty" })],
      activePanelID: "pa",
    }
    expect(getPanelBadge(wb, "s1")).toBe("P1")
  })

  test("returns undefined for unbound session", () => {
    const wb = wbWithPanels("/space", [panel({ id: "p1", slotState: "empty" })], "/space")
    expect(getPanelBadge(wb, "unknown")).toBeUndefined()
  })

  test("returns undefined when no panels are bound", () => {
    const wb = wbWithPanels(
      "/space",
      [panel({ id: "p1", slotState: "empty" }), panel({ id: "p2", slotState: "empty" })],
      "/space",
    )
    expect(getPanelBadge(wb, "s1")).toBeUndefined()
  })

  test("skips active space in fallback scan to avoid double-counting", () => {
    const wb = wbWithPanels("/active", [panel({ id: "p1", slotState: "bound", boundSessionId: "s1" })], "/active")
    // Session is in active space — should find it via activePath
    expect(getPanelBadge(wb, "s1")).toBe("P1")
  })
})

// ── getSessionMarker ──────────────────────────────────────────────────────────

describe("getSessionMarker", () => {
  test("renders dot for normal session", () => {
    const result = getSessionMarker("", "idle", "healthy")
    expect(result).toEqual({ type: "dot", colorClass: "text-v2-icon-icon-muted", text: undefined })
  })

  test("renders folder icon for directory session", () => {
    const result = getSessionMarker("directory", "idle", "healthy")
    expect(result).toEqual({ type: "directory", colorClass: "text-v2-icon-icon-muted" })
  })

  test("renders branch icon for worktree session", () => {
    const result = getSessionMarker("worktree", "idle", "healthy")
    expect(result).toEqual({ type: "worktree", colorClass: "text-v2-icon-icon-muted" })
  })

  test("applies color based on status and health", () => {
    // 1. bound status
    expect(getSessionMarker("", "bound", "healthy")).toEqual({
      type: "dot",
      colorClass: "text-v2-icon-icon-accent",
      text: undefined,
    })

    // 2. idle status (muted color)
    expect(getSessionMarker("", "idle", "healthy")).toEqual({
      type: "dot",
      colorClass: "text-v2-icon-icon-muted",
      text: undefined,
    })

    // 3. unhealthy (amber color + !)
    expect(getSessionMarker("", "idle", "missing")).toEqual({
      type: "dot",
      colorClass: "text-amber-500",
      text: "!",
    })
  })
})

// ── openSessionInPanel ──────────────────────────────────────────────────────

describe("openSessionInPanel", () => {
  test("invokes actions.loadSessionIntoPanel with correct scope and directory for General space", async () => {
    const loadedCalls: Array<{ scope: any; panelID: string; sessionID: string; directory: string }> = []
    const actions = {
      addPanel: () => undefined,
      loadSessionIntoPanel: async (options: any) => {
        loadedCalls.push(options)
        return { status: "committed", panelID: options.panelID }
      },
    }

    const wb = wbWithPanels("", [panel({ id: "p-empty", slotState: "empty" })])

    await openSessionInPanel({
      session: { id: "s-100", title: "General Session" },
      sessionDirectory: "/workspace/proj-a",
      targetSpace: { id: "General", name: "General", path: "" },
      wb,
      actions,
      t: (key) => key,
      showOverwriteDialog: () => {},
    })

    expect(loadedCalls.length).toBe(1)
    expect(loadedCalls[0]).toEqual({
      scope: { kind: "general" },
      panelID: "p-empty",
      sessionID: "s-100",
      directory: "/workspace/proj-a",
    })
  })
})
