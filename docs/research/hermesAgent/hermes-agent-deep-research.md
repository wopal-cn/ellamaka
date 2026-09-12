# Hermes Agent 深度研究

> **研究日期**: 2026-04-17
> **源码路径**: `labs/ref-repos/hermes-agent`
> **项目**: Nous Research — hermes-agent (MIT)

---

## 项目定位

Hermes Agent 是一个 **self-improving AI agent**——能自我学习、持久记忆、跨平台运行的通用 AI Agent。

- **语言**: Python 3.11+
- **核心**: 同步 tool-calling loop（OpenAI 格式），支持 parallel tool execution
- **入口**: CLI TUI（Rich + prompt_toolkit）+ Messaging Gateway + API Server + ACP Server
- **工具数**: 40+（Web、Browser、Terminal、File、Vision、TTS、Cron、MCP、HomeAssistant、RL…）
- **模型支持**: OpenRouter(200+)、Anthropic、OpenAI、Copilot、Ollama、MiniMax、Kimi、Qwen、Mistral
- **部署**: 6 种终端后端（local/Docker/SSH/Daytona/Singularity/Modal）

---

## Agent Loop 架构

### 核心循环

核心逻辑在 `AIAgent.run_conversation()`（`run_agent.py:7528-10346`，约 2800 行），是一个 **完全同步的 while 循环**：

```
while (api_call_count < max_iterations 且 iteration_budget.remaining > 0) 或 budget_grace_call:
    1. 检查中断（用户发送新消息 / Ctrl+C）
    2. 构建 API 请求（system prompt + messages + tools + prompt caching）
    3. 调用 LLM（streaming 优先，非 streaming 回退）
    4. 解析响应:
       ├─ finish_reason=length    → continuation retry（最多 3 次）
       ├─ 有 tool_calls           → 验证/修复 → 执行工具 → 结果加入 messages → continue
       └─ 无 tool_calls           → 文本响应 → break（对话结束）
    5. 检查 context 使用率 → 自动压缩（阈值 50%）
```

### Iteration Budget

线程安全计数器，替代旧版 `max_iterations`：
- 默认 **90 次** turn
- `execute_code`（编程式工具调用）**不消耗预算**（称为 refund）
- 预算耗尽时 **Grace Call**：注入一条 "总结你已完成的工作" 的消息，再给一次 API 机会
- 子代理有 **独立预算**（默认 50）

### System Prompt 与 Prompt Caching 保护

这是 Hermes 最精妙的设计之一：

| 原则 | 实现 |
|------|------|
| **System prompt 在整个会话期间冻结不变** | `_cached_system_prompt` 首次构建后永不重建 |
| **Memory 写入磁盘但不更新 prompt** | memory tool 立即写 MEMORY.md，但 system prompt 不刷新 |
| **Skills 以 user message 注入** | `skill_manage` 结果作为 user message 追加，不触碰 system prompt |
| **Plugin 上下文注入 user message** | `pre_llm_call` hook 的结果追加到当前 user message，不修改 system prompt |
| **Anthropic cache 自动启用** | `apply_anthropic_cache_control()` 在 system + 最后 3 条消息注入 `cache_control` breakpoints |

**目的**：确保 Anthropic prefix cache 命中率，多轮对话 input token 成本降低约 75%。

### Context Compression

当 prompt_tokens + completion_tokens 总 token 数超过阈值的 **50%** 时自动触发：
- 中间 turn 总结压缩
- 保护前 3 条和后 20 条不被压缩
- 使用专用辅助模型执行压缩（可配置 `compression.summary_model`）
- 压缩后创建新 session，原 session 保持完整（用于回溯）
- **Preflight 压缩**：加载历史会话时如果已超限，进入 loop 前先压缩

### 错误恢复矩阵

Hermes 拥有约 **20+ 种** 错误恢复策略：

| 错误类型 | 恢复策略 |
|---------|---------|
| Thinking signature invalid（Anthropic 400） | 剥离所有 reasoning_details 重试（一次性） |
| Context length exceeded | 降低 context_length tier + 压缩历史 |
| Max tokens too large | 降低 max_tokens 到可用值（不缩小 context_length） |
| 413 payload too large | 压缩历史（最多 3 次） |
| 429 rate limit | Credential pool 轮换 → 切换 fallback provider |
| Anthropic long-context tier | 将 context 降到 200K（标准层级） |
| Truncated response (length finish) | 继续请求（最多 3 次）→ 回退到最后完成状态 |
| 推理耗尽（只有 think 没有回答） | 检测 think tag → 用户友好提示 → 建议降低 reasoning effort |
| Invalid tool name | Auto-repair（模糊匹配）→ 返回错误给模型自纠正（最多 3 次） |
| Invalid JSON args | 返回 JSON 修复建议给模型（最多 3 次） |
| Empty response | Thinking prefill 重试 → 空响应重试（3 次）→ 切换 fallback |
| UnicodeEncodeError | 剥离 surrogate characters → 重试 |
| 非可重试客户端错误 | 尝试 fallback → 失败则终止 |
| 连接死亡 | 自动清理 TCP dead connection → 重建 |

