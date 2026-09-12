# OpenCode V2 架构变更研究报告

> 分析日期：2026-06-14
> 源仓库：`labs/ref-repos/opencode`（sst/opencode）
> 分析范围：v1.15.13 → v1.16.0 → v1.16.2 → v1.17.0 → v1.17.3
> 规格来源：`specs/v2/` 目录（session.md、tools.md、config.md、instructions.md、todo.md、schema-changelog.md、provider-policy.md、provider-model.md、catalog-config-plugin-lifecycle.md）

---

## 一、版本时间线与阶段定位

### 版本发布节奏

| 版本 | 发布日期 | commit 数 | 阶段定位 |
|------|---------|----------|---------|
| v1.15.0 → v1.15.13 | 05-15 → 05-30 | — | 准备期：Hono→Effect HttpApi 迁移、desktop v2 UI 基建 |
| **v1.16.0** | 06-05 | 210 | 地基铺设期：V2 session runtime 骨架、location filesystem 抽象 |
| **v1.16.2**（无 .1） | 06-05（同日） | 43 | 补丁期：V2 skill guidance 接入、bugfix |
| **v1.17.0** | 06-10 | 163 | 能力补齐期：V2 runner 功能补全、全面 Effect 化 |
| v1.17.1 → v1.17.3 | 06-10（同日） | — | 快速修复 |

### v1.16 为何只到 .2 就跳到 v1.17？

**不是方向变更，而是 V2 重构进入了新里程碑。**

`specs/v2/todo.md` 开篇明义：

> "ok we need to work towards a launch of v2 so we can get out of this rebuild phase"

整条 v1.15 → v1.16 → v1.17 是一条连贯的 V2 重构路线。每个 minor 标记一个里程碑阶段：

- **v1.16**：铺设 V2 地基（session runtime 骨架、location filesystem contract、event sourced inputs、skill/command registry）
- **v1.17**：V2 功能补全到可运行（中断、压缩、权限执行、溢出恢复、工具架构统一、Effect logger 替换）

v1.17 引入了完整的 V2 工具架构（`Tool.make` 统一类型、permission-checked builtins、output bounding）和 Effect-native runner 功能集（compaction/interrupt/recovery），属于 MINOR 级别的功能增量，而非 patch。

---

## 二、V1/V2 双轨并行现状

### 代码结构（v1.17.3）

当前代码库中 V1 和 V2 三层并存：

| 层 | 位置 | 状态 |
|----|------|------|
| **V1 运行时** | `packages/opencode/src/session/`、`packages/opencode/src/plugin/` | 完整保留，当前默认运行路径 |
| **V1 兼容命名空间** | `packages/core/src/v1/` | V1 config/permission/session schema 隔离到 `v1/` 子目录 |
| **V2 运行时** | `packages/core/src/session/`、`packages/core/src/plugin/` | Effect-native 运行时，实验阶段 |

### V1 插件兼容机制

V1 插件在当前版本**仍可运行**。`packages/opencode/src/plugin/index.ts` 的 `applyPlugin()` 采用探测式加载：

1. `readV1Plugin(mod, spec, "server", "detect")` 检测是否为 V1 格式（`default export { id, server() }`）
2. V1 格式 → 走 V1 hook 系统（`Hooks[]`，`(input, output) => Promise<void>` 模式）
3. 非 V1 格式 → 走 `getLegacyPlugins()` 兜底（更老的纯函数导出）
4. V2 插件走 `packages/core/src/plugin/boot.ts` 的 `PluginBoot` 层，独立 `PluginV2.Definition` + Effect hooks

两套插件系统并行，互不干扰。

### V2 替换 V1 的 Launch Gate

`specs/v2/session.md` 包含一份 **"V1 Runtime Context Parity" 对照表**，列出 V2 替换 V1 前必须达到功能对等的行为清单：

