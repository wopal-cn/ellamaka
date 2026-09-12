# OpenCode Project/Worktree/Workspace 架构分析报告

> 研究日期: 2026-03-11
> 研究对象: OpenCode 官方 SDK v1.2.x

---

## 一、核心概念定义

### Project

**定义**: Git 仓库的逻辑抽象，代表一个独立的项目。

**核心特征**:
- ID 由 Git root commit hash 生成（唯一标识）
- 包含主 worktree 和派生 worktree（sandboxes）
- 作为 Session 的顶层归属容器

**源码位置**: `src/project/project.ts`

**数据模型** (`project/project.ts:33-61`):
```typescript
const Info = z.object({
  id: z.string(),           // Git root commit hash
  worktree: z.string(),     // 主 worktree 物理路径
  vcs: z.literal("git").optional(),
  name: z.string().optional(),
  icon: {
    url: z.string().optional(),
    override: z.string().optional(),
    color: z.string().optional()
  }.optional(),
  commands: {
    start: z.string().optional()  // 启动脚本
  }.optional(),
  time: {
    created: z.number(),
    updated: z.number(),
    initialized: z.number().optional()
  },
  sandboxes: z.array(z.string()),  // 派生 worktree 路径数组
})
```

**数据库表** (`project/project.sql.ts`):
```typescript
const ProjectTable = sqliteTable("project", {
  id: text().primaryKey(),
  worktree: text().notNull(),
  vcs: text(),
  name: text(),
  icon_url: text(),
  icon_color: text(),
  time_created: integer(),
  time_updated: integer(),
  time_initialized: integer(),
  sandboxes: text({ mode: "json" }).notNull().$type<string[]>(),
  commands: text({ mode: "json" }).$type<{ start?: string }>(),
})
```

### Worktree

**定义**: Git worktree 的物理实现，提供目录隔离机制。

**核心特征**:
- 物理上是 Git worktree（`git worktree add`）
- 分支命名规范: `opencode/<name>`
- 存储路径: `<Global.Path.data>/worktree/<project-id>/<name>`

**源码位置**: `src/worktree/index.ts`

**数据模型** (`worktree/index.ts:36-45`):
```typescript
const Info = z.object({
  name: z.string(),      // 如 "brave-comet"
  branch: z.string(),    // 如 "opencode/brave-comet"
  directory: z.string(), // 如 "/data/worktree/abc123/brave-comet"
})
```

**命名规则** (`worktree/index.ts:124-188`):
- 形容词池: brave, calm, clever, cosmic, crisp, curious, eager, gentle, glowing, happy, hidden, jolly, kind, lucky, mighty, misty, neon, nimble, playful, proud, quick, quiet, shiny, silent, stellar, sunny, swift, tidy, witty
- 名词池: cabin, cactus, canyon, circuit, comet, eagle, engine, falcon, forest, garden, harbor, island, knight, lagoon, meadow, moon, mountain, nebula, orchid, otter, panda, pixel, planet, river, rocket, sailor, squid, star, tiger, wizard, wolf
- 生成格式: `<adjective>-<noun>` 或 `<base>-<adjective>-<noun>`

### Sandbox（深度分析）

**定义**: Project 的 `sandboxes` 字段中存储的 Worktree 目录路径。

**核心特征**:
- **不是独立实体**，而是 Project 的字段
- **本质是 Worktree 的物理路径字符串数组**
- 用于追踪 Project 下所有派生的 worktree

**数据来源** (`project/project.ts:236-238`):
```typescript
// 自动检测并注册
if (data.sandbox !== result.worktree && !result.sandboxes.includes(data.sandbox))
  result.sandboxes.push(data.sandbox)
// 过滤不存在的目录
result.sandboxes = result.sandboxes.filter((x) => existsSync(x))
```

**Sandbox 与 Worktree 的关系**:

| 术语 | 含义 | 存储位置 |
|------|------|----------|
| **主 Worktree** | Git 仓库原始目录 | `Project.worktree` |
| **Sandbox** | 派生 worktree（通过 `git worktree add` 创建） | `Project.sandboxes[]` |
| **当前 Sandbox** | 用户启动 opencode 时所在的 worktree | `Instance.worktree` |

**命名评价**:

当前命名不够清晰，建议的更优命名：

| 当前命名 | 含义 | 更好的命名 |
|----------|------|-----------|
| `Project.worktree` | 主仓库路径 | `repository` / `rootWorktree` |
| `Project.sandboxes` | 派生 worktree 列表 | `worktrees` / `derivedWorktrees` |

> **结论**: Sandbox = Worktree 的同义词，只是在不同语境下的称呼。主 worktree 存储在 `Project.worktree`，派生的存储在 `Project.sandboxes[]`。

### Workspace

**定义**: Worktree 的业务抽象层，提供 API 级别的隔离。

**核心特征**:
- **可选层**（不创建时 Session 直接属于 Project）
- 目前仅支持 `type: "worktree"`，架构预留扩展能力
- 通过 Adaptor 模式实现底层操作

**源码位置**: `src/control-plane/workspace.ts`

**数据模型** (`control-plane/types.ts:4-13`):
```typescript
const WorkspaceInfo = z.object({
  id: Identifier.schema("workspace"),  // wrk_xxx
  type: z.string(),                     // 目前仅 "worktree"
  branch: z.string().nullable(),        // git 分支名
  name: z.string().nullable(),          // 显示名
  directory: z.string().nullable(),     // 物理路径
  extra: z.unknown().nullable(),        // 扩展字段
  projectID: z.string(),                // 外键 → Project.id
})
```