### 并行工具执行

```python
_PARALLEL_SAFE_TOOLS = {"read_file", "search_files", "session_search", ...}
_PATH_SCOPED_TOOLS = {"read_file", "write_file", "patch"}  # 路径不重叠时可并行
```

同一批次的工具调用满足：
1. 不包含 `clarify`（需要用户交互）
2. 所有工具是只读或路径不冲突
3. 最多 8 个并发线程

则用线程池并行执行，否则串行。

### API Mode 适配

三种模式自动检测切换：
- `chat_completions` — OpenAI 兼容
- `codex_responses` — OpenAI Codex API
- `anthropic_messages` — 原生 Anthropic Messages API

每种模式有独立的 client 构建、response 规范化、错误处理。

---

## 工具系统

### 工具注册

集中式注册器（`tools/registry.py`）：

```python
registry.register(
    name="terminal",
    toolset="terminal",
    schema=TOOL_SCHEMA,
    handler=run_terminal,
    check_fn=check_terminal_requirements,
    requires_env=["PATH"],
    is_async=True,
    emoji="⚡",
    max_result_size_chars=50000,
)
```

### Toolset 组合系统

`toolsets.py` 提供灵活的 toolset 定义：

```python
TOOLSETS = {
    "web": { "tools": ["web_search", "web_extract"], "includes": [] },
    "debugging": { "tools": ["terminal", "process"], "includes": ["web", "file"] },
    "hermes-cli": { "tools": _HERMES_CORE_TOOLS, "includes": [] },
    # 12+ messaging platform toolsets（Telegram/Discord/WhatsApp/Signal/Matrix/DingTalk/...）
}
```

- **includes** 支持递归组合（带循环检测）
- 支持 `$all` / `$*` 通配
- 插件可在运行时注册新 toolset
- 子代理可继承父代理的 toolset 并移除受限工具

### 工具类别

| 类别 | 工具 |
|------|------|
| Web | web_search, web_extract |
| Terminal | terminal, process |
| File | read_file, write_file, patch, search_files |
| Browser | navigate, snapshot, click, type, scroll, vision, console... |
| Vision / 图像 | vision_analyze, image_generate |
| 技能 | skills_list, skill_view, skill_manage |
| 记忆 | memory (add/replace/remove/read) |
| 规划 | todo |
| TTS | text_to_speech |
| 编码 | execute_code, delegate_task |
| 搜索 | session_search |
| 定时任务 | cronjob |
| MCP | mcp_tool（动态发现 MCP Server 工具） |
| 智能家居 | ha_list_entities, ha_call_service... |
| 消息 | send_message（跨平台） |
| 交互 | clarify（向用户提问） |
| RL | rl_start_training, rl_get_results... |

---

## 记忆系统

### 双层记忆

| 存储 | 内容 | 分隔符 |
|------|------|--------|
| MEMORY.md | Agent 个人笔记和观察（环境事实、项目约定、工具特性） | `§` |
| USER.md | 用户画像（偏好、沟通风格、工作习惯） | `§` |

### 冻结快照模式

- System prompt 初始化时读入 MEMORY.md + USER.md
- 会话期间 tool 操作写入磁盘，**但 system prompt 不更新**
- 下一会话启动时才刷新
- 好处：保持 prefix cache 完整

### Memory Provider 插件

外部记忆系统通过插件注入（如 Honcho dialectic profiling）：

```python
# config.yaml
memory:
  provider: "honcho"
```

插件提供：
- `prefetch_all(query)` — 对话前预取
- `sync_all(user_msg, response)` — 对话后同步
- `on_delegation(task, result, session_id)` — 委派结果通知
- Tool schema 注入

### 安全扫描

Memory 写入前进行 prompt injection 检测：
- 不可见 unicode 字符检测
- 注入模式匹配（ignore instructions、role hijack、exfil、SSH backdoor...）

---

### 上下文构造流程（深度分析）

Hermes 的上下文构造是**多层装配 + 动态生命周期管理**的混合系统。核心围绕四个来源：

#### 装配层（System Prompt）— 组装一次后冻结

