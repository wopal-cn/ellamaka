# Ellamaka — Config Consumption and Settings Panel

> **Status**: Draft
> **Updated**: 2026-10-13
> **Parent**: `./DESIGN.md`
> **Sibling DESIGNs**:
>
> - `../../../docs/products/wopal-space/DESIGN-config-settings.md` — Phase 3 Config Plane 总体方向与 canonical settings
> - `../../../projects/wopal-cli/docs/DESIGN-config-cli.md` — CLI 呈现与 SDK 消费
> - `../../../.wopal/docs/DESIGN-assembly.md` — 本体装配：空间 `settings.jsonc` 的分发契约
>
> **Scope**: Phase 3 Draft；研究 Ellamaka/DSH 双引擎如何消费统一 canonical settings，并保留各自 native apply lifecycle。当前实现 Plan 不交付本设计。

---

## What This Owns

> **Deferred**：本文整体仍是 Phase 3 Draft。当前 SDK / Runtime Foundation 实施不得新增 Config Plane、统一 DSH 配置投影或新的 config mutation API；现有读面只按当前已经批准的契约维护。

Phase 3 计划把本机 trusted 配置 implementation 放在 private `@wopal/wopalspace` 的 `config` module，并通过统一公开 `@wopal/ellamaka-sdk` 提供消费面：Wopal CLI 使用 `/local` 的 `config.*` methods，Browser/Workbench 使用 `/http`。Config Plane 的业务 owner 仍是 private `@wopal/wopalspace/config`，SDK package 统一不代表领域 owner 合并。

本文研究引擎侧四件事：

1. 如何把用户全局 + 空间 canonical settings 解析成 Ellamaka effective config；
2. Ellamaka config mutation 后如何从当前“粗粒度 dispose”演进为明确的 apply lifecycle；
3. 如何把 canonical DSH facts 交给 DSH native Settings/ConfigEditor/HMR/Loader，而不自行实现另一套 DSH reload；
4. Workbench 如何通过 Ellamaka HTTP 观察同一个 Config Plane，而不是复制业务规则。

---

## Reading: User Global + Space Override

WopalSpace 模式下，引擎启动时按现有合并链读取配置（低 → 高）：

| 层级           | 来源                                        | 性质                                        |
| -------------- | ------------------------------------------- | ------------------------------------------- |
| 用户全局层     | `$WOPAL_HOME/config/settings.jsonc`         | 共享服务写，跨空间默认值                    |
| 空间层（公共） | `<空间>/.wopal/config/settings.jsonc`       | 只读。本体装配物化的默认值，随本体 Git 流转 |
| 空间层（本地） | `<空间>/.wopal/config/settings.local.jsonc` | 共享服务写，本机私有覆盖（Git 忽略）        |

之后叠加 agent frontmatter 与 `ELLAMAKA_CONFIG_CONTENT` 内联覆盖（现有链路，见本文档 Configuration Contract）。深合并，后加载者覆盖。

**空间公共层是只读的**：它是本体维护人员经 Git 分发的默认配置，引擎不写它，也不接受任何针对它的写入请求。用户想覆盖某个默认值，写入空间本地层即可——加载顺序天然让本地覆盖生效，"恢复默认"等于删掉本地层的对应键。

### Plugin Configuration Assembly

引擎读取三层 settings 时，也合并 `wopal.pluginConfig`，并将结果留在实例的内存配置状态中。配置合并独立于插件装载：插件缺席或装载失败，不改变已经得到的生效配置。

插件装载时，引擎把整张生效表经 `PluginInput.pluginConfig`（fork `packages/plugin` 契约字段，类型 `Record<string, Record<string, unknown>>`）交给插件，插件按自身配置键自取条目；引擎不解析插件身份、不按身份切片。`pluginConfig` 对插件条目内联 options 的同名配置具有更高优先级；内联 options 保持原有兼容性。插件校验自己的行为配置，装载失败由插件装载链报告，不以默认配置掩盖失败。插件不读配置文件，只消费引擎交付的条目。

TUI 插件走同一契约的另一条装载链：TUI 配置链（`TuiConfig`）在 WopalSpace 模式读三层 settings 时合并 `wopal.pluginConfig`，TUI 运行时装配 TUI 插件时把同一张生效表经 `TuiPluginApi.pluginConfig`（类型与 `PluginInput.pluginConfig` 一致）整表交付，TUI 插件按自身配置键自取并校验，同样不读配置文件。内联 mount options 保持为兼容 fallback，`pluginConfig` 优先。

