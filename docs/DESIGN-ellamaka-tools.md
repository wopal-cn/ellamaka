# 工具容器 profile 设计

> **Status**: Active
> **Updated**: 2026-10-08
> **Parent**: `./DESIGN.md`
> **Scope**: DSH v0.2 的现有工具采用、容器装配、审批与沙箱兼容。

Ellamaka 通过 `ellamaka-tools` profile 获得工具执行后端。容器装配在进程内共享，空间配置决定是否采用沙箱投影。工具容器使用最小调用外观，Ellamaka 拥有持久 Session、权限与消息。

## Capability Adoption

每个能力按输入输出与实际依赖采用。工具消费少量调用上下文时由 adapter 补齐；依赖 Ellamaka 的钩子、权限、会话或界面的能力由原生插件拥有。

| 能力       | Registry 工具               | 后端                                           |
| ---------- | --------------------------- | ---------------------------------------------- |
| 搜索       | grep / glob                 | fs-search 与 subprocess                        |
| 文件       | read / write / edit         | tool-fs 与 fs-sandbox                          |
| 字符串编辑 | str_replace_editor          | 明确的 tool-str-replace-editor 行与 fs-sandbox |
| Shell      | bash；Windows 实际源为 pwsh | 平台 shell executor 与 sandbox                 |

新 Session 外部能力经 PTC 消费的装配契约由独立设计定义。本文保持当前采用表与权限消费面的兼容。

## Container Composition

ProfileRuntime、依赖解析、完整补丁与 mutation queue 遵循 [基础设计](./DESIGN-dsh-base.md)。工具容器装配 tools、system-prompt、fs、subprocess、sandbox、sandboxPolicy、session-projection、approval，以及所采用的文件和平台 shell provider。

session-projection 注册表为最小外观提供策略折叠，容器不生成真实 Session。approval 保持可用，缺失询问闭包时按原生 unavailable 结果关闭提权。

宿主约束禁用 session 生命周期与检查点、agent-loop、模型调用、界面、configEditor/pluginManager、DeepSeek account、目标、计划、压缩、子代理和后台任务等耦合能力。新增基础 bundle 行也按容器边界审定，不能依靠一份按旧包名保存的用户禁用表维持该边界。

用户补丁保留工具配置，宿主能力约束负责保证无会话执行和可用后端。两种平台 shell 行均关闭后台执行，schema 不宣告 run_in_background，强制传入由工具拒绝。tools presentation 固定为 native，进程级 PTC 环境选择不改变采用表。

挂载验收检查本平台的采用集合及其 provider。macOS/Linux 检查七个工具；Windows 检查文件工具与 pwsh 后端。DSH 的 API 定义包可以在闭包中存在，相关会话 provider 的激活由该 profile 的边界决定。

## Tool Projection

ontology 的 dsh-adapter 通过 tool.provider 在每次模型请求读取容器的 live schemas，确定性投影、排序并覆盖采用的同名工具。schema 随实际插件状态变化，参数转换与工具结果映射由 adapter 拥有。

| 消费面         | 契约                                                                      |
| -------------- | ------------------------------------------------------------------------- |
| schema         | 动态读取 registry，保留所需参数与描述；Bash 的 description 随 schema 投影 |
| 参数           | 固定的参数名转换，执行时反向转换；其余参数保持原名                        |
| Shell 平台映射 | Windows 将 pwsh 的实际 schema/dispatch 映射到现有逻辑 shell 工具名        |
| 结果           | content 为模型输出，value 为完整文件结果，meta 为补充差异与执行信息       |
| 权限           | 执行前复用 Ellamaka 读写与外部目录门禁；平台映射使用逻辑工具权限          |
| 生命周期       | 实际执行交由 registry，取消、超时与清理由 provider 拥有                   |

文件能力整套采用，读取观测与后续编辑共享同一后端。容器未发布时 adapter 不投影工具，Ellamaka 原生工具按照其既有权限运行。Bun 的标准 API 兼容、模块路由与激活状态由宿主基座保证。

## Session Facade

adapter 按 Ellamaka session 复用最小内存外观：header.cwd、header.id、seq、eventAt、snapshotEvents、append。事件序号连续，快照范围冻结，审计事件与策略覆盖保存在外观的内存日志中。

每次 registry 执行包裹引用计数的 turn/start 与 turn/end。并发和嵌套共享最外层活动 turn，finally 保证闭合。容器持久会话与检查点由 Web profile 的独立执行面拥有。

## Sandbox and Approval

启用沙箱时采用表使用 DSH enforcing provider。默认模式来自空间 pluginConfig，显式消息模式通过 ToolContext.extra.sandboxMode 传入，每次选择均追加 sandbox/mode 事件。

事件折叠采用 LAST-wins。恢复默认值也需要显式追加该值；字段缺失是沿用当前折叠值的唯一信号。

沙箱提权由原生 approval 服务处理。adapter 监听 approval/request，按 session id 取得当前执行的 ctx.ask 闭包，映射为 Ellamaka 的 sandbox_escalation 权限卡片。

| 决策          | DSH 结果                                           |
| ------------- | -------------------------------------------------- |
| 仅本次允许    | allowed-once                                       |
| 总是允许      | Ellamaka 权限池承接；DSH 当前调用返回 allowed-once |
| 拒绝          | rejected                                           |
| 缺失 answerer | 下游 unavailable，提权关闭                         |
| 中止          | 原生取消                                           |

escalation=never 为外观写入 approval/policy，审批服务在询问前拒绝。一次提权仅影响该调用，程序或工具副作用不自动重放。

## Configuration and UI

进程级容器与空间级投影分离。用户级、空间公共、空间私有的 pluginConfig 经引擎合并，adapter 校验 dsh-adapter 条目。

sandbox.enabled=true 时采用完整工具集，mode 的空间默认为 read-only 或 workspace-write；缺失或 false 时使用 Ellamaka 原生工具。消息级选择可以表达 read-only、workspace-write 和 full-access，并转换为 provider 的模式词汇。

Workbench 的选择器依据实际 ready、已装 adapter 与有效 sandbox 配置显示。选择随消息保存与继承，权限、外观事件和工具执行使用相同输入事实。

## Platform Enforcement

| 平台    | 后端                          | 边界                                             |
| ------- | ----------------------------- | ------------------------------------------------ |
| macOS   | sandbox-exec                  | 后端可用时执行所选策略                           |
| Linux   | bubblewrap 或 Landlock        | provider 报告完整或部分 enforcement              |
| Windows | ACL / restricted-token runner | 实际 shell 为 pwsh，enforcement 按 provider 报告 |

enforcing backend 不可用时返回 sandbox-unavailable，不能把受限请求转为无沙箱执行。运行结果区分执行结果、拒绝与实际 enforcement。

PTC 的独立执行 provider 不属于当前工具投影所需的运行时。其启用、SDK 注入和 Session grant 由后续装配契约拥有。
