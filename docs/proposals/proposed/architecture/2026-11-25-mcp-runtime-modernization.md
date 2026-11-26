# Ellamaka Native MCP Runtime Modernization

Status: proposed

- **Class**: architecture
- **Created**: 2026-11-25

## Problem

`ellamaka` 当前的 MCP 运行时建立在 `@modelcontextprotocol/sdk` `1.27.1`（见 [package.json](../../../../packages/opencode/package.json)）和早期 OpenCode 的同步/投影模型之上（主要位于 [index.ts](../../../../packages/opencode/src/mcp/index.ts)、[tools.ts](../../../../packages/opencode/src/session/tools.ts)、[auth.ts](../../../../packages/opencode/src/mcp/auth.ts)、[oauth-provider.ts](../../../../packages/opencode/src/mcp/oauth-provider.ts) 与 [mcp.ts](../../../../packages/opencode/src/config/mcp.ts)）。在实际接入较多 MCP Server 或复杂企业工具时，这套实现暴露出五类明显短板：

1. **MCP 协议版本与特性停留在旧代，且缺少能力验证**：[index.ts](../../../../packages/opencode/src/mcp/index.ts) 沿用单包 `1.27.1`，未接入 MCP v2 规范（如 `2026-07-28` 协商与现代结构化载荷）。相反，为了绕过部分 Server 返回的 `outputSchema`，代码中不得不手写 `TolerantListToolsResultSchema` 直接把 `outputSchema` 剥离掉；[tools.ts](../../../../packages/opencode/src/session/tools.ts) 执行结果循环仅处理 `text`、`image`、`resource`，直接忽略 `structuredContent`、`resource_link` 与 `audio`，也不识别 `execution.taskSupport === 'required'`。
2. **上下文爆炸与缓存破坏严重**：只要挂载多个 MCP Server，[index.ts](../../../../packages/opencode/src/mcp/index.ts) 与 [tools.ts](../../../../packages/opencode/src/session/tools.ts) 就会把全部 MCP 工具 schema 一次性平铺进模型顶层工具列表，既吞噬有限上下文，又和静态前缀稳定性冲突。同时，Server 提供的 `instructions`（`client.getInstructions()`）、资源模板（`listResourceTemplates()`）也未被系统化接管和向模型暴露。
3. **命名碰撞与 64 字符限制未防护**：当前使用 `sanitize(service) + "_" + sanitize(tool.name)`（把非字母数字字符全替换为 `_`）作为工具名并在循环中覆盖写入。不仅会出现不同服务/工具清理后撞名静默覆盖，也没有处理主流大模型对工具名 64 字符上限的约束。
4. **生命周期、重连与快照原子性不足**：缺少两阶段快照更新、`tools/list_changed` 的防抖合并（debounce）与原子替换、带抖动和上限的指数退避重连、空闲探活（probe）、退出前 `closeTimeoutMs` 兜底，以及面向子进程的环境变量脱敏。
5. **不适合经由 `dsh-adapter` 转接替代原生 MCP**：当前 `ellamaka` 的本地核心工具已通过 `ellamaka-tools` 与原生/本地沙箱体系紧耦合（参见 [DESIGN.md](../../../DESIGN.md) 与 [DESIGN-ellamaka-tools.md](../../../DESIGN-ellamaka-tools.md)）。若通过 `ellamaka-cordis` 的 `dsh-adapter` 强行把 MCP 与运行态托管给 DSH（或直接引入绑定 Cordis `Context` 的 DSH npm 包），会带来双重控制面、跨沙箱语义分裂以及重型运行态耦合风险。

因此需要按“路线 B”：保持 `ellamaka` 原生 Effect + `packages/opencode` 控制面架构不变，将 `@deepseek-ai/dsh-mcp-client` 与 `@deepseek-ai/dsh-mcp-resources` 验证过的成熟机制，基于官方 MCP v2 SDK 原生复刻并整合进 `ellamaka`。

## Proposal