Phase 3 的 Ellamaka Config Reconciler 对配置变化明确分类为 `live | reload | restart-required`。未声明 live capability 的字段采用 reload 语义；只有具有稳定运行时更新契约的字段使用 live apply。

`pluginConfig` 是两个契约类型上的必选字段。空间探测失败（非 WopalSpace 实例）或三层文件都没有 `wopal` 段时，字段取空对象 `{}`——形状不变，插件按自身键取不到条目即是「未配置」。字段设为必选而非可选，是为了让每个构造点显式表态：漏传会立刻类型报错，而不是静默变成 `undefined` 让插件在运行时才发现。

合并阶段的输入形状由引擎把关：`wopal.pluginConfig` 的值必须是对象，字符串、数组或 `null` 视为配置错误，合并失败并报出文件路径与键名。不做静默跳过——手写配置把一个值写错类型时，跳过会让它悄悄退回插件内置默认，表现为「配置写了但不生效」，比启动失败难定位得多。插件装载阶段的行为配置校验仍归插件自己（见上），两类失败的报告渠道不同：合并期错在配置，装载期错在插件。

---

## Dual-Engine Config Plane — Phase 3 Draft

### Canonical Facts vs Native Runtime Config

Phase 3 的用户配置真相优先落在：

```text
$WOPAL_HOME/config/settings.jsonc
<space>/.wopal/config/settings.jsonc        # distribution default, read-only to product writers
<space>/.wopal/config/settings.local.jsonc  # user-local override
```

Ellamaka 可以直接消费这些文件的 `ellamaka` / `wopal` / `tui` 等事实；DSH 不应被迫改用 JSONC。未来 DSH 配置事实也先进入 canonical settings，再由 Ellamaka-owned integration adapter 转译为 DSH native mutation。

```text
canonical DSH fact
  -> resolve scope/profile/entry/path
  -> DshConfigProvider
  -> ctx.settings / ConfigEditor
  -> HMR.runExclusive + reconcileProfilePatches
  -> Loader lifecycle
```

DSH native configuration lifecycle 提供的关键机制直接作为 provider 的 apply backend：

- Settings descriptor 带 revision，stale write 会被拒绝；
- schema 的 `.volatile()` 字段可在运行实例内更新引用并发出 `loader/volatile-update`；
- ordinary config 由 Loader lifecycle 重新 mount；
- ConfigEditor 在持久化前校验完整 candidate，使用 profile writer lock 与 atomic write，并在 reconcile 失败时恢复 prior document；
- HMR `runExclusive()` 把配置写与自动 reload 串行化；
- `app-boot/config-reload` 表示 reconciliation 已完成；`settings/document-updated` 是 revision/invalidation 通知。

因此 WopalSpace 不复制这些机制，只定义统一的外层语义：`describe/read/mutate/observe`、opaque revision、source、schema、以及 apply outcome。DSH provider 把统一语义适配到 DSH native lifecycle。

### Single Authored Truth Constraint

目标模型不能长期允许 canonical settings 与 DSH profile patch 都作为普通用户配置的独立 authored truth，否则必然出现双写和优先级冲突。Phase 3 激活前必须明确 native direct edit 的政策：

1. 产品设置 UI / Agent mutation 是否全部回写 canonical settings，再由 provider 投影；
2. DSH native editor 是否仅作为高级 override，并在 `config explain` 中明确高优先级来源；或
3. 对产品托管的字段禁用 native direct write。

本文暂不选择其中一种；这也是配置设计继续保持 Draft 的主要原因。

### Unified Change Semantics

未来可对两个引擎统一“变化发生了什么”的语义，而不统一内部实现：

```text
durable mutation
  -> config changed / revision advanced
  -> engine-native reconcile
  -> applied: live | reload | restart-required | failed
```

事件只承担 invalidation/notification，不成为配置真相源。多进程场景下任何进程都必须能从 canonical/native provider 重新读取并收敛；DSH 继续使用自己的 HMR/watch，Ellamaka 则在 Phase 3 设计自己的 Config Reconciler。事件 schema、跨进程 transport 和 revision 生成方式均暂不冻结。

## Forwarding: HTTP API

