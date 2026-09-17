// IPC channel name registry. Source of truth for every channel registered by
// registerIpcHandlers in ipc.ts. unregisterIpcHandlers clears the exact same
// set so re-registration (dev HMR) can replace handlers without Electron
// throwing "attempted to register a second handler".
//
// Kept electron-free so it can be imported by tests that run outside the
// Electron runtime (bun:test with electron-mock cannot fully load electron).
//
// When adding/removing a channel in registerIpcHandlers, update these lists
// in lockstep. The structural test in ipc.test.ts verifies the lists cover
// every channel registered in ipc.ts.

export const IPC_HANDLE_CHANNELS = [
  "kill-sidecar",
  "await-initialization",
  "get-window-config",
  "consume-initial-deep-links",
  "get-display-backend",
  "set-display-backend",
  "parse-markdown",
  "check-app-exists",
  "run-updater",
  "check-update",
  "install-update",
  "set-background-color",
  "export-debug-logs",
  "record-fatal-renderer-error",
  "get-sidecar-state",
  "restart-sidecar",
  "store-get",
  "store-set",
  "store-delete",
  "store-clear",
  "store-keys",
  "store-length",
  "open-directory-picker",
  "open-file-picker",
  "save-file-picker",
  "open-path",
  "read-clipboard-image",
  "get-window-count",
  "get-window-focused",
  "set-window-focus",
  "show-window",
  "get-zoom-factor",
  "set-zoom-factor",
  "set-titlebar",
  "run-desktop-menu-action",
  "save-recent-model",
] as const

export const IPC_EVENT_CHANNELS = [
  "loading-window-complete",
  "open-link",
  "show-notification",
  "relaunch",
] as const
