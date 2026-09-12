# OpenCode SDK 差距分析报告

> 分析日期：2026-03-11
> 官方 SDK 版本：@opencode-ai/sdk v1.2.24
> 项目路径：projects/ontology/tools/opencode-sdk

---

## 一、项目概述

`opencode-sdk` 是基于官方 `@opencode-ai/sdk` 封装的 TypeScript CLI 工具，提供命令行接口与 OpenCode 后台服务交互。

**项目架构：**
```
opencode-sdk/
├── src/
│   ├── cli/
│   │   ├── commands/     # CLI 命令实现
│   │   ├── api/          # API 客户端封装
│   │   ├── output/       # 输出格式化
│   │   └── utils/        # 工具函数
│   └── index.ts
├── dist/generated/       # 自动生成的类型定义
└── package.json
```

**核心依赖：**
- `@opencode-ai/sdk` - 官方 SDK（提供完整 API 客户端）
- `commander` - CLI 框架
- `chalk` / `ora` / `cli-table3` - 终端美化

---

## 二、已实现的 CLI 命令

### Global 模块
| 命令 | API | 功能 | 状态 |
|------|-----|------|------|
| `oc global health` | `fetch(/global/health)` | 健康检查 | ✅ |
| `oc global agents` | `api.app.agents()` | 列出可用 Agent | ✅ |
| `oc global commands` | `api.command.list()` | 列出可用命令 | ✅ |

### Session 模块
| 命令 | API | 功能 | 状态 |
|------|-----|------|------|
| `oc session list` | `api.session.list()` | 列出会话 | ✅ |
| `oc session create` | `api.session.create()` | 创建会话 | ✅ |
| `oc session get <id>` | `api.session.messages()` | 查看会话消息 | ✅ |
| `oc session delete <id>` | `api.session.delete()` | 删除会话 | ✅ |
| `oc session abort <id>` | `api.session.abort()` | 中止会话 | ✅ |
| `oc session messages <id>` | `api.session.messages()` | 查看消息列表 | ✅ |

### Project 模块
| 命令 | API | 功能 | 状态 |
|------|-----|------|------|
| `oc project current` | `api.project.current()` | 当前项目 | ✅ |
| `oc project list` | `api.project.list()` | 项目列表 | ✅ |

### Provider 模块
| 命令 | API | 功能 | 状态 |
|------|-----|------|------|
| `oc provider list` | `api.provider.list()` | 提供商列表 | ✅ |
| `oc provider auth` | `api.provider.auth()` | 认证状态 | ✅ |

### Config 模块
| 命令 | API | 功能 | 状态 |
|------|-----|------|------|
| `oc config get` | `api.config.get()` | 获取配置 | ✅ |
| `oc config set <k> <v>` | `api.config.update()` | 设置配置 | ✅ |

### File 模块
| 命令 | API | 功能 | 状态 |
|------|-----|------|------|
| `oc file list <path>` | `api.file.list()` | 列出目录 | ✅ |
| `oc file read <path>` | `api.file.read()` | 读取文件 | ✅ |

### Find 模块
| 命令 | API | 功能 | 状态 |
|------|-----|------|------|
| `oc find files <pattern>` | `api.find.files()` | 查找文件 | ✅ |
| `oc find text <pattern>` | `api.find.text()` | 搜索文本 | ✅ |
| `oc find symbols <query>` | `api.find.symbols()` | 查找符号 | ✅ |

### Prompt 模块
| 命令 | API | 功能 | 状态 |
|------|-----|------|------|
| `oc prompt <msg> -s <id>` | `api.session.prompt()` | 发送消息 | ✅ |
| `oc prompt <msg> -s <id> --stream` | `api.session.promptAsync()` | 流式响应 | ✅ |

---

## 三、未实现的 CLI 命令（差距分析）

### Session 高级功能（差距最大）

