# 工具容器 profile 设计

> **Status**: Active
> **Updated**: 2026-10-26
> **Parent**: `./DESIGN.md`
> **Sibling DESIGNs**:
>
> - `./DESIGN-dsh-base.md` — DSH 集成基础、依赖闭包与 Profile 生命周期
>
> **Scope**: DSH v0.2 的工具采用、内置 adapter、容器装配、审批与沙箱兼容。

Ellamaka 通过 `ellamaka-tools` profile 获得工具执行后端。容器装配在进程内共享，空间配置决定是否采用沙箱投影。工具容器使用最小调用外观，Ellamaka 拥有持久 Session、权限与消息。

Tools profile 是 Ellamaka 与 DSH 的内部集成能力，不属于 DSH Web 的界面开关。当前进程只由 `ELLAMAKA_DSH_TOOLS` 控制是否准备和加载该 profile：精确值 `0` 表示禁用，未设置或其他值表示允许。Workbench Settings 不写这个环境变量，也不按 Space 启停进程级 Tools profile。

## Capability Adoption

每个能力按输入输出与实际依赖采用。工具消费少量调用上下文时由 adapter 补齐；依赖 Ellamaka 的钩子、权限、会话或界面的能力由原生插件拥有。

| 能力       | Registry 工具               | 后端                                           |
| ---------- | --------------------------- | ---------------------------------------------- |
| 搜索       | grep / glob                 | fs-search 与 subprocess                        |
| 文件       | read / write / edit         | tool-fs 与 fs-sandbox                          |
| 字符串编辑 | str_replace_editor          | 明确的 tool-str-replace-editor 行与 fs-sandbox |
| Shell      | bash；Windows 实际源为 pwsh | 平台 shell executor 与 sandbox                 |

本文覆盖当前工具采用表、内部 adapter、权限消费与宿主 PTC provider/preflight。Session 外部工具授权、SDK 注入和 `run_code` 的装配归独立的 Session Assembly 契约。

## Container Composition

ProfileRuntime、依赖解析、完整补丁与 mutation queue 遵循 [DSH 基础设计](./DESIGN-dsh-base.md)。

`ellamaka-tools` 是从空 Cordis 根独立装配的无会话工具 profile。它使用官方 profile、bundle 与 YAML `insert` 格式，直接声明所需工具和基础服务；`dsh.profile.bundles` 的初始选择不包含 `@deepseek-ai/dsh-base`。产品维护最小工具装配声明，用户在标准 profile 补丁中配置插件，并通过官方插件安装流程添加外部包与 bundle。

装配内容以本文的能力采用表和实际依赖为准。工具消费的基础服务在声明中明确列出；插件自身提供的默认配置直接复用，产品只声明必要的行为参数。文件与平台 shell 采用沙箱后端；`tools.mode` 为 `native`，shell 后台执行关闭。`session-projection` 提供策略折叠，`approval` 承接沙箱单次提权，缺失询问闭包时返回原生 `unavailable`。容器保持无持久 DSH Session 的边界。

插件包与服务的选择由标准配置表达。宿主按官方声明加载、解析并报告激活结果；不增加 `adopt` 字段、整棵 `dsh-base` 的禁用表，或通过扫描上游源码推导并改写装配的机制。必要的 Bun/Electron 宿主接线归基础设计。

产品在 tools 补丁中维护一个有明确首尾注释边界的装配块，块后为用户内容。准备阶段比较该块与产品声明：一致即整步跳过，普通启动不重写补丁层；不一致（closureVersion 上升、产品装配更新或旧宿主迁移）时只刷新该块，块外用户字节原样保留。这是产品装配与用户覆盖的唯一交界。旧宿主模板遗留的注释骨架与指向上游已不存在条目的失效行属于宿主文本，在一次性迁移中清除，不与用户内容混同。用户插件、bundle 与配置继续使用官方 profile 声明。`cordis.yml` 仍为每次准备与挂载前重置的空合成根。