**数据库表** (`control-plane/workspace.sql.ts`):
```typescript
const WorkspaceTable = sqliteTable("workspace", {
  id: text().primaryKey(),
  type: text().notNull(),
  branch: text(),
  name: text(),
  directory: text(),
  extra: text({ mode: "json" }),
  project_id: text().notNull().references(() => ProjectTable.id, { onDelete: "cascade" }),
})
```

**设计意图**: Workspace 是为未来扩展预留的抽象层：

```
Project (Git 仓库)
    │
    ├── Worktree (物理隔离，本地 Git worktree)
    │
    └── Workspace (业务抽象，Adaptor 模式)
            │
            ├── type: "worktree"  ← 当前唯一实现
            ├── type: "docker"    ← 预留
            ├── type: "cloud"     ← 预留（远程 SSE 同步）
            └── type: "???"       ← 未来可扩展
```

**核心设计**:
1. **Adaptor 接口** (`control-plane/types.ts:15-20`)：`configure` / `create` / `remove` / `fetch`
2. **远程同步** (`workspace.ts:114-151`)：`workspaceEventLoop` 通过 SSE 监听远程 workspace 事件
3. **`type !== "worktree"` 才启动同步**：暗示未来非本地 workspace 需要远程通信

**SDK 成熟度评估**:

| 层面 | 状态 |
|------|------|
| **服务端 API** | ✅ 可用 (`/experimental/workspace`) |
| **SDK 类型** | ✅ 已生成 (`ExperimentalClient.list/create/remove`) |
| **Adaptor 实现** | ⚠️ 仅 `worktree` 一种 |
| **文档** | ❌ 无 |
| **生产使用** | ❌ 未推广 |

> **结论**: Workspace 是半成品架构，API 能用但只有 worktree 一种实现，本质上是对 Worktree 的薄封装。除非未来扩展其他类型（如远程/容器），否则直接用 Worktree API 更简洁。

### Session

**定义**: 对话工作单元，可属于 Project 或 Workspace。

**核心特征**:
- 最小工作单元
- `workspaceID` 字段可选
- `directory` 字段记录创建时的物理路径

**数据模型** (`session/index.ts:119-161`):
```typescript
const Info = z.object({
  id: Identifier.schema("session"),
  slug: z.string(),
  projectID: z.string(),
  workspaceID: z.string().optional(),  // 可选！
  directory: z.string(),
  parentID: Identifier.schema("session").optional(),
  summary: {
    additions: z.number(),
    deletions: z.number(),
    files: z.number(),
    diffs: Snapshot.FileDiff.array().optional()
  }.optional(),
  share: { url: z.string() }.optional(),
  title: z.string(),
  version: z.string(),
  time: {
    created: z.number(),
    updated: z.number(),
    compacting: z.number().optional(),
    archived: z.number().optional()
  },
  permission: PermissionNext.Ruleset.optional(),
  revert: {
    messageID: z.string(),
    partID: z.string().optional(),
    snapshot: z.string().optional(),
    diff: z.string().optional()
  }.optional(),
})
```

### Directory（物理工作目录）

**定义**: 用户通过 API 请求传入的**物理工作目录**，是 OpenCode 运行时上下文的入口参数。

**来源优先级** (`server.ts:200`):
```typescript
const raw = c.req.query("directory")      // 1. URL 查询参数
  || c.req.header("x-opencode-directory") // 2. HTTP Header
  || process.cwd()                         // 3. 服务端当前目录（默认值）
const directory = decodeURIComponent(raw)  // URL 解码
```

**核心特征**:
- **物理属性**：文件系统上的真实路径（如 `/home/user/my-project/src/components`）
- **运行时确定**：每次 API 调用时通过请求参数传递
- **可以是子目录**：不一定是 Git 根目录，可能是任意深度的子目录
- **实例创建基础**：用于创建和标识 OpenCode Instance

**关键作用**:
1. 作为 `Instance.provide()` 的输入参数
2. 作为 Instance 缓存的 key（相同 directory 共享 Instance）
3. 触发 `Project.fromDirectory()` 解析 Project 信息

**与 Instance 的关系**:
```
HTTP Request (directory: "/workspace/src/components")
    ↓
Instance.provide({ directory })
    ↓
Project.fromDirectory(directory)
    ├── 向上查找 .git 目录
    ├── 解析 Git worktree 根目录 → Instance.worktree
    └── 返回 Project 信息 → Instance.project
    ↓
Instance 创建完成
    ├── Instance.directory = "/workspace/src/components" (原始输入)
    ├── Instance.worktree = "/workspace" (Git 根目录)
    └── Instance.project = { id: "abc123", ... }
```

### Directory vs Workspace vs Instance 对照

| 特性 | Directory | Instance | Workspace |
|------|-----------|----------|-----------|
| **性质** | 物理路径字符串 | 运行时上下文对象 | 持久化配置实体 |
| **来源** | HTTP 请求参数 | 内存中创建 | 数据库存储 |
| **生命周期** | 请求级 | 实例级（缓存） | 持久化 |
| **唯一标识** | 路径本身 | directory 字符串 | `wrk_xxx` ID |
| **远程支持** | 不支持 | 不支持 | 支持（通过 SSE 同步） |
| **多租户** | 单一用户 | 单一用户 | 多用户协作 |
| **包含关系** | Instance 的输入 | 包含 directory/worktree/project | 独立实体 |

