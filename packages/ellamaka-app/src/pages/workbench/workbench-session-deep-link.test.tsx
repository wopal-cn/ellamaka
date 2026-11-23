import { describe, expect, test } from "bun:test"
import {
  coordinateWorkbenchSessionLink,
  type CoordinateWorkbenchSessionLinkParams,
  type WorkbenchSessionGroupSummary,
} from "./workbench-session-deep-link-core"
import type { RevealSessionInput, RevealSessionResult } from "./workbench-actions"
import type { WopalSpace } from "./space-store"

const generalGroup = (sessions: WorkbenchSessionGroupSummary["sessions"]): WorkbenchSessionGroupSummary => ({
  id: "General",
  title: "General",
  type: "general",
  sessions,
})

const spaceGroup = (
  id: string,
  title: string,
  sessions: WorkbenchSessionGroupSummary["sessions"],
): WorkbenchSessionGroupSummary => ({
  id,
  title,
  type: "space",
  sessions,
})

const session = (over: Partial<WorkbenchSessionGroupSummary["sessions"][number]> = {}) => ({
  id: "ses-1",
  title: "Session 1",
  directory: "/sp-a",
  directoryHealth: "healthy" as const,
  ...over,
})

function revealMock(behavior: (input: RevealSessionInput) => RevealSessionResult) {
  const calls: RevealSessionInput[] = []
  const fn = async (input: RevealSessionInput): Promise<RevealSessionResult> => {
    calls.push(input)
    return behavior(input)
  }
  return { fn, calls }
}

function baseParams(overrides: Partial<CoordinateWorkbenchSessionLinkParams>): CoordinateWorkbenchSessionLinkParams {
  return {
    sessionID: "ses-1",
    groups: [],
    spaces: [],
    reveal: async () => ({ status: "loaded", panelID: "p1", scopePath: "/sp-a" }),
    openTab: () => {},
    showConfirm: () => {},
    setStatusMessage: () => {},
    consume: () => {},
    t: (key) => key,
    ...overrides,
  }
}