| 边界 | 行为 | 状态 |
|------|------|------|
| Per-turn request assembly | Placement、selected model、chronological history、canonical lowering | **complete** |
| Prompt/reference expansion | Durable typed prompt attachments | **complete** |
| Durable Context Source | Environment facts and host-local date | partial |
| Durable Context Source | Global and upward project instructions | partial |
| Durable Context Source | Configured local/glob and remote URL instructions | **missing** |
| Per-turn request assembly | Policy-filtered tools | partial |
| Per-turn request assembly | Plugin message/system/parameter/header transforms | **missing** |
| Per-turn request assembly | Automatic/context-pressure compaction | partial |
| Prompt/reference expansion | Native template and @ mention expansion | **missing** |

大量项仍为 `partial` 或 `missing`，V2 尚未达到功能对等，V1 短期内不会消失。

---

## 三、配置系统破坏性变更

`specs/v2/config.md` 是一份逐字段审查文档，对每个配置项明确标注 keep / remove / redesign。

### 字段重命名（单数 → 复数，无兼容别名）

| V1 | V2 | 说明 |
|----|----|------|
| `provider` | `providers` | 故意不保留 singular key 的兼容别名 |
| `agent` | `agents` | — |
| `permission` | `permissions` | 从 map 简写改为有序数组 `{ action, resource, effect }` |
| `plugin` | `plugins` | option tuple → `{ package, options? }` 对象 |
| `reference` | `references` | — |
| `snapshot` | `snapshots` | — |
| `attachment` | `attachments` | 避免与 model capability flag `attachment` 冲突 |
| MCP servers | `mcp.servers` | 协议级设置（如 timeout）提升到 `mcp` 下 |

### 字段删除

| 删除项 | 原因 |
|--------|------|
| `command` | 用户自定义命令归入 skills |
| `tools`（布尔 enable/disable） | 统一走 permissions |
| `mode`（顶级别名） | 废弃 alias |
| `default_agent` | 等 V2 agent 设计定后再定义 |
| `small_model` | title 生成走 agent model override |
| `logLevel` / `server` | location config 在 server 启动后才加载 |
| `autoshare` | 用 `share: "auto"` 替代 |
| `layout` | stretch layout 恒定 |
| `experimental.batch_tool` | 不再支持 |
| `experimental.primary_tools` | 走 permissions |
| `experimental.continue_loop_on_deny` | 废弃 |
| `experimental.openTelemetry` | 走标准 OTel 环境变量 |

### 字段语义重设计

**Provider 启停控制** — `disabled_providers` / `enabled_providers` 全部替换为 `experimental.policies` 策略数组：

```jsonc
// V1
{ "disabled_providers": ["openai"] }

// V2
{ "experimental": { "policies": [
  { "effect": "deny", "action": "provider.use", "resource": "openai" }
]}}
```

Policy 评估规则（`specs/v2/provider-policy.md`）：
- 默认 `allow`，最后匹配的 statement 决定结果
- 跨文档优先级：repository → user-global → organization-managed（后者覆盖前者）
- 插件**不能**修改 policy

**Agent 定义** — `prompt` → `system`、`maxSteps` → `steps`、`disable` → `disabled`、删除 `temperature`/`top_p`（走 `options`）。

**Compaction** — `keep` 改为 `keep.tokens`，context headroom 改名为 `buffer`。

**MCP timeout** — 从 `experimental.mcp_timeout` 移到 `mcp.timeout`（默认）和 `mcp.servers.<name>.timeout`（per-server）。

### 配置自动转换计划

`specs/v2/todo.md` 第 96-97 行：

> "We should do another pass on config to clean up any mistakes we made with it and simplify as much as possible. Old configs should get auto-converted to new"

意图是写一个 V1→V2 配置自动转换器。但该转换器**尚未实现**（负责人标记为 `???`）。

---

## 四、插件 API 完全重写

V2 的插件系统是全新架构，不是增量改进。

### 架构对比