**组合使用场景**:
```typescript
// 场景1: 仅使用 directory（本地开发，最常见）
// 请求: GET /session?directory=/home/user/my-project
// 效果: 创建/复用 Instance，Session 属于 Project

// 场景2: 同时使用 directory + workspace
// 请求: GET /session?directory=/home/user/my-project&workspace=wrk_xxx
// 效果: 在指定 workspace 上下文中执行，Session 属于 Workspace

// 场景3: 仅使用 workspace（远程模式）
// 请求: GET /session?workspace=wrk_remote_xxx
// 效果: 通过 SSE 同步远程 workspace 状态
```

---

## 二、架构层次关系

### 层次图

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Project                                    │
│  id: <git-root-commit-hash>                                         │
│  worktree: /path/to/main/repo                                       │
│  sandboxes: ["/data/worktree/.../sandbox1", "/data/.../sandbox2"]  │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    Workspace (可选层)                          │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────┐ │  │
│  │  │ Workspace A     │  │ Workspace B     │  │ Workspace C    │ │  │
│  │  │ type: worktree  │  │ type: worktree  │  │ type: remote?  │ │  │
│  │  │ branch: feat-a  │  │ branch: feat-b  │  │ (可扩展)       │ │  │
│  │  │ directory: ...  │  │ directory: ...  │  │                │ │  │
│  │  │                 │  │                 │  │                │ │  │
│  │  │ Sessions A1,A2  │  │ Sessions B1,B2  │  │ Sessions C1,C2 │ │  │
│  │  └─────────────────┘  └─────────────────┘  └────────────────┘ │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │              Main Worktree (无 Workspace 时)                    │ │
│  │              Sessions 直接绑定到 Project                        │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 术语关系对照表

| 术语 | 本质 | 层级 | 持久化 | 生命周期 | 示例 |
|------|------|------|--------|----------|------|
| **Directory** | 物理路径字符串 | 请求参数 | 无 | 请求级 | `/workspace/src/components` |
| **Instance** | 运行时上下文对象 | 运行时 | 无 | 实例级（缓存） | `{ directory, worktree, project }` |
| **Project** | Git 仓库逻辑抽象 | 顶层 | ProjectTable | 持久化 | `id: "abc123"` (root commit) |
| **Worktree** | Git 物理隔离机制 | 基础设施 | 无独立表 | Git 管理 | `git worktree add ...` |
| **Sandbox** | Project.sandboxes[] 中的路径 | Project 字段 | ProjectTable.sandboxes | 持久化 | 指向 Worktree 目录 |
| **Workspace** | Worktree 的 API 抽象层 | 可选业务层 | WorkspaceTable | 持久化 | `type: "worktree"` |
| **Session** | 对话工作单元 | 最小单元 | SessionTable | 持久化 | 属于 Project 或 Workspace |

---

## 三、核心算法与流程

### Project ID 生成算法

**源码位置**: `project/project.ts:90-204`

**算法步骤**:
1. 从当前目录向上搜索 `.git` 目录
2. 读取 `.git/opencode` 缓存文件（若存在）
3. 若无缓存，执行 `git rev-list --max-parents=0 --all` 获取所有 root commits
4. 取排序后的第一个 root commit 作为 ID
5. 写入 `.git/opencode` 文件缓存

**代码片段** (`project/project.ts:117-143`):
```typescript
if (!id) {
  const roots = await git(["rev-list", "--max-parents=0", "--all"], { cwd: sandbox })
    .then(async (result) =>
      (await result.text())
        .split("\n")
        .filter(Boolean)
        .map((x) => x.trim())
        .toSorted(),
    )
    .catch(() => undefined)

  if (!roots) {
    return {
      id: "global",
      worktree: sandbox,
      sandbox: sandbox,
      vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
    }
  }

  id = roots[0]
  if (id) {
    await Filesystem.write(path.join(dotgit, "opencode"), id).catch(() => undefined)
  }
}
```

**关键发现**:
- 同一 Git 仓库的所有 worktree 共享相同的 Project ID（因为共享 `.git` 目录）
- 无 Git 的目录使用 `"global"` 作为 ID
- 缓存机制避免重复计算

### Worktree 创建流程

**源码位置**: `worktree/index.ts:334-429`

**流程步骤**:
1. 调用 `makeWorktreeInfo()` 生成唯一名称和分支
2. 执行 `git worktree add --no-checkout -b <branch> <directory>`
3. 调用 `Project.addSandbox()` 注册到 Project.sandboxes[]
4. 异步执行 `git reset --hard` 填充文件
5. 执行 `Instance.provide()` 初始化实例
6. 执行启动脚本（project.commands.start + extra）

**代码片段** (`worktree/index.ts:346-418`):
```typescript
export async function createFromInfo(info: Info, startCommand?: string) {
  const created = await $`git worktree add --no-checkout -b ${info.branch} ${info.directory}`
    .quiet()
    .nothrow()
    .cwd(Instance.worktree)
  if (created.exitCode !== 0) {
    throw new CreateFailedError({ message: errorText(created) || "Failed to create git worktree" })
  }

  await Project.addSandbox(Instance.project.id, info.directory).catch(() => undefined)

  const projectID = Instance.project.id
  const extra = startCommand?.trim()

  return () => {
    const start = async () => {
      const populated = await $`git reset --hard`.quiet().nothrow().cwd(info.directory)
      if (populated.exitCode !== 0) {
        // ... 错误处理
      }

      const booted = await Instance.provide({
        directory: info.directory,
        init: InstanceBootstrap,
        fn: () => undefined,
      })
      // ... 事件通知
      await runStartScripts(info.directory, { projectID, extra })
    }
    void start().catch((error) => { /* ... */ })
  }
}
```

