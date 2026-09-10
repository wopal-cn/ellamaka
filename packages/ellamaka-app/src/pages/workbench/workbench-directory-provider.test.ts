import { describe, expect, test } from "bun:test"
import { createWorkbenchStore, type PersistedWorkbench } from "./workbench-store"
import {
  readWorkbenchDirectoryMode,
  selectWorkbenchDirectoryTarget,
  selectWorkbenchPanelDirectoryTarget,
} from "./workbench-directory-provider"
import {
  WORKBENCH_FIXTURES,
  WORKBENCH_SCENARIO,
  createControlledDirectoryTransport,
} from "./testing/workbench-test-harness"

const persisted = (): PersistedWorkbench => ({
  display: { showTitlebar: true, showStatusbar: true, showSpaceRail: true, showFileViewer: true },
  spaces: {
    "": {
      activePanelID: WORKBENCH_SCENARIO.panels.general,
      panels: [
        {
          id: WORKBENCH_SCENARIO.panels.general,
          slotState: "bound",
          boundSessionId: WORKBENCH_SCENARIO.sessions.general.id,
          mode: "chat",
          directory: WORKBENCH_SCENARIO.sessions.general.directory,
          width: 1,
        },
      ],
    },
    [WORKBENCH_FIXTURES.spaceA.path]: {
      activePanelID: WORKBENCH_SCENARIO.panels.spaceA,
      panels: [
        {
          id: WORKBENCH_SCENARIO.panels.spaceA,
          slotState: "bound",
          boundSessionId: WORKBENCH_SCENARIO.sessions.spaceA.id,
          mode: "chat",
          directory: WORKBENCH_SCENARIO.sessions.spaceA.directory,
          width: 1,
        },
      ],
    },
    [WORKBENCH_FIXTURES.spaceB.path]: {
      activePanelID: WORKBENCH_SCENARIO.panels.spaceB,
      panels: [
        {
          id: WORKBENCH_SCENARIO.panels.spaceB,
          slotState: "bound",
          boundSessionId: WORKBENCH_SCENARIO.sessions.spaceB.id,
          mode: "chat",
          directory: WORKBENCH_SCENARIO.sessions.spaceB.directory,
          width: 1,
        },
      ],
    },
  },
  tabs: [
    {
      id: WORKBENCH_FIXTURES.general.name,
      name: WORKBENCH_FIXTURES.general.name,
      path: WORKBENCH_FIXTURES.general.path,
      type: "general",
    },
    {
      id: WORKBENCH_FIXTURES.spaceA.name,
      name: WORKBENCH_FIXTURES.spaceA.name,
      path: WORKBENCH_FIXTURES.spaceA.path,
      type: "space",
    },
    {
      id: WORKBENCH_FIXTURES.spaceB.name,
      name: WORKBENCH_FIXTURES.spaceB.name,
      path: WORKBENCH_FIXTURES.spaceB.path,
      type: "space",
    },
  ],
  activeSpaceName: WORKBENCH_FIXTURES.general.name,
})

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