在 `packages/opencode` 中以 Effect 原生架构升级 MCP 子系统，直接依赖官方 `@modelcontextprotocol/client` 与 `@modelcontextprotocol/core`（v2 系列），不引入 `dsh-adapter` 桥接，也不直接依赖绑定 Cordis `Context` 的 DSH 上层包。

升级范围覆盖协议层、工具命名与按需加载、结构化校验、资源与说明书暴露、连接韧性以及认证/配置/HTTP 控制面平滑兼容，并与前缀缓存治理提案 [2026-11-25-prompt-cache-stability.md](./2026-11-25-prompt-cache-stability.md) 协同保证上下文经济性与缓存命中。

## Protocol Upgrade and Runtime Architecture

### 1. 升级 MCP v2 SDK 与双形态传输层

1. **依赖替换**：在 [package.json](../../../../packages/opencode/package.json) 中将 `@modelcontextprotocol/sdk`（`1.27.1`）替换为官方 MCP v2 `@modelcontextprotocol/client` 与 `@modelcontextprotocol/core`（如 `2.2.0` 兼容版本），配合 `ajv` 负责 `outputSchema` 校验。
2. **协议协商**：建立连接时参考 `dsh-mcp-client` 的 `versionNegotiation: { mode: 'auto' }` 策略，优先协商最新协议版本（`2026-07-28`）并保留对旧版 Server 的兼容回退；在实例状态中记录每个 Server 实际协商出的 `protocolVersion`、`capabilities` 与 `serverInfo`。
3. **传输与子进程隔离**：
   - `stdio` 本地命令严格参考 `scrubbedParentEnv()` 进行环境清理：仅保留安全白名单变量并显式剔除宿主敏感凭据与代理/Token 变量后再合并用户配置的 `env`，默认 `stderr: 'pipe'` 并对诊断输出做 `[redacted]` 敏感词脱敏。
   - **沙箱边界显式声明**：沿用 `ellamaka` 与 DSH 一致的边界事实——外接 `stdio` MCP 子进程由客户端宿主启动，远程 `http`/`sse` MCP 服务运行于远端，MCP 工具调用本身**不自动运行在 `ellamaka` 内部工具沙箱内**；当全局开启沙箱策略时，需要在配置/权限说明与 UI 状态提示中清晰标示外接 MCP 的独立信任边界与权限确认规则。

### 2. 工具命名规范、`Ajv` 结构化校验与全量结果投影

1. **规范化命名与防碰撞**：替换当前 `sanitize(service) + "_" + sanitize(tool.name)` 逻辑，参考 `publicToolName()` 规范为 `mcp__<serverName>__<rawName>`（非法字符规范化后若超出 64 字符或发生截断/标准化碰撞，追加 12 位 SHA-256 摘要后缀保证稳定且全局唯一），保留旧工具名别名兼容映射策略或清晰迁移告警。
2. **`outputSchema` 校验与 `structuredContent` 支持**：移除 [index.ts](../../../../packages/opencode/src/mcp/index.ts) 中的 `TolerantListToolsResultSchema` 剥离逻辑。保留并缓存每个工具的 `outputSchema`，在 [tools.ts](../../../../packages/opencode/src/session/tools.ts) 收到 `CallToolResult` 时：
   - 若工具声明了 `outputSchema` 且返回非 `isError`，使用缓存的 `Ajv` 校验器校验 `structuredContent`；校验失败抛出结构化协议错误（类似 `MCP_INVALID_RESULT`）。
   - 若工具定义声明 `execution?.taskSupport === 'required'`，在同步调用路径显式拒绝并给出明确错误码（`MCP_UNSUPPORTED_TASK_EXECUTION`），避免挂起或静默误解析。
   - 结果投影扩展到完整的 `text`、`image`、`audio`、`resource_link` 与 `structuredContent`，不再静默丢弃新规范字段。

### 3. On-Demand 工具加载、Instructions 与 MCP Resources 暴露