```
System Prompt 结构（按装配顺序）：
┌─────────────────────────────────────────────┐
│ ① Agent 身份（SOUL.md 或硬编码默认）         │
│ ② 工具使用指导（Memory / Session / Skills） │
│ ③ 模型纪律（按模型族匹配：GPT / Gemini）     │
│ ④ MEMORY.md 快照（冻结，直到下次会话刷新）  │
│ ⑤ USER.md 快照（用户画像）                  │
│ ⑥ 外部记忆插件的 system_prompt_block()      │
│ ⑦ Skills 体系指导（技能分类索引）           │
│ ⑧ 项目文件（AGENTS.md / .cursorrules 等）  │
│ ⑨ 时间戳 + Session ID + Model + Provider    │
│ ⑩ 平台提示（WhatsApp / TG / Discord）       │
└─────────────────────────────────────────────┘
```

**关键设计**：
- **Cache 稳定**：System Prompt 只构建一次，缓存复用在 `self._cached_system_prompt`
- **续会话恢复**：从 SessionDB 恢复上次 System Prompt，保证 Anthropic cache prefix 匹配
- **Ephemeral Prompt 不在 System Prompt 中**：只在 API 调用时注入，不持久化
- **重建触发**：仅在 Context Compression 后重建（因为此时记忆可能从磁盘刷新）

#### 对话层（Messages List）— 越聊越长，超限压缩

对话消息是动态增长的列表。当总 token 数超过窗口上限的 50% 时触发压缩。

#### 注入层（每轮动态）— 按需注入到当前消息

| 注入源 | 注入时机 | 注入位置 |
|------|---------|---------|
| @引用扩展 | 用户消息发送前 | 展开文件/链接内容，追加到用户消息 |
| Memory Prefetch | 每轮 API 调用前 | `<memory-context>` XML 块，追加在 System Prompt 之后 |
| Ephemeral Prompt | API 调用时 | 临时注入，不持久化到消息列表 |

#### 管理层（生命周期）— 监控大小、决定何时压缩

```
ContextCompressor / 插件 ContextEngine
├── 监控 token 使用量
├── 决定是否触发压缩
├── 协调 Memory Manager 的生命周期钩子
└── 压缩前通知所有 Memory Provider 提取关键信息
```

---

### 记忆的生命周期：写入与读取

#### 写入路径

```
两种方式写入记忆：
1. 对话中 LLM 主动调用 memory 工具
2. 后台审查线程（Background Review）
```

**方式一：对话中主动调用**

LLM 根据 memory tool 的 description 指导主动写入：

```json
{
  "name": "memory",
  "arguments": {
    "action": "add",
    "target": "user",
    "content": "用户是自由职业者，讨厌啰嗦，偏好简短回复"
  }
}
```

行为指导（在 tool description 中）：
- "用户纠正你或说'记住这个'时 → 保存"
- "用户分享了偏好、习惯、个人信息 → 保存"
- "发现了环境特点（OS、工具、项目结构）→ 保存"
- "不要保存任务进度、临时状态 → 用 session_search 回溯"

**方式二：后台审查线程（_spawn_background_review）**

```
每轮对话结束后：
  │
  ├─ 距上次记忆审查过了 N 轮？（默认 10 轮）→ 触发 memory 审查
  ├─ 距上次技能审查过了 N 次工具调用？（默认 10 次） → 触发 skills 审查
  │
  └─ 任一触发 → 启动后台线程
```

后台审查流程：
1. 把完整对话快照复制给一个独立 AIAgent 实例
2. 用同一个 Model、同样的工具
3. 追加审查指令作为"用户消息"
4. 后台 Agent 直接调用 memory / skill_manage 工具写入磁盘
5. 扫描后台 Agent 的操作记录，摘要推送给用户界面

**审查指令示例：**
- **记忆审查**: "回顾本次对话，用户是否透露了个人偏好/身份信息/行为期望？有就保存。"
- **技能审查**: "是否有需要试错的经验发现？是否有用户期望与实际结果不符？如有就创建/更新技能。"

**关键设计**：在用户收到回复**之后**才启动，不拖慢对话速度。

#### 内存存储

```
~/.hermes/memories/
├── MEMORY.md     # 环境事实、项目约定、工具特性、教训（上限 2200 字符）
└── USER.md       # 用户偏好、沟通风格、工作习惯（上限 1375 字符）
```

两条文件，用 `§` 分隔符分隔多条独立记录。每条是普通文本。

**容量限制（按字符数，不依赖模型 tokenizer）**：
- MEMORY.md：最多 2200 字符
- USER.md：最多 1375 字符

#### 操作 API

