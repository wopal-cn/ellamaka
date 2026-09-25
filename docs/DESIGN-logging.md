# Ellamaka — Logging Architecture

> **Status**: Active
> **Updated**: 2026-09-25
> **Parent**: `./DESIGN.md`
> **Parent Architecture**: `../../../docs/products/wopal-space/DESIGN.md`（产品架构；空间运行态 `logs/` 的归属）
> **Sibling DESIGNs**:
>
> - `../../wopal-cli/docs/DESIGN.md` — CLI 侧日志架构：空间感知路由的参照模型，以及 CLI 与引擎的日志边界
> - `../../../docs/products/wopal-space/DESIGN-config-settings.md` — 配置体系：`wopal.logging.level` 与 `ELLAMAKA_LOG_LEVEL` 的统一定义
>
> **Scope**: 引擎日志的目录路由、文件生命周期、输出通道、级别与 Trace 策略、脱敏边界

---

## What This Owns

引擎日志体系（`@wopal/ellamaka-core` 的 `Log`）是引擎唯一的日志落盘通道：CLI 各角色、TUI 主进程与 worker、Desktop sidecar、DSH runtime 与 cordis 插件导出记录都经它写入。本设计定义四件事：

- **目录路由**：每个进程的日志落在哪个目录
- **文件生命周期**：命名、创建时机与保留上限
- **输出通道、级别与 Trace**：终端与文件各自承载什么；`DEBUG` 与 `TRACE` 的语义
- **脱敏与边界**：什么内容允许进入日志

归属边界：空间注册与 `.wopal-space/` 目录结构归 wopal-cli 与空间运行时，引擎按其既有结构写入；CLI 自身日志策略归 CLI 侧设计；空间运行态组件（如 wopal-plugin）的日志归其自身所有。

## Log Routing

### 角色分域

引擎进程按角色进入两个日志域：

| 角色      | 进程                                                             | 日志目录                                                              |
| --------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `serve`   | `ellamaka serve`、`ellamaka web`                                   | `$WOPAL_HOME/logs/`                                                   |
| `sidecar` | Desktop 内嵌服务                                                   | `$WOPAL_HOME/logs/`                                                   |
| `tui`     | 交互命令族（TUI 主进程与 worker、attach、run、机器子命令）           | 启动时位于空间内 → `<space>/.wopal-space/logs/`；否则 `$WOPAL_HOME/logs/` |

`serve` 与 `sidecar` 是机器级服务：一个进程按请求同时服务多个空间实例，日志归属全局域。`tui` 是空间感知角色：在空间内启动的交互进程，其日志归该空间，与 wopal-cli 的空间路由语义一致。

### 空间判定

空间判定的唯一来源是 CLI 入口对进程启动 cwd 的检测：沿 cwd 向上查找带 `.wopal/.git` 标记的目录（`detectWopalSpace`，止于用户 home）。判定结果经 `WOPAL_SPACE_ROOT` 传给 logger 与 worker 进程，logger 自身不重复检测。

- `--disable-wopalspace` 关闭 WopalSpace 模式时不做空间路由，日志落全局域。
- 日志目录在进程启动时确定；运行期的目录切换（TUI 的目录选择、attach 目标变化）不改变它。

### 覆盖与正交

目录决策按以下优先级，命中即停：

1. **显式目录覆盖（仅 dev 通道：本地构建）**：`WOPAL_DEBUG_LOG_DIR` 设置时写入该目录。这是 dev 工具链与测试的调试入口，例如 dev.sh 将 TUI 日志指向空间下的 `.wopal-space/logs/dev/<scope>/`，Desktop dev 将 sidecar 日志指向同一目录。
2. **角色规则**：按角色分域表路由。
3. **兜底**：`$WOPAL_HOME/logs/`。

覆盖入口归 dev 工具链与测试使用；常规运行中调用方（CLI、Desktop）不向引擎进程注入日志目录覆盖。

Verbosity 与路径正交：`--log-level`、`--trace`、`--print-logs` 只控制记录详细度与终端镜像，不改变文件目录。`--print-logs` 把记录镜像到 stderr，进程不落日志文件。

## Log Files

- **常规文件**：`<role>-<YYYY-MM-DDTHHmmss>.log`（本地时间）；无角色进程为 `<YYYY-MM-DDTHHmmss>.log`。
- **dev 文件**：dev 通道使用稳定的角色前缀文件名 `ellamaka-dev-<role>.log`（`ellamaka-dev-tui.log`、`ellamaka-dev-serve.log`、`ellamaka-dev-sidecar.log`），便于跟踪。同角色进程共享该文件。
- **独立落盘**：常规通道下每个进程各自成文件（TUI 主进程与 worker 分别落盘），进程间不共享。
- **惰性创建**：进程没有实际写入时不产生日志文件。
- **保留上限**：同一目录保留最新的 10 个时间戳文件（跨角色共享上限，按文件名排序修剪）；dev 稳定文件不参与修剪。
- **目录创建**：目标目录不存在时按需创建。