**关键发现**:
- 创建是两阶段：同步创建 + 异步初始化
- 使用 `--no-checkout` 避免立即填充文件
- 启动脚本支持项目级和 worktree 级两级

### Sandbox 自动注册机制

**源码位置**: `project/project.ts:236-238`

**触发条件**:
- 在 `Project.fromDirectory()` 中自动检测
- 当 `data.sandbox !== result.worktree` 且未在 `sandboxes[]` 中时注册

**代码片段**:
```typescript
if (data.sandbox !== result.worktree && !result.sandboxes.includes(data.sandbox))
  result.sandboxes.push(data.sandbox)
result.sandboxes = result.sandboxes.filter((x) => existsSync(x))
```

**关键发现**:
- 自动过滤不存在的目录
- 每次调用 `fromDirectory()` 都会更新 sandboxes 列表
- 主 worktree 不会被添加到 sandboxes（因为条件是 `!==`）

### Workspace 创建与 Adaptor 模式

**源码位置**: `control-plane/workspace.ts:55-87`, `control-plane/adaptors/worktree.ts`

**创建流程**:
1. 调用 `Workspace.create()` 传入 `type` 和 `projectID`
2. 通过 `getAdaptor(type)` 获取对应适配器
3. 调用 `adaptor.configure()` 生成配置（如 Worktree 名称/分支/目录）
4. 写入 WorkspaceTable
5. 调用 `adaptor.create()` 执行底层创建

**Adaptor 接口** (`control-plane/types.ts:15-20`):
```typescript
export type Adaptor = {
  configure(input: WorkspaceInfo): WorkspaceInfo | Promise<WorkspaceInfo>
  create(input: WorkspaceInfo, from?: WorkspaceInfo): Promise<void>
  remove(config: WorkspaceInfo): Promise<void>
  fetch(config: WorkspaceInfo, input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}
```

**WorktreeAdaptor 实现** (`control-plane/adaptors/worktree.ts:13-46`):
```typescript
export const WorktreeAdaptor: Adaptor = {
  async configure(info) {
    const worktree = await Worktree.makeWorktreeInfo(info.name ?? undefined)
    return {
      ...info,
      name: worktree.name,
      branch: worktree.branch,
      directory: worktree.directory,
    }
  },
  async create(info) {
    const config = Config.parse(info)
    const bootstrap = await Worktree.createFromInfo({
      name: config.name,
      directory: config.directory,
      branch: config.branch,
    })
    return bootstrap()
  },
  async remove(info) {
    const config = Config.parse(info)
    await Worktree.remove({ directory: config.directory })
  },
  async fetch(info, input, init?) {
    const config = Config.parse(info)
    const { WorkspaceServer } = await import("../workspace-server/server")
    // ... 转发请求到实际目录
  },
}
```

**关键发现**:
- Workspace 是 Worktree 的"逻辑包装层"
- Adaptor 模式预留扩展能力（目前仅 worktree 类型）
- `fetch()` 方法实现请求路由到实际物理目录

---

## 四、实际测试验证

### 本地测试（macOS）

**测试环境**:
- 平台: macOS
- 项目: wopal-workspace
- Project ID: `5abd9d34c6299911967441461a52109583124aef`

**创建 Worktree**:
```bash
curl -X POST http://localhost:3099/experimental/worktree \
  -H "Content-Type: application/json" \
  -d '{"name": "test-worktree-123"}'
```

**返回结果**:
```json
{
  "name": "test-worktree-123",
  "branch": "opencode/test-worktree-123",
  "directory": "/Users/sam/.local/share/opencode/worktree/5abd9d34c6299911967441461a52109583124aef/test-worktree-123"
}
```

**验证**:
```bash
$ git worktree list
/Users/sam/coding/wopal/wopal-workspace                                                               73672df [main]
/Users/sam/.local/share/opencode/worktree/5abd9d34c6299911967441461a52109583124aef/test-worktree-123  73672df [opencode/test-worktree-123]
```

### Docker 容器内测试

**测试环境**:
- 容器 ID: `f89d845504d4`
- 项目路径: `/workspace` (agent-tools)
- Project ID: `543f6025230cefff449109df38f3febc2899b691`
- 运行用户: `coder`

**创建 Workspace**:
```bash
curl -X POST http://127.0.0.1:20000/experimental/workspace \
  -H "Content-Type: application/json" \
  -d '{"type": "worktree", "branch": null}'
```

**返回结果**:
```json
{
  "id": "wrk_cdb568db5001bkGUh77xOAQDlk",
  "type": "worktree",
  "branch": "opencode/curious-meadow",
  "name": "curious-meadow",
  "directory": "/home/coder/.local/share/opencode/worktree/543f6025230cefff449109df38f3febc2899b691/curious-meadow",
  "extra": null,
  "projectID": "543f6025230cefff449109df38f3febc2899b691"
}
```

**容器内验证**:
```bash
$ docker exec f89d845504d4 ls /home/coder/.local/share/opencode/worktree/
543f6025230cefff449109df38f3febc2899b691/

$ docker exec f89d845504d4 git worktree list
/workspace                                                                                                bade9dc [main]
/home/coder/.local/share/opencode/worktree/543f6025230cefff449109df38f3febc2899b691/curious-meadow  bade9dc [opencode/curious-meadow]
```

### 测试结论