| 维度 | V1 | V2 |
|------|----|----|
| 注册方式 | 应用层导入 + hook 函数 | `PluginV2.Definition<R>`，Effect-native，带 `order` + `hooks` |
| Hook 输入 | 可变对象直接修改 | Immer `Draft<T>` 不可变输入 + 可变 output draft |
| 生命周期 | 隐式 | 显式 `PluginBoot` 层，内置插件有序加载 |
| 作用域 | 进程级 | **Location-scoped** — 每个 Location 独立实例和 Scope |
| 热重载 | 全局 reload | 粒度化：服务 emit 事件，依赖方响应变更 |
| 禁用行为 | 需手动清理 | 自动回滚（replayable transform 卸载） |

### V2 插件加载顺序

```ts
export const Order = {
  modelsDev: 0,    // models.dev catalog 数据
  env: 10,         // 环境变量凭证检测
  account: 20,     // 账户认证状态
  provider: 30,    // Provider 注册（Anthropic、OpenRouter、Bedrock 等）
  config: 40,      // 用户配置应用
  discovery: 50,   // 动态发现
}
```

### V2 核心 Hook

```ts
type HookSpec = {
  "provider.update": { provider: Draft<ProviderV2.Info>; cancel: boolean }
  "model.update":    { model: Draft<ModelV2.Info>; cancel: boolean }
  "account.update" / "account.remove" / "account.activate" / "account.activated"
}
```

关键约束：
- Hook 接收 immutable input + mutable output（Immer draft）
- 支持 `cancel: boolean` 阻止变更
- 顺序触发，确定性保证
- **插件不能修改 policy**

### Catalog Transform 模型

插件不再直接操作 catalog，而是注册 **replayable transform**。插件禁用时自动回滚其贡献——这是 V1 没有的概念。

`specs/v2/catalog-config-plugin-lifecycle.md` 记录了两种设计选项（A: Config Transforms vs B: Catalog Transforms），最终选择了 **Option B（Catalog Transforms）**：

```ts
interface Catalog {
  transform(): Effect.Effect<
    (update: (catalog: Catalog.Editor) => void) => Effect.Effect<void>,
    never, Scope.Scope
  >
}
```

每个 transform 是一个 scoped callback，插件 Scope 关闭时自动注销。

---

## 五、Session 运行时 — 事件溯源架构

这是最深层的行为变更。

### Prompt 投递模型

| 维度 | V1 | V2 |
|------|----|----|
| Prompt 入口 | `Session.prompt()` 直接写入 transcript | `SessionV2.prompt()` 先写入 durable inbox（`session_input` 表） |
| 模型可见性 | 立即可见 | Runner 在安全边界 promote 后才可见 |
| Delivery 语义 | 无 | 显式 `steer`（插入当前活动）vs `queue`（FIFO 新活动）|
| 幂等性 | 无 | Prompt message ID 复用 = 精确重试（Session + prompt + delivery 匹配时）|

### Context Epoch

V2 引入全新概念——持久化精确的 system context baseline + 结构化快照，按 epoch 版本管理。

- **首次观察**初始化 epoch baseline（环境信息、AGENTS.md、skill guidance 等）
- Agent 切换、model 切换、compaction 完成触发 **epoch 替换**
- 替换是惰性的：在下一个安全 provider-turn 边界完成
- Session move 时清空 epoch，目标 Location 必须重新初始化完整 baseline

V1 没有等价机制。

### Compaction

V2 compaction 在每个 provider turn 前自动触发：
1. 估算完整请求大小 vs 模型 context window 减去绝对保留 headroom
2. 超限时压缩：保留完整 transcript，但替换 model 可见表示为结构化摘要 + token-bounded 序列化近期上下文
3. Provider-native reasoning/tool 消息不跨越压缩边界（避免签名和加密 reasoning 失败）
4. 压缩完成后请求 Context Epoch 替换，重新加载 pending turn

### 执行模型

- V2 runner 每个 provider turn 只发一个 `llm.stream(request)`，不桥接 `SessionPrompt.loop()`
- 本地工具即时执行（eager settlement），provider turn 关闭后统一 await
- 进程崩溃后，之前 `running` 状态的 tool 被 durable fail 为 "Tool execution interrupted"，不会静默重放
- `SessionRunCoordinator` 序列化同一 Session 的 drain chain，不同 Session 可并发
- V1→V2 shadow bridge 继续为已可见的 V1 prompt 发布普通 `Prompted` 事件

