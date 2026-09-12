# OpenCode TUI 插件系统分析

> 基于 OpenCode `dev` 分支 `7532d99e5`（v1.3.4 ~ v1.3.13），分析 TUI 插件系统的能力边界与本空间利用可能。

---

## 一、架构概览

TUI 插件是**基于 SolidJS + OpenTUI 的终端 UI 扩展系统**，采用声明式 JSX 渲染。配置入口为 `tui.json`，插件通过 `@opencode-ai/plugin/tui` 包获取类型。

| 层 | 源码 | 职责 |
|---|---|---|
| SDK 类型层 | `packages/plugin/src/tui.ts` (437 行) | 纯类型定义，npm 发布 |
| 插槽注册层 | `cli/cmd/tui/plugin/slots.tsx` (61 行) | SolidJS Slot Registry |
| API 桥接层 | `cli/cmd/tui/plugin/api.tsx` (420 行) | 宿主上下文 → `TuiPluginApi` |
| 运行时 | `cli/cmd/tui/plugin/runtime.ts` (998 行) | 生命周期、加载/激活/清理 |
| 内置插件 | `cli/cmd/tui/feature-plugins/` | 9 个 internal plugin |
| 安装/CLI | `cli/cmd/plug.ts` + `plugin/install.ts` | `opencode plug <module>` |
| 规范文档 | `specs/tui-plugins.md` (410 行) | 完整技术参考 |

### 与 Server 插件的关系

- **v1 互斥**：一个模块只能导出 `server` 或 `tui`，不能同时。需要拆分文件 + `package.json` exports。
- **Server 保留 v0 兼容**：function exports / enumerated exports 仍可加载。
- **共享安装流程**：`install.ts` 统一处理 npm 安装、manifest 读取、config patch。

---

## 二、能力全景

### UI 扩展 — 插槽系统

8 个可注入插槽，按渲染模式分三类：

| 模式 | 插槽 | 说明 |
|---|---|---|
| `replace` | `home_logo`, `home_prompt` | 完全替换宿主 UI |
| `single_winner` | `sidebar_title`, `sidebar_footer` | 最后注册的赢 |
| 默认（多播） | `app`, `home_bottom`, `sidebar_content` | 多插件内容按 `order` 排列叠加 |

`sidebar_content` 的 order 分层：context(100) → mcp(200) → lsp(300) → todo(400) → files(500)，外部插件可插入任意位置。

### 路由系统

- 注册自定义路由页面（`home` 和 `session` 为保留名）
- 路由间导航 + 参数传递（`api.route.navigate(name, params?)`）
- `api.route.current` 感知当前位置（home / session / 自定义）
- 未知路由渲染 fallback 页面（含 go home 操作）

### 命令 + 快捷键

- 注册命令：title、value、category、keybind、slash name、aliases
- 隐藏命令仍响应快捷键和 `command.trigger()`
- 支持斜杠命令（如 `/smoke`）
- 插件级 keybind 集合（`api.keybind.create()`），支持用户覆盖

### 对话框 & Toast

| 组件 | 用途 |
|---|---|
| `DialogAlert` | 确认提示 |
| `DialogConfirm` | 二选一确认 |
| `DialogPrompt` | 文本输入 |
| `DialogSelect` | 列表选择（支持分类、快捷键、搜索过滤） |
| `Dialog` | 基础对话框包装 |
| `api.ui.dialog.replace()` | 在宿主 dialog 栈上叠加自定义界面 |
| `api.ui.toast()` | 轻量提示 |

### 数据访问（`api.state`）

实时同步的宿主状态：

| 域 | 可读数据 |
|---|---|
| Session | messages、todo、diff、status、permission、question |
| 环境 | config、provider 列表、path (state/config/worktree/directory)、vcs.branch |
| Workspace | list()、get(workspaceID) |
| 工具 | lsp()、mcp() |
| Part | part(messageID) — 消息的各部分内容 |

### 主题系统

- `api.theme.current` — 60+ 个 RGBA 色值 token（含 diff、markdown、syntax 高亮色）
- `api.theme.set(name)` / `has(name)` / `mode()` — 切换/检测
- `api.theme.install(jsonPath)` — 安装主题 JSON 文件
- 插件更新时自动同步已追踪主题的变更