describe("coordinateWorkbenchSessionLink", () => {
  test("activates an already-bound General session without opening any Space Tab", async () => {
    const reveal = revealMock(() => ({ status: "activated", panelID: "p1", scopePath: "" }))
    const openTabCalls: unknown[] = []
    const consumed: string[] = []
    await coordinateWorkbenchSessionLink(
      baseParams({
        groups: [generalGroup([session({ id: "ses-1" })])],
        reveal: reveal.fn,
        openTab: (space) => openTabCalls.push(space),
        consume: () => consumed.push("c"),
      }),
    )
    expect(reveal.calls).toEqual([{ scope: { kind: "general" }, sessionID: "ses-1", directory: "/sp-a" }])
    expect(openTabCalls).toEqual([])
    expect(consumed).toEqual(["c"])
  })

  test("activates an already-bound Space session and opens its Tab", async () => {
    const reveal = revealMock(() => ({ status: "activated", panelID: "p1", scopePath: "/sp-a" }))
    const openTabCalls: unknown[] = []
    await coordinateWorkbenchSessionLink(
      baseParams({
        groups: [spaceGroup("space-a", "Space A", [session({ id: "ses-1", directory: "/sp-a" })])],
        spaces: [{ id: "space-a", name: "Space A", path: "/sp-a" }],
        reveal: reveal.fn,
        openTab: (space) => openTabCalls.push(space),
      }),
    )
    expect(openTabCalls).toEqual([{ id: "space-a", name: "Space A", path: "/sp-a" }])
    expect(reveal.calls[0].scope).toEqual({ kind: "space", name: "Space A", path: "/sp-a" })
  })

  test("loads an unbound session into an available Panel", async () => {
    const reveal = revealMock(() => ({ status: "loaded", panelID: "p2", scopePath: "/sp-a" }))
    const consumed: string[] = []
    await coordinateWorkbenchSessionLink(
      baseParams({
        groups: [spaceGroup("space-a", "Space A", [session({ id: "ses-1" })])],
        spaces: [{ id: "space-a", name: "Space A", path: "/sp-a" }],
        reveal: reveal.fn,
        consume: () => consumed.push("c"),
      }),
    )
    expect(reveal.calls[0].forceReplace).toBeUndefined()
    expect(consumed).toEqual(["c"])
  })

  test("requests confirmation when every Panel is bound, then replaces on confirm", async () => {
    const reveal = revealMock((input) =>
      input.forceReplace
        ? { status: "loaded", panelID: "p1", scopePath: "/sp-a" }
        : { status: "replacement_required", panelID: "p1", scopePath: "/sp-a" },
    )
    let onConfirm: (() => void) | undefined
    let onCancel: (() => void) | undefined
    const consumed: string[] = []
    await coordinateWorkbenchSessionLink(
      baseParams({
        groups: [spaceGroup("space-a", "Space A", [session({ id: "ses-1" })])],
        spaces: [{ id: "space-a", name: "Space A", path: "/sp-a" }],
        reveal: reveal.fn,
        showConfirm: (confirm, cancel) => {
          onConfirm = confirm
          onCancel = cancel
        },
        consume: () => consumed.push("c"),
      }),
    )
    expect(reveal.calls.length).toBe(1)
    expect(reveal.calls[0].forceReplace).toBeUndefined()
    expect(typeof onConfirm).toBe("function")
    expect(consumed).toEqual([]) // not consumed until the user decides

    onConfirm!()
    await Promise.resolve()
    expect(reveal.calls.length).toBe(2)
    expect(reveal.calls[1].forceReplace).toBe(true)
    expect(consumed).toEqual(["c"])
    expect(typeof onCancel).toBe("function")
  })

  test("keeps the user's work when the overwrite is cancelled", async () => {
    const reveal = revealMock(() => ({ status: "replacement_required", panelID: "p1", scopePath: "/sp-a" }))
    let onCancel: (() => void) | undefined
    const consumed: string[] = []
    await coordinateWorkbenchSessionLink(
      baseParams({
        groups: [spaceGroup("space-a", "Space A", [session({ id: "ses-1" })])],
        spaces: [{ id: "space-a", name: "Space A", path: "/sp-a" }],
        reveal: reveal.fn,
        showConfirm: (_confirm, cancel) => {
          onCancel = cancel
        },
        consume: () => consumed.push("c"),
      }),
    )
    onCancel!()
    expect(consumed).toEqual(["c"])
    expect(reveal.calls.length).toBe(1) // no replacement load happened
  })

  test("does not load a session whose directory is unavailable", async () => {
    const reveal = revealMock(() => ({ status: "loaded", panelID: "p1", scopePath: "/sp-a" }))
    const messages: string[] = []
    const consumed: string[] = []
    await coordinateWorkbenchSessionLink(
      baseParams({
        groups: [spaceGroup("space-a", "Space A", [session({ id: "ses-1", directoryHealth: "unavailable" })])],
        spaces: [{ id: "space-a", name: "Space A", path: "/sp-a" }],
        reveal: reveal.fn,
        setStatusMessage: (m) => messages.push(m),
        consume: () => consumed.push("c"),
      }),
    )
    expect(messages).toEqual(["workbench.status.dirHealthWarning"])
    expect(reveal.calls).toEqual([])
    expect(consumed).toEqual(["c"])
  })

  test("reports a missing session without touching the Workbench", async () => {
    const reveal = revealMock(() => ({ status: "loaded", panelID: "p1", scopePath: "/sp-a" }))
    const messages: string[] = []
    const consumed: string[] = []
    await coordinateWorkbenchSessionLink(
      baseParams({
        groups: [spaceGroup("space-a", "Space A", [session({ id: "other" })])],
        spaces: [{ id: "space-a", name: "Space A", path: "/sp-a" }],
        reveal: reveal.fn,
        setStatusMessage: (m) => messages.push(m),
        consume: () => consumed.push("c"),
      }),
    )
    expect(messages).toEqual(["workbench.status.sessionNotFound"])
    expect(reveal.calls).toEqual([])
    expect(consumed).toEqual(["c"])
  })

  test("reports a Space that is no longer registered", async () => {
    const reveal = revealMock(() => ({ status: "loaded", panelID: "p1", scopePath: "/sp-a" }))
    const messages: string[] = []
    const consumed: string[] = []
    await coordinateWorkbenchSessionLink(
      baseParams({
        groups: [spaceGroup("space-x", "Space X", [session({ id: "ses-1" })])],
        spaces: [{ id: "space-a", name: "Space A", path: "/sp-a" }],
        reveal: reveal.fn,
        setStatusMessage: (m) => messages.push(m),
        consume: () => consumed.push("c"),
      }),
    )
    expect(messages).toEqual(["workbench.status.spaceNotRegistered"])
    expect(reveal.calls).toEqual([])
    expect(consumed).toEqual(["c"])
  })

  test("surfaces an unavailable (archived) session from the reveal result", async () => {
    const reveal = revealMock(() => ({ status: "unavailable", reason: "archived", panelID: "p1", scopePath: "/sp-a" }))
    const messages: string[] = []
    const consumed: string[] = []
    await coordinateWorkbenchSessionLink(
      baseParams({
        groups: [spaceGroup("space-a", "Space A", [session({ id: "ses-1" })])],
        spaces: [{ id: "space-a", name: "Space A", path: "/sp-a" }],
        reveal: reveal.fn,
        setStatusMessage: (m) => messages.push(m),
        consume: () => consumed.push("c"),
      }),
    )
    expect(messages).toEqual(["workbench.status.sessionUnavailable"])
    expect(consumed).toEqual(["c"])
  })

  test("processes only the most recent of two consecutive notifications", async () => {
    const reveal = revealMock(() => ({ status: "loaded", panelID: "p1", scopePath: "/sp-a" }))
    const consumed: string[] = []
    const spaces: WopalSpace[] = [{ id: "space-a", name: "Space A", path: "/sp-a" }]

    // Second notification has already incremented the generation by the time
    // the first effect runs, so the stale request bails before revealing.
    let generation = 2
    await Promise.all([
      coordinateWorkbenchSessionLink(
        baseParams({
          sessionID: "ses-stale",
          groups: [spaceGroup("space-a", "Space A", [session({ id: "ses-stale" })])],
          spaces,
          reveal: reveal.fn,
          consume: () => consumed.push("stale"),
          isCurrent: () => generation === 1,
        }),
      ),
      coordinateWorkbenchSessionLink(
        baseParams({
          sessionID: "ses-latest",
          groups: [spaceGroup("space-a", "Space A", [session({ id: "ses-latest" })])],
          spaces,
          reveal: reveal.fn,
          consume: () => consumed.push("latest"),
          isCurrent: () => generation === 2,
        }),
      ),
    ])
    expect(reveal.calls.length).toBe(1)
    expect(reveal.calls[0].sessionID).toBe("ses-latest")
    expect(consumed).toEqual(["latest"])
  })
})