| 操作 | 用法 | 说明 |
|------|------|------|
| 写 | `memory(action="add", target="memory", content="...")` | 自动去重、容量检查 |
| 改 | `memory(action="replace", target="memory", old_text="子串", content="...")` | 查找包含子串的条目 |
| 删 | `memory(action="remove", target="memory", old_text="子串")` | 查找包含子串的条目 |
| 读 | `memory(action="read")` | 返回当前条目和用量 |

**安全机制**：
- 写前扫描注入攻击（prompt injection、隐藏 unicode 字符）
- 文件锁保护（多 Agent 并发安全）
- 原子写（临时文件 + rename，不会写入一半就断电）

---

### 自动召回：每轮对话前的主题相关搜索

Hermes 的记忆召回有两个层级来处理不同主题的动态搜索：

#### A. 内存在 System Prompt 中 — 全量注入，不过滤

```
新会话启动：
  1. 读取 MEMORY.md 全部 2200 字符
  2. 读取 USER.md 全部 1375 字符
  3. 冻结快照 → 注入 System Prompt
  4. 无论这次聊什么，记忆都在
```

为什么这么设计：
- 总量小（合计 <4000 字符），对 128K 窗口的模型来说 <3%
- System Prompt 只注入一次，后续复用
- 结构简单可靠，没有召回失败的风险

#### B. 外部插件 — 按需召回

```
本轮用户消息："上次那个 React 项目怎么设置的？"
     ↓
queue_prefetch(user_message)     ← 本轮结束后排队
     ↓
(后台用用户消息做 query 搜索 Honcho/Hindsight 数据库)
     ↓
下一轮对话前 prefetch(user_message)  ← 消费召回结果
     ↓
注入 <memory-context> XML 块
```

**召回格式：**
```
<memory-context>
[系统提示：以下是召回的记忆背景，不是用户新输入。仅作参考。]
- 上次聊 React 时你提到用 Next.js 而不是 CRA
- 用户偏好 TypeScript 而非 JavaScript
</memory-context>
```

用 XML 标签包裹，明确标注"这是背景，不是用户在说话"，防止 LLM 混淆。

#### C. 主动查阅 — LLM 自己决定查不查

内置记忆没有自动搜索，LLM 带着内置记忆开始对话，遇到不够用时自己调用 `memory` 工具查阅。不是系统主动匹配主题，而是 LLM 主动查。

---

### 选择逻辑：内置记忆 vs 外部服务 vs 历史搜索

Hermes 设计了**三层并存**的工具表，暴露给 LLM 同时使用：

```
┌───────────────────────────────────────────────┐
│ ① 内置记忆工具: memory                         │
│    action: add / replace / remove             │
│    target: memory / user                      │
│    存储: MEMORY.md / USER.md（磁盘文件）      │
├───────────────────────────────────────────────┤
│ ② 外部记忆工具（以 Hindsight 为例）:           │
│    hindsight_retain  → 存储事实               │
│    hindsight_recall  → 搜索相关记忆           │
│    hindsight_reflect → 深度综合               │
│    存储: 后端向量库                           │
├───────────────────────────────────────────────┤
│ ③ 跨会话搜索: session_search                  │
│    功能: 搜索历史对话记录                      │
│    存储: sessions.db（SQLite FTS5）           │
└───────────────────────────────────────────────┘
```

LLM 做选择完全依赖工具 schema 中的 **description** 文本指导。

#### 关键机制：内置写入 → 外部自动同步

当 LLM 调用内置 `memory` 工具写入 MEMORY.md 时，Hermes 会自动通知外部插件：

```python
# run_agent.py 中的路径
if tool_name == "memory":
    result = _memory_tool(action, target, content, old_text, store=self._memory_store)
    # 无论成功与否，通知外部插件
    self._memory_manager.on_memory_write(action, target, content)
```

外部插件收到这个通知后，可以把同样的内容写入自己的后端。**两条线都记住了**。

#### 场景映射

| 场景 | LLM 的选择 | 原因 |
|------|------------|------|
| "记住这个：我喜欢用 VS Code" | `memory(add, target=user)` | 明确的用户偏好 |
| 调试中发现罕见错误的解决方法 | `memory(add, target=memory)` | 教训，通用价值 |
| 大量技术细节需要存储 | `hindsight_retain` | 内容可能很大、需要分类标签 |
| "我们上次聊的 React 项目怎么做？" | `session_search` + `hindsight_recall` | 回溯历史 |
| 需要复杂综合回答 | `hindsight_reflect` | 深度分析，不是简单查询 |

---

### Context Compression（上下文压缩）深度分析