| API | 功能 | 优先级 | 说明 |
|-----|------|--------|------|
| `session.status` | 获取会话状态（idle/busy/retry） | **P0** | 判断会话是否可操作 |
| `session.update` | 更新会话属性（title, archived） | P1 | 会话管理 |
| `session.children` | 获取子会话列表 | P1 | 会话树导航 |
| `session.todo` | 获取会话 Todo 列表 | **P0** | 任务跟踪 |
| `session.init` | 分析项目生成 AGENTS.md | **P0** | 项目初始化 |
| `session.fork` | 从特定消息分叉会话 | P1 | 会话分支 |
| `session.share` | 共享会话 | P1 | 协作功能 |
| `session.unshare` | 取消共享会话 | P1 | 协作功能 |
| `session.diff` | 获取会话变更差异 | **P0** | 代码变更查看 |
| `session.summarize` | 摘要会话 | P1 | 上下文压缩 |
| `session.message` | 获取单个消息详情 | P1 | 消息详情 |
| `session.command` | 发送命令到会话 | **P0** | 命令执行 |
| `session.shell` | 运行 Shell 命令 | P1 | 终端命令 |
| `session.revert` | 回滚消息 | P1 | 版本控制 |
| `session.unrevert` | 恢复回滚的消息 | P1 | 版本控制 |
| `session.deleteMessage` | 删除特定消息 | P2 | 消息管理 |
| `session.part.update` | 更新消息部分 | P2 | 细粒度编辑 |
| `session.part.delete` | 删除消息部分 | P2 | 细粒度编辑 |

### PTY 终端管理（完全未实现）

| API | 功能 | 优先级 | 说明 |
|-----|------|--------|------|
| `pty.list` | 列出 PTY 会话 | **P0** | 后台进程查看 |
| `pty.create` | 创建 PTY 会话 | **P0** | 启动后台进程 |
| `pty.remove` | 移除 PTY 会话 | P1 | 清理进程 |
| `pty.get` | 获取 PTY 信息 | P1 | 进程详情 |
| `pty.update` | 更新 PTY（title, size） | P2 | 终端配置 |
| `pty.connect` | 连接到 PTY | P1 | 进程交互 |

**使用场景：** 后台运行长时间任务（测试、构建、服务器等）

### MCP 服务管理（完全未实现）

| API | 功能 | 优先级 | 说明 |
|-----|------|--------|------|
| `mcp.status` | 获取 MCP 服务状态 | **P0** | 服务健康检查 |
| `mcp.add` | 动态添加 MCP 服务 | **P0** | 运行时扩展 |
| `mcp.connect` | 连接 MCP 服务 | P1 | 服务连接 |
| `mcp.disconnect` | 断开 MCP 服务 | P1 | 服务断开 |
| `mcp.auth.start` | 启动 OAuth 认证 | P1 | 远程 MCP 认证 |
| `mcp.auth.callback` | OAuth 回调 | P1 | 认证完成 |
| `mcp.auth.authenticate` | 自动认证流程 | P1 | 一键认证 |
| `mcp.auth.remove` | 移除认证凭证 | P2 | 凭证管理 |

**使用场景：** 动态加载/管理 Model Context Protocol 服务

### 权限与问题交互（完全未实现）

| API | 功能 | 优先级 | 说明 |
|-----|------|--------|------|
| `permission.list` | 列出待处理权限请求 | **P0** | 非交互模式必需 |
| `permission.reply` | 回复权限请求 | **P0** | 非交互模式必需 |
| `question.list` | 列出待回答问题 | **P0** | 非交互模式必需 |
| `question.reply` | 回答问题 | **P0** | 非交互模式必需 |
| `question.reject` | 拒绝问题 | P1 | 取消操作 |

**关键说明：** 
这些 API 是实现**非交互模式自动化**的核心。当 Agent 在后台运行时，无法通过 TUI 交互，必须通过 API 响应权限请求和问题。

### 工具管理（完全未实现）

| API | 功能 | 优先级 | 说明 |
|-----|------|--------|------|
| `tool.ids` | 列出所有工具 ID | P1 | 工具发现 |
| `tool.list` | 列出工具及参数 Schema | P1 | 工具详情 |

**使用场景：** 查询当前可用的工具及其参数定义

### Workspace/Worktree 管理（实验性 API）

| API | 功能 | 优先级 | 说明 |
|-----|------|--------|------|
| `experimental.workspace.list` | 列出工作区 | P2 | 工作区管理 |
| `experimental.workspace.create` | 创建工作区 | P2 | 并行开发 |
| `experimental.workspace.remove` | 移除工作区 | P2 | 清理工作区 |
| `experimental.worktree.list` | 列出 worktree | P1 | Git worktree |
| `experimental.worktree.create` | 创建 worktree | P1 | 并行分支开发 |
| `experimental.worktree.remove` | 移除 worktree | P1 | 清理 worktree |
| `experimental.worktree.reset` | 重置 worktree | P2 | 状态恢复 |
| `experimental.session.list` | 全局会话列表 | P1 | 跨项目会话 |
| `experimental.resource.list` | MCP 资源列表 | P2 | 资源发现 |

