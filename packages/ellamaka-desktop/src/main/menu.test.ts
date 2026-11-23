import { describe, expect, mock, test } from "bun:test"
import type { MenuDeps } from "./menu"

// Registered before the dynamic import below: that import loads ./menu, which
// resolves the mocked module at load time.
await mock.module("./desktop-menu-actions", () => ({ runDesktopMenuAction: () => {} }))

const { aboutOptions, buildMenuTemplate, showWindowsMenuBar } = await import("./menu")

const deps: MenuDeps = {
  trigger: () => {},
  checkForUpdates: () => {},
  relaunch: () => {},
  restartSidecar: () => {},
  exportLogs: () => {},
  toggleDebugLogging: () => {},
  isDebugLogging: () => false,
}

const items = (entry: { submenu?: unknown }) => entry.submenu as Array<{ label?: string; submenu?: unknown }>

describe("desktop native menu", () => {
  test("provides the Windows menu bar with diagnostics and About", () => {
    const template = buildMenuTemplate("windows", deps) as Array<{ label?: string; submenu?: unknown }>

    expect(template.map((entry) => entry.label)).toEqual(["File", "Edit", "View", "Window", "Help"])
    expect(items(template[0]).map((entry) => entry.label)).toContain("Settings...")
    expect(items(template[0]).map((entry) => entry.label)).toContain("Exit")

    const help = template.find((entry) => entry.label === "Help")!
    expect(items(help).map((entry) => entry.label)).toContain("About Ellamaka")

    const diagnostics = items(help).find((entry) => entry.label === "Diagnostics")!
    expect(items(diagnostics).map((entry) => entry.label)).toEqual([
      "Restart Local Server",
      "Export Diagnostic Logs...",
      "Enable Debug Logging",
    ])
  })

  test("keeps the macOS application menu while excluding Windows File", () => {
    const template = buildMenuTemplate("macos", deps) as Array<{ label?: string }>

    expect(template.map((entry) => entry.label)).toContain("Ellamaka")
    expect(template.map((entry) => entry.label)).not.toContain("File")
  })

  test("formats About with the packaged prerelease version", () => {
    expect(aboutOptions("Ellamaka Beta", "1.15.13-beta.3")).toEqual({
      type: "info",
      title: "About Ellamaka Beta",
      message: "Ellamaka Beta",
      detail: "Version 1.15.13-beta.3",
    })
  })

  test("forces the Windows menu bar visible after registering the native menu", () => {
    const events: string[] = []

    showWindowsMenuBar([
      {
        setAutoHideMenuBar: (value) => events.push(`auto-hide:${value}`),
        setMenuBarVisibility: (value) => events.push(`visible:${value}`),
      },
    ])

    expect(events).toEqual(["auto-hide:false", "visible:true"])
  })
})
