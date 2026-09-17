import { app } from "electron"

type Channel = "local" | "main" | "beta" | "stable"
const raw = import.meta.env.ELLAMAKA_CHANNEL
export const CHANNEL: Channel =
  raw === "local" || raw === "main" || raw === "beta" || raw === "stable" ? raw : "local"

export const SETTINGS_STORE = "ellamaka.settings"
export const WSL_ENABLED_KEY = "wslEnabled"
export const UPDATER_ENABLED = app.isPackaged && (CHANNEL === "stable" || CHANNEL === "beta")
