# Ellamaka Desktop

Ellamaka desktop application powered by Electron 41.2.1. Hosts the `ellamaka-app` Workbench and manages a local Ellamaka sidecar process.

## Upstream Baseline

- **Source**: OpenCode `packages/desktop` at commit [`385cb694419f98103af0e8fc6187ddcbcbb6eecb`](https://github.com/anomalyco/opencode/commit/385cb694419f98103af0e8fc6187ddcbcbb6eecb) (v1.15.13)
- **Electron**: 41.2.1
- **Sync strategy**: Selective backport of security and lifecycle fixes only. No cross-version wholesale upgrade. All changes tracked via `git diff` against the baseline.

## Runtime Architecture

```
Electron Main Process
├── Window Manager (BrowserWindow lifecycle)
├── Sidecar Manager (packages/opencode node runtime)
└── IPC Handler Registry
          │ IPC
Electron Preload (minimal allowlisted desktop API)
          │
ellamaka-app Renderer (SolidJS SPA)
          │ HTTP / WebSocket
Ellamaka Sidecar (packages/opencode/build-node.ts)
├── PTY Session Registry
├── Disconnect Grace Reaper (10s)
└── PTY / TUI processes
```

### Core Design Principle

Electron is a thin shell — it only manages window lifecycle and the sidecar process. All PTY, TUI, and session management lives in the sidecar. The Renderer shares the exact same PTY logic as the browser Workbench.

### Layer Responsibilities

| Layer | Responsibility |
|---|---|
| **Main Process** | Creates windows, starts/stops the sidecar, holds sidecar connection credentials. Terminates the sidecar and all child processes on app exit |
| **Preload** | Exposes a minimal IPC interface (window, file picker, menus, updates, sidecar init). Renderer has context isolation enabled, Node integration disabled |
| **Renderer** | The `@wopal/ellamaka-app` `/workbench` route. Receives `platform: "desktop"` via `PlatformProvider` for file picker, menus, updates, and system integration |
| **Sidecar** | Node runtime built from `packages/opencode`. Listens on loopback only, generates temporary auth credentials per launch. Owns PTY creation, probing, reconnection, Grace reaping, and explicit deletion |

### Relationship with ellamaka-app Workbench

The Workbench doesn't know whether it's running in a browser or Electron. It gets platform capabilities through `PlatformProvider`:

| Capability | Browser | Electron |
|-----------|---------|----------|
| File picker | Browser native | Via Preload IPC |
| Menus | None | Native Electron menus |
| Updates | None | Electron updater |
| PTY lifecycle | Identical | Identical |

PTY creation, probing, reconnection, and deletion logic is fully shared and does not fork by platform. The Electron Renderer only adds a desktop platform adaptation layer and does not maintain an independent copy of PTY ownership.

### State Ownership

| State | Owner | Lifecycle |
|-------|-------|-----------|
| Panel layout, PTY ID hints | `ellamaka-app` / `localStorage` | Cross-refresh, cross-launch |
| PTY sessions, subscribers, grace timer | Ellamaka sidecar | Current sidecar runtime |
| PTY/TUI OS processes | Ellamaka sidecar | Current sidecar runtime |
| Sidecar credentials | Electron Main Process | Current app process |

### PTY Lifecycle Rules

- Last WebSocket subscriber disconnect → 10s Grace → auto-terminate
- Reconnect within Grace → cancel timer, reuse PTY
- Explicit Panel/Space close → immediate termination (no Grace)
- App exit → Main Process stops sidecar → sidecar finalizer kills all PTYs and children
- Renderer crash → sidecar keeps PTY alive in Grace; Renderer can reconnect

### Sidecar Startup Flow

```
Electron Main Process (src/main/index.ts)
        │
        ▼
  src/main/server.ts
        │
        ├─ 1. Compute sidecar path (built from packages/opencode/build-node.ts)
        ├─ 2. Generate random port + temp auth credentials (ellamaka:<random-password>)
        ├─ 3. Set environment variables: WOPAL_HOME, port, password
        ├─ 4. Spawn sidecar child process
        ├─ 5. Health check polling: GET /api/health
        └─ 6. Pass credentials to Renderer via Preload IPC
               │
               ▼
        Renderer receives URL + credentials:
        ├─ Create API client (HTTP Basic Auth)
        ├─ Connect WebSocket (PTY)
        └─ Subscribe to SSE (real-time events)
```

## Development Commands

All commands run from `packages/ellamaka-desktop/`.

| Command | Purpose |
|------|------|
| `bun test --preload ./electron-mock.ts --force-exit src` | Run tests (requires electron mock) |
| `bun run typecheck` | TypeScript type check (`tsgo -b`) |
| `bun run build` | Vite + electron-vite build → `out/` |
| `bun run package:mac` | macOS unsigned dev DMG/ZIP → `dist/` |

## Build Steps

```bash
# 1. Build sidecar first (required)
cd ../opencode && bun script/build-node.ts

# 2. Build desktop app
cd ../ellamaka-desktop && bun run build

# 3. Package macOS installer (dev, unsigned)
bun run package:mac
```

## Testing

```bash
# Unit tests (requires electron-mock preload)
cd packages/ellamaka-desktop
bun test --preload ./electron-mock.ts --force-exit src

# Typecheck
bun run typecheck

# Full-repo typecheck
bun turbo typecheck
```

`--preload ./electron-mock.ts` mocks Electron APIs (`electron`, `electron-store`, etc.) so tests run in Node/Bun without a real Electron window.

## Baseline Checks

```bash
# Verify packages/desktop/ hasn't drifted from v1.15.13 baseline
bash scripts/check-desktop-baseline.sh

# Verify packages/app/ hasn't drifted from v1.15.13 baseline
bash scripts/check-app-baseline.sh
```

## Verification Contract

See `docs/DESKTOP.md` §11. Automated checks run in CI. Manual runtime verification:

| # | Check | How |
|---|-------|-----|
| 1 | Electron loads Workbench `/workbench` on startup | Launch app, verify the UI is Workbench |
| 3 | TUI/Terminal can be created, receive I/O, and resize | Create a Session, switch to TUI view |
| 4 | PTY ID and PID survive Renderer refresh | Create a TUI, then `Cmd+R` refresh |
| 5 | No duplicate PTYs after refresh | PTY count unchanged in sidecar after refresh |
| 6 | Panel close kills its PTY process | Close a Panel |
| 7 | Space close kills all its PTYs | Close a Space Tab |
| 9 | App exit kills sidecar and all child processes | Quit app, `ps aux \| grep` to confirm |
| 11 | Renderer can reconnect after crash | Simulate crash and recovery |

## Branding

- App name: Ellamaka (productName)
- Bundle ID: `ai.ellamaka.desktop.dev` (dev), `ai.ellamaka.desktop` (prod)
- Protocol: `ellamaka://`
- Settings store: `ellamaka.settings`
- Auth: Basic auth `ellamaka:<password>`
- Service name: `ellamaka server`

## Key Files

| File | Role |
|------|------|
| `src/main/index.ts` | Main Process entry — app lifecycle, window creation, sidecar orchestration |
| `src/main/sidecar.ts` | Sidecar worker thread — server listen/stop |
| `src/main/server.ts` | Sidecar spawn, health check, env setup |
| `src/main/ipc.ts` | IPC handler registry |
| `src/main/constants.ts` | Channel, store key constants |
| `src/preload/index.ts` | Context bridge — ElectronAPI → `window.api` |
| `src/renderer/index.tsx` | Renderer entry — platform setup, routing, sidecar connection |
| `electron-builder.config.ts` | Packaging config (unsigned macOS dev build) |
| `electron.vite.config.ts` | Vite config (main/preload/renderer builds) |

## Security Boundaries

- BrowserWindow has context isolation enabled; Renderer has Node integration disabled
- Preload only exposes explicitly allowed IPC methods
- Sidecar listens on loopback only, with per-launch temporary auth credentials
- Auth credentials are held by Main Process and never written to `localStorage`
- PTY probing, reconnection, and deletion go through existing auth and directory routing boundaries
- App exit is handled by Main Process which terminates the sidecar and child process group