触发条件：
```
总 token 数 >= threshold_tokens（默认窗口上限的 50%）
AND 连续两次压缩节省率 >= 10%（防抖动）
```

#### 压缩算法四阶段

**Phase 1：精简旧工具输出（不需要 LLM，速度快）**
- 同一文件读了多次 → 只保留最新完整内容，旧的替换成一行摘要
  - 例：`[read_file] 读取了 config.py（3400 字符）`
- 大文件写操作（参数 >500 字符）→ 仅留开头
- 删除重复的工具输出

**Phase 2：保护头和尾**
- **保护头部 3 条**：系统提示 + 前几轮对话（奠定基调）
- **保护尾部（按 token 预算倒推）**：从最新消息往前倒推，累计消息长度，到预算就停
  - 遇到成对的"工具调用 + 工具结果"不拆开
  - 确保最新一条用户请求一定在尾部，不丢失

**Phase 3：用辅助模型总结中间部分**

摘要采用 12 个固定字段的模板：

| 字段 | 内容 | 说明 |
|------|------|------|
| 当前任务 | **最重要** | 逐字复制用户最新请求 |
| 目标 | 用户想达成什么 | — |
| 约束与偏好 | 编码风格、用户习惯 | — |
| 已完成操作 | 编号列表 | "做了什么 + 结果" |
| 当前状态 | 工作目录、分支、文件 | — |
| 进行中 | 做到哪一步 | — |
| 阻塞项 | 错误信息、卡在哪里 | — |
| 关键决策 | 为什么选 A 不选 B | — |
| 已解决问题 | 问题 + 答案 | 避免重复回答 |
| 待用户回答 | 问了什么但还没回复 | — |
| 相关文件 | 读过/改过/创建了哪些 | — |
| 剩余工作 | 还有什么没做 | — |

- **迭代更新**：如果之前压缩过，增量合并旧摘要和新对话，不从头生成
- **聚焦压缩**：`/compress <focus>` 优先保留相关主题信息
- **摘要模型不可用时**：放占位标记，告诉 LLM "这里丢了一些上下文"

**Phase 4：重新拼装**
- 头 + 摘要 + 尾 拼接成新对话
- 检查"工具调用"和"工具结果"是否成对，孤儿项自动修复
- 摘要生成失败 → 冷却机制（60s/transient，600s/permanent）
- 摘要模型 404 → 自动回退到主模型

#### 防抖动保护

连续 2 次压缩节省都不到 10% → 停止自动压缩，避免无限压缩死循环。

---

### MemoryManager 架构

```
MemoryManager（管理器）
├── BuiltinMemoryProvider（始终存在，不能删除）
│   └── MEMORY.md / USER.md（磁盘文件）
│
└── 外部插件（最多 1 个，按配置选择）
    ├── Honcho
    ├── Hindsight
    ├── Mem0
    ├── Supermemory
    ├── RetainDB
    ├── Holographic
    ├── Byterover
    └── OpenViking
```

MemoryProvider 抽象基类定义了完整生命周期接口：

| 钩子 | 时机 | 用途 |
|------|------|------|
| `initialize()` | 会话启动 | 连接、预热 |
| `system_prompt_block()` | prompt 装配 | 静态 provider 信息 |
| `prefetch()` | 每轮 API 调用前 | 召回相关记忆 |
| `queue_prefetch()` | 每轮结束后 | 排队下一轮召回 |
| `sync_turn()` | 每轮完成后 | 后台持久化 |
| `on_pre_compress()` | compression 前 | 提取关键信息注入摘要 |
| `on_session_end()` | 会话结束 | 事实提取 |
| `on_delegation()` | 子代理完成 | 观察委派结果 |
| `on_memory_write()` | 内置记忆写入时 | 同步到外部后端 |
| `shutdown()` | 会话清理 | 关闭连接、清空队列 |

---

### 设计局限

| 局限 | 说明 |
|------|------|
| 内置记忆全量注入 | 无论聊什么，MEMORY.md 和 USER.md 始终在。记忆多了会浪费 token |
| 没有主题分类 | 内置记忆就是文本列表，没有标签、分类、向量搜索 |
| 依赖 LLM 自己查 | 系统不主动判断"当前主题 vs 记忆内容"的匹配度，全靠 LLM 意识到"我该查一下" |
| 外部插件是黑盒 | 召回效果取决于 Honcho/Hindsight 等外部服务的搜索质量 |

---

## 技能系统

### Skills 文档

兼容 agentskills.io 标准，每个技能是一个目录：
- `SKILL.md` — 技能描述和指令
- 可选: references/, scripts/, templates/

### 技能生命周期

