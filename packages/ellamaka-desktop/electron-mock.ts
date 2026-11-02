// Mock electron module for Bun test environment
// Required because the main process imports from 'electron' which is only
// available within the Electron runtime, not in plain bun.
import { mock } from "bun:test"
mock.module("electron", () => ({
  app: {
    getPath: () => "/tmp",
    getVersion: () => "41.2.1",
    isPackaged: true,
    getName: () => "Ellamaka",
    on: () => {},
    whenReady: () => Promise.resolve(),
  },
  crashReporter: {
    start: () => {},
    addExtraParameter: () => {},
  },
  netLog: {
    startLogging: () => Promise.resolve(),
    stopLogging: () => Promise.resolve(),
  },
  utilityProcess: {
    fork: () => ({}),
  },
  shell: {
    openPath: () => Promise.resolve(""),
    openExternal: () => Promise.resolve(),
    trashItem: () => Promise.resolve(),
  },
  // oxlint-disable-next-line typescript-eslint/no-extraneous-class -- Electron mock only needs a constructible token
  BrowserWindow: class {},
  Menu: {
    buildFromTemplate: () => ({}),
    setApplicationMenu: () => {},
  },
  dialog: {
    showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [] }),
    showSaveDialog: () => Promise.resolve({ canceled: false, filePath: "" }),
  },
  ipcMain: {
    handle: () => {},
    on: () => {},
    removeHandler: () => {},
    removeAllListeners: () => {},
  },
  session: {
    defaultSession: {
      setPermissionRequestHandler: () => {},
      setPreloads: () => {},
    },
  },
  nativeTheme: {
    themeSource: "system",
  },
  net: {
    fetch: () => Promise.reject(new Error("net mocked for tests")),
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
  },
  protocol: {
    registerSchemesAsPrivileged: () => {},
  },
  // oxlint-disable-next-line typescript-eslint/no-extraneous-class -- Electron mock only needs a constructible token
  Notification: class {},
  default: {
    app: {
      getPath: () => "/tmp",
      getVersion: () => "41.2.1",
      isPackaged: true,
      getName: () => "Ellamaka",
      on: () => {},
      whenReady: () => Promise.resolve(),
    },
  },
}))

mock.module("electron-log", () => ({
  default: {
    log: () => {},
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  },
  transports: {
    file: { maxSize: 0 },
  },
  initialize: () => {},
}))

mock.module("electron-log/main.js", () => ({
  default: {
    log: () => {},
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  },
  transports: {
    file: { maxSize: 0, resolvePathFn: () => {} },
  },
  initialize: () => {},
}))

// Mock drizzle required by sidecar.ts (needs node:sqlite)
mock.module("drizzle-orm/node-sqlite/driver", () => ({
  drizzle: () => ({
    $client: null,
  }),
}))

// The desktop bundle resolves `virtual:opencode-server` to the compiled
// opencode node bundle (electron.vite.config.ts). Tests run against source, so
// the module resolves to the real cordis implementation the CLI mount also
// uses — the point of these tests is the shared decision table, and a stub
// would pin the copy instead of the contract.
// The sidecar's live `setLogLevel` message path awaits this specifier at
// message time, so the mock must carry a `Log` shim alongside the real
// install-command surface the sidecar also consumes. `setLevel` records into
// a process-level array so `sidecar-log-level.test.ts` can assert the wiring
// regardless of bun's shared module registry (a per-file mock.module override
// cannot re-patch the specifier once another file has materialized it).
;(globalThis as Record<string, unknown>).__mockDshSetLevelCalls = []
mock.module("virtual:opencode-server", async () => {
  const real = await import("../ellamaka-cordis/src/plugins/install-command")
  return {
    ...real,
    Log: {
      setLevel: (level: string) => {
        ;(globalThis as Record<string, unknown>).__mockDshSetLevelCalls.push(level)
      },
      create: () => ({ warn() {}, info() {}, error() {} }),
    },
  }
})