### 补丁层的顺序规则与插件安装

tools profile 的补丁层按固定顺序合成：bundle 层的 patch → 产品装配块 → 块后的用户行。Loader 的 patch 只能作用于**本层之前已经存在**的行，因此这条顺序决定了插件该怎么装：

- **产品装配块**（首尾注释之间）声明工具容器必需的插件行。升级时整块刷新，块内内容不承载用户意图。
- **块后的用户行**在上游之后应用，可以按 id 覆盖产品行的 config、或 `disabled: true` 关掉产品行。升级刷新产品块时这些行逐字保留，顺序也不变。
- **bundle 层**位于两者之前，所以 bundle 自带的 disable 行**无法**关闭产品块插入的行；把替换型插件的 bundle 选进 `dsh.profile.bundles` 只会让替换行与产品行同时存在，造成服务重复注册。

据此，tools profile 的插件装配分两类：

| 情形                                       | 做法                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 追加型插件（新增独立能力，不替换产品行）   | `ellamaka dsh plugin --profile ellamaka-tools add <包目录或包名>`，bundle 层正常生效                                          |
| 替换型插件（替换产品已声明的行，如沙箱链） | 同样用 `ellamaka dsh plugin add` 安装包，但把 `dsh.profile.bundles` 保持为空，并在**块后**手写 disable 产品行 + insert 插件行 |

替换型的典型例子是 `@wopal/dsh-sandbox-roots`：它在 tools 中替换 `sandbox`、`sandbox-policy`、`fs-sandbox` 三条 stock 行。装配写在块后，`writableRoots` 也写在该行 config 中，因此该列表归用户所有——产品块刷新不会覆盖它。

补丁覆盖是**整块替换 config**，不做深合并：覆盖 `sandbox-roots-policy` 时需同时重述 `mode` 与 `workspaceRoot`。缺少被引用的插件包时容器按 fail-closed 拒绝启动并报出条目名，不会静默降级。

### Tool Availability Contract

Loader settlement 后，macOS/Linux 必须实际注册 `bash`、`read`、`write`、`edit`、`glob`、`grep`、`str_replace_editor`；Windows 使用 `pwsh` 后端与相同文件/搜索能力。缺少必需工具或必需插件等待服务、激活失败时，容器报告具体原因并拒绝发布 ready。首次挂载与配置重放共用验收。

升级兼容性由真实工具调用验证：读写和编辑结果、文件搜索、shell 工作目录与输出、字符串替换、沙箱拒绝、审批、取消和必要的 PTC 执行均有回归保护。工具注册与 schema 检查是启动条件，实际执行结果是兼容验收依据。测试固定对外行为，允许上游内部插件组织变化。

升级使用基础设计的单一 DSH 版本入口。依赖安装及生成物刷新后运行同一组工具回归；通过即接受该版本在已覆盖工具契约上的兼容性。失败时依据模块解析、激活或执行诊断定位实际变化，再修正受影响的标准配置或 adapter。官方真实破坏性变更由具体修复承接，不通过预设别名、源码模式猜测或多版本分支预测。

## Internal Adapter

dsh-adapter 的实现放在 `packages/ellamaka-cordis/src/dsh-adapter/`，通过 `@wopal/ellamaka-cordis/dsh-adapter` 导出。opencode 在内部插件入口注册这个导出，CLI 与 Desktop sidecar 将它和 Bridge 一起编译分发。

adapter 只依赖公开 Plugin SDK，不导入 opencode 内部模块。配置、Permission 询问和消息信息由引擎通过 PluginInput/ToolContext 交付；构建使用同一份 SDK 与 schema 实例，保证 schema 类型一致。