1. **两级工具加载模式（`eager` vs `on-demand`）**：
   - 在 [mcp.ts](../../../../packages/opencode/src/config/mcp.ts) 与 [config.ts](../../../../packages/opencode/src/config/config.ts) 中新增 per-server / 全局 `toolLoading: 'eager' | 'on-demand'`、单工具加载开关与 `catalogDescriptionMaxLength`（参考 `160` 字符截断）配置。
   - 参考 `McpToolLoader` 机制，对 `on-demand` 服务默认仅注册轻量的目录加载入口工具 `mcp__<serverName>__load_tools`（或按服务暴露摘要目录到运行时上下文），模型按需调用后按 `(sessionID, agentName)` 隔离记录已激活工具集合，并结合 [2026-11-25-prompt-cache-stability.md](./2026-11-25-prompt-cache-stability.md) 的 `addition-only` 机制向模型增量开放完整 JSON Schema，大幅削减空闲工具的初始上下文占用。
   - **注意兼容**：为不破坏现有用户无配置升级体验，已有 MCP 配置在未显式指定时可保持 `eager` 或在接入数量超过阈值时提供默认提示与可切换配置。
2. **接管 `server.instructions`**：连接就绪后读取 `client.getInstructions()`，按上限（如 `32 KiB`）做截断和清洗，经由 Runtime Context 通道分块注入会话，不再丢弃 Server 附带的用法说明。
3. **补全 MCP Resources 一等公民工具**：参考 `dsh-mcp-resources`，在原生工具层新增通用资源工具 `list_mcp_resources`、`list_mcp_resource_templates` 与 `read_mcp_resource`（封装现有与新增的 `listResourceTemplates()` 能力），并在运行时上下文摘要（`mcp-resource-servers`）中向模型列出支持 `resources` 能力的已连接 Server，让模型无需硬编码 URI 即可自行探索并读取 MCP 资源与模板。

### 4. 连接韧性、原子快照与控制面兼容

1. **两阶段原子 `syncTools()` 与防抖**：收到 `tools/list_changed`（以及 `resources/list_changed`、`prompts/list_changed`）通知时先做短窗防抖，通过后台拉取构造完整新快照并完成 schema 编译后，再原子替换运行态快照；避免刷新中途工具短暂消失。
2. **退避重连、探活与优雅关闭**：为远程 `http`/`sse` 与可重启 `stdio` 增加指数退避重连（`initialDelayMs: 500`、`maxDelayMs: 30_000`、带抖动和 `maxAttempts: 10` 上限）、定期连接探活、单次调用超时（默认 `toolCallTimeoutMs: 60_000` 与配置支持）以及关闭/实例释放阶段的 `closeTimeoutMs`（如 `5_000 ms`）兜底强关机制。
3. **OAuth / HTTP API / CLI 接口平滑迁移**：
   - 将 [auth.ts](../../../../packages/opencode/src/mcp/auth.ts) 与 [oauth-provider.ts](../../../../packages/opencode/src/mcp/oauth-provider.ts) 中的实现对接到 MCP v2 `@modelcontextprotocol/client` 的 OAuth auth provider 接口，保留 `~/.local/share/...` 既有本地凭据存储格式兼容。
   - 保持 [groups/mcp.ts](../../../../packages/opencode/src/server/routes/instance/httpapi/groups/mcp.ts) 与 [handlers/mcp.ts](../../../../packages/opencode/src/server/routes/instance/httpapi/handlers/mcp.ts) 对外的 REST/RPC 端点契约、事件广播和 `GET /tool` 能力发现（参见 [DESIGN.md](../../../DESIGN.md)）语义兼容，使 TUI、Desktop 与 Web 前端无需同步重写即可拿到工具、Prompts 与 Resources 状态；同时保持 [command/index.ts](../../../../packages/opencode/src/command/index.ts) 的 MCP Slash Commands 正常运行。

## Alternatives considered