### SDK Client

- `api.client` — 当前 workspace 的 SDK client
- `api.scopedClient(workspaceID)` — 绑定特定 workspace
- `api.event.on(type, handler)` — 订阅 SSE 事件流，返回 unsubscribe
- `api.renderer` — 原始 CliRenderer（可添加后处理特效，如 VignetteEffect）

### KV 持久化

- `api.kv.get/set` — 基于 `state/kv.json` 的共享键值存储
- **非命名空间**，所有插件共享同一 KV 空间
- `api.kv.ready` 等待加载完成

### 插件间管理

- `api.plugins.list()` — 所有插件状态（id、source、enabled、active）
- `api.plugins.activate(id)` / `deactivate(id)` — 运行时切换
- `api.plugins.install(spec, options)` — 运行时安装新插件
- `api.plugins.add(spec)` — 运行时加载（不写入配置）

### 生命周期

| 阶段 | 行为 |
|---|---|
| 加载 | 内部插件优先 → 外部插件并行解析 → 顺序激活（确定性副作用） |
| 激活 | 传入 `api`、`options`、`meta`，执行 `tui()` 函数 |
| 失败 | 回滚该插件的 commands/routes/slots/events 注册 |
| 清理 | `lifecycle.onDispose()` 注册的回调，逆序执行，5 秒超时预算 |
| 元数据 | `meta.state`: `first` / `updated` / `same`，感知插件更新状态 |

---

## 三、插件形态

### 文件插件（本地开发）

```json
// .opencode/tui.json
{
  "$schema": "https://opencode.ai/tui.json",
  "theme": "smoke-theme",
  "plugin": ["./plugins/demo.tsx", { "label": "demo" }],
  "plugin_enabled": { "demo": false }
}
```

文件插件必须导出非空 `id`。路径相对于 `tui.json` 所在目录解析。

### npm 插件（发布分发）

```bash
opencode plug @acme/opencode-plugin          # latest
opencode plug @acme/opencode-plugin@1.2.3    # pin 版本
opencode plug @acme/opencode-plugin -g       # 全局安装
opencode plug @acme/opencode-plugin -f       # 强制替换
```

包结构要求：

```json
{
  "name": "@acme/opencode-plugin",
  "exports": {
    "./server": { "import": "./dist/server.js" },
    "./tui": { "import": "./dist/tui.js" }
  },
  "engines": { "opencode": "^1.0.0" }
}
```

- 版本兼容性通过 `engines.opencode` 声明
- 安装使用 `--ignore-scripts`，不执行包生命周期脚本
- pin 版本（`pkg@1.2.3`）不会自动更新
- `plugin_enabled` 持久化到 KV，启动时覆盖配置

### 最小模块示例

```tsx
/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const tui: TuiPlugin = async (api) => {
  api.command.register(() => [
    {
      title: "Demo",
      value: "demo.open",
      onSelect: () => api.route.navigate("demo"),
    },
  ])

  api.route.register([
    {
      name: "demo",
      render: () => <box><text>demo</text></box>,
    },
  ])
}

export default { id: "acme.demo", tui } satisfies TuiPluginModule & { id: string }
```

---

## 四、内置插件分析

9 个 internal plugin 展示了系统的实际用法：

| 插件 ID | 功能 | 使用的 API |
|---|---|---|
| `home-footer` | 首页底栏：目录+分支、MCP 状态、版本号 | `slots.home_footer`, `state.path`, `state.vcs`, `state.mcp`, `app.version` |
| `home-tips` | 首页提示条，可隐藏 | `slots.home_bottom`, `command.register`, `kv.get/set`, `route.current`, `state.session.count` |
| `sidebar-context` | 侧栏上下文信息：token 用量、上下文占比、花费 | `slots.sidebar_content` (order 100), `state.session.messages` |
| `sidebar-mcp` | MCP 服务状态列表 | `slots.sidebar_content` (order 200), `state.mcp()` |
| `sidebar-lsp` | LSP 服务状态列表 | `slots.sidebar_content` (order 300), `state.lsp()` |
| `sidebar-todo` | 会话 Todo 列表 | `slots.sidebar_content` (order 400), `state.session.todo()` |
| `sidebar-files` | 会话文件变更列表 | `slots.sidebar_content` (order 500), `state.session.diff()` |
| `sidebar-footer` | 侧栏底栏 | `slots.sidebar_footer` |
| `plugin-manager` | 插件管理器（列表/切换/安装） | `command.register`, `ui.dialog.replace`, `plugins.list/activate/deactivate/install` |

