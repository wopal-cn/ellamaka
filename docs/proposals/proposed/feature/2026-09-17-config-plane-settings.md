# Ellamaka Config Plane, Multi-Key Mutation, and Settings Panel

Status: proposed

- **Class**: feature
- **Created**: 2026-09-17

## Problem

当前 [DESIGN-config-engine.md](../../../DESIGN-config-engine.md) 与 [DESIGN-wopalspace.md](../../../DESIGN-wopalspace.md) 只覆盖了只读配置消费以及针对 `wopal.dsh.web.enabled` 的全局窄写面；Workbench 的完整图形化设置面板、逐项配置来源解释（`global` / `space` / `space-local`）、通用全局与空间本地写入、`reset-key` 恢复继承，以及 Ellamaka 与 DSH 双核心之间的统一在线生效协议均尚未建立。

若在缺乏统一写面和单一 authored truth 规则的情况下直接扩展设置面板，会导致两类问题：

1. Workbench 或 CLI 各自修改 JSONC 或 `cordis.patch.yml`，破坏唯一真相源并在双核心间引发覆写冲突；
2. 缺少按字段能力分类的生效语义（`live | reload | restart-required`），使用户无法得知配置变更后是否生效或是否需要重启。

## Proposal

在保留现有 `wopal.dsh.web.enabled` 窄写面与 `wopal.execution.*` 启动读取契约的前提下，将 Phase 3 的统一 Config Plane、双核心配置投影、完整 `/config-v2` 读写接口及 Workbench 设置面板拆分为可独立决策与分阶段验收的功能提案。本提案不改变已上线的 [DESIGN-config-engine.md](../../../DESIGN-config-engine.md) 现行三层读取与窄写面契约。

核心演进包括四部分：

1. **Dual-Engine Config Plane 与 `DshConfigProvider`**：把写入逻辑统一收口到 private `@wopal/wopalspace` 的 `config` 模块，对外通过 [DESIGN-ellamaka-sdk.md](../../../DESIGN-ellamaka-sdk.md) 的 `/http`（Workbench）与 `/local`（Wopal CLI）暴露统一 `config.*` operation；未来纳入托管的 DSH authored facts 先落入 canonical `settings.jsonc` / `settings.local.jsonc`，再经 `DshConfigProvider` 映射到 DSH 原生 `Settings` / `ConfigEditor` / `HMR.runExclusive` / `Loader` 生命周期，不复制第二套 DSH reload 机制。
2. **明确 Single Authored Truth 边界**：在激活前由产品拍板 DSH 原生 `cordis.patch.yml` 直改策略（回写 canonical settings、仅作显式高优先级 override，或对产品托管字段禁用直写），避免双源冲突。
3. **完整 `/config-v2` 读写与 `reset-key` 接口**：
   - `GET /config-v2` 返回 `effective`（含 `ellamaka`、`wopal`、`tui` 三段）与叶键级 `sources`（`global` / `space` / `space-local`）；
   - `PATCH /config-v2` 扩展支持 `target: "global" | "space"` 的受控键值写入（写 Space 公共只读层 `settings.jsonc` 返回只读错误码）；
   - `POST /config-v2/reset-key` 删除空间本地层 `settings.local.jsonc` 中的指定键以恢复继承。
4. **Workbench 图形化设置面板与统一 Apply Lifecycle**：顶部提供“用户全局设置 | 空间设置”作用域切换；每个可继承字段（含 `wopal.pluginConfig.*`）渲染“继承自全局 / 空间默认 / 本地覆写”标签与“恢复继承”操作；变更按字段能力返回 `live | reload | restart-required | failed`（未证明可 `live` 的字段默认走安全 `reload` 或 `restart-required`）。

## Dual-Engine Config Plane and Apply Semantics