---

## 六、工具架构 — 统一类型系统

### `Tool.make` 统一接口

V1 工具从应用层 orchestration 导入。V2 所有工具（built-in、plugin、application）用同一个 `Tool.Definition`：

```ts
const make: <Input, Output>(config: {
  description: string
  input: Input         // Schema.Codec
  output: Output       // Schema.Codec
  execute: (input, context: Tool.Context) => Effect<Output, ToolFailure>
  toModelOutput?: (input) => ReadonlyArray<Tool.Content>
}) => Definition<Input, Output>
```

### 工具法则（Laws）

`specs/v2/tools.md` 定义了严格约束：

- **单执行器**：`Tool.make(config)` 只能调 `config.execute`
- **Codec 边界**：执行看 decoded input，投影看 encoded output
- **Durable identity**：invocation-owned records 使用 runner 提供的精确 Session/agent/message/call ID
- **Scoped registration**：关闭 Scope 只移除自己的注册，暴露下层 overlay
- **Captured execution**：registration 变更不能改变已开始的 invocation
- **Stale rejection**：call 永远不执行非 provider-turn-advertised 的 registration
- **Storage encapsulation**：domain output 不因 model-output bounding 改变

### 内置工具行为变更

| 工具 | V2 变更 |
|------|---------|
| `bash` | 删除 `background` 参数（deferred）；非沙箱，仅 advisory warnings |
| `edit` | V2 只有 exact edit，V1 fuzzy edit 行为故意推迟 |
| `apply_patch` | 全新工具，顺序提交语义（无 atomic rollback，无 move） |
| `webfetch` | V2 首版 text-only，拒绝图片（V1 返回 attachment） |
| `read` | 分页目录列表、bounded 读取、支持 named references |
| `glob`/`grep` | 排除 hidden 文件（比 V1 ripgrep `--hidden` 更窄） |

---

## 七、权限系统 — 双层重构

### PermissionV2（工具级）

- Location-scoped pending requests
- 回复类型：`once` / `always` / `reject`
- 规则格式：有序数组 `{ action, resource, effect }`，替代 V1 的 map 简写
- `effect` 支持 `"ask"`（交互式），区别于 Policy 的纯 allow/deny
- Action 词汇：`read`、`glob`、`grep`、`edit`、`external_directory`、`bash`、`todowrite`、`webfetch`、`skill`

```jsonc
{
  "permissions": [
    { "action": "bash", "resource": "*", "effect": "ask" },
    { "action": "bash", "resource": "git status", "effect": "allow" },
  ],
}
```

### Policy（Provider 级）

全新系统，替代 `enabled_providers` / `disabled_providers`：

- 评估：默认 allow，最后匹配 statement 决定结果
- 跨文档优先级：repository policy → user-global policy → organization-managed policy
- 用户全局 policy 可覆盖仓库 policy（仓库不能静默重启用用户已禁用的 provider）
- 插件**不能**添加、删除或覆盖 policy statement

---

## 八、数据持久化 — 不兼容重置

### V2 实验数据库明确 disposable

`specs/v2/session.md` 第 167 行：

> "The `session.next.*` event schemas remain experimental and unshipped; databases created by earlier experimental builds are disposable rather than compatibility targets."

### 新增数据库对象

| 对象 | 用途 |
|------|------|
| `session_input` 表 | Durable prompt admission inbox（含 autoincrement sequence、delivery mode） |
| `session_context_epoch` 表 | Context Epoch baseline + 结构化快照 + replacement_seq |
| `session_message.seq` 字段 | Projected message 按 durable event sequence 排序，替代 wall-clock timestamp |
| `session.next.*` 事件族 | 版本化 durable event（如 `session.next.compaction.ended.2`） |

### 迁移策略

