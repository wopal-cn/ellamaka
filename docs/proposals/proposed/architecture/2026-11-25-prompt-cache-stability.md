# Ellamaka Prompt Cache Stability and Context Prefix Governance

Status: proposed

- **Class**: architecture
- **Created**: 2026-11-25

## Problem

在多轮对话与工具调用长会话中，KV Cache（Prompt Cache）命中率决定了首字延迟和 Token 成本。`ellamaka` 当前把多个会随回合、目录、日期或配置变化的动态内容直接拼进请求前缀（system prompt、tool definitions 和历史消息），导致模型服务端看到的前缀字节序列频繁变动，缓存从变化点之后整体失效。

逐一排查 [request.ts](../../../../packages/opencode/src/session/llm/request.ts)、[system.ts](../../../../packages/opencode/src/session/system.ts)、[registry.ts](../../../../packages/opencode/src/tool/registry.ts)、[compaction.ts](../../../../packages/opencode/src/session/compaction.ts)、[reminders.ts](../../../../packages/opencode/src/session/reminders.ts)、[prompt.ts](../../../../packages/opencode/src/session/prompt.ts)、[transform.ts](../../../../packages/opencode/src/provider/transform.ts) 与 [native-request.ts](../../../../packages/opencode/src/session/llm/native-request.ts)，当前存在五处破坏前缀稳定性的结构性问题：

1. **System Prompt 整块拼接且混入易变字段**：[request.ts](../../../../packages/opencode/src/session/llm/request.ts) 将 agent/provider 提示词、`env`、`instructions`、`skills`、`structured-output` 与 `user.system` 合并为单条字符串。其中 [system.ts](../../../../packages/opencode/src/session/system.ts) 直接写入 `Today's date: ${new Date().toDateString()}`，一旦跨天（本地时间 00:00）整条 `system` 文本即失效；后续动态加载目录指令或 `mcp` 列表变化时，也会改变整条 `system[0]`。
2. **Tool Definitions 随会话内状态变化而整体重排/改写**：[registry.ts](../../../../packages/opencode/src/tool/registry.ts) 在每次构建工具列表时，把 `describeTask(input.agent)` 与 `describeSkill(input.agent, input.sessionPermission)` 直接拼入 `task` 和 `skill` 的工具描述；同时动态连接或按需加载 MCP 工具会直接增删全量工具数组。对将 `tools` 序列化在 `system` 前面的模型后端（如 Anthropic）而言，工具列表末尾之外的任何改动都会击穿工具区之后所有 `system` 与 `messages` 缓存；同时 [request.ts](../../../../packages/opencode/src/session/llm/request.ts) 使用依赖宿主 Locale 的 `localeCompare` 排序工具，存在跨环境顺序漂移风险。
3. **工具结果就地剪枝破坏历史前缀**：当启用 `compaction.prune`（默认开启）时，[compaction.ts](../../../../packages/opencode/src/session/compaction.ts) 异步写入 `part.state.time.compacted = Date.now()`，后续 [message-v2.ts](../../../../packages/opencode/src/session/message-v2.ts) 在渲染历史消息时把旧 `tool` 输出就地替换为 `"[Old tool result content cleared]"`。这种“回溯改写历史消息体”的做法，会直接击穿从被剪枝消息往后的全部前缀缓存。
4. **In-memory 改写消息与 `<system-reminder>` 注入**：[reminders.ts](../../../../packages/opencode/src/session/reminders.ts)（非实验性 Plan Mode 时）在每一步就地改写 `userMessage.parts`，[prompt.ts](../../../../packages/opencode/src/session/prompt.ts) 在 `step > 1` 时把用户追问包进 `<system-reminder>` 标签。若前缀中的某条消息或中间态提醒被修改或重插，同样会让后续整段历史无法命中缓存。
5. **`cache_control` 断点设置粗糙且遗漏工具区与原生链路**：[transform.ts](../../../../packages/opencode/src/provider/transform.ts) 的 `applyCaching()` 仅覆盖部分非 gateway 路由的 `anthropic`/`claude`/`alibaba` 模型，只标记 `system.slice(0, 2)` 和末尾两条非 system 消息，没有给静态 `tools` 末尾加缓存断点；更重要的是，[native-request.ts](../../../../packages/opencode/src/session/llm/native-request.ts) 在调用原生 `@wopal/llm` 时未传递 `ToolDefinition.cache` 与分段 `SystemPart.cache`，而底层的 [anthropic-messages.ts](../../../../packages/llm/src/protocols/anthropic-messages.ts) 与 [bedrock-converse.ts](../../../../packages/llm/src/protocols/bedrock-converse.ts) 已经支持最多 4 个缓存断点（含 `tool.cache`）。

