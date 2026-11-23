import { describe, expect, test } from "bun:test"
import { isWorkbenchClosePanelShortcut, isWorkbenchTabCloseProtected } from "./workbench-keyboard"

describe("Workbench close-panel shortcut", () => {
  test("accepts the platform modifier without extra modifiers", () => {
    expect(
      isWorkbenchClosePanelShortcut({ key: "w", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }),
    ).toBe(true)
    expect(
      isWorkbenchClosePanelShortcut({ key: "W", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }),
    ).toBe(true)
  })

  test("does not treat modified variants as close-panel", () => {
    expect(
      isWorkbenchClosePanelShortcut({ key: "w", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }),
    ).toBe(false)
    expect(
      isWorkbenchClosePanelShortcut({ key: "w", metaKey: true, ctrlKey: true, altKey: false, shiftKey: false }),
    ).toBe(false)
    expect(
      isWorkbenchClosePanelShortcut({ key: "w", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false }),
    ).toBe(false)
    expect(
      isWorkbenchClosePanelShortcut({ key: "w", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }),
    ).toBe(false)
    expect(
      isWorkbenchClosePanelShortcut({ key: "q", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }),
    ).toBe(false)
  })

  test("protects the General and pinned tabs from command-triggered close", () => {
    expect(isWorkbenchTabCloseProtected(undefined)).toBe(true)
    expect(isWorkbenchTabCloseProtected({ path: "" })).toBe(true)
    expect(isWorkbenchTabCloseProtected({ path: "/space", pinned: true })).toBe(true)
    expect(isWorkbenchTabCloseProtected({ path: "/space", pinned: false })).toBe(false)
  })
})