| 项目 | 本地测试 | Docker 测试 |
|------|---------|------------|
| Worktree 存储路径 | `~/.local/share/opencode/worktree/<project-id>/<name>` | `/home/coder/.local/share/opencode/worktree/<project-id>/<name>` |
| 分支命名 | `opencode/<name>` | `opencode/<name>` |
| Git worktree 关联 | ✅ 正常 | ✅ 正常 |
| API 响应 | ✅ 正常 | ✅ 正常 |

**注意**: 容器内 opencode 运行用户是 `coder`，所以数据目录在 `/home/coder/.local/share/opencode/`，而非 `/root/`。

---

## 五、API 端点汇总

### Project API

**源码位置**: `server/routes/project.ts`

| 端点 | 方法 | 说明 | 返回类型 |
|------|------|------|---------|
| `/project` | GET | 列出所有 Project | `Project.Info[]` |
| `/project/current` | GET | 获取当前 Project | `Project.Info` |
| `/project/:projectID` | PATCH | 更新 Project | `Project.Info` |

### Worktree API (Experimental)

**源码位置**: `server/routes/experimental.ts:92-189`

| 端点 | 方法 | 说明 | 返回类型 |
|------|------|------|---------|
| `/experimental/worktree` | POST | 创建 Worktree | `Worktree.Info` |
| `/experimental/worktree` | GET | 列出 Project.sandboxes | `string[]` |
| `/experimental/worktree` | DELETE | 删除 Worktree | `boolean` |
| `/experimental/worktree/reset` | POST | 重置 Worktree 到默认分支 | `boolean` |

### Workspace API (Experimental)

**源码位置**: `server/routes/workspace.ts`

| 端点 | 方法 | 说明 | 返回类型 |
|------|------|------|---------|
| `/experimental/workspace` | POST | 创建 Workspace | `Workspace.Info` |
| `/experimental/workspace` | GET | 列出 Workspaces | `Workspace.Info[]` |
| `/experimental/workspace/:id` | DELETE | 删除 Workspace | `Workspace.Info?` |

### Session API (Experimental - Global)

**源码位置**: `server/routes/experimental.ts:190-248`

| 端点 | 方法 | 说明 | 返回类型 |
|------|------|------|---------|
| `/experimental/session` | GET | 列出全局 Sessions | `Session.GlobalInfo[]` |

**查询参数**:
- `directory`: 按项目目录过滤
- `roots`: 仅返回根 Sessions（无 parentID）
- `start`: 过滤更新时间 >= 此时间戳
- `cursor`: 分页游标（更新时间 < 此值）
- `search`: 按标题搜索
- `limit`: 返回数量限制
- `archived`: 是否包含已归档（默认 false）

---

## 六、使用示例

### 创建 Worktree

```typescript
import { ExperimentalClient } from 'opencode-sdk';

const client = new ExperimentalClient({ baseUrl: 'http://localhost:8080' });

// 创建 Worktree
const worktree = await client.create({
  name: 'feature-login',
  directory: '/path/to/your/project'
});

console.log('Worktree 创建成功:', worktree);
// {
//   name: "feature-login",
//   branch: "opencode/feature-login",
//   directory: "/Users/sam/.local/share/opencode/worktree/xxx/feature-login"
// }
```

### 创建 Workspace

```typescript
// 创建 Workspace（内部是 Worktree）
const workspace = await client.create({
  type: 'worktree',
  branch: null,
  directory: '/path/to/your/project'
});

console.log('Workspace 创建成功:', workspace);
// {
//   id: "wrk_xxx",
//   type: "worktree",
//   branch: "opencode/curious-meadow",
//   name: "curious-meadow",
//   directory: "...",
//   projectID: "..."
// }
```

### 在 Worktree 中创建 Session

```typescript
// 1. 创建 worktree
const worktree = await client.create({
  name: 'new-feature',
  directory: '/path/to/project'
});

// 2. 在新 worktree 中创建会话
const session = await sessionClient.create({
  directory: worktree.directory
});

// 3. 发送消息
await sessionClient.prompt(session.id, {
  parts: [{ type: 'text', text: { content: '帮我开发这个功能' } }]
});
```

### 并行开发多个功能

```typescript
async function developMultipleFeatures() {
  const projectDir = '/path/to/my-project';
  
  // 为每个功能创建独立的 worktree
  const [featureA, featureB] = await Promise.all([
    client.create({ name: 'feature-login', directory: projectDir }),
    client.create({ name: 'feature-dashboard', directory: projectDir })
  ]);
  
  // 同时在两个 worktree 中工作
  const [sessionA, sessionB] = await Promise.all([
    sessionClient.create({ directory: featureA.directory }),
    sessionClient.create({ directory: featureB.directory })
  ]);
  
  // 并行发送消息
  await Promise.all([
    sessionClient.prompt(sessionA.id, {
      parts: [{ type: 'text', text: { content: '实现登录功能' } }]
    }),
    sessionClient.prompt(sessionB.id, {
      parts: [{ type: 'text', text: { content: '实现仪表盘' } }]
    })
  ]);
}
```

---

## 七、约束与限制

### Git Only 限制

**源码位置**: `worktree/index.ts:335-337`

```typescript
if (Instance.project.vcs !== "git") {
  throw new NotGitError({ message: "Worktrees are only supported for git projects" })
}
```

**约束**: Worktree/Sandbox/Workspace 仅支持 Git 项目（`vcs === "git"`）

### 主 Worktree 保护

**源码位置**: `worktree/index.ts:527-529`

```typescript
const directory = await canonical(input.directory)
const primary = await canonical(Instance.worktree)
if (directory === primary) {
  throw new ResetFailedError({ message: "Cannot reset the primary workspace" })
}
```