## Proposal

借鉴 `deepseek-harness`（`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-agent-loop`、`@deepseek-ai/dsh-llm`）的缓存工程实践，将“前置声明的静态部分”与“随会话演进的动态部分”严格隔离，把所有增量变化约束在前缀末尾（append-only）。与并发推进的 MCP 改造提案 [2026-11-25-mcp-runtime-modernization.md](./2026-11-25-mcp-runtime-modernization.md) 协同，共同守住多工具场景下的前缀稳定性。

整体策略概括为四条原则：

1. **System 稳定化与分块化**：把跨天变化、目录状态、动态指令和运行时上下文移出静态前缀。
2. **Tools 前缀锁定与增量声明**：固定工具排序规则，禁止改写已有工具描述；运行期新激活的工具通过 `addition-only` 消息增量声明，避免回改顶层 `tools` 声明区。
3. **历史消息不可变（Append-only）**：禁用或改用不可变分支策略处理旧工具结果剪枝，禁止回写既有历史消息。
4. **原生与兼容路由统一的 4 断点 Cache Control**：充分利用 `@wopal/llm` 已支持的 `tool.cache` 与 `system` / `messages` 多断点布局，补齐原生链路与 AI SDK 链路的能力对齐。

## Prefix Isolation and Append-Only State Design

### 1. System Prompt 结构重分块与去易变化

参考 `@deepseek-ai/dsh-system-prompt` 与 `@deepseek-ai/dsh-agent-loop` 的 `SystemPromptProjection` / `RuntimeContextProjection` 模型，将当前合并成单条字符串的 `system` 拆分为有序块（在支持多 `SystemPart` 的通道保留分块，在仅支持单字符串通道保持确定性顺序与标记边界）：

1. **静态基础设施层（Tier 0，长周期不变）**：provider 核心指令、agent 基础角色指令、全局规则摘要。该层在同一个 session 生命周期内禁止插入时间戳、随机 ID 或动态列表。
2. **会话级环境锚点层（Tier 1，Session 启动快照）**：将 [system.ts](../../../../packages/opencode/src/session/system.ts) 中的 `Today's date`、工作区根目录、Git 分支基础信息固定为“会话创建/首轮请求时的快照”，持久化在 session 元数据中；不再在每轮请求调用 `new Date().toDateString()`。若需向模型报告当前日期变化或环境状态变更，改为走下述运行期上下文增量注入。
3. **动态运行期上下文（Append-only `<system-reminder>`）**：参考 `RuntimeContextProjection` 与 `deepEqualJson` 去重机制，目录级 `AGENTS.md` / `CLAUDE.md`（参见 [DESIGN-instruction-loading.md](../../../DESIGN-instruction-loading.md)）、Skill 目录更新、日期跨天切换、MCP 服务器说明书与状态变化（由 [2026-11-25-mcp-runtime-modernization.md](./2026-11-25-mcp-runtime-modernization.md) 产生），统一收敛为结构化的 runtime context sections。每轮仅当某个 section 的规范化快照较上一次已注入历史发生变化时，才向当前最新一条 user message 末尾追加增量 `<system-reminder>`，已经注入过的历史消息永远保持原样。

### 2. Tool Definitions 前缀稳定性与 `addition-only` 更新

工具区往往是整个请求中最大的静态前缀之一，任何变更都应遵循“既不改旧条目、也不插队重排”：