## Output Channels

终端与文件是两个独立通道，不互为副本：

- **终端**：面向用户的启动契约与即时反馈。serve 的终端输出是监听地址、Workbench 地址与可操作警告。
- **文件**：面向事后排障的结构化记录。`INFO` 记录对应需要事后关注的状态变化——例如一次完成的数据迁移、VCS 分支切换或按需依赖安装。
- **`--log-level DEBUG`**：实现级诊断，有界且仍脱敏；理解正常运行不依赖它。
- **`--trace`**：第五级，见 Trace 节。
- **`--print-logs`**：将记录镜像到 stderr，进程不落文件；dev 工具链用它接管进程输出。

日志记录状态变化与故障，不是活动流水：事件总线订阅抖动、SSE / WebSocket 连接抖动、会话与消息生命周期事件、权限求值、question 回复、文件搜索请求、PTY 客户端生命周期、配置 / 插件 / provider 枚举都不进入日志——它们已有权威状态或事件流，文本副本只制造噪声并可能暴露用户数据。

级别顺序：`TRACE` < `DEBUG` < `INFO` < `WARN` < `ERROR`，默认 `INFO`。

## Level Resolution

引擎的生效级别是全产品统一机制的一个消费面（机制定义见 [`../../../docs/products/wopal-space/DESIGN-config-settings.md`](../../../docs/products/wopal-space/DESIGN-config-settings.md) 的 Logging Level 节）。解析顺序：

```text
--log-level <级别>（进程树显式覆盖）
  → ELLAMAKA_LOG_LEVEL（环境变量）
    → settings.jsonc 的 wopal.logging.level（持久配置）
      → INFO（默认）
```

- 解析一次发生在进程入口、日志初始化之前；结果写回 `ELLAMAKA_LOG_LEVEL` 供进程内传播。
- 引擎把生效级别传给 DSH（runtime 与各 profile 文件）与 wopal-plugin；worker 与子进程靠环境继承，组件自身不读配置文件。
- 配置读取实现留有单一替换点，将来可替换为 `wopal config get` 契约。
- 显式 `--log-level` 覆盖一切；显式 `--log-level` 与 `--trace` 的搭配规则见 Trace 节。
- 非法值或配置不可读时回落 `INFO`，不阻断启动。
- 上游遗留的级别环境变量名不再读取；日志级别的唯一环境变量名是 `ELLAMAKA_LOG_LEVEL`。

## Trace

`TRACE` 是第五级，低于 `DEBUG`。它承载正常运行绝不输出的高容量生命周期记录；除非调用者显式点名类别，否则不生效。

- **只有级别不会输出任何记录**：`--log-level TRACE` 不带 `--trace` 被拒绝——“全部打开”正是该级别要消除的洪泛。`--trace` 不带值运行会列出全部类别。
- 类别是封闭注册表（`Log.TraceCategory`），每个类别负责一块高容量诊断领域；新增类别必须同时有调用点与本设计中的一行记录。

| 类别         | 覆盖范围                                  |
| ------------ | ----------------------------------------- |
| `bus`        | 事件总线发布                              |
| `permission` | 权限决策与回复                            |
| `session`    | 会话 prompt 循环与 processor turn         |
| `llm`        | 每次请求的模型 / runtime 选择             |
| `plugin`     | 插件加载、MCP 连接、OAuth 初始化          |
| `io`         | 文件、formatter、语言服务器活动           |

- `--trace session,llm` 只启用点名类别并把有效级别提升为 `TRACE`；显式 `--log-level` 优先，遗留的 `--trace` selector 不会静默升级一次 `INFO` 运行。
- `--trace all`（或 `*`）是全类别的显式逃生口。
- 未知类别是错误，输出合法名称列表，绝不静默放宽 selector。
- Trace 记录与其他记录同样结构化、有界：每条带归一化的 `category=` 标记，继承统一的脱敏与长度限制。

Trace 绝不承载原始 payload 或用户数据：

- bus：只记事件类型，不复制发布属性（会话内容、工具参数、消息体）。
- permission：只记权限名、决策 `action`（`allow|ask|deny`）、`escalated` 标记、计数与 `reply` 结果；不写求值后的 pattern、命令、路径、session id 或 pending 请求内容。
- session / LLM：只记步骤计数与 runtime / model 标识；不写消息内容、prompt 或工具参数。