- 多次 schema migration 会 reset pre-launch projections
- workspace beta 数据被明确标记为可丢弃
- V1 canonical `session`、`message`、`part` 行在 reset 中保留

---

## 九、其他破坏性变更

| 领域 | 变更 |
|------|------|
| **Server** | Hono → Effect HttpApi（V1 兼容期后删除 Hono shim） |
| **Logger** | Legacy logger → Effect logging（`#31310`） |
| **TUI** | 提取为独立包（`#31193`：`refactor(tui): extract standalone package`） |
| **Filesystem** | 引入 Location 抽象，read/mutation/search 各有独立 protocol |
| **session.init 路由** | 删除专用端点 `POST /session/:sessionID/init`，走 `/init` 命令流 |
| **`@opencode-ai/llm`** | In-memory tool loop 计划移除，替换为 typed dispatcher |
| **fff 搜索** | v1.17 新增 fff (Fast File Finder) 搜索工具（`#27802`），默认启用但 Windows 仍在 flag 后 |

---

## 十、对 Ellamaka 的影响评估

### 当前影响（短期）

**无直接影响。** Ellamaka 基于 V1 运行时，V1 运行时和插件系统完整保留。V2 处于实验阶段，不影响 V1 代码路径。

### 上游合并风险（中期）

随着 V2 逐步成熟，上游每次 release 会包含更多 V2 代码和 V1→V2 迁移：

| 风险点 | 影响 | 应对 |
|--------|------|------|
| V1 文件被移入 `v1/` 子目录 | Import 路径变更 | 上游合并后检查 import 是否需更新 |
| Hono shim 被删除 | Server 路由可能断裂 | 关注 server 路由层变更 |
| Config schema 变更 | 配置加载可能受影响 | 关注 `packages/core/src/v1/config/` 是否被修改 |
| TUI 独立包 | TUI 插件加载路径变更 | 关注 `packages/opencode/src/plugin/tui/` |

### V2 迁移准备（长期）

当 V2 launch（V1 Runtime Context Parity 表大部分达到 `complete`）时，ellamaka 需要评估：

1. **插件重写**：ellamaka 的自定义插件是否需要迁移到 `PluginV2.Definition` 格式
2. **Config 兼容**：ellamaka 的 WopalSpace 配置注入是否需要适配新的 config schema
3. **Location 抽象**：V2 的 Location-scoped 服务是否与 WopalSpace 的空间模型对齐
4. **Session 运行时**：V2 的 event-sourced session 是否影响 ellamaka 的 session 管理逻辑

### 监控信号

以下信号出现时，说明 V2 迁移迫近：

- `specs/v2/session.md` 的 Parity 表中 `complete` 项超过 70%
- `packages/core/src/v1/` 目录被标记 deprecated 或开始缩小
- `packages/opencode/src/session/`（V1 session）出现 deprecation 注释
- `specs/v2/todo.md` 中 "remove the public in-memory `@opencode-ai/llm` tool loop" 被标记完成
- Config auto-converter 被实现（负责人从 `???` 变为实际 owner）

---

## 十一、总结

V2 不是单纯的技术栈迁移，而是**产品架构重定义**：

| 维度 | V2 方向 |
|------|---------|
| **配置** | 几乎所有用户可见字段都有 breaking change，无兼容别名，计划自动转换 |
| **插件** | 全新 Effect-native + Location-scoped + Immer draft + transform replay 架构 |
| **Session** | 从同步调用变为 event-sourced durable inbox + Context Epoch |
| **工具** | 统一 typed `Tool.make`，codec 边界，Location-scoped 注册 |
| **权限** | 双层（PermissionV2 工具级 + Policy provider 级），完全替代 V1 map 简写 |
| **数据** | 实验性 V2 数据库明确 disposable，不保证迁移兼容 |

团队策略是**不保留长期兼容 shim**，旧配置计划自动转换，V1 插件通过探测式加载在过渡期继续可用。V1 运行时将在 V2 达到功能对等后被替换，但目前 Parity 表显示距离该目标还有显著差距。