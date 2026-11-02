import { describe, expect, test } from "bun:test"
import { PtyManager } from "./pty-manager"
import type { PtySDK } from "./pty-manager"

function createSDK() {
  const removed: string[] = []
  return {
    removed,
    sdk: {
      client: {
        pty: {
          get: async () => {
            throw new Error("not found")
          },
          remove: async ({ ptyID }: { ptyID: string }) => {
            removed.push(ptyID)
            return { data: true }
          },
        },
      },
    },
  }
}

describe("PtyManager", () => {
  test("a deferred live probe cannot be replayed after the canonical owner disposes its PTY", async () => {
    const manager = new PtyManager()
    let finishProbe!: () => void
    let getCalls = 0
    let createCalls = 0
    const removed: string[] = []
    const sdk: PtySDK = {
      client: {
        pty: {
          get: async ({ ptyID }) => {
            getCalls += 1
            if (getCalls === 1) await new Promise<void>((resolve) => (finishProbe = resolve))
            if (removed.includes(ptyID)) throw new Error("PTY not found")
            return { data: { id: ptyID } }
          },
          remove: async ({ ptyID }) => {
            removed.push(ptyID)
            return { data: true }
          },
        },
      },
    }
    const old = manager.ensure({
      spacePath: "/alias",
      panelId: "panel-1",
      kind: "term",
      existingPtyId: "pty-shared",
      sdk,
      directory: "/real/project",
      createFn: async () => {
        createCalls += 1
        return "unexpected-create"
      },
    })
    await manager.transferSpace(
      "/alias",
      "/real",
      () => ({ id: "panel-1" }),
      () => ({ id: "panel-1" }),
    )
    finishProbe()
    expect(await old).toBe("pty-shared")
    expect(
      await manager.ensure({
        spacePath: "/real",
        panelId: "panel-1",
        kind: "term",
        existingPtyId: "pty-shared",
        sdk,
        directory: "/real/project",
        createFn: async () => {
          createCalls += 1
          return "unexpected-create"
        },
      }),
    ).toBe("pty-shared")
    await manager.disposePty({ spacePath: "/real", panelId: "panel-1", kind: "term", sdk, knownPtyId: "pty-shared" })
    expect(
      await manager.ensure({
        spacePath: "/alias",
        panelId: "panel-1",
        kind: "term",
        existingPtyId: "pty-shared",
        sdk,
        directory: "/real/project",
        createFn: async () => {
          createCalls += 1
          return "pty-new"
        },
      }),
    ).toBe("pty-new")
    expect({ getCalls, createCalls, removed }).toEqual({ getCalls: 3, createCalls: 1, removed: ["pty-shared"] })
  })
  test("does not reuse an old pending PTY after Space identity migration", async () => {
    const manager = new PtyManager()
    const { removed, sdk } = createSDK()
    let finish!: (id: string) => void
    let creates = 0
    const old = manager.ensure({
      spacePath: "/alias",
      panelId: "panel-1",
      kind: "split",
      existingPtyId: undefined,
      sdk,
      directory: "/alias",
      createFn: () => {
        creates += 1
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    })
    await manager.transferSpace(
      "/alias",
      "/real",
      () => ({ id: "panel-1" }),
      () => ({ id: "panel-1" }),
    )
    finish("pty-old")
    await old
    await manager.disposePty({ spacePath: "/alias", panelId: "panel-1", kind: "split", sdk, knownPtyId: "pty-old" })
    const next = await manager.ensure({
      spacePath: "/real",
      panelId: "panel-1",
      kind: "split",
      existingPtyId: undefined,
      sdk,
      directory: "/real",
      createFn: async () => {
        creates += 1
        return "pty-new"
      },
    })
    expect(next).toBe("pty-new")
    expect(creates).toBe(2)
    expect(removed).toEqual(["pty-old"])
  })
  test("destroys a persisted panel PTY even when it is not in the in-memory registry", async () => {
    const manager = new PtyManager()
    const { removed, sdk } = createSDK()

    await manager.disposePanel("/space", "panel-1", sdk, {
      split: "pty-persisted",
    })

    expect(removed).toEqual(["pty-persisted"])
  })

  test("destroys a PTY that finishes creating after its terminal is closed", async () => {
    const manager = new PtyManager()
    const { removed, sdk } = createSDK()
    let resolveCreation!: (ptyID: string) => void

    const creating = manager.ensure({
      spacePath: "/space",
      panelId: "panel-1",
      kind: "split",
      existingPtyId: undefined,
      sdk,
      directory: "/space",
      createFn: () =>
        new Promise<string>((resolve) => {
          resolveCreation = resolve
        }),
    })
    const disposing = manager.disposePty({
      spacePath: "/space",
      panelId: "panel-1",
      kind: "split",
      sdk,
    })

    resolveCreation("pty-racing")
    await Promise.all([creating, disposing])

    expect(removed).toEqual(["pty-racing"])
  })

  test("routes normal disposal through the PTY's real directory", async () => {
    const manager = new PtyManager()
    const removals: Array<{ ptyID: string; directory?: string }> = []
    const sdk = {
      client: {
        pty: {
          get: async () => {
            throw new Error("not found")
          },
          remove: async (input: { ptyID: string; directory?: string }) => {
            removals.push(input)
            return { data: true }
          },
        },
      },
    }

    await manager.ensure({
      spacePath: "",
      panelId: "panel-1",
      kind: "tui",
      existingPtyId: undefined,
      sdk,
      directory: "/real/session/directory",
      createFn: async () => "pty-panel",
    })
    await manager.disposePanel("", "panel-1", sdk, { tui: "pty-panel" })

    expect(removals).toEqual([
      {
        ptyID: "pty-panel",
        directory: "/real/session/directory",
      },
    ])
  })

  test("delete removes PTY from active registry without tracking for unload cleanup", async () => {
    const manager = new PtyManager()
    const { sdk } = createSDK()

    await manager.ensure({
      spacePath: "",
      panelId: "p1",
      kind: "tui",
      existingPtyId: undefined,
      sdk,
      directory: "/real/dir",
      createFn: async () => "pty-1",
    })

    manager.delete("", "p1", "tui")

    // After delete, re-ensuring with the same key should create a new PTY
    // (the old one is gone from the active registry, not held by any cleanup set)
    const id2 = await manager.ensure({
      spacePath: "",
      panelId: "p1",
      kind: "tui",
      existingPtyId: undefined,
      sdk,
      directory: "/real/dir",
      createFn: async () => "pty-2",
    })

    expect(id2).toBe("pty-2")
  })

  test("does not expose unload disposal methods", () => {
    const manager = new PtyManager()
    expect("disposeEverythingOnUnload" in manager).toBeFalse()
    expect("disposeAllSyncOnUnload" in manager).toBeFalse()
  })

  test("clears remembered PTY directories with the rest of its session memory", async () => {
    const manager = new PtyManager()
    const removals: Array<{ ptyID: string; directory?: string }> = []
    const sdk = {
      client: {
        pty: {
          get: async () => {
            throw new Error("not found")
          },
          remove: async (input: { ptyID: string; directory?: string }) => {
            removals.push(input)
            return { data: true }
          },
        },
      },
    }

    await manager.ensure({
      spacePath: "/space",
      panelId: "panel-1",
      kind: "tui",
      existingPtyId: undefined,
      sdk,
      directory: "/first-workbench-session",
      createFn: async () => "pty-remembered",
    })
    manager.clearMemoryOnly()

    await manager.disposePanel("/space", "panel-1", sdk, { tui: "pty-remembered" })

    expect(removals).toEqual([{ ptyID: "pty-remembered", directory: undefined }])
  })
})