Effect 代码经 logger bridge 发 trace：`EffectLogger.create(...).trace(category, message, extra)`。Effect 在 logger 之前过滤 Sub-Info 级别，bridge 以 annotation 携带类别并路由到 `Log.trace`；不要用 `Effect.logTrace` 期待 trace 记录。

DSH 只有四级：宿主 `TRACE` 在边界映射为 DSH `DEBUG`。`--trace` 运行不丢 DSH 诊断，DSH 日志契约保持不变。

## Redaction and Bounds

- **脱敏键**：`requestBody`、`requestBodyValues`、`responseBody`、`messages`、`prompt`、`system`、`authorization`、`apiKey`、`token`、`password`、`secret`、`cookie` 等键在序列化时替换为 `[redacted]`（下划线、连字符与大小写归一后匹配）。
- **传输错误摘要**：provider SDK 错误只保留有界结构化摘要（`name`、`code`、`type`、`statusCode`、`isRetryable`、去除查询串的 `url`）；request body、response body、凭证、OAuth state 与子进程 stdout/stderr 不进入日志。
- **长度界**：单值 ≤ 4096 字符、单行 ≤ 16 KiB，超出追加 `…[truncated]`；message 折叠为单行。
- **序列化安全**：BigInt 携带 `n` 后缀；循环引用记 `[circular]`；不可序列化值记 `[unserializable]`。

## DSH Plugin Records

DSH 插件的 severity 不被照抄：插件用 `error` 表示“调用方 agent 预期处理的工具结果”，那不是宿主故障。

- 预期的工具策略结果——read-before-edit、观测目标缺失、观测过期、沙箱 / 审批拒绝、取消——是脱敏的 `DEBUG` 记录；权威解释保留在交付给 agent 的工具结果中。
- 重试中的插件是 `DEBUG`：自动恢复仍在进行时，单次连接尝试不是 operator 警告。
- 非预期的工具执行失败是脱敏的 `WARN`：保留工具名与类别，不把 session id、call id、路径与原始工具错误抄进持久插件日志。
- `ERROR` 表示能力实际不可用（例如重试耗尽后工具被注销）或插件报告不可恢复故障，携带固定 reason code 而非任意上游 payload。
- DSH 记录跟随统一解析出的生效级别（见 Level Resolution 节），不做文件级或组件级独立定级；DSH 内部不再有等级映射。
- `dsh-runtime.log` 记录宿主级 runtime 管理（物化、加载、profile 装配）；`dsh-plugins-<profile>.log` 按 profile 拆分插件诊断（`web`、`ellamaka-tools`，未来新增 profile 自动获得独立文件）。每个文件独立有界（容量上限、滚动备份、重复抑制），位于全局域 `$WOPAL_HOME/logs/`。
- DSH runtime 记录按关注度分级：物化的开始与完成、依赖安装、降级与失败是 `INFO`——它们是需要事后关注的运行时状态变化；阶段轨迹（resolve / inspect / lock / stage / verify / activate / load）与插件例行为 `DEBUG`。默认 `INFO` 下，首次安装或依赖变更留下物化记录，缓存命中的例行启动保持安静；需要完整轨迹时把级别提升到 `DEBUG`。
- `ELLAMAKA_DSH=0` 不创建任何 DSH 文件；终端镜像仅在 `--print-logs` 时开启。

## Wopal Plugin Records

wopal-plugin 随宿主进程运行，其记录与引擎记录同目录同级别：

- 生效级别按优先级解析：`WOPAL_PLUGIN_LOG_LEVEL`（显式覆盖，用户或 dev 工具链注入）> `wopal.pluginConfig["wopal-plugin"].logLevel` / `wopal.logLevel`（插件配置）> `ELLAMAKA_LOG_LEVEL`（宿主生效级别）> `INFO`。前两层是插件自身显式接口，后两层来自统一机制。
- 模块过滤（`logModules`）是插件的诊断筛选维度，与级别独立，保持插件配置。
- 插件日志文件由宿主的 `WOPAL_PLUGIN_LOG_FILE` 指定调试目标，缺省落在日志目录下的 `wopal-plugin.log`；目录路由与引擎一致。

## Reference Documents

| 文档              | 说明                                                             |
| ----------------- | ---------------------------------------------------------------- |
| `../AGENTS.md`    | 日志写入规则（必打 / 禁打 / 聚合 / 结构化）与调试命令入口的操作规范 |
