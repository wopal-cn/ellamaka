import { join } from "node:path"

// Desktop app identity. Packaged builds resolve to the channel-specific
// application id; development builds (electron-vite dev, app.isPackaged ===
// false) use the `local` suffix so dev runs never mutate a packaged app's
// settings. See #233 — userData must never be redirected based on WOPAL_HOME,
// only separated by appId.
export const APP_IDS: Record<string, string> = {
  main: "ai.ellamaka.desktop.main",
  beta: "ai.ellamaka.desktop.beta",
  stable: "ai.ellamaka.desktop",
}

export function resolveAppId(isPackaged: boolean, channel: string): string {
  if (isPackaged) return APP_IDS[channel] ?? `ai.ellamaka.desktop.${channel}`
  return `ai.ellamaka.desktop.${channel}`
}

// The Electron userData directory always lives under the OS standard
// app-data path, keyed by appId. It is independent of WOPAL_HOME: both
// packaged and development builds read/write their own appId-scoped path,
// which keeps CLI (env-inheriting) and Finder/Dock (cold-start) launches on
// the exact same path.
export function resolveUserDataPath(isPackaged: boolean, appData: string, channel: string): string {
  return join(appData, resolveAppId(isPackaged, channel))
}