**约束**: 主 worktree 不可被 reset

### 分支命名规范

**源码位置**: `worktree/index.ts:271`

```typescript
const branch = `opencode/${name}`
```

**约束**: Worktree 分支必须使用 `opencode/` 前缀

### 路径存储规范

**源码位置**: `worktree/index.ts:339`

```typescript
const root = path.join(Global.Path.data, "worktree", Instance.project.id)
```

**约束**: Worktree 目录统一存储在 `<Global.Path.data>/worktree/<project-id>/` 下

**Global.Path.data 定义** (`src/global/index.ts:9`):
```typescript
const data = path.join(xdgData!, app)  // app = "opencode"
```

| 平台 | 路径 |
|------|------|
| **macOS/Linux** | `~/.local/share/opencode` (若未设置 `XDG_DATA_HOME`) |
| **自定义** | `$XDG_DATA_HOME/opencode` (若设置了环境变量) |

---

## 八、Instance 上下文机制

### Instance 定义与核心职责

**源码位置**: `project/instance.ts`

**核心职责**:
1. **上下文隔离**：基于 Node.js `AsyncLocalStorage` 实现请求级上下文隔离
2. **实例缓存**：相同 directory 共享 Instance，避免重复初始化
3. **状态管理**：通过 State 机制管理实例级状态生命周期
4. **权限边界**：通过 `containsPath()` 判断路径是否在项目边界内

**技术实现**:
```typescript
// 基于 AsyncLocalStorage 实现上下文隔离
import { AsyncLocalStorage } from "async_hooks"

interface Context {
  directory: string    // 用户指定的原始目录
  worktree: string     // Git worktree 根目录（通过 git rev-parse 解析）
  project: Project.Info // Project 信息
}

const context = Context.create<Context>("instance")  // AsyncLocalStorage 封装
const cache = new Map<string, Promise<Context>>()    // 实例缓存
```

### Instance 创建流程

**源码** (`instance.ts:22-44`):
```typescript
export const Instance = {
  async provide<R>(input: { directory: string; init?: () => Promise<any>; fn: () => R }): Promise<R> {
    // 1. 检查缓存
    let existing = cache.get(input.directory)
    
    // 2. 缓存未命中时创建新实例
    if (!existing) {
      Log.Default.info("creating instance", { directory: input.directory })
      existing = iife(async () => {
        // 2.1 解析 Project 信息
        const { project, sandbox } = await Project.fromDirectory(input.directory)
        
        // 2.2 构建上下文
        const ctx = {
          directory: input.directory,  // 保持原始输入
          worktree: sandbox,           // Git 解析后的根目录
          project,
        }
        
        // 2.3 执行初始化钩子
        await context.provide(ctx, async () => {
          await input.init?.()  // 如 InstanceBootstrap
        })
        return ctx
      })
      
      // 2.4 写入缓存
      cache.set(input.directory, existing)
    }
    
    // 3. 在上下文中执行用户函数
    const ctx = await existing
    return context.provide(ctx, async () => {
      return input.fn()
    })
  },
}
```

**流程图**:
```
┌─────────────────────────────────────────────────────────────────┐
│ HTTP Request: GET /session?directory=/workspace/src/components  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ Instance.provide({ directory: "/workspace/src/components" })    │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ 1. cache.get("/workspace/src/components") → undefined      │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              ↓                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ 2. Project.fromDirectory("/workspace/src/components")      │ │
│  │    ├── Filesystem.up(".git") → 找到 .git 目录              │ │
│  │    ├── git rev-parse --show-toplevel → "/workspace"        │ │
│  │    ├── git rev-parse --git-common-dir → 主仓库根           │ │
│  │    └── 返回 { project, sandbox: "/workspace" }             │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              ↓                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ 3. 构建上下文:                                              │ │
│  │    ctx = {                                                  │ │
│  │      directory: "/workspace/src/components", // 原始输入   │ │
│  │      worktree: "/workspace",                  // Git 根目录 │ │
│  │      project: { id: "abc123", ... }                        │ │
│  │    }                                                        │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              ↓                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ 4. cache.set("/workspace/src/components", ctx)             │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              ↓                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ 5. context.provide(ctx, () => next())  // 执行后续处理     │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### directory vs worktree 核心区别

| 字段 | 来源 | 含义 | 典型场景 |
|------|------|------|----------|
| `directory` | HTTP 请求参数 | 用户指定的**当前工作目录**（可能是子目录） | `/workspace/src/components` |
| `worktree` | `git rev-parse --show-toplevel` | 当前 Git worktree 的**根目录** | `/workspace` |

**为什么需要两个字段？**

1. **相对路径解析**：工具参数中的相对路径应基于 `directory` 解析
   ```typescript
   // tool/read.ts:34
   filepath = path.resolve(Instance.directory, filepath)
   ```

2. **Git 操作**：Git 命令应在 `worktree` 根目录执行
   ```typescript
   // worktree/index.ts:350
   $`git worktree add ...`.cwd(Instance.worktree)
   ```

3. **路径显示**：相对于 `worktree` 显示更友好
   ```typescript
   // tool/edit.ts:150
   title: path.relative(Instance.worktree, filePath)
   ```

4. **权限判断**：检查路径是否在项目边界内
   ```typescript
   // instance.ts:59-64
   containsPath(filepath: string) {
     if (Filesystem.contains(Instance.directory, filepath)) return true
     if (Instance.worktree === "/") return false  // 非 Git 项目
     return Filesystem.contains(Instance.worktree, filepath)
   }
   ```

**实际示例**:
```
用户在 /workspace/src/components 目录下启动 OpenCode