| 操作 | 方式 |
|------|------|
| 查看 | `skills_list` + `skill_view` |
| 编辑 | `skill_manage(action="edit")` |
| 创建/安装 | `skill_manage(action="install/create")` |
| 条件触发 | `SKILL.md` 中的 `condition` 字段 |
| 平台级开关 | 不同 platform 可启用/禁用不同技能 |

### 自主技能创建

- Agent 在完成任务时可自主创建/更新 skill
- `_SKILL_REVIEW_PROMPT` 驱动
- 每 10 个 tool 迭代触发一次 nudge

---

## 多 Agent 协作

### delegate_task 工具

`tools/delegate_tool.py`（1103 行）是实现多 Agent 协作的核心。

```
父代理调用 delegate_task
    ↓
_build_child_agent() — 构建子代理实例
    │  • 独立 AIAgent
    │  • 独立 iteration budget（默认 50）
    │  • 隔离工具集（移除 delegate/clarify/memory/send_message/execute_code）
    │  • 深度限制 MAX_DEPTH=2
    │  • 独立 model/provider/credentials
    ↓
执行:
    ├─ 单任务: 直接 child.run_conversation()
    └─ 多任务: ThreadPoolExecutor(max_workers=N) 并行
    ↓
_run_single_child():
    • 心跳线程: 每 30s 更新父代理活动状态
    • Credential 租赁: pool.acquire_lease() / release_lease()
    • 进度回调: 子代理工具调用实时推送父代理 UI
    ↓
结果汇总 → JSON → 返回父代理的 tool result
```

### 委派约束

| 约束 | 设计 |
|------|------|
| 子代理不共享对话历史 | 只看 goal + context |
| 阻塞等待 | 父代理等所有子代理完成 |
| 不可递归委派 | 移除 delegate_task，深度限制 2 |
| 不可交互用户 | 移除 clarify |
| 不写共享内存 | 移除 memory |
| 不用 execute_code | 要求逐步推理，而非写脚本 |

### Background Review — 后台审查

`_spawn_background_review()`：用户 turn 结束后 **异步** 启动完整 AIAgent 实例：

```
主代理完成响应 → 后台线程启动审查 Agent →
  继承相同 model + tools + 对话历史 →
  注入审查 prompt → 最多 8 次工具调用 →
  扫描 memory/skill 操作 → 摘要推送用户界面
```

实现 agent 自我学习——自动判断是否应将本次对话经验写入 MEMORY.md 或创建新 Skill。

---

## Serve 模式与前后端分离

### OpenAI API Server

**位置**: `gateway/platforms/api_server.py`（~1800 行 FastAPI 应用）

API Server 是 Gateway 的一个**平台适配器**，与 Telegram、Discord 等平台平级。

**端点**:

| 端点 | 说明 |
|------|------|
| `POST /v1/chat/completions` | OpenAI Chat Completions（无状态，每次传完整 messages） |
| `POST /v1/responses` | OpenAI Responses API（**有状态**，server 存对话历史） |
| `GET /v1/responses/{id}` | 检索存储的响应 |
| `DELETE /v1/responses/{id}` | 删除存储的响应 |
| `GET /v1/models` | 列出可用模型 |
| `GET /health` | 健康检查 |

**关键特性**:

| 特性 | 说明 |
|------|------|
| **端口** | 默认 8642 |
| **认证** | Bearer Token（`API_SERVER_KEY`），绑定 `0.0.0.0` 时强制 |
| **CORS** | 默认关闭，可配置 allowlist |
| **Streaming** | SSE 流式输出 + 工具进度 inline 标记 |
| **Named Conversations** | `conversation` 参数自动链接到最新响应 |
| **Response 存储** | SQLite 持久化，最多 100 条（LRU） |
| **Multi-user** | Profile 隔离（独立端口/key/memory/skills） |
| **前端兼容** | Open WebUI、LobeChat、LibreChat 等 10+ |

### ACP Server（Agent Client Protocol）

**位置**: `acp_adapter/`

ACP 是 VS Code / Zed / JetBrains 的 Agent 通信协议标准。独立入口 `hermes-acp`：

- Session 管理（创建/恢复/分叉/列出）
- Model 切换
- MCP Server 注册（Stdio + SSE + HTTP 三种传输）
- 权限审批回调

### Gateway 常驻守护进程

Gateway = **常驻 agent 进程**，同时监听多个消息平台：