### 事件订阅（完全未实现）

| API | 功能 | 优先级 | 说明 |
|-----|------|--------|------|
| `event.subscribe` | 订阅项目事件流 | **P0** | 实时事件监听 |
| `global.event` | 获取全局事件流 | **P0** | 跨项目事件 |

**事件类型：**
- `session.status` - 会话状态变更
- `session.created/deleted/updated` - 会话生命周期
- `message.updated/part.updated` - 消息更新
- `permission.asked` - 权限请求
- `question.asked` - 问题请求
- `file.edited` - 文件编辑
- `pty.created/exited` - PTY 生命周期
- `mcp.tools.changed` - MCP 工具变更

### TUI 控制（完全未实现）

| API | 功能 | 优先级 | 说明 |
|-----|------|--------|------|
| `tui.appendPrompt` | 追加提示文本 | P2 | TUI 控制 |
| `tui.submitPrompt` | 提交提示 | P2 | TUI 控制 |
| `tui.clearPrompt` | 清空提示 | P2 | TUI 控制 |
| `tui.executeCommand` | 执行 TUI 命令 | P2 | TUI 控制 |
| `tui.showToast` | 显示 Toast | P2 | TUI 控制 |
| `tui.selectSession` | 选择会话 | P2 | TUI 控制 |
| `tui.openHelp/Sessions/Themes/Models` | 打开对话框 | P3 | TUI 控制 |
| `tui.publish` | 发布 TUI 事件 | P3 | TUI 控制 |
| `tui.control.next/response` | 控制流 | P3 | TUI 控制 |

**说明：** TUI API 主要用于外部程序控制 OpenCode TUI 界面，CLI 场景使用较少。

### 其他 API

| API | 功能 | 优先级 | 说明 |
|-----|------|--------|------|
| `instance.dispose` | 销毁当前实例 | P1 | 资源清理 |
| `path.get` | 获取路径信息 | P2 | 路径查询 |
| `vcs.get` | 获取 VCS 信息 | P2 | Git 状态 |
| `app.log` | 写日志 | P2 | 日志记录 |
| `app.skills` | 列出技能 | P1 | 技能发现 |
| `lsp.status` | LSP 服务状态 | P1 | 语言服务 |
| `formatter.status` | 格式化器状态 | P2 | 代码格式化 |
| `auth.set` | 设置认证凭证 | P1 | 提供商认证 |
| `auth.remove` | 移除认证凭证 | P2 | 凭证管理 |
| `project.git/init` | 初始化 Git | P2 | 项目初始化 |
| `project.update` | 更新项目信息 | P2 | 项目配置 |
| `config.providers` | 获取提供商配置 | P1 | 配置查询 |

---

## 四、覆盖率统计

### 按模块统计

| 模块 | 官方 API 数量 | 已实现 CLI | 覆盖率 |
|------|--------------|-----------|--------|
| Session | 22 | 6 | **27%** |
| PTY | 6 | 0 | **0%** |
| MCP | 8 | 0 | **0%** |
| Permission/Question | 5 | 0 | **0%** |
| Tool | 2 | 0 | **0%** |
| Workspace/Worktree | 9 | 0 | **0%** |
| TUI | 13 | 0 | **0%** |
| Event | 2 | 0 | **0%** |
| Global | 3 | 3 | **100%** |
| Project | 4 | 2 | **50%** |
| Provider | 5 | 2 | **40%** |
| Config | 3 | 2 | **67%** |
| File | 3 | 2 | **67%** |
| Find | 3 | 3 | **100%** |
| Prompt | 2 | 2 | **100%** |
| Auth | 2 | 0 | **0%** |
| Instance | 1 | 0 | **0%** |
| Path/VCS | 2 | 0 | **0%** |
| App | 3 | 0 | **0%** |
| LSP/Formatter | 2 | 0 | **0%** |

### 总体统计