Instance.directory = "/workspace/src/components"  ← 用户所在位置
Instance.worktree = "/workspace"                   ← Git 根目录

工具调用时:
- 读取 "Button.tsx" → /workspace/src/components/Button.tsx (基于 directory)
- 显示路径 → "src/components/Button.tsx" (相对于 worktree)
- Git 操作 → 在 /workspace 执行
```

### State 机制

**源码位置**: `project/state.ts`

**设计目的**: 为每个 Instance 提供独立的状态存储，支持清理回调。

**核心实现**:
```typescript
export namespace State {
  const recordsByKey = new Map<string, Map<any, Entry>>()
  
  interface Entry {
    state: any
    dispose?: (state: any) => Promise<void>
  }

  export function create<S>(
    root: () => string,                           // 获取 key 的函数（通常是 Instance.directory）
    init: () => S,                                // 初始化函数
    dispose?: (state: Awaited<S>) => Promise<void> // 清理函数
  ) {
    return () => {
      const key = root()  // 使用 Instance.directory 作为 key
      let entries = recordsByKey.get(key)
      if (!entries) {
        entries = new Map<string, Entry>()
        recordsByKey.set(key, entries)
      }
      const exists = entries.get(init)
      if (exists) return exists.state as S  // 缓存命中
      const state = init()
      entries.set(init, { state, dispose })
      return state
    }
  }

  export async function dispose(key: string) {
    const entries = recordsByKey.get(key)
    if (!entries) return
    // 调用所有 dispose 回调
    for (const [init, entry] of entries) {
      if (entry.dispose) {
        await entry.dispose(entry.state)
      }
    }
    entries.clear()
    recordsByKey.delete(key)
  }
}
```

**使用示例** (`instance.ts:66-67`):
```typescript
// 创建实例级状态访问器
state<S>(init: () => S, dispose?: (state: Awaited<S>) => Promise<void>): () => S {
  return State.create(() => Instance.directory, init, dispose)
}
```

### Instance 生命周期

```
┌─────────────────────────────────────────────────────────────┐
│                    Instance 生命周期                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. 创建阶段 (provide)                                       │
│     ├── 检查缓存                                             │
│     ├── Project.fromDirectory() 解析                         │
│     ├── 执行 init 钩子 (如 InstanceBootstrap)               │
│     └── 写入缓存                                             │
│                                                              │
│  2. 使用阶段                                                 │
│     ├── 通过 Instance.directory/worktree/project 访问上下文 │
│     ├── 通过 Instance.state() 访问/创建状态                 │
│     └── 相同 directory 的请求复用同一 Instance              │
│                                                              │
│  3. 销毁阶段 (dispose)                                       │
│     ├── 调用所有 State.dispose() 回调                       │
│     ├── 从缓存中移除                                         │
│     └── 发送 "server.instance.disposed" 事件                │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**关键 API**:
```typescript
// 销毁单个实例
Instance.dispose()

// 销毁所有实例（服务关闭时）
Instance.disposeAll()
```

### Instance 在 HTTP 请求中的注入

**源码位置**: `server/server.ts:197-221`

```typescript
// 全局中间件：为每个请求创建 Instance 上下文
.use(async (c, next) => {
  if (c.req.path === "/log") return next()
  
  // 获取 workspaceID（可选）
  const workspaceID = c.req.query("workspace") || c.req.header("x-opencode-workspace")
  
  // 获取 directory（必需）
  const raw = c.req.query("directory") || c.req.header("x-opencode-directory") || process.cwd()
  const directory = decodeURIComponent(raw)

  // 嵌套上下文：WorkspaceContext → Instance
  return WorkspaceContext.provide({
    workspaceID,
    async fn() {
      return Instance.provide({
        directory,
        init: InstanceBootstrap,  // 初始化钩子
        async fn() {
          return next()  // 继续处理请求
        },
      })
    },
  })
})
```

**上下文嵌套关系**:
```
HTTP Request
    ↓
WorkspaceContext.provide({ workspaceID })
    ↓
Instance.provide({ directory })
    ↓
Route Handler (可访问 Instance.* 和 WorkspaceContext.*)
```

---

## 九、常见问题

### Q1: Directory 和 Instance 有什么区别？

**答**：
- **Directory** 是字符串，来自 HTTP 请求参数，代表用户指定的物理路径
- **Instance** 是对象，包含 directory/worktree/project 三要素，提供完整的运行时上下文
- 一个 Directory 对应一个 Instance（通过缓存机制）

### Q2: Instance.directory 和 Instance.worktree 有什么区别？

**答**：
- `Instance.directory` = 用户请求时传入的原始路径（可能是子目录）
- `Instance.worktree` = 通过 `git rev-parse --show-toplevel` 解析的 Git 根目录
- 例如：用户在 `/workspace/src/components` 启动 OpenCode
  - `directory` = `/workspace/src/components`
  - `worktree` = `/workspace`

### Q3: 为什么需要缓存 Instance？

**答**：
1. **性能优化**：避免每次请求都解析 Project 信息
2. **状态共享**：相同 directory 的请求共享状态（如 LSP 客户端）
3. **资源管理**：统一管理实例生命周期，支持清理

### Q4: Worktree 和普通目录有什么区别？

**答**：Worktree 是 Git 管理的特殊目录，与主仓库共享 `.git` 目录。优势：
- 不需要克隆完整的仓库
- 分支切换瞬间完成
- 磁盘空间占用小