| 代码边界        | 归属与变化原因                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| DSH 侧适配      | 同包内的 DSH 调用代码：registry 执行、调用外观、sandbox/approval 事件、PTC binding、provider 差异；随固定 DSH 版本适配 |
| Ellamaka 侧接入 | 同包内的 plugin 导出：读取有效配置、tool.provider/run_code 接入、Permission 询问、工具结果与 UI 元数据；随引擎契约维护 |
| 用户行为参数    | settings.jsonc：沿用 dsh-adapter 参数键和空间覆盖，不随代码位置调整                                                    |

两类代码都归 `ellamaka-cordis`，按实际职责分文件，使用直接的类型化调用。Session 外部工具授权与 SDK 注入由 Session Assembly 契约拥有。

内部插件注册在配置要求采用 DSH 后端时生效。它读取当前进程的 Tools profile 加载结果：profile 已 `ready` 时绑定工具池；profile 被环境变量禁用或本次加载失败时不接管工具，Ellamaka 保持 Native Tools。内部身份固定为 `dsh-adapter`；若配置中存在同名外部插件条目，在依赖安装、模块 import 和工厂执行之前直接由内部实现接管，只读识别包元数据身份，不加载外部副本，也不改写原配置文件与 ontology 源码。无法判明的身份冲突返回明确错误。

参数依旧由引擎交付 `PluginInput.pluginConfig["dsh-adapter"]`；三层 settings 合并、JSONC 写法、现有字段和内联 options fallback 均保持原契约。无需新增插件路径即可配置内部实现。示例：

```jsonc
{
  "wopal": {
    "pluginConfig": {
      "dsh-adapter": {
        "sandbox": { "enabled": true, "mode": "workspace-write" },
        "escalation": "ask",
      },
    },
  },
}
```

宿主池按当前进程共享，内部插件按 Instance 消费配置；同一进程中不同空间的参数和权限相互独立。实例释放只撤销自己的询问闭包与调用外观，宿主关闭才释放池。参数校验失败必须报告，不能退回默认权限。

## Tool Projection

Ellamaka 内部的 dsh-adapter 通过 tool.provider 在每次模型请求读取容器的 live schemas，确定性投影、排序并覆盖采用的同名工具。schema 随实际插件状态变化，参数转换与工具结果映射由 adapter 拥有。

| 消费面         | 契约                                                                      |
| -------------- | ------------------------------------------------------------------------- |
| schema         | 动态读取 registry，保留所需参数与描述；Bash 的 description 随 schema 投影 |
| 参数           | 固定的参数名转换，执行时反向转换；其余参数保持原名                        |
| Shell 平台映射 | Windows 将 pwsh 的实际 schema/dispatch 映射到现有逻辑 shell 工具名        |
| 结果           | content 为模型输出，value 为完整文件结果，meta 为补充差异与执行信息       |
| 权限           | 执行前复用 Ellamaka 读写与外部目录门禁；平台映射使用逻辑工具权限          |
| 生命周期       | 实际执行交由 registry，取消、超时与清理由 provider 拥有                   |

文件能力整套采用，读取观测与后续编辑共享同一后端。这里严格区分 **profile 加载失败** 与 **工具调用失败**：

- Tools profile 被 `ELLAMAKA_DSH_TOOLS=0` 禁用，或本次启动在发布 `ready` 前加载失败：adapter 不启用，当前 Space 使用 Ellamaka Native Tools。
- Tools profile 已 `ready`，且当前 Space 的 `sandbox.enabled=true`：adapter 接管采用表中的工具。之后的 sandbox 拒绝、approval 拒绝、参数错误、超时、工具/provider 执行错误都直接作为本次 DSH 调用失败返回；不得用同名 Native Tool 重试，也不得把一次调用错误改写成 profile 加载失败。
- 已发布的容器随后整体失效：当前已进入 DSH 调用路径的请求继续 fail closed。宿主只有在明确的新 profile 加载周期中重新判定 `dsh.tools`，不能用单次工具异常触发 backend 切换。

Bun 的标准 API 兼容、模块路由与激活状态由宿主基座保证。

## Session Facade