```
┌─────────── 前端层（无状态）───────────────┐
│  CLI  │  Telegram  │  Discord  │  WebUI  │
│  TUI  │  Bot       │  Bot      │  OpenAI │
└───┬───┴─────┬─────┴──────┬────┴────┬────┘
    ▼         ▼            ▼         ▼
┌───────────────  Gateway 运行时 ──────────────┐
│  Session Store (SQLite + FTS5)                │
│  Platform Adapters (10+ platforms)            │
│  ┌─────────────────────────────────────────┐  │
│  │  AIAgent (共享核心)                        │  │
│  │  ├── Tool Registry (40+ tools)          │  │
│  │  ├── Context Compressor                 │  │
│  │  ├── Memory Manager                     │  │
│  │  ├── Skill System                       │  │
│  │  └── Plugin Hooks                       │  │
│  └─────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

**设计哲学**: Agent 永远在后台运行（Gateway 常驻），前端只负责交互。同一个 agent 同时服务所有平台，共享 memory、skills、会话状态。

---

## Session 与存储

### Session DB

SQLite + FTS5 全文搜索：
- 会话持久化：JSON 日志 + SQLite 双写
- 增量保存：每次 tool 执行后写 session log
- 跨会话搜索：`session_search` 工具，带 LLM summarization
- Token 统计：input/output/cache/read/write/cost
- 系统 prompt 快照存储（用于 prefix cache 恢复）

### Trajectory 采样

支持保存对话轨迹到 JSONL：
- 成功会话 → `trajectory_samples.jsonl`
- 失败会话 → `failed_trajectories.jsonl`
- 用于训练下一代 tool-calling 模型

---

## Plugin 系统

### Hook 生命周期

| Hook | 触发时机 |
|------|---------|
| `on_session_start` | 新会话首次调用 API |
| `pre_llm_call` | 进入 tool-calling loop 前 |
| `pre_api_request` | 发送 API 请求前 |
| `post_api_request` | 收到 API 响应后 |
| `post_llm_call` | tool-calling loop 结束后 |
| `on_session_end` | run_conversation() 返回前 |

### Context Engine 插件

可替换内置 ContextCompressor：

```yaml
context:
  engine: "compressor"  # 或插件名
```

插件位于 `plugins/context_engine/<name>/` 或安装插件。

### Memory Provider 插件

```yaml
memory:
  provider: "honcho"  # 或插件名
