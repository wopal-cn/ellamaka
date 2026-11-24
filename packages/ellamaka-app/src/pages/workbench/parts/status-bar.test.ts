import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { DshRuntimeStatus } from "@/utils/server-health"
import { initWorkbenchState } from "../view-store"
import { createDshToolsDiagnosticRetry } from "./status-bar"
import { executeDiagnosticRetry } from "./status-bar-diagnostics"
import { getStatusBarSegments } from "./status-bar-segments"

describe("getStatusBarSegments", () => {
  test("returns empty array when activePanelID is undefined", () => {
    const segments = getStatusBarSegments({
      spaceName: "main",
      activePanelID: undefined,
      panels: [],
      getSessionTitle: () => undefined,
    })
    expect(segments).toEqual([])
  })

  test("returns empty array when active panel is not found in panels list", () => {
    const segments = getStatusBarSegments({
      spaceName: "main",
      activePanelID: "p-missing",
      panels: [{ id: "p-1", slotState: "empty", directory: "/workspace/main" }],
      getSessionTitle: () => undefined,
    })
    expect(segments).toEqual([])
  })

  test("returns panel index segment for empty slot panel", () => {
    const segments = getStatusBarSegments({
      spaceName: "main",
      activePanelID: "p-2",
      panels: [
        { id: "p-1", slotState: "empty", directory: "/workspace/main" },
        { id: "p-2", slotState: "empty", directory: "/workspace/main/sub" },
      ],
      getSessionTitle: () => undefined,
    })
    expect(segments).toEqual([{ type: "panel", text: "P2/2" }])
  })

  test("returns panel and session title segments if bound and session title exists", () => {
    const getSessionTitle = (id: string) => {
      if (id === "ses-1") return "Fix CSS Bug"
      return undefined
    }

    const segments = getStatusBarSegments({
      spaceName: "General",
      activePanelID: "p-1",
      panels: [{ id: "p-1", slotState: "bound", boundSessionId: "ses-1", directory: "/workspace/general" }],
      getSessionTitle,
    })
    expect(segments).toEqual([
      { type: "panel", text: "P1/1" },
      { type: "session", text: "Fix CSS Bug" },
    ])
  })

  test("returns panel segment if bound but session title is missing", () => {
    const segments = getStatusBarSegments({
      spaceName: "General",
      activePanelID: "p-1",
      panels: [{ id: "p-1", slotState: "bound", boundSessionId: "ses-2", directory: "/workspace/general" }],
      getSessionTitle: () => undefined,
    })
    expect(segments).toEqual([{ type: "panel", text: "P1/1" }])
  })
})

describe("dsh tools diagnostic retry", () => {
  test("keeps the degraded warning when server retry succeeds while dshTools remains degraded, and clears once ready", async () => {
    let dispose!: () => void
    const wb = createRoot((d) => {
      dispose = d
      return initWorkbenchState()
    })

    try {
      const [dshTools, setDshTools] = createSignal<DshRuntimeStatus>("degraded")
      let retryTarget: DshRuntimeStatus = "degraded"
      const runtime = {
        get dshTools() {
          return dshTools()
        },
        retry: async () => {
          setDshTools(retryTarget)
          return true
        },
      }

      const warningText = "沙箱插件 dsh-adapter 已禁用（DSH_HOME_BUSY），当前使用原生工具"
      wb.pushDiagnostic("warning", warningText, {
        id: "dsh-tools-status",
        autoDismiss: false,
        onRetry: createDshToolsDiagnosticRetry(runtime),
        source: "dsh-adapter",
      })

      const item = () => wb.diagnostics.find((entry) => entry.id === "dsh-tools-status")
      expect(item()?.text).toBe(warningText)

      // Server healthcheck returns true, but dshTools stays degraded -> alert must remain visible.
      const resolvedWhileDegraded = await executeDiagnosticRetry(item()!, wb.removeDiagnostic)
      expect(resolvedWhileDegraded).toBe(false)
      expect(item()?.text).toBe(warningText)

      // Once a subsequent retry recovers dshTools to ready -> alert clears immediately.
      retryTarget = "ready"
      const resolvedWhenReady = await executeDiagnosticRetry(item()!, wb.removeDiagnostic)
      expect(resolvedWhenReady).toBe(true)
      expect(item()).toBeUndefined()
    } finally {
      dispose()
    }
  })
})
