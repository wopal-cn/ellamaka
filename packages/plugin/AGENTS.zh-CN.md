---
name: plugin 包 AGENT RULES
description: Plugin SDK 包，提供 server 插件（tools、hooks、auth）和 TUI 插件（slots、routes、commands、theme）的类型定义
---

# Agent Development Rules

## Canonical References

- Parent Rules: `../../AGENTS.md`
- DESIGN: `../../docs/DESIGN.md`

## Architecture and Directories

纯类型导出包，无运行时逻辑。CLI 通过 TypeScript 直接加载 `src/`，不消费构建产物。

| Directory | Responsibility |
|---|---|
| `src/index.ts` | Server 插件 API：`Plugin`、`Hooks`、`AuthHook`、`ProviderHook`、`PluginInput` |
| `src/tool.ts` | `tool()` 工厂函数 + `ToolContext` / `ToolResult` |
| `src/tui.ts` | TUI 插件 API：`TuiPlugin`、`TuiPluginApi`、slot/route/dialog/theme 类型 |
| `src/shell.ts` | `BunShell` 类型绑定，供插件访问 shell |
| `src/example*.ts` | 参考实现，非测试 |

## Development Commands

| Scenario | Command | When |
|---|---|---|
| Typecheck | `bun run typecheck` from `packages/plugin` | After type changes |

