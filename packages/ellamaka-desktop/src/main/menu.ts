import { app, BrowserWindow, dialog, Menu, shell } from "electron"
import type { MenuItemConstructorOptions } from "electron"
import {
  DESKTOP_MENU,
  desktopMenuVisible,
  type DesktopMenuEntry,
  type DesktopMenuPlatform,
  type DesktopMenuRole,
} from "@wopal/ellamaka-app/desktop-menu"

import { UPDATER_ENABLED } from "./constants"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { getReleaseInfo } from "./release-info"

export type MenuDeps = {
  trigger: (id: string) => void
  checkForUpdates: () => void
  relaunch: () => void
  restartSidecar: () => void
  exportLogs: () => void
  toggleDebugLogging: () => void
  isDebugLogging: () => boolean
}

export function createMenu(deps: MenuDeps) {
  const platform = menuPlatform(process.platform)
  if (!platform) return

  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(platform, deps)))
  if (platform === "windows") showWindowsMenuBar(BrowserWindow.getAllWindows())
}

export function showWindowsMenuBar(
  windows: Iterable<Pick<BrowserWindow, "setAutoHideMenuBar" | "setMenuBarVisibility">>,
) {
  for (const win of windows) {
    win.setAutoHideMenuBar(false)
    win.setMenuBarVisibility(true)
  }
}

export function buildMenuTemplate(platform: DesktopMenuPlatform, deps: MenuDeps): MenuItemConstructorOptions[] {
  return DESKTOP_MENU.filter((menu) => desktopMenuVisible(menu, platform)).map((menu) => {
    if (menu.role) return { role: nativeRole(menu.role) }
    return {
      label: menu.label,
      submenu: menu.items?.filter((entry) => desktopMenuVisible(entry, platform)).map((entry) => nativeItem(entry, platform, deps)),
    }
  })
}

export function aboutOptions(name: string = app.getName(), version: string = getReleaseInfo().displayVersion) {
  return {
    type: "info" as const,
    title: `About ${name}`,
    message: name,
    detail: `Version ${version}`,
  }
}

function menuPlatform(platform: NodeJS.Platform): DesktopMenuPlatform | undefined {
  if (platform === "darwin") return "macos"
  if (platform === "win32") return "windows"
}

function nativeItem(entry: DesktopMenuEntry, platform: DesktopMenuPlatform, deps: MenuDeps): MenuItemConstructorOptions {
  if (entry.type === "separator") return { type: "separator" }
  if (entry.role) return { label: entry.label, role: nativeRole(entry.role) }

  const item: MenuItemConstructorOptions = {
    label: entry.label,
    accelerator: entry.accelerator?.[platform],
    enabled: entry.enabled === "updater" ? UPDATER_ENABLED : undefined,
    submenu: entry.items?.filter((child) => desktopMenuVisible(child, platform)).map((child) => nativeItem(child, platform, deps)),
  }

  if (entry.action === "app.toggleDebugLogging") {
    item.type = "checkbox"
    item.checked = deps.isDebugLogging()
  }

  if (entry.command) {
    const command = entry.command
    item.click = () => deps.trigger(command)
  }
  if (entry.action) {
    const action = entry.action
    item.click = (menuItem) => {
      if (action === "app.showAbout") {
        void dialog.showMessageBox(aboutOptions())
        return
      }

      runDesktopMenuAction(BrowserWindow.getFocusedWindow(), action, {
        checkForUpdates: deps.checkForUpdates,
        relaunch: deps.relaunch,
        restartSidecar: deps.restartSidecar,
        exportLogs: deps.exportLogs,
        toggleDebugLogging: () => {
          deps.toggleDebugLogging()
          if (menuItem) menuItem.checked = deps.isDebugLogging()
        },
      })
    }
  }
  if (entry.href) {
    const href = entry.href
    item.click = () => shell.openExternal(href)
  }

  return item
}

function nativeRole(role: DesktopMenuRole) {
  return role as NonNullable<MenuItemConstructorOptions["role"]>
}