1. **确定性排序**：将 [request.ts](../../../../packages/opencode/src/session/llm/request.ts) 中的 `localeCompare` 替换为基于 Unicode 码位（code-unit / `a < b ? -1 : a > b ? 1 : 0`）的纯确定性排序，消除不同系统 `LC_ALL` 导致的工具顺序漂移。
2. **剥离 `task` 与 `skill` 工具描述中的动态枚举**：不再在 [registry.ts](../../../../packages/opencode/src/tool/registry.ts) 中每次请求拼接全量 subagent 列表和 permission 过滤后的 skill 列表进工具 schema。静态工具 description 只保留参数用法说明；动态的可用 agent / skill 清单移入上文 Runtime Context 增量注入或按需查询工具。
3. **工具集合扩展的双模式投影（`in-history` vs `addition-only`）**：
   - 参考 `@deepseek-ai/dsh-agent-loop` 的 `toolUpdate` 策略，针对当前在 `ellamaka` 中由 MCP 按需加载（如 `load_tools`）或会话中途重连新增的工具，引入显式的会话工具激活台账（`activatedTools`），仅追加不删除。
   - 对支持在对话流中动态激活或通过开发者消息声明增量的模型协议，新加载工具不回改初始顶层 `tools` 前缀，而是跟随 tool result / developer-like 增量上下文通知模型，并尽量利用原生 `defer_loading` / `tool_reference`（当协议支持时）或将 MCP 核心网关工具（如 `load_tools`）留在静态前缀内。
   - 若因配置强制变更确实必须改动顶层 `tools` 列表，标记新的缓存序列边界（`startsSeries` 语义），在 session 状态和日志中显式记录“预期缓存重置原因”。

### 3. 历史消息不可变策略与剪枝调整

解决当前 [compaction.ts](../../../../packages/opencode/src/session/compaction.ts) 与 [reminders.ts](../../../../packages/opencode/src/session/reminders.ts) 的历史改写问题：

1. **默认关闭会破坏前缀的就地 Tool Output Prune**：把 `compaction.prune` 对已有已发送历史消息的就地替换行为与“真正的会话压缩（Compaction Summary）”拆开。在常规多轮对话（未触发完整上下文窗口上限 Compaction）期间，禁止就地替换旧 tool output 为 `"[Old tool result content cleared]"`；仅允许在执行全量 Compaction（生成新摘要消息开启新前缀）时丢弃或截断原始工具输出。若保留 `prune` 配置项用于极端降本场景，须在配置文档与默认行为中明确标记为 `destructive-cache` 选项且默认不启用。
2. **禁止就地突变既有 `MessageV2` Parts**：重构 [reminders.ts](../../../../packages/opencode/src/session/reminders.ts) 与 [prompt.ts](../../../../packages/opencode/src/session/prompt.ts)，不再修改之前轮次已经发送给 LLM 的 `userMessage.parts`。所有提醒（Plan/Build 模式切换、权限变化、中断恢复提示）统一附加到**当前待发送的新 user turn** 尾部，保证前缀字节流严格只增不改。

### 4. 四断点 Cache Control 统一编排与可观测性

1. **统一标记规划器**：在 [request.ts](../../../../packages/opencode/src/session/llm/request.ts) 与 [native-request.ts](../../../../packages/opencode/src/session/llm/native-request.ts) 之前抽象一个提供商无关的缓存断点规划器，按协议能力分配最多 4 个断点：
   - Breakpoint 1：静态 `tools` 定义数组最后一个工具（通过 `@wopal/llm` 原生支持的 `ToolDefinition.cache` 与 AI SDK adapter 透传）。
   - Breakpoint 2：静态 `system` 分块（Tier 0 + Tier 1）末尾。
   - Breakpoint 3 & 4：滑动置于历史对话最后两条稳定消息锚点（例如倒数第二轮结束与当前最新稳定 user turn 之前），且避免在每一步流式 tool loop 中来回挪动导致单轮内频繁失效。
