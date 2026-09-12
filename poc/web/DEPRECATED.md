# DEPRECATED — poc/web

> **本目录已废弃，不再维护。**

## 状态

`poc/web` 已完成其历史使命：验证了桌面端多空间 TUI 嵌入（xterm.js + bun-pty 多 PTY）与移动端 Chat 投影（EllamakaClient + ChatProjector）的可行性。

## 去向

- **桌面 TUI**：已进入 **Workbench** 产品线（`packages/ellamaka-app`），作为三栏 IDE 工作台的核心视图。
- **移动 Chat 视图**：即将迁移合并到 Workbench，迁移完成后本目录整体移除。
- **未迁移期间**：本目录不再维护，包括 `wopal space list --json` 消费适配（`space.list` v2 的 `SpaceEntry.id`/`name` 变更不再跟进）。

## 参考

- Workbench 产品文档：`docs/DESIGN-workbench.md`
- Workbench 前端实现：`packages/ellamaka-app/src/pages/workbench/`
