# OpenCode 2026-04-17 调试机制研究

> **日期**: 2026-04-17
> **源码位置**: `labs/ref-repos/opencode/`
> **版本**: dev 分支 (ec3ac0c4b)
> **研究目标**: 调试每轮 LLM 调用上下文、插件注入前后状态

---

## 一、日志系统

### 基础架构

```
packages/opencode/src/util/log.ts
```

**Log 级别**: `DEBUG(0) < INFO(1) < WARN(2) < ERROR(3)`

**日志格式**:

```
<时间戳> +<延迟ms> <标签> <消息>
```

示例:

`2026-04-17T10:30:00 +42ms service=llm providerID=anthropic modelID=claude-sonnet-4-6 stream`

**输出去向**:

- `--print-logs`: 写入 stderr
- 默认（无此标志）: 写入 `Global.Path.log/<ISO_TIMESTAMP>.log`（自动轮换，保留最近 10 个文件）
- 本地/dev 安装默认级别自动为 `DEBUG`，生产安装默认为 `INFO`

### Effect Logger 桥接

```
packages/opencode/src/effect/logger.ts
```

Effect 框架有自己的 Logger，opencode 在 Effect Logger 上做了桥接：

- Effect 的 `Trace`/`Debug` 级别 → 映射到 `log.debug()`
- Effect 的 `Info` 级别 → 映射到 `log.info()`
- Effect 的 `Warn` 级别 → 映射到 `log.warn()`
- Effect 的 `Error`/`Fatal` 级别 → 映射到 `log.error()`

同时携带 Fiber 注解（spans、log annotations、cause/stack traces）。

---

## 二、调试每轮 LLM 调用

### 方案一: `--log-level DEBUG`（最快上手）

```bash
opencode --log-level DEBUG --print-logs
```

**每轮 Agent 会看到的日志**:

| 级别  | 来源               | 格式                                   |
| ----- | ------------------ | -------------------------------------- |
| INFO  | `llm.ts:81`        | `stream {modelID, providerID}`         |
| INFO  | `llm.ts:323`       | `stream error {error}`                 |
| INFO  | `llm.ts:330`       | `repairing tool call {tool, repaired}` |
| INFO  | `prompt.ts:1315`   | `loop {step: N}`                       |
| INFO  | `prompt.ts:1351`   | `exiting loop`                         |
| DEBUG | `registry.ts:286`  | `time(tool.id) started/completed`      |
| DEBUG | `prompt.ts:363`    | `time(resolveTools) started/completed` |
| INFO  | `mcp/index.ts:447` | `create() {toolCount}`                 |
| INFO  | `prompt.ts:970`    | `file {mime}`                          |
| INFO  | `prompt.ts:1044`   | `mcp resource {clientName, uri}`       |

**Tag 信息** (每个 LLM 调用都附带):

`providerID=<p> modelID=<m> sessionID=<sid> small=<bool> agent=<name> mode=<mode> `

**看不到的**: 系统提示词完整文本、工具列表详细内容、实际发**给 LLM 的消息数组**。

### 方案二: OpenTelemetry（完整 trace）

opencode 官方最推荐的深度调试方式。能看到**每个 span 的上下文和耗时**。

**启用方式**:

1. 安装 Jaeger（最简单）：

```bash
docker run --rm -d -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest
```

2. 设环境变量：

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

3. 在 `opencode.jsonc` 开启：

```jsonc
{
  "experimental": {
    "openTelemetry": true,
  },
}
```

关键实现细节：

- OTel 注册了 `AsyncLocalStorageContextManager` ，确保 AI SDK spans 和 Effect 代码的父 span 能正确关联
- 日志和 Traces 分别导出到 `{endpoint}/v1/logs` 和 `{endpoint}/v1/traces`
- AI SDK spans 附带 metadata: `userId`, `sessionId`

**能看到的完整 Span 链路**：

| Span Name                     | 所在文件                   | 覆盖范围                                |
| ----------------------------- | -------------------------- | --------------------------------------- |
| `session.llm`                 | `src/session/llm.ts`       | LLM 调用（AI SDK `streamText` wrapper） |
| `SessionPrompt.runner`        | `src/session/prompt.ts`    | 主提示词处理                            |
| `SessionPrompt.loop`          | `src/session/prompt.ts`    | 每轮 agent 循环                         |
| `SessionPrompt.resolveTools`  | `src/session/prompt.ts`    | 工具解析 + 插件注入                     |
| `SessionPrompt.handleSubtask` | `src/session/prompt.ts`    | 子任务处理                              |
| `SessionPrompt.ensureTitle`   | `src/session/prompt.ts`    | 标题生成                                |
| `SessionPrompt.compact`       | `src/session/prompt.ts`    | 上下文压缩                              |
| `Tool.execute`                | `src/tool/tool.ts`         | 每次工具执行                            |
| `Plugin.trigger`              | `src/plugin/index.ts`      | 插件 hook                               |
| `Npm.reify`                   | `src/shared/npm.ts`        | npm 安装                                |
| `InstanceBootstrap`           | `src/project/bootstrap.ts` | 启动流程                                |

浏览器打开 `http://localhost:16686` 查看瀑布图，可以清晰看到每个 span 的执行时间和依赖关系。

### 方案三: `--pure` 模式（隔离插件）

```bash
opencode --log-level DEBUG --print-logs --pure
```

跳过所有外部插件加载，排查是否某个插件拖慢速度。