2. **补齐 [native-request.ts](../../../../packages/opencode/src/session/llm/native-request.ts) 的透传**：利用 [anthropic-messages.ts](../../../../packages/llm/src/protocols/anthropic-messages.ts) 和 [bedrock-converse.ts](../../../../packages/llm/src/protocols/bedrock-converse.ts) 现成的 `part.cache` 与 `tool.cache` 字段，让原生 `@wopal/llm` 请求路径与 [transform.ts](../../../../packages/opencode/src/provider/transform.ts) 具备同等甚至更完整的工具区缓存能力。
3. **缓存命中与失效审计指标**：在 session assistant message 的 usage 元数据及调试日志中，计算每轮 `prefixHash`（分别统计 `toolsHash`、`systemStaticHash`、`historyPrefixHash`）以及 `cacheRead / (input + cacheRead)` 命中率；当任意前缀分段 Hash 意外变化时记录结构化告警原因（如 `tool_order_changed`、`system_mutated`、`history_rewritten`）。

## Alternatives considered

1. **仅调整 `applyCaching()` 断点数量而不修改前缀构造**：只需小幅修改 [transform.ts](../../../../packages/opencode/src/provider/transform.ts) 与 [native-request.ts](../../../../packages/opencode/src/session/llm/native-request.ts)。但只要日期、动态工具描述、`prune` 和就地提醒继续改写前缀内容，再精准的 `cache_control` 断点依然会逐轮穿透，治标不治本，因此不采用。
2. **仅对 Anthropic 系列模型做前缀稳定化，其他 Provider 维持现状**：OpenAI、DeepSeek、Google Gemini 等主流模型同样使用隐式或显式前缀匹配缓存（Prefix Caching）；统一的前缀只增不改约束对所有模型都有直接收益，因此把稳定化做在中间请求层而非单一协议适配层。
3. **继续保留异步 `SessionCompaction.prune()` 并靠延迟触发躲避缓存期**：`prune` 的触发点在多轮工具会话中几乎必然落在缓存 TTL 窗口（如 Anthropic 5 分钟 / DeepSeek 上下文缓存窗口）之内，只要就地替换历史正文就会必然造成整段重算，因此必须将“保留旧输出直至整段 Compaction”作为默认架构策略。

## Acceptance criteria

1. **静态前缀字节零漂移**：同一会话连续执行 10 轮以上包含工具调用、目录指令加载与跨子夜日期模拟的多步测试时，前 9 轮已建立的 `toolsHash`、`systemStaticHash` 以及历史消息前缀序列保持 100% 一致，不因 `new Date()`、permission 变动或 `task`/`skill` 描述变化发生改变。
2. **Tool 顺序与增量安全**：工具排序改为码位确定性排序；`task` 与 `skill` 工具描述不再内嵌随会话变化的动态列表；新增激活的按需工具不破坏已建立工具区前缀的连续性。
3. **剪枝与提醒不再回写历史**：默认配置下多轮会话不改写历史消息中的 `tool` part 正文；所有 `SessionReminders` 与运行期上下文仅在变化时追加到最新 user message 末尾，连续无状态变化的多轮不重复注入。
4. **双链路缓存断点生效**：单元测试与请求快照验证 [native-request.ts](../../../../packages/opencode/src/session/llm/native-request.ts) 与 [transform.ts](../../../../packages/opencode/src/provider/transform.ts) 均能为支持缓存的协议正确输出包含工具区尾断点与系统静态区尾断点在内的断点标记（总数不超过协议上限 4 个），且真实兼容集成回放显示连续多轮对话 `cacheRead` 占比稳定维持预期高位。

## Risks

1. **保留旧工具输出可能加快触达上下文窗口上限**：取消常规轮次的就地 `prune` 后，大体积工具输出会在历史中保留更久，可能更早触发全量 Compaction。缓解方案是严格执行输出截断上限（tool output truncation）并依赖全量 Compaction 一次性切换干净摘要前缀。
2. **动态目录指令与 Skill 列表从 System 前缀后移后的注意力权重变化**：把部分动态清单移入 `<system-reminder>` 后，少数遵循能力较弱的模型可能对尾部提醒关注度不如系统首部高。需要在提示词模板与集成评测中验证工具调用准确率，确保不回退。
3. **不同模型协议对多块 `system` 与 `addition-only` 工具的兼容差异**：部分 OpenAI-compatible 中转接口不支持多个 `system` 数组元素或工具动态补充，需要按 `request` / `native-request` 渠道做降级合并，保证结构统一与功能可用不冲突。
