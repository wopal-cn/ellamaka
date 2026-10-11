# Ellamaka — Config Consumption and Settings Panel

> **Status**: Draft
> **Updated**: 2026-10-10
> **Parent**: `./DESIGN.md`
> **Sibling DESIGNs**:
>
> - `../../../docs/products/wopal-space/DESIGN-config-settings.md` — 配置体系总体设计：共享服务拥有写入与校验
> - `../../../projects/wopal-cli/docs/DESIGN-config-cli.md` — CLI 呈现与 SDK 消费
> - `../../../.wopal/docs/DESIGN-assembly.md` — 本体装配：空间 `settings.jsonc` 的分发契约
>
> **Scope**: 引擎怎么读三层配置、怎么让面板与 CLI 复用共享服务、面板的状态标签怎么渲染

---

## What This Owns

配置的读取、schema 和写入校验由 Ellamaka 共享配置服务拥有。引擎 HTTP handler 直接调用服务，Wopal CLI 通过统一 SDK 消费它；业务规则只有一份。本文为阶段 3 Draft，编辑面、来源标签和完整写接口仍由该阶段交付，不进入当前升级 Plan。本设计回答引擎侧的三件事：

1. 启动时怎么把"用户全局 + 空间"配置读成一个生效值
2. Workbench 面板的写入请求怎么经引擎调用共享服务
3. 面板的"继承自全局/空间覆写"标签数据从哪来

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

运行中的重载：引擎监听配置文件变化，共享服务写完文件后热重载自动接住，当前实例即时生效（现有 ReloadController 链路）。

`pluginConfig` 是两个契约类型上的必选字段。空间探测失败（非 WopalSpace 实例）或三层文件都没有 `wopal` 段时，字段取空对象 `{}`——形状不变，插件按自身键取不到条目即是「未配置」。字段设为必选而非可选，是为了让每个构造点显式表态：漏传会立刻类型报错，而不是静默变成 `undefined` 让插件在运行时才发现。

合并阶段的输入形状由引擎把关：`wopal.pluginConfig` 的值必须是对象，字符串、数组或 `null` 视为配置错误，合并失败并报出文件路径与键名。不做静默跳过——手写配置把一个值写错类型时，跳过会让它悄悄退回插件内置默认，表现为「配置写了但不生效」，比启动失败难定位得多。插件装载阶段的行为配置校验仍归插件自己（见上），两类失败的报告渠道不同：合并期错在配置，装载期错在插件。

---

## Forwarding: HTTP API

Workbench 面板跑在浏览器里，浏览器只跟引擎 HTTP API 说话。引擎提供独立的 `config-v2` 路由组（实例作用域，Instance Context + Workspace Routing + Authorization 中间件，两种运行模式通用），读写两条链分工明确。此端点是配置的通用消费面——后续配置相关功能优先建立在它之上，`/config` 维持运行时视图、不扩展：

```typescript
// 读——引擎直接从自己的加载状态回答，不走 CLI
// 返回生效配置树 + 每项来源（全局 / 空间公共 / 空间本地），面板标签的数据源
HttpApiEndpoint.get("configGet", "/config-v2", {
  query: WorkspaceRoutingQuery,
  success: described(ConfigV2TreeResponse, "Effective configuration with per-item source"),
})

// 写——HTTP handler 直接调用共享配置服务，与 SDK/local 的 CLI 消费同源
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

写入链路使用同一业务实现：

```text
Workbench → HTTP handler → 共享配置服务 → 校验与原子写入
Wopal CLI → SDK/local → 同一共享配置服务
```

### Shared Configuration Consumption

引擎从已加载的实例状态回答运行时读面；持久配置的写入、来源计算与 schema 校验由共享服务执行。HTTP handler 校验传输和授权上下文，服务校验键、值和可写目标，CLI 仅解释命令输入并呈现结果。读取不启动 CLI，写入不 spawn Wopal。

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

- `ellamaka` 段：共享服务写完文件 → 引擎文件监听热重载 → 当前实例即时生效。
- `wopal.pluginConfig` 段：WopalSpace 模式下引擎与 TUI 配置链各自加载时合并三层结果，插件装载时消费（server 插件经 `PluginInput.pluginConfig`，TUI 插件经 `TuiPluginApi.pluginConfig`）。写入后插件重新装载时取得新值；面板在写入响应里提示这一点，并在面板关闭时触发空间插件重建，让新配置尽快就位。`tui` 段由 TUI 配置链消费。

---

## Reference Documents

| Document                                  | Purpose                                        |
| ----------------------------------------- | ---------------------------------------------- |
| `references/ellamaka-config-mechanism.md` | 引擎配置加载与合并的现状机制（代码级参考）     |
| `./API-CONTRACT.md`                       | Runtime API 的 schema、OpenAPI 与 SDK 生成纪律 |