**关键观察**：sidebar 内置插件的 order 从 100 到 500，外部插件可通过 order 值插入任意位置。

---

## 五、本空间利用分析

### 当前状态

| 项目 | 现状 |
|---|---|
| 宿主 | OpenCode (CLI mode) |
| Server 插件 | 有（`opencode.jsonc` → `plugins` 字段） |
| TUI 插件 | **无**（无 `tui.json`，无 `.opencode/plugins/`） |
| 配置层 | `.opencode/` 存在，但无 `tui.json` 和 `plugins/` 目录 |

### 可利用方向

| 方向 | 可行性 | 价值 | 复杂度 | 说明 |
|---|---|---|---|---|
| **A. 空间状态仪表盘** | ★★★★★ | 高 | 低 | `sidebar_content` slot 注入自定义 block，展示 ontology 状态、部署同步、memory 统计 |
| **B. 自定义 Home 页面** | ★★★★ | 高 | 中 | `home_logo` + `home_prompt` + `home_bottom` 全部可替换 |
| **C. 空间专属命令面板** | ★★★★ | 高 | 低 | 注册 `/plan`、`/deploy`、`/sync` 等斜杠命令 + 快捷键 |
| **D. 空间监控路由页** | ★★★ | 中 | 中 | 自定义路由页面，用 `api.state` + `api.client` 构建管理界面 |
| **E. 空间品牌主题** | ★★★ | 低-中 | 低 | `api.theme.install()` 安装 WopalSpace 主题 |
| **F. Server-TUI 联动** | ★★ | 中期 | 高 | KV + event bus 让 TUI 插件与 Server 插件协作 |

### 约束与风险

| 约束 | 影响 | 应对 |
|---|---|---|
| 技术栈：JSX + SolidJS + `@opentui/solid` | 需要熟悉 SolidJS 响应式模式 | 文件插件可直接用，npm 包需构建流程 |
| Server / TUI 互斥 | 现有能力层插件无法直接迁移 | 拆分为独立模块，通过 exports 分离 |
| OpenTUI 快速迭代（0.1.91→0.1.95） | API 可能继续变化 | 先用文件插件试水，不急于 npm 包化 |
| 自定义 slot name 未开放 | 只能用预定义 8 个 | 等待官方支持，当前够用 |
| `api.kv` 非命名空间 | 多插件 KV 冲突风险 | key 加 plugin id 前缀 |
| 内置插件不可卸载 | 可能与自定义 sidebar 插槽冲突 | 通过 order 值控制排列顺序 |

### 推荐路径

#### 短期：文件插件试水

1. 创建 `.opencode/tui.json`
2. 创建 `.opencode/plugins/` 目录
3. 编写 **空间 Home 定制插件**：
   - 替换 `home_logo` 为 Wopal ASCII art
   - 替换 `home_prompt` 为空间专属提示
   - 在 `home_bottom` 添加空间快速操作入口
4. 编写 **sidebar 状态块插件**：
   - 在 `sidebar_content` (order 50) 插入空间级状态信息
5. 注册空间快捷命令（`/sync`、`/deploy` 等）

#### 中期：npm 包化

- 将 TUI 插件打包为 `@wopal/space-tui`
- 通过 `opencode plug @wopal/space-tui` 一键安装
- Server 插件（能力层）和 TUI 插件（UI 层）分而治之

#### 暂缓

- 等待 OpenTUI API 稳定后再做深度定制
- 自定义 slot name 支持后再做复杂布局
- 等待 `api.plugins` 管理能力完善后再做插件生态