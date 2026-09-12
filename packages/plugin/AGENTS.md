---
name: plugin package AGENT RULES
description: Plugin SDK package providing type definitions for server plugins (tools, hooks, auth) and TUI plugins (slots, routes, commands, theme)
---

# Agent Development Rules

## Canonical References

- Parent Rules: `../../AGENTS.md`
- DESIGN: `../../docs/DESIGN.md`

## Architecture and Directories

Type-only export package with no runtime logic. CLI loads `src/` directly via TypeScript; no build output is consumed.

| Directory | Responsibility |
|---|---|
| `src/index.ts` | Server plugin API: `Plugin`, `Hooks`, `AuthHook`, `ProviderHook`, `PluginInput` |
| `src/tool.ts` | `tool()` factory + `ToolContext` / `ToolResult` |
| `src/tui.ts` | TUI plugin API: `TuiPlugin`, `TuiPluginApi`, slot/route/dialog/theme types |
| `src/shell.ts` | `BunShell` type bindings for plugin shell access |
| `src/example*.ts` | Reference implementations, not tests |

## Development Commands

| Scenario | Command | When |
|---|---|---|
| Typecheck | `bun run typecheck` from `packages/plugin` | After type changes |