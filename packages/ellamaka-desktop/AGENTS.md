---
name: ellamaka-desktop
description: Ellamaka Electron desktop application — v1.15.13 base from OpenCode packages/desktop
---

# Agent Development Rules

## Upstream Baseline

- **Source**: OpenCode `packages/desktop` at commit `385cb694419f98103af0e8fc6187ddcbcbb6eecb` (v1.15.13)
- **Electron**: 41.2.1
- **Sync strategy**: Selective backport of security/lifecycle fixes only. No cross-version wholesale upgrade. All changes tracked via git diff against baseline.

## Architecture

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
Ellamaka sidecar (packages/opencode/build-node.ts)
├── PTY Session Registry
├── Disconnect Grace Reaper (10s)
└── PTY / TUI processes
```

### State Ownership

| State | Owner | Lifecycle |
|-------|-------|-----------|
| Panel layout, PTY ID hints | `ellamaka-app` / `localStorage` | Cross-refresh, cross-launch |
| PTY sessions, subscribers, grace timer | Ellamaka sidecar | Current sidecar runtime |
| PTY/TUI OS processes | Ellamaka sidecar | Current sidecar runtime |
| Sidecar credentials | Electron Main | Current app process |

### PTY Lifecycle Rules

- Last WebSocket subscriber disconnect → 10s Grace → auto-terminate
- Reconnect within Grace → cancel timer, reuse PTY
- Explicit Panel/Space close → immediate termination (no Grace)
- App exit → Main stops sidecar → sidecar finalizer kills all PTYs + children
- Renderer crash → sidecar keeps PTY alive in Grace; Renderer can reconnect

## Development Commands

All commands run from `packages/ellamaka-desktop/`.

| Command | Purpose |
|---------|---------|
| `bun test --preload ./electron-mock.ts --force-exit src` | Run tests (requires electron mock) |
| `bun run typecheck` | TypeScript type check (`tsgo -b`) |
| `bun run build` | Vite + electron-vite build → `out/` |
| `bun run package:mac` | macOS unsigned dev DMG/ZIP → `dist/` |

Pre-build steps:
```bash
# Build sidecar first
cd ../opencode && bun script/build-node.ts
# Build desktop
cd ../ellamaka-desktop && bun run build
```

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
| `src/main/index.ts` | Main process entry — app lifecycle, window creation, sidecar orchestration |
| `src/main/sidecar.ts` | Sidecar worker thread — server listen/stop |
| `src/main/server.ts` | Sidecar spawn, health check, env setup |
| `src/main/ipc.ts` | IPC handler registry |
| `src/main/constants.ts` | Channel, store keys |
| `src/preload/index.ts` | Context bridge — ElectronAPI → `window.api` |
| `src/renderer/index.tsx` | Renderer entry — platform setup, routing, sidecar connection |
| `electron-builder.config.ts` | Packaging config (unsigned macOS dev build) |
| `electron.vite.config.ts` | Vite config (main/preload/renderer builds) |