1. **路线 A：通过 `ellamaka-cordis` 的 `dsh-adapter` 挂载整个 DSH MCP 管线**：改动面涵盖 ToolRegistry、Sandbox 桥接、权限流与状态广播双同步，极易把当前已稳定的原生简单工具与本地沙箱引入不稳定因素，已被明确排除。
2. **直接在 `packages/opencode` 引入 `@deepseek-ai/dsh-mcp-client` 与 `@deepseek-ai/dsh-mcp-resources` npm 包**：DSH 侧包强依赖 Cordis 插件运行时（`Context`、Cordis 服务注入、`dsh-tools` 类型体系），直接复用会在 `ellamaka` 原生 Effect 架构中引入第二套 DI 容器和类型转换胶水层，反而加重维护负担。采用官方 MCP v2 SDK 原生复刻设计语义是最轻量的长期方案。
3. **继续停留在 `@modelcontextprotocol/sdk` `1.27.1` 上打补丁**：无法原生获得 MCP `2026-07-28` 协议协商与 v2 split package 的类型约束，后续每新增一项新规范（如 tasks、structuredContent 校验、audio/resource_link）都需要重复造轮子甚至维护分叉 schema。

## Acceptance criteria

1. **MCP v2 依赖与协议能力落地**：[package.json](../../../../packages/opencode/package.json) 迁移至 `@modelcontextprotocol/client` 与 `@modelcontextprotocol/core` v2；针对 mock/真实 v2 与 legacy Server 的测试均能完成版本自动协商，且状态接口返回准确的 `protocolVersion` 与能力集合。
2. **结构化校验与完整内容投影**：启用 `outputSchema` 校验测试——合法 `structuredContent` 正常透出，`isError: false` 但校验不通过时返回预期协议错误；`execution.taskSupport === 'required'` 返回明确不支持错误；`text`、`image`、`audio`、`resource_link` 与 `structuredContent` 在 [tools.ts](../../../../packages/opencode/src/session/tools.ts) 中均可被正确映射。
3. **防碰撞命名与按需加载**：单测验证超过 64 字符工具名及不同 Server 同名清洗场景生成确定性哈希后缀不发生静默覆盖；开启 `toolLoading: 'on-demand'` 后，首轮模型上下文仅包含 `mcp__<server>__load_tools`（或轻量摘要），调用加载后再在当前 `(sessionID, agentName)` 作用域下增量可见。
4. **Instructions 与 Resources 工具可用**：连接携带 `instructions` 与 `resources`/`resourceTemplates` 的测试 Server 时，说明书截断注入生效，且 `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` 三项工具可完成端到端查询与读取。
5. **韧性与现有控制面兼容**：模拟断连触发退避重连，并发 `tools/list_changed` 通知仅触发合并后的单次原子工具快照切换，subprocess 环境脱敏验证关键密钥不会泄漏进子进程；已有 HTTP MCP endpoints、OAuth 凭据读取与 Slash Command 回归测试全部通过。

## Risks

1. **MCP v2 SDK API 与 `1.27.1` 差异引发 OAuth 与传输适配工作量**：官方 SDK v2 拆包后部分 auth hook、SSE fallback 与 Error 类名发生变化，需要在迁移期补充完整的 `stdio`/`http`/`sse` 与 OAuth 集成测试覆盖 [oauth-provider.ts](../../../../packages/opencode/src/mcp/oauth-provider.ts)。
2. **`on-demand` 工具加载可能增加一次额外的模型思考往返**：首次发现与加载特定 MCP 工具多出一次 `load_tools` 调用。可通过保留 `eager` 配置选项、按 Server 粒度配置 `toolLoading`，以及向模型提示清晰的摘要目录（`catalogDescriptionMaxLength`）来平衡延迟与 Token 占用。
3. **升级期间与 `ellamaka` 生成 SDK 及前端契约同步**：如果扩展 MCP status 返回字段（如 `protocolVersion`、`toolLoading`、`capabilities`），需要按 [DESIGN.md](../../../DESIGN.md) 约束同步重新生成 SDK 并核对客户端消费方，避免前后端字段脱节。