```

---

## 安全与护栏

### 终端安全

- 危险命令审批机制
- `terminal_approval_threshold` 配置触发条件
- `DANGEROUS_COMMANDS` 预定义列表

### 路径安全

- 工作目录限制
- 路径遍历检测（`..` 检测）
- 符号链接跟随策略

### Prompt Injection 防护

- Memory content 扫描
- Context file（AGENTS.md/.cursorrules/SOUL.md）扫描
- 不可见 unicode 字符检测
- 注入模式匹配表

### 技能防护

- `skills_guard.py` — 技能执行前安全检查
- 技能禁用列表
- 跨平台技能开关

---

## 性能与成本

### 成本追踪

| 指标 | 存储 |
|------|------|
| Prompt/Completion tokens | 每 API call 累积 |
| Cache read/write tokens | Anthropic cache命中率 |
| Reasoning tokens | 推理模型专用 |
| Estimated cost USD | 模型定价表查询 |
| 来源标注 | real/estimated/included |

### 上下文压力警告

Tiered 警告系统（仅用户可见，不注入消息）：
- 85% → orange 警告
- 95% → red/critical 警告
- 带 cooldown dedup

---

## 与 OpenCode 的设计对比

| 维度 | Hermes Agent | OpenCode |
|------|-------------|----------|
| **品类** | 通用 AI Agent（聊天/自动化/记忆/跨平台） | 终端内代码 IDE |
| **Agent Loop** | 同步 while 循环，2800 行，20+ 恢复策略 | 流式响应驱动 |
| **工具系统** | 集中注册 + Toolset 组合，40+ 工具 | Plugin 分散注册，~20 工具 |
| **并行工具** | 内置（路径冲突检测，8 线程） | 有限支持 |
| **Context 管理** | 中间压缩 + prompt cache 冻结 | 窗口截断 + 缓存 |
| **记忆系统** | MEMORY.md + USER.md + Memory Provider 插件 | 上下文注入 |
| **技能系统** | 自主创建/更新 + hub 搜索 | 无 |
| **多 Agent** | delegate_task（线程池，深度限制 2） | 无 |
| **Serve 模式** | ✅ API Server + ACP Server + Gateway 常驻 | ❌ 无 |
| **前后端分离** | ✅ Gateway 常驻，多前端接入 | 单体 TUI |
| **OpenAI 兼容** | ✅ `/v1/chat/completions` + `/v1/responses` | ❌ |
| **Session 存储** | SQLite + FTS5 全文搜索 | 文件系统 |
| **错误恢复** | 20+ 策略（thinking signature/credential pool/fallback chain） | 基础重试 |
| **Plugin 系统** | Hook 生命周期 + Context Engine + Memory Provider | Hook-based |
| **多租户** | Profile 隔离 | 无 |
| **Token 预算** | IterationBudget（可 refund） | 无显式预算 |
| **模型灵活性** | 运行时切换，fallback 链，credential pool | 配置切换 |

---

## 与 WopalSpace 的设计对比

| 维度 | Hermes | WopalSpace |
|------|--------|------------|
| **Agent 核心** | 同步 Python while loop | OpenCode 异步 TypeScript |
| **记忆模型** | MEMORY.md + User profile | LanceDB 长期记忆 + MEMORY.md + AGENTS.md |
| **技能系统** | agentskills.io 兼容，自主创建 | Ontology 源码层，手动编辑 + deploy |
| **部署模型** | Gateway 常驻 + 多平台 | OpenCode 单次会话 |
| **多 Agent** | delegate_task（同进程线程池） | wopal_task（异步，双向通信）|
| **用户交互** | 用户发消息 → agent 响应 | 用户发消息 → Wopal（规划）→ fae（执行） |
| **安全护栏** | Prompt injection 扫描 + 终端审批 | AGENTS.md 红线 + 宪法 |
| **前端分离** | ✅ 10+ 前端兼容 | Wopal 运行在 OpenCode TUI |

---

## 可借鉴的功能

### 高优先级

| # | 功能 | 借鉴理由 |
|--|------|---------|
| 1 | **Prompt Cache 冻结模式** | 这是 Anthropic 缓存高效利用的关键——system prompt 冻结、memory 异步更新不刷新 prompt、插件上下文注入 user message。WopalSpace 当前 session 继续时 system prompt 可能因记忆更新而重建，破坏缓存。 |
| 2 | **20+ 错误恢复策略** | Hermes 的错误分类器将 API 错误分为 rate_limit/credential_rotate/compression/fallback 等类型。Wopal 的 OpenCode 基础恢复太粗（重试 + fallback）。 |
| 3 | **Context Compression（中间总结）** | 当上下文超过阈值 50% 时自动总结中间 turn。OpenCode 有类似机制但 Hermes 的 tier 降级 + 解析 limit + output cap 细化更全面。 |
| 4 | **API Server（OpenAI 兼容）** | 让 Wopal 的能力可通过标准 API 暴露给 Open WebUI 等前端。配合 profile 隔离实现多租户。 |
| 5 | **Toolset 组合系统** | Hermes 的 includes 递归组合优于 Wopal 扁平工具注册。可参考设计 ontological toolsets。 |

### 中优先级

| # | 功能 | 借鉴理由 |
|--|------|---------|
| 6 | **迭代预算（IterationBudget）** | 替代 max_iterations。execute_code refund 模式对 Wopal 的 Fae 委派有启发——编程式调用应有独立计票。 |
| 7 | **Background Review（后台审查 Agent）** | Wopal 的 `/memo` 是手动的，Hermes 自动判断何时该记忆/创建技能。可借鉴 `_spawn_background_review()` 模式。 |
| 8 | **Gateway 常驻模式** | "Agent 永远在后台"。Wopal 当前是 OpenCode 会话级生命周期。如果要做"无处不在的 Wopal"，Gateway 模式是必经之路。 |
| 9 | **Profile 多实例隔离** | 完整的 HERMES_HOME 隔离。Wopal 目前只有单一身份。 |
| 10 | **Grace Call** | 预算耗尽前先让模型总结已完成的工作，避免用户得到空回复。 |

### 探索性

| # | 功能 | 借鉴理由 |
|--|------|---------|
| 11 | **Credential Pool** | 多密钥轮换应对 rate limit。Wopal 目前单 key。 |
| 12 | **Prompt Injection 扫描** | Memory/Context 内容安全扫描。WopalSpace 宪法中缺乏自动化防护层。 |
| 13 | **Trajectory 采样** | 保存成功/失败对话轨迹用于训练下一代 tool-calling 模型。与 Wopal 的"自我进化"理念一致。 |
| 14 | **ACP 协议适配** | VS Code / Zed 的 Agent 通信协议。如果 Wopal 要进入 IDE，这是标准路径。 |
| 15 | **Thinking-only prefill** | 模型只产出 reasoning 没产出文本时，自动 prefill 继续。Hermes 处理各种 reasoning 模型 quirks 非常细。 |

---

*(研究完成 — 10578 行核心代码深度分析)*