describe("Workbench directory status", () => {
  test("does not select a runtime directory for an empty Panel or a tab without Panels", () => {
    const store = createWorkbenchStore(persisted())
    store.unbindSessionFromPanel("", WORKBENCH_SCENARIO.panels.general)
    expect(
      selectWorkbenchDirectoryTarget({
        spaces: store.spaces,
        tabs: store.tabs,
        activeTabPath: "",
      }),
    ).toBeUndefined()
    expect(
      selectWorkbenchDirectoryTarget({
        spaces: {},
        tabs: store.tabs,
        activeTabPath: WORKBENCH_FIXTURES.spaceA.path,
      }),
    ).toBeUndefined()
  })

  test("changes the Panel SDK boundary when a bound Session changes directory", () => {
    const panel = { id: "panel-general", directory: "/fixtures/general/old" }
    const before = selectWorkbenchPanelDirectoryTarget(panel)
    const after = selectWorkbenchPanelDirectoryTarget({
      ...panel,
      directory: "/fixtures/general/new",
    })

    expect(after.directory).toBe("/fixtures/general/new")
    expect(after.key).not.toBe(before.key)
    expect(selectWorkbenchPanelDirectoryTarget({ id: panel.id, directory: "" }).key).not.toBe("")
  })

  test("does not suspend the Workbench shell while directory mode is loading", () => {
    let reads = 0
    const loading = readWorkbenchDirectoryMode({
      isWopalSpaceLoading: true,
      get isWopalSpace(): boolean {
        reads += 1
        throw new Error("pending resource was read")
      },
    })

    expect(loading).toBe(false)
    expect(reads).toBe(0)
    expect(readWorkbenchDirectoryMode({ isWopalSpaceLoading: false, isWopalSpace: true })).toBe(true)
  })

  test("selects exact capability source paths across General, Space A, Space B and General", async () => {
    const store = createWorkbenchStore(persisted())
    const transport = createControlledDirectoryTransport()
    const order = [
      WORKBENCH_FIXTURES.general,
      WORKBENCH_FIXTURES.spaceA,
      WORKBENCH_FIXTURES.spaceB,
      WORKBENCH_FIXTURES.general,
    ]
    const observed: { directory: string; sources: string[] }[] = []

    for (const fixture of order) {
      store.setActive(fixture.path)
      const target = selectWorkbenchDirectoryTarget({
        spaces: store.spaces,
        tabs: store.tabs,
        activeTabPath: store.activeTabPath,
      })
      if (!target) throw new Error(`Missing active directory target for ${fixture.name}`)
      const response = transport.prepare("capabilities.list", target.directory)
      const pending = transport.request("capabilities.list", target.directory)
      response.resolve(fixture.capabilitySources)
      const sources = await pending
      if (!isStringArray(sources)) throw new Error(`Invalid capability response for ${fixture.name}`)
      observed.push({ directory: target.directory, sources })
    }

    expect(observed).toEqual(
      order.map((fixture) => ({
        directory: fixture.directory,
        sources: fixture.capabilitySources,
      })),
    )
  })

  test("keeps a late Space A response in the Space A cache while Space B stays visible", async () => {
    const store = createWorkbenchStore(persisted())
    const transport = createControlledDirectoryTransport()
    const projection = new Map<string, string[]>()
    const spaceA = transport.prepare("capabilities.list", WORKBENCH_FIXTURES.spaceA.directory)
    const spaceB = transport.prepare("capabilities.list", WORKBENCH_FIXTURES.spaceB.directory)

    const load = async (directory: string) => {
      const value = await transport.request("capabilities.list", directory)
      if (!isStringArray(value)) throw new Error(`Invalid capability response for ${directory}`)
      projection.set(directory, value)
    }

    store.setActive(WORKBENCH_FIXTURES.spaceA.path)
    const pendingA = load(WORKBENCH_FIXTURES.spaceA.directory)
    store.setActive(WORKBENCH_FIXTURES.spaceB.path)
    const pendingB = load(WORKBENCH_FIXTURES.spaceB.directory)
    spaceB.resolve(WORKBENCH_FIXTURES.spaceB.capabilitySources)
    await pendingB
    spaceA.resolve(WORKBENCH_FIXTURES.spaceA.capabilitySources)
    await pendingA

    const active = selectWorkbenchDirectoryTarget({
      spaces: store.spaces,
      tabs: store.tabs,
      activeTabPath: store.activeTabPath,
    })
    if (!active) throw new Error("Missing active Space B directory target")
    expect(projection.get(active.directory)).toEqual(WORKBENCH_FIXTURES.spaceB.capabilitySources)
    expect(projection.get(WORKBENCH_FIXTURES.spaceA.directory)).toEqual(WORKBENCH_FIXTURES.spaceA.capabilitySources)
  })
})