Phase 3 中 Workbench 面板跑在浏览器里，只通过引擎 HTTP API 访问 Config Plane。设计候选继续使用独立的 `config-v2` 路由组（实例作用域，Instance Context + Workspace Routing + Authorization 中间件，两种运行模式通用），读写两条链分工明确。此端点是配置的通用消费面——后续配置相关功能优先建立在它之上，`/config` 维持运行时视图、不扩展：

```typescript
// 读——引擎直接从自己的加载状态回答，不走 CLI
// 返回生效配置树 + 每项来源（全局 / 空间公共 / 空间本地），面板标签的数据源
HttpApiEndpoint.get("configGet", "/config-v2", {
  query: WorkspaceRoutingQuery,
  success: described(ConfigV2TreeResponse, "Effective configuration with per-item source"),
})

// 写——Server HTTP handler 直接调用 private @wopal/wopalspace Config Plane；
// Wopal CLI 通过 @wopal/ellamaka-sdk/local 的 client.config.* 消费同一 implementation
// payload 指定目标（global / space）+ 键值；目标是空间公共层（settings.jsonc）时返回只读错误码
HttpApiEndpoint.patch("configUpdate", "/config-v2", {
  query: WorkspaceRoutingQuery,
  payload: ConfigV2UpdatePayload, // { target: "global" | "space", updates: KeyValue[] }
  success: described(ConfigV2UpdateResult, "Written by shared configuration service"),
})

// 恢复继承——删掉空间本地层里指定的键，回落上层默认值
HttpApiEndpoint.post("configResetKey", "/config-v2/reset-key", {
  query: WorkspaceRoutingQuery,
  payload: Schema.Struct({ keyPath: Schema.Array(Schema.String) }),
  success: described(Schema.Boolean, "Reset successful"),
})
```

### Read Surface

> **P2 先行 · 读面简版**：`GET /config-v2` 首版（`effective.ellamaka` + `effective.wopal.pluginConfig`，供权限选择器消费）现载于主设计 `./DESIGN.md`「Config Read Surface」，由 P2 计划 `enhance-config-read-surface` 实施；本文档定稿（P3 细节设计）时将这部分迁入，并补齐逐项来源、`tui` 段与写面（`PATCH` / `reset-key`）、面板的完整契约。

`GET /config-v2` 覆盖三层继承链上的三个设置段：`ellamaka`、`wopal`、`tui`。`spaces` / `ontologies` 注册表走各自命令与既有读取通道，不进入本端点。返回形态：

```jsonc
{
  "effective": {
    "ellamaka": {
      /* 实例合并后的引擎配置 */
    },
    "wopal": {
      /* pluginConfig、logging */
    },
    "tui": {
      /* 终端偏好 */
    },
  },
  "sources": {
    "wopal.pluginConfig.dsh-adapter.sandbox.mode": "space-local",
  },
}
```

- `effective` 是引擎合并链的结果值。`ellamaka` 段与既有 `/config` 同源同语义（`$VAR` 在加载时已代换）；`wopal` / `tui` 段为文件镜像（`$VAR` 不代换，引用解析发生在消费方插件内部）。
- `sources` 是叶键级的点路径 → 来源层标注，值 ∈ `global` / `space` / `space-local`；缺省值不占键，数组类键按整键标注。面板的"继承自全局 / 本地覆写 / 恢复继承"标签以此渲染。
- 分工：`/config` 维持运行时视图且不扩展；`/config-v2` 是配置的编辑视图，面板与后续配置功能统一消费它。权限选择器读 `effective.wopal.pluginConfig["dsh-adapter"].sandbox` 判断显示与默认模式，内部 adapter 的可用性由产品注册与真实 DSH ready 决定，不依赖外部装配路径。

写入链路使用同一 private 业务实现：

```text
Workbench
  → @wopal/ellamaka-sdk/http
  → Server HTTP handler
  → private @wopal/wopalspace Config Plane

Wopal CLI
  → @wopal/ellamaka-sdk/local client.config.*
  → SDK tarball 内组装的同源 WopalSpace Config Plane
```

这里的 `config` 是 client domain method，不为 Config domain 新增独立 npm subpath。

### Config Plane Consumption — Phase 3 Draft

引擎从已加载的实例状态回答 runtime effective read surface；canonical 配置的 mutation、来源计算与 schema 校验由 WopalSpace Config Plane 执行。HTTP handler 只翻译 transport/authorization，CLI 只解释命令输入并呈现结果。读取不启动 CLI，写入不 spawn Wopal。