```text
Workbench (@wopal/ellamaka-sdk/http) ─┐
                                       ├─▶ private @wopal/wopalspace Config Plane
Wopal CLI (@wopal/ellamaka-sdk/local) ─┘       │
                                               ├─▶ Ellamaka Config Reconciler (live | reload | restart-required)
                                               └─▶ DshConfigProvider ─▶ ctx.settings / ConfigEditor ─▶ HMR.runExclusive ─▶ Loader
```

- **权限与只读保护**：Space 公共层 `<space>/.wopal/config/settings.jsonc` 由本体装配分发，对产品写端永久只读；用户覆写一律写入 `<space>/.wopal/config/settings.local.jsonc`。
- **全局独占键保护**：`wopal.dsh.web.enabled` 等全局独占键在空间设置作用域下保持不可编辑且不提供空间覆盖或恢复继承。
- **配置变更事件**：事件仅作为 invalidation/notification 信号，不成为配置真相源；多进程场景下各进程仍从 canonical/native provider 重新收敛。

## Alternatives considered

- **继续在现有窄写面基础上为每个新设置单开独立 HTTP 端点**：每新增一类产品设置都需要新增端点和前后端胶水，且无法提供统一的来源解释（`sources`）和通用 `reset-key` 能力，长期会导致接口碎片化，因此不采用。
- **让 DSH 引擎直接改读 JSONC 并放弃原生 `Settings` / `ConfigEditor`**：会破坏 DSH 上游自身的 schema 校验、`.volatile()` 热更新、`HMR.runExclusive` 串行队列和原子回滚机制，维护成本过高，因此不采用。
- **允许 `settings.jsonc` 与 `cordis.patch.yml` 长期双向自由编辑而不定唯一真相源**：必然产生双写竞争和优先级漂移，在界面上无法向用户诚实解释“当前值来自哪里”，因此必须在 Phase 3 激活前定界。

## Acceptance criteria

1. **双通道同源读写**：Workbench（经 `@wopal/ellamaka-sdk/http`）与 Wopal CLI（经 `@wopal/ellamaka-sdk/local`）调用同一套 `wopalspace` Config Plane 实现完成读、改、重置，写 Space 公共 `settings.jsonc` 时均返回明确只读错误。
2. **逐项来源与恢复继承**：`GET /config-v2` 准确返回 `effective`（含 `ellamaka`、`wopal`、`tui`）及 `sources` 标注；调用 `POST /config-v2/reset-key` 删除空间本地覆盖键后，生效值正确回落到全局或空间公共默认值，且保留 JSONC 注释与无关字段。
3. **DSH 原生投影与 Apply 状态**：经由 `DshConfigProvider` 变更托管字段时，通过 DSH `ConfigEditor` 校验与 `HMR.runExclusive` 应用，并向上返回准确的 `live | reload | restart-required | failed` 结果；校验或 reconcile 失败时保留原有效配置不留半成品。
4. **设置面板交互完整**：Workbench 设置面板支持“用户全局 / 空间”切换、继承状态标签、恢复继承操作及全局独占键禁用表现，且面板自身不直接读写磁盘配置文件。

## Risks

- **Single Authored Truth 策略未定稿导致用户习惯冲突**：若直接禁用原生 `cordis.patch.yml` 直改会影响熟悉高级手动编辑的用户；若完全放开则需处理外部修改与 canonical settings 的覆盖优先级。
- **字段 `live` 生效误判风险**：若将实际需要重挂载或重启才能生效的字段标记为 `live`，会造成界面提示已生效但运行态未更新，因此未充分验证的字段必须保守归类为 `reload` 或 `restart-required`。

## Reference Documents

- [Ellamaka Config Engine Present-State DESIGN](../../../DESIGN-config-engine.md)
- [Ellamaka SDK DESIGN](../../../DESIGN-ellamaka-sdk.md)
- [WopalSpace Config Settings Product DESIGN](../../../../../../docs/products/wopal-space/DESIGN-config-settings.md)
- [Ellamaka Config Mechanism Reference](../../../references/ellamaka-config-mechanism.md)