| 指标 | 数值 |
|------|------|
| 官方 API 总数 | ~98 |
| 已实现 CLI 命令 | ~22 |
| **总体覆盖率** | **~22%** |

---

## 五、优先级建议

### P0 - 核心能力（必须实现）

这些 API 是实现完整自动化工作流的基础：

1. **`session.diff`** - 查看代码变更，评估 Agent 工作结果
2. **`session.todo`** - 任务跟踪，了解进度
3. **`session.command`** - 执行斜杠命令
4. **`session.status`** - 判断会话状态
5. **`session.init`** - 项目初始化
6. **`permission.list/reply`** - 权限交互（非交互模式必需）
7. **`question.list/reply/reject`** - 问题交互（非交互模式必需）
8. **`event.subscribe` / `global.event`** - 实时事件监听

### P1 - 重要功能

1. **`pty.*`** - 后台进程管理，支持长时间任务
2. **`mcp.status/add/connect`** - MCP 服务管理
3. **`session.share`** - 会话共享
4. **`tool.ids/list`** - 工具发现
5. **`experimental.worktree.*`** - Git worktree 管理
6. **`experimental.session.list`** - 跨项目会话视图
7. **`auth.set`** - 提供商认证
8. **`lsp.status`** - 语言服务状态
9. **`app.skills`** - 技能列表

### P2 - 锦上添花

1. `session.fork/revert/unrevert` - 会话版本控制
2. `session.update/children` - 会话管理
3. `experimental.workspace.*` - 工作区管理
4. `config.providers` - 提供商配置查询
5. `path.get/vcs.get` - 路径和 VCS 信息
6. `formatter.status` - 格式化器状态

### P3 - 低优先级

1. `tui.*` - TUI 控制（仅 TUI 场景需要）
2. `session.part.update/delete` - 细粒度消息编辑
3. `mcp.auth.*` - MCP OAuth（大多数场景用本地 MCP）

---

## 六、实现建议

### 架构建议

当前实现直接使用官方 SDK，架构简洁。建议：

1. **保持现有模式** - 继续使用 `@opencode-ai/sdk` 作为底层
2. **补充事件处理** - 添加 SSE 事件订阅的 CLI 封装
3. **统一错误处理** - 当前 `withCommandHandler` 已有基础，可扩展

### CLI 命令设计建议

```bash
# Session 高级命令
oc session status <id>           # 会话状态
oc session diff <id>             # 查看变更
oc session todo <id>             # Todo 列表
oc session command <id> <cmd>    # 执行命令

# PTY 管理
oc pty list                      # 列出 PTY
oc pty create <cmd>              # 创建 PTY
oc pty connect <id>              # 连接 PTY

# 权限/问题
oc permission list               # 待处理权限
oc permission reply <id> <action> # 回复权限
oc question list                 # 待回答问题
oc question reply <id> <answer>  # 回答问题

# MCP 管理
oc mcp status                    # MCP 状态
oc mcp add <name> <config>       # 添加 MCP
oc mcp connect <name>            # 连接 MCP

# 事件监听
oc event subscribe               # 订阅事件流
oc event global                  # 全局事件流
```

### 事件处理示例

```typescript
// src/cli/commands/event.ts
import { getApi } from '../api/client.js';

export const eventCommand = new Command('event');

eventCommand
  .command('subscribe')
  .description('Subscribe to project events')
  .option('-d, --directory <path>')
  .action(async (options) => {
    const api = getApi();
    const eventStream = await api.event.subscribe({
      query: { directory: options.directory }
    });
    
    eventStream.on('message', (event) => {
      console.log(JSON.stringify(event));
    });
  });
```

---

## 七、结论

当前 `opencode-sdk` 项目实现了约 **22%** 的官方 API 能力，覆盖了基础的会话、项目、文件操作。

**主要差距：**
1. **Session 高级功能** - 缺少 diff、todo、command 等核心能力
2. **权限/问题交互** - 完全缺失，无法支持非交互模式
3. **事件订阅** - 完全缺失，无法实现实时响应
4. **PTY/MCP 管理** - 完全缺失，无法管理后台进程和 MCP 服务

**建议优先级：**
1. 先实现 P0 级别的 8 个核心 API
2. 再实现 P1 级别的 PTY 和 MCP 管理
3. 最后根据实际需求补充 P2/P3 功能

---

*报告生成于 2026-03-11*