阶段 3 的 PATCH/reset-key 使用同一服务。语义错误来自服务，传输错误由 HTTP 层表达；接口与 SDK 从 schema 生成，不复制校验或最低 CLI 版本门禁。

---

## Settings Panel

面板顶部一个作用域切换：**用户全局设置 | 空间设置**。选全局 → 写全局层；选空间 → 写空间本地层。界面上不存在"编辑空间 settings.jsonc"的入口——那是本体维护人员的 Git 工作流，不是设置面板的事。

工作台里现有的沙箱模式切换辅助函数依赖插件条目的内联 options。条目零内联之后它不再有可达调用点，但函数本身保留：它表达的是「这个空间默认用哪种沙箱模式」这条产品意图，后续设置面板要提供空间级默认值时会复用同一语义。确认无引用后可以清理，不在本次改动范围内。

```text
┌────────────────────────────────────────────────────────────────────────┐
│  设置 (Settings)                                                       │
│                                                                        │
│  作用域: [ 用户全局设置 ]  |  [ 空间设置: <空间名> ▼ ]                   │
├─────────────────────────┬──────────────────────────────────────────────┤
│ 侧边导航栏              │ 配置详情区                                   │
│ 【偏好】                │ 默认智能体 (Default Agent)                   │
│   • 通用外观 (桌面端)   │ [标签: 继承自全局]                           │
│   • 快捷键              │                                              │
│ 【模型与服务】          │ 外部目录访问策略 (external_directory)        │
│   • AI 供应商           │ [标签: 空间覆写]  [恢复继承]                 │
│ 【空间治理】            │                                              │
│   • 智能体偏好          │                                              │
│   • 权限与沙箱策略      │                                              │
│   • 插件与扩展          │                                              │
│ 【记忆与上下文】        │                                              │
│   • 记忆开关与注入      │                                              │
│   • LLM / Embedding    │                                              │
└─────────────────────────┴──────────────────────────────────────────────┘
```

每个可继承的配置项带一个状态标签，说清"这个值现在是谁的"。覆盖范围含插件行为配置（`wopal.pluginConfig.<插件名>.*`）——插件条目只装路径，行为配置统一落段，面板照常渲染继承状态：

| 状态                           | 界面表现                                         | 用户能做什么                                                       |
| ------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------ |
| 继承中（空间本地层没写过这项） | 灰色标签"继承自全局"或"空间默认"，显示继承源的值 | 直接改 → 写入空间本地层                                            |
| 已覆写（空间本地层写过这项）   | 高亮标签"本地覆写" + "恢复继承"按钮              | 改 → 更新本地值；点恢复 → 删掉本地键，回落继承源                   |
| 悬停诊断                       | 标签浮窗                                         | 看全貌：全局是什么、空间默认是什么、本地覆盖是什么、最终生效是哪个 |

标签数据来自 `GET /config-v2`——引擎从自己的加载状态直接回答，来源判定与合并算法同源。面板自己不碰任何文件，也不感知文件路径——它只知道"用户全局 / 空间"两个作用域和引擎给的数据。

---

## When Settings Take Effect

本节只记录 Phase 3 目标，不承诺当前实现已经具备统一热更新。

- Ellamaka：Config Reconciler 根据字段能力返回 `live | reload | restart-required`；未明确证明可 live 的字段默认走现有 reload/dispose 安全路径。
- DSH：provider 不自行判断如何重启 plugin，而是调用 DSH native Settings/ConfigEditor，让 HMR/Loader 根据 schema 与 lifecycle 完成 volatile update 或 remount；无法在线完成的变更向上返回 restart-required。
- `wopal.pluginConfig` / `tui`：继续由各自真实 consumer 决定 apply 方式，Phase 3 再统一对外呈现的 apply outcome。

---

## Reference Documents

| Document                                  | Purpose                                                    |
| ----------------------------------------- | ---------------------------------------------------------- |
| `references/ellamaka-config-mechanism.md` | 引擎配置加载与合并的现状机制（代码级参考）                 |
| `./DESIGN-ellamaka-sdk.md`                | Runtime API 的 schema、OpenAPI 与远程 SDK 生成纪律         |
| `./DESIGN-ellamaka-sdk.md`                | Phase 3 将扩展的统一 Runtime/WopalSpace public contract |
