# 工具容器 profile 设计

> **Status**: Active
> **Updated**: 2026-10-20
> **Parent**: `./DESIGN.md`
> **Sibling DESIGNs**:
>
> - `./DESIGN-dsh-base.md` — DSH 融合基础、依赖闭包与 Profile 生命周期
>
> **Scope**: DSH v0.2 的工具采用、内置 adapter、容器装配、审批与沙箱兼容。

Ellamaka 通过 `ellamaka-tools` profile 获得工具执行后端。容器装配在进程内共享，空间配置决定是否采用沙箱投影。工具容器使用最小调用外观，Ellamaka 拥有持久 Session、权限与消息。

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

1. **单一裁剪真相源**：
   - `ellamaka-tools` 是宿主专用的无会话内部工具容器。其磁盘目录 `$WOPAL_HOME/dsh/home/profiles/ellamaka-tools/` 由官方 `initProfile` 初始化为标准空补丁模板（`cordis.patch.yml` 保持空数组模板 `[]`，`cordis.yml` 在每次准备与挂载前无条件重置为 `[]\n`）。宿主不在磁盘 `cordis.patch.yml` 中写入静态禁用列表，也不维护针对磁盘补丁文件的跨版本字符串改写。
   - 容器对 `@deepseek-ai/dsh-base` 的裁剪完全由宿主运行时的 `profileCapabilityPatches`（内存 overlay 层）作为唯一真相源统一生成。
2. **采用集合与底层依赖服务闭包**：
   - `profileCapabilityPatches` 保留工具容器所需的服务与工具 provider（`timer`、`session-projection`、`subprocess`、`sandbox`、`sandbox-policy`、`bash-sandbox`、`pwsh-sandbox`、`approval`、`ptc-runtime`、`shell-env`、`working-directory`、`tool-bash`、`tool-pwsh`、`fs-observation-policy`、`tool-fs`、`tool-fs-search`、`timeout-policy`、`spill-local`、`spill-policy`、`tools`、`system-prompt`、`fs-sandbox`、`storage`、`storage-json`、`storage-domain`），显式插入 `@deepseek-ai/dsh-tool-str-replace-editor`，并将 `tools.mode` 固定为 `"native"`、关闭 `tool-bash` 与 `tool-pwsh` 的 `enableRunInBackground`（schema 不宣告 `run_in_background`，强制传入由工具拒绝）。其余耦合了会话生命周期、检查点、Agent 循环、模型调用、界面、账号、子代理与后台任务的 `@deepseek-ai/*` 行统一禁用。
   - `session-projection` 注册表保持启用以向 `sandbox-policy` 提供策略折叠，容器不生成真实 Session；`approval` 保持启用以承接沙箱单次提权，缺失询问闭包时按原生 `unavailable` 结果关闭提权。
   - 为防止上游 DSH 升级时从既有工具拆分出新的底层基础服务（如 `working-directory`）而被白名单误禁，宿主校验已采用工具与服务插件的 Cordis `inject` 服务声明（或 `peerDependencies`），确保已采用插件依赖的基础服务包含在启用集合中。
3. **挂载完成强验收门禁**：
   - Cordis 对缺失 `inject` 服务的插件采取静默等待策略，不会自动抛错。因此 `ellamaka-tools` 在 Loader settlement 后必须执行**注册工具完整性强验收**：
     - macOS / Linux 必须实际注册齐 7 个工具：`bash`、`read`、`write`、`edit`、`glob`、`grep`、`str_replace_editor`；
     - Windows 必须实际注册齐文件工具与 `pwsh` 后端。
   - 缺失任一必需工具或存在挂起等待（pending `inject`）的已采用插件时，挂载直接失败并明确报告缺失工具及未就绪的依赖服务，绝不允许带着残缺工具集进入 `ready` 状态。

## Internal Adapter

dsh-adapter 的实现放在 `packages/ellamaka-cordis/src/dsh-adapter/`，通过 `@wopal/ellamaka-cordis/dsh-adapter` 导出。opencode 在内部插件入口注册这个导出，CLI 与 Desktop sidecar 将它和 Bridge 一起编译分发。

adapter 只依赖公开 Plugin SDK，不导入 opencode 内部模块。配置、Permission 询问和消息信息由引擎通过 PluginInput/ToolContext 交付；构建使用同一份 SDK 与 schema 实例，保证 schema 类型一致。

| 代码边界        | 归属与变化原因                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| DSH 侧适配      | 同包内的 DSH 调用代码：registry 执行、调用外观、sandbox/approval 事件、PTC binding、provider 差异；随固定 DSH 版本适配 |
| Ellamaka 侧接入 | 同包内的 plugin 导出：读取有效配置、tool.provider/run_code 接入、Permission 询问、工具结果与 UI 元数据；随引擎契约维护 |
| 用户行为参数    | settings.jsonc：沿用 dsh-adapter 参数键和空间覆盖，不随代码位置调整                                                    |

两类代码都归 `ellamaka-cordis`，按实际职责分文件，使用直接的类型化调用。Session 外部工具授权与 SDK 注入由 Session Assembly 契约拥有。

内部插件注册在配置要求采用 DSH 后端时生效，其工厂等待共享初始化结果后再绑定工具池。内部身份固定为 `dsh-adapter`；若配置中存在同名外部插件条目，在依赖安装、模块 import 和工厂执行之前直接由内部实现接管，只读识别包元数据身份，不加载外部副本，也不改写原配置文件与 ontology 源码。无法判明的身份冲突返回明确错误。

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

文件能力整套采用，读取观测与后续编辑共享同一后端。配置要求 DSH 后端时，adapter 必须先等待容器 ready；准备阶段拿不到容器时，采用面回退到 Ellamaka 原生工具，会话保持可用，宿主通过 health 与界面提示说明沙箱不可用。容器在 ready 后失效时，请求继续 fail closed。明确关闭 DSH 采用的配置同样使用原生工具。Bun 的标准 API 兼容、模块路由与激活状态由宿主基座保证。

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

进程级容器与空间级投影分离。用户级、空间公共、空间私有的 pluginConfig 经引擎合并，adapter 校验 dsh-adapter 条目。

sandbox.enabled=true 时采用完整工具集，mode 的空间默认为 read-only 或 workspace-write；缺失或 false 时使用 Ellamaka 原生工具。消息级选择可以表达 read-only、workspace-write 和 full-access，并转换为 provider 的模式词汇。

Workbench 的选择器依据实际 DSH ready 与有效 sandbox 配置显示；内部实现的存在由产品保证，显示不依赖外部插件路径条目。选择随消息保存与继承，权限、外观事件和工具执行使用相同输入事实。

## Platform Enforcement

| 平台    | 后端                          | 边界                                             |
| ------- | ----------------------------- | ------------------------------------------------ |
| macOS   | sandbox-exec                  | 后端可用时执行所选策略                           |
| Linux   | bubblewrap 或 Landlock        | provider 报告完整或部分 enforcement              |
| Windows | ACL / restricted-token runner | 实际 shell 为 pwsh，enforcement 按 provider 报告 |

enforcing backend 不可用时返回 sandbox-unavailable，不能把受限请求转为无沙箱执行。运行结果区分执行结果、拒绝与实际 enforcement。

web 与 ellamaka-tools 均保留原生 PTC provider，启动预检在 read-only 沙箱调用无业务副作用的 JSON binding。native presentation 服务文件与 shell 采用面；Session Assembly 使用同一池的 scope、`tools.restrict()` 和 `presentAs("ptc")` 消费 run_code，SDK 注入与 Session grant 由独立装配契约拥有。