### 方案四: 日志文件追踪

```bash
# 查看全局路径（含日志目录）
opencode debug paths

# 实时追踪日志
tail -f ~/Library/Application\ Support/opencode/logs/*.log
```

---

## 三、系统提示词构建流程

系统提示词在 `llm.ts` 中组装，顺序如下:

```
1. provider(model)                    → 根据模型 ID 选择模板（Claude/GPT/Gemini/Kimi/Trinity/CodeX）
2. input.agent.prompt                 → Agent 自定义提示词
3. input.system                       → 调用方的自定义系统字符串
4. input.user.system                  → 用户消息中的 system override
5. [Plugin: "experimental.chat.system.transform"]  → 插件修改系统提示词
6. environment(model)                 → 模型名/工作目录/git 状态/平台/日期
7. skills(agent)                      → 可用技能列表
8. instructions                       → 自定义指令文件
```

关键源码在 `llm.ts:99-124` 和 `prompt.ts:1473-1489`。

### 模型特定提示词

`provider(model)` 函数（`system.ts:19-33`）根据模型 ID 匹配不同的提示词模板：

- `gpt-4/o1/o3` → `PROMPT_BEAST`
- `gpt` + `codex` → `PROMPT_CODEX`
- `gpt` → `PROMPT_GPT`
- `gemini-` → `PROMPT_GEMINI`
- `claude` → `PROMPT_ANTHROPIC`
- `trinity` → `PROMPT_TRINITY`
- `kimi` → `PROMPT_KIMI`
- 其他 → `PROMPT_DEFAULT`

### 环境信息

`environment(model)` 函数返回：

- 模型名称和 ID
- 工作目录路径
- Workspace root
- 是否为 Git 仓库
- 操作系统平台
- 当前日期

---

## 四、插件工具注入流程

工具注入在 `registry.ts` + `prompt.ts` 中完成:

```
1. registry.tools()
   ├── 扫描 {tool,tools}/*.{js,ts} 自定义工具
   ├── 加载 Plugin.tool 定义
   └── 加载内置工具（bash, read, glob, grep, edit, write, task, fetch, ...）
   │   └── [Plugin: "tool.definition"] → 修改单个工具定义
2. prompt.ts resolveTools()
   ├── 合并 MCP 工具
   └── [Plugin: "tool.execute.before/after"] → 工具执行前后 hook
3. llm.ts resolveTools() → 权限过滤（disabled 工具过滤掉）
```

关键源码在 `registry.ts:153-307` 和 `prompt.ts:354-523`。

### 工具过滤

最终发\*\*给 LLM 的工具会经过权限过滤 (`llm.ts:433-438`)：

- `Permission.disabled()` — 获取禁用的工具列表
- 过滤掉用户配置中 `false` 的工具

### 模型特定优化

不同模型可能获得不同的工具集：

- GPT 模型 → 获得 `patch` 工具，替换 `edit`/`write`
- 需要 OpenCode/exa 配置 → 才能用 `search`/`code` 工具

---

## 五、Agent 循环流程

`runLoop` 函数在 `prompt.ts:1305` 开始执行：

```
1. slog.info("loop", {step})          → 记录循环入口
2. 过滤压缩后的消息，找最后一条用户/助手消息
3. 如果助手没有更多待处理工具调用 → slog.info("exiting loop") → 退出
4. 处理子任务和上下文压缩
5. 检查消息溢出 → 创建压缩
6. 解析工具列表, 处理消息, 调用 LLM
7. 根据 LLM 响应继续或退出循环
```

每轮的步骤:

1. **工具解析** — 注册所有可用工具到 AI SDK
2. **系统提示词构建** — 组装 provider 模板 + 环境 + 技能
3. **LLM 调用** — 发请求到 AI 服务
4. **工具执行** — 如果返回工具调用，执行对应工具
5. **结果组装** — 把工具结果加到对话历史
6. **循环继续** — 回到第 1 步

---

## 六、推荐调试流程

```bash
# 第一步：快速排查
opencode --log-level DEBUG --print-logs

# 如果还不够详细—第二步：OTel 完整 trace
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
opencode --log-level DEBUG --print-logs
# 浏览器打开 http://localhost:16686 查看 trace 瀑布图

# 第三步：隔离插件
opencode --log-level DEBUG --print-logs --pure

# 后台追踪日志
tail -f ~/Library/Application\ Support/opencode/logs/*.log
```

---

## 七、源码参考索引

| 模块          | 文件                                            |
| ------------- | ----------------------------------------------- |
| 日志系统      | `packages/opencode/src/util/log.ts`             |
| Effect Logger | `packages/opencode/src/effect/logger.ts`        |
| 模型调用      | `packages/opencode/src/session/llm.ts`          |
| 提示词处理    | `packages/opencode/src/session/prompt.ts`       |
| 系统提示模板  | `packages/opencode/src/session/system.ts`       |
| 工具注册      | `packages/opencode/src/tool/registry.ts`        |
| 插件加载      | `packages/opencode/src/plugin/index.ts`         |
| Observability | `packages/opencode/src/effect/observability.ts` |
| 认证系统      | `packages/opencode/src/auth/index.ts`           |
| 配置加载      | `packages/opencode/src/config/config.ts`        |
| Bootstrap     | `packages/opencode/src/project/bootstrap.ts`    |
| MCP           | `packages/opencode/src/mcp/index.ts`            |