Bridge 按 Ellamaka session 复用最小内存外观，内部 adapter 提供调用身份与权限回调：header.cwd、header.id、seq、eventAt、snapshotEvents、append。事件序号连续，快照范围冻结，审计事件与策略覆盖保存在外观的内存日志中。

每次 registry 执行包裹引用计数的 turn/start 与 turn/end。并发和嵌套共享最外层活动 turn，finally 保证闭合。容器持久会话与检查点由 Web profile 的独立执行面拥有。

## Sandbox and Approval

启用沙箱时采用表使用 DSH enforcing provider。默认模式来自空间 pluginConfig，显式消息模式通过 ToolContext.extra.sandboxMode 传入，每次选择均追加 sandbox/mode 事件。

事件折叠采用 LAST-wins。恢复默认值也需要显式追加该值；字段缺失是沿用当前折叠值的唯一信号。

沙箱提权由原生 approval 服务处理。Bridge 监听 approval/request 并识别 DSH 请求，内部 adapter 按 session id 取得当前执行的 ctx.ask 闭包，映射为 Ellamaka 的 sandbox_escalation 权限卡片。

| 决策          | DSH 结果                                           |
| ------------- | -------------------------------------------------- |
| 仅本次允许    | allowed-once                                       |
| 总是允许      | Ellamaka 权限池承接；DSH 当前调用返回 allowed-once |
| 拒绝          | rejected                                           |
| 缺失 answerer | 下游 unavailable，提权关闭                         |
| 中止          | 原生取消                                           |

escalation=never 为外观写入 approval/policy，审批服务在询问前拒绝。一次提权仅影响该调用，程序或工具副作用不自动重放。

## Configuration and UI

进程级容器与空间级投影分离。`ELLAMAKA_DSH_TOOLS` 只决定当前进程有没有 Tools backend；用户级、空间公共、空间私有的 `pluginConfig` 经引擎合并，adapter 再按当前 Instance 校验 `dsh-adapter` 条目。一个 Server 内的不同 Space 可以独立选择是否采用同一进程级 Tools backend。

sandbox.enabled=true 时采用完整工具集，mode 的空间默认为 read-only 或 workspace-write；缺失或 false 时使用 Ellamaka 原生工具。消息级选择可以表达 read-only、workspace-write 和 full-access，并转换为 provider 的模式词汇。

Workbench 的选择器依据 `dsh.tools=ready` 与当前 Space 的有效 sandbox 配置显示；内部实现的存在由产品保证，显示不依赖外部插件路径条目。选择随消息保存与继承，权限、外观事件和工具执行使用相同输入事实。

Workbench 的 Plugins 状态页始终用当前 Space 的真实采用结果表达 `dsh-adapter`：只有 `dsh.tools=ready` 且 `sandbox.enabled=true` 时显示为已启用；Tools profile 被环境禁用、加载失败，或当前 Space 没有启用 sandbox 时显示“未启用”。这个状态描述 backend 是否被采用，不根据某一次工具调用成功或失败改变。

## Platform Enforcement

| 平台    | 后端                          | 边界                                             |
| ------- | ----------------------------- | ------------------------------------------------ |
| macOS   | sandbox-exec                  | 后端可用时执行所选策略                           |
| Linux   | bubblewrap 或 Landlock        | provider 报告完整或部分 enforcement              |
| Windows | ACL / restricted-token runner | 实际 shell 为 pwsh，enforcement 按 provider 报告 |

enforcing backend 不可用时返回 sandbox-unavailable，不能把受限请求转为无沙箱执行。运行结果区分执行结果、拒绝与实际 enforcement。

web 与 ellamaka-tools 均保留原生 PTC provider，启动预检在 read-only 沙箱调用无业务副作用的 JSON binding。native presentation 服务文件与 shell 采用面；Session Assembly 使用同一池的 scope、`tools.restrict()` 和 `presentAs("ptc")` 消费 run_code，SDK 注入与 Session grant 由独立装配契约拥有。