### Q2: 可以创建多少个 Worktree？

**答**：理论上没有限制，但受限于磁盘空间和系统性能。建议同时运行的 Worktree 数量不超过 5-10 个。

### Q3: Worktree 中的文件是否会影响主仓库？

**答**：不会。Worktree 有完全独立的文件系统，但共享 Git 历史。提交会在同一个仓库中。

### Q4: Sandbox 是独立概念吗？

**答**：**否**，Sandbox 就是 Worktree 的别名：
- 主 worktree 存储在 `Project.worktree`
- 派生 worktree 存储在 `Project.sandboxes[]`

### Q5: Workspace SDK 成熟吗？

**答**：目前是半成品，只有 worktree 一种实现。除非需要扩展其他类型（如远程/容器），否则直接用 Worktree API 更简洁。

---

## 十、源码索引

### 核心模块

| 模块 | 路径 | 主要功能 |
|------|------|---------|
| Project | `src/project/project.ts` | Project 生命周期管理 |
| Project SQL | `src/project/project.sql.ts` | Project 数据库表定义 |
| Instance | `src/project/instance.ts` | 请求级上下文管理（AsyncLocalStorage） |
| State | `src/project/state.ts` | 实例级状态存储与生命周期管理 |
| Context | `src/util/context.ts` | AsyncLocalStorage 封装 |
| Worktree | `src/worktree/index.ts` | Git worktree 操作 |
| Workspace | `src/control-plane/workspace.ts` | Workspace 生命周期管理 |
| Workspace SQL | `src/control-plane/workspace.sql.ts` | Workspace 数据库表定义 |
| WorkspaceContext | `src/control-plane/workspace-context.ts` | Workspace 上下文传递 |
| Adaptor Index | `src/control-plane/adaptors/index.ts` | Adaptor 注册与获取 |
| WorktreeAdaptor | `src/control-plane/adaptors/worktree.ts` | Worktree 适配器实现 |
| Session | `src/session/index.ts` | Session 生命周期管理 |
| Global | `src/global/index.ts` | 全局路径配置 |

### API 路由

| 路由 | 路径 | 端点 |
|------|------|------|
| ProjectRoutes | `src/server/routes/project.ts` | `/project/*` |
| ExperimentalRoutes | `src/server/routes/experimental.ts` | `/experimental/*` |
| WorkspaceRoutes | `src/server/routes/workspace.ts` | `/experimental/workspace/*` |

---

## 十一、结论

### 核心关系总结

1. **Directory = 请求入口参数**
   - 用户通过 HTTP 请求传入的物理路径
   - 可以是 Git 仓库的任意子目录
   - 作为 Instance 缓存的 key

2. **Instance = 运行时上下文容器**
   - 基于 AsyncLocalStorage 实现请求级隔离
   - 包含 directory（原始路径）、worktree（Git 根目录）、project（项目信息）
   - 相同 directory 共享 Instance（缓存机制）

3. **Project = Git 仓库的逻辑抽象**
   - ID 由 root commit hash 唯一确定
   - 包含主 worktree 和派生 sandboxes

4. **Worktree = Git 物理隔离机制**
   - 使用 `git worktree` 命令实现
   - 目录存储在统一路径下
   - 分支命名有规范要求

5. **Sandbox = Worktree 的同义词**
   - 本质是字符串数组
   - 主 worktree 在 `Project.worktree`，派生的在 `Project.sandboxes[]`
   - 命名不够优雅，`worktrees` 更合适

6. **Workspace = Worktree 的业务抽象层（半成品）**
   - 可选层，不创建时 Session 直接属于 Project
   - 通过 Adaptor 模式预留扩展能力
   - 目前只有 worktree 一种实现

7. **Session = 最小工作单元**
   - 可属于 Project 或 Workspace
   - workspaceID 字段可选
   - directory 记录创建时的物理路径

### 请求处理流程

```
┌─────────────────────────────────────────────────────────────────────┐
│ HTTP Request                                                         │
│ GET /session?directory=/workspace/src/components&workspace=wrk_xxx  │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ Server Middleware                                                    │
│ ├── 解析 directory → "/workspace/src/components"                    │
│ └── 解析 workspaceID → "wrk_xxx"                                    │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ WorkspaceContext.provide({ workspaceID })                            │
│ (可选层，提供 workspace 上下文)                                       │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ Instance.provide({ directory })                                      │
│ ├── 检查缓存: cache.get(directory)                                   │
│ ├── Project.fromDirectory(directory)                                 │
│ │   ├── 向上查找 .git 目录                                           │
│ │   ├── git rev-parse --show-toplevel → worktree                    │
│ │   └── 返回 { project, sandbox }                                    │
│ ├── 构建 Context: { directory, worktree, project }                  │
│ ├── 执行 init 钩子                                                   │
│ └── 缓存并返回                                                        │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────┐
│ Route Handler                                                        │
│ ├── Instance.directory → "/workspace/src/components"                │
│ ├── Instance.worktree → "/workspace"                                │
│ └── Instance.project → { id: "abc123", ... }                        │
└─────────────────────────────────────────────────────────────────────┘
```

### 架构设计意图

- **多 Workspace 并行开发**: 支持在同一 Project 下创建多个隔离环境
- **Git 原生集成**: 充分利用 Git worktree 机制实现物理隔离
- **可扩展性**: Adaptor 模式预留 docker/remote 等类型扩展
- **向后兼容**: Workspace 是可选层，不影响现有使用方式

---

*报告完成于 2026-03-11*
*测试验证: 本地 macOS + Docker 容器*