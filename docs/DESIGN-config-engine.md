# Ellamaka — Config Consumption

> **Status**: Active
> **Updated**: 2026-11-25
> **Parent**: `./DESIGN.md`
> **Parent Architecture**: `../../../docs/products/wopal-space/DESIGN.md`
> **Parent Product**: `../../../docs/products/wopal-space/PRD.md`
> **Sibling DESIGNs**:
>
> - `../../../docs/products/wopal-space/DESIGN-config-settings.md` — 产品级两级配置体系与 canonical settings
> - `../../../projects/wopal-cli/docs/DESIGN-config-cli.md` — CLI 呈现与 SDK 消费
> - `../../../.wopal/docs/DESIGN-assembly.md` — 本体装配：空间 `settings.jsonc` 的分发契约
>
> **Scope**: Ellamaka 对三层 canonical settings 的读取合并、`wopal.pluginConfig` 整表交付、`config-v2` 窄写面及宿主机启动环境配置消费。

## Overview and Scope

Ellamaka 从产品内置默认值、用户全局配置、空间公共配置与空间本地配置中按固定顺序解析实例配置，向 Server 插件和 TUI 插件统一交付生效表，并通过 `config-v2` HTTP 接口暴露只读视图与受控的 `wopal.dsh.web.enabled` 全局写面。

**Owned Here**：三层配置的合并优先级、`wopal.pluginConfig` 的整表交付与类型校验、`config-v2` 窄读写面契约，以及宿主启动前对全局 `wopal.execution.shellEnv` 的读取约束。

**Handled Elsewhere**：`wopal.dsh.web.enabled` 的持久化写入实现由 [DESIGN-wopalspace.md](./DESIGN-wopalspace.md) 拥有；DSH 原生 `cordis.patch.yml` 生命周期由 [DESIGN-dsh-base.md](./DESIGN-dsh-base.md) 拥有；未落地的完整多键配置写入与图形设置面板属于提案方向。

**Source Carrier**：`packages/opencode/src/config/`、`packages/opencode/src/server/routes/instance/httpapi/groups/config.ts`、`packages/wopalspace/src/product-settings.ts`。

## Reading: Product Defaults + User Global + Space Override

Workbench General 与 WopalSpace Instance 从 Ellamaka 产品默认值和用户全局设置开始；WopalSpace Instance 再叠加空间覆盖（低 → 高）。其它 OpenCode-compatible 非 WopalSpace Instance 继续使用兼容配置链，不自动采用 Workbench 的内部沙箱默认值：

| 层级           | 来源                                        | 性质                                             |
| -------------- | ------------------------------------------- | ------------------------------------------------ |
| 产品默认层     | Ellamaka built-in                           | 不落盘，不占来源标签                             |
| 用户全局层     | `$WOPAL_HOME/config/settings.jsonc`         | Workbench General 与所有 Space 共享的用户默认值  |
| 空间层（公共） | `<空间>/.wopal/config/settings.jsonc`       | 仅 Space；只读，本体装配物化的默认值，随本体流转 |
| 空间层（本地） | `<空间>/.wopal/config/settings.local.jsonc` | 仅 Space；共享服务写，本机私有覆盖（Git 忽略）   |

之后叠加 agent frontmatter 与 `ELLAMAKA_CONFIG_CONTENT` 内联覆盖（见 [DESIGN.md](./DESIGN.md#configuration-contract)）。深合并，后加载者覆盖。

**空间公共层是只读的**：它是本体维护人员经 Git 分发的默认配置，引擎不写它，也不接受任何针对它的写入请求。

### Plugin Configuration Assembly

引擎按当前 Workbench Instance 的层级合并 `wopal.pluginConfig`，并将结果留在实例的内存配置状态中。General 合并产品默认与用户全局两层；Space 在同一基线上继续合并 public / local 两层。配置合并独立于插件装载：插件缺席或装载失败，不改变已经得到的生效配置。

插件装载时，引擎把整张生效表经 `PluginInput.pluginConfig`（fork `packages/plugin` 契约字段，类型 `Record<string, Record<string, unknown>>`）交给插件，插件按自身配置键自取条目；引擎不解析插件身份、不按身份切片。`pluginConfig` 对插件条目内联 options 的同名配置具有更高优先级；内联 options 保持原有兼容性。插件校验自己的行为配置，装载失败由插件装载链报告，不以默认配置掩盖失败。插件不读配置文件，只消费引擎交付的条目。

TUI 插件走同一契约的另一条装载链：TUI 配置链与 Server 使用相同的 General / Space 层级规则合并 `wopal.pluginConfig`，运行时装配 TUI 插件时把同一张生效表经 `TuiPluginApi.pluginConfig`（类型与 `PluginInput.pluginConfig` 一致）整表交付，TUI 插件按自身配置键自取并校验，同样不读配置文件。内联 mount options 保持为兼容 fallback，`pluginConfig` 优先。

`pluginConfig` 是两个契约类型上的必选字段。General task 目录在空间探测失败时仍保留产品默认与用户全局层；其它非 WopalSpace Instance 保持兼容空表语义。General/Space 没有任何显式 `wopal` 段时仍保留产品内置默认表。漏传会在类型检查阶段直接报错，避免运行时静默退回 `undefined`。

## Config Surface and Bootstrap Consumption

- **`config-v2` 窄契约**（完整接口定义见 [DESIGN.md](./DESIGN.md#config-surface)）：
  - `GET /config-v2` 由引擎从实例状态直接返回 `effective.ellamaka`、`effective.wopal.dsh.web.enabled` 与 `effective.wopal.pluginConfig`；`/config` 维持原有运行时视图不变。
  - `PATCH /config-v2` 仅接受 `target="global"` 对 `wopal.dsh.web.enabled` 的布尔写入，经 `@wopal/wopalspace` 受控 settings writer 保留 JSONC 注释与无关字段并原子落盘，固定返回 `apply: "restart-required"`。
  - `wopal.dsh.web.enabled` 只属于用户全局 `$WOPAL_HOME/config/settings.jsonc`，默认 `true`，Space 层不覆盖它；`ellamaka-tools` 的进程级开关只认 `ELLAMAKA_DSH_TOOLS`，与本字段互不替代。
- **宿主机启动环境直读**：`wopal.execution.shellEnv` 与 `wopal.execution.execWritableRoots` 同样只从用户全局 `$WOPAL_HOME/config/settings.jsonc` 读取。Desktop Main 在确定本次产品根后直接读取 `wopal.execution.shellEnv` 合成宿主环境，与 Server 及 `config-v2` 生命周期解耦（见 [DESIGN-desktop.md](./DESIGN-desktop.md#desktop-host-environment)）。

## Business Rules and Failure Boundaries

- **输入形状失败关闭**：合并阶段 `wopal.pluginConfig` 的值必须是对象，字符串、数组或 `null` 视为配置错误，合并失败并报出文件路径与键名；禁止静默跳过并退回默认值，以免掩盖配置语法错误。
- **只读与作用域拒绝**：对 Space 公共层 `<space>/.wopal/config/settings.jsonc`、非 `global` target 或未注册键名发起 `PATCH /config-v2` 写入时，受控 writer 必须明确拒绝并保持原文件逐字节不变。
- **热生效边界**：`wopal.dsh.web.enabled` 的磁盘修改不即时挂载或卸载运行中的 Web profile，必须重启 Server/sidecar 后在新生命周期生效；`wopal.pluginConfig` 仅在配置加载/重载周期向插件交付。

## Reference Documents

| Document                                                           | Purpose                                                               |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `./proposals/proposed/feature/2026-09-17-config-plane-settings.md` | 未落地的 Phase 3 完整 Config Plane、多键写入与 Workbench 设置面板提案 |
| `references/ellamaka-config-mechanism.md`                          | 引擎配置加载与合并的现状机制（代码级参考）                            |
| `./DESIGN-ellamaka-sdk.md`                                         | Runtime API 的 schema、OpenAPI 与远程 SDK 生成纪律                    |
