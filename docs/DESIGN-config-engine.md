# Ellamaka — Config Consumption and Settings Panel

> **Status**: Active
> **Updated**: 2026-09-25
> **Parent**: `./DESIGN.md`
> **Sibling DESIGNs**:
> - `../../../docs/products/wopal-space/DESIGN-config-settings.md` — 配置体系总体设计："只有 CLI 能写配置"的规则由它定
> - `projects/wopal-cli/docs/DESIGN-config-cli.md` — CLI 侧：唯一写入实现，本设计的端点与面板最终都调它
> - `.wopal/docs/DESIGN-assembly.md` — 本体装配：空间 `settings.jsonc` 的分发契约
>
> **Scope**: 引擎怎么读三层配置、怎么把面板的读写请求转给 CLI、面板的状态标签怎么渲染

---

## What This Owns

引擎是配置的**读取者**和**写入转发者**，不是写入者。全产品的配置写入归 wopal CLI（`config.operation` capability），引擎里没有写配置文件的代码。本设计回答引擎侧的三件事：

1. 启动时怎么把"用户全局 + 空间"配置读成一个生效值
2. Workbench 面板的写入请求怎么经引擎落到 CLI
3. 面板的"继承自全局/空间覆写"标签数据从哪来

---

## Reading: User Global + Space Override

WopalSpace 模式下，引擎启动时按现有合并链读取配置（低 → 高）：

| 层级 | 来源 | 性质 |
|------|------|------|
| 用户全局层 | `$WOPAL_HOME/config/settings.jsonc` | CLI 写，跨空间默认值 |
| 空间层（公共） | `<空间>/.wopal/config/settings.jsonc` | 只读。本体装配物化的默认值，随本体 Git 流转 |
| 空间层（本地） | `<空间>/.wopal/config/settings.local.jsonc` | CLI 写，本机私有覆盖（Git 忽略） |

之后叠加 agent frontmatter 与 `ELLAMAKA_CONFIG_CONTENT` 内联覆盖（现有链路，见本文档 Configuration Contract）。深合并，后加载者覆盖。

**空间公共层是只读的**：它是本体维护人员经 Git 分发的默认配置，引擎不写它，也不接受任何针对它的写入请求。用户想覆盖某个默认值，写入空间本地层即可——加载顺序天然让本地覆盖生效，"恢复默认"等于删掉本地层的对应键。

### Plugin Configuration Assembly

引擎读取三层 settings 时，也合并 `wopal.pluginConfig`，并将结果留在实例的内存配置状态中。配置合并独立于插件装载：插件缺席或装载失败，不改变已经得到的生效配置。

插件装载时，引擎把整张生效表经 `PluginInput.pluginConfig`（fork `packages/plugin` 契约字段，类型 `Record<string, Record<string, unknown>>`）交给插件，插件按自身配置键自取条目；引擎不解析插件身份、不按身份切片。`pluginConfig` 对插件条目内联 options 的同名配置具有更高优先级；内联 options 保持原有兼容性。插件校验自己的行为配置，装载失败由插件装载链报告，不以默认配置掩盖失败。插件不读配置文件，只消费引擎交付的条目。

TUI 插件走同一契约的另一条装载链：TUI 配置链（`TuiConfig`）在 WopalSpace 模式读三层 settings 时合并 `wopal.pluginConfig`，TUI 运行时装配 TUI 插件时把同一张生效表经 `TuiPluginApi.pluginConfig`（类型与 `PluginInput.pluginConfig` 一致）整表交付，TUI 插件按自身配置键自取并校验，同样不读配置文件。内联 mount options 保持为兼容 fallback，`pluginConfig` 优先。

运行中的重载：引擎监听配置文件变化，CLI 写完文件后热重载自动接住，当前实例即时生效（现有 ReloadController 链路）。

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

// 写——引擎自己不写文件：经 CLI adapter 调 config.operation，由 CLI 落盘
// payload 指定目标（global / space）+ 键值；目标是空间公共层（settings.jsonc）时返回只读错误码
HttpApiEndpoint.patch("configUpdate", "/config-v2", {
  query: WorkspaceRoutingQuery,
  payload: ConfigV2UpdatePayload, // { target: "global" | "space", updates: KeyValue[] }
  success: described(ConfigV2UpdateResult, "Written via CLI writer"),
})

// 恢复继承——删掉空间本地层里指定的键，回落上层默认值
HttpApiEndpoint.post("configResetKey", "/config-v2/reset-key", {
  query: WorkspaceRoutingQuery,
  payload: Schema.Struct({ keyPath: Schema.Array(Schema.String) }),
  success: described(Schema.Boolean, "Reset successful"),
})
```

### Read Surface

`GET /config-v2` 覆盖三层继承链上的三个设置段：`ellamaka`、`wopal`、`tui`。`spaces` / `ontologies` 注册表走各自命令与既有读取通道，不进入本端点。返回形态：

```jsonc
{
  "effective": { "ellamaka": { /* 实例合并后的引擎配置 */ }, "wopal": { /* pluginConfig、logging */ }, "tui": { /* 终端偏好 */ } },
  "sources": {
    "wopal.pluginConfig.dsh-adapter.sandbox.mode": "space-local"
  }
}
```

- `effective` 是引擎合并链的结果值。`ellamaka` 段与既有 `/config` 同源同语义（`$VAR` 在加载时已代换）；`wopal` / `tui` 段为文件镜像（`$VAR` 不代换，引用解析发生在消费方插件内部）。
- `sources` 是叶键级的点路径 → 来源层标注，值 ∈ `global` / `space` / `space-local`；缺省值不占键，数组类键按整键标注。面板的"继承自全局 / 本地覆写 / 恢复继承"标签以此渲染。
- 分工：`/config` 维持运行时视图且不扩展；`/config-v2` 是配置的编辑视图，面板与后续配置功能统一消费它。权限选择器读 `effective.wopal.pluginConfig["dsh-adapter"].sandbox` 判断显示与默认模式，读 `effective.ellamaka.plugin` 判断插件存在性。

写入链路复用现有的 Wopal CLI adapter（sidecar 内 spawn `wopal --api-version` 进程，见 Runtime API 与 SDK 契约）：

```text
面板 ─→ 引擎 HTTP API ─→ CLI adapter ─→ wopal config ... --json ─→ CLI 写文件
                            │
                            └─ 引擎不实现任何写入逻辑，只做调用、超时与错误映射
```

### How the Engine Consumes the CLI Config Capability

引擎对 CLI 配置能力的使用分三个场景，各有明确路径，边界是"写走 CLI，读和 schema 走自己"：

| 场景 | 路径 | 为什么 |
|------|------|--------|
| 改配置 | adapter → `wopal config` → CLI 落盘 | 唯一写入实现，校验/补丁/密钥规则只存在一份 |
| 读配置值 | 引擎自己的加载链（内存中的合并结果，含 `wopal.pluginConfig`） | 启动时已加载，spawn 进程是纯开销 |
| 来源标注 / 继承状态 | 引擎合并记录直答 | 同上 |
| `ellamaka` 段 schema | 引擎构建期自带（`Config.Info` 转出的片段） | schema 真相源在引擎源码，不依赖 CLI |

adapter 侧的调用形态（复用既有 `CliContract` 的进程边界、超时、稳定错误码映射，无状态调用不引入常驻 worker）：

```text
引擎组件（面板 API handler）
  → adapter.runConfigOperation({ target, updates })
      → spawn: wopal config set <keyPath> <value> [--global] --json --api-version 1
      → 版本化 JSON envelope（ok / data / error code）
  → adapter 把 envelope 映射为引擎领域结果/错误
```

`PATCH /config-v2` 与 `reset-key` 端点内部就是这个 adapter 调用，没有第二实现。schema、OpenAPI 描述、SDK 生成遵循 `API-CONTRACT.md` 的纪律。

---

## Settings Panel

面板顶部一个作用域切换：**用户全局设置 | 空间设置**。选全局 → 写全局层；选空间 → 写空间本地层。界面上不存在"编辑空间 settings.jsonc"的入口——那是本体维护人员的 Git 工作流，不是设置面板的事。

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

| 状态 | 界面表现 | 用户能做什么 |
|------|----------|--------------|
| 继承中（空间本地层没写过这项） | 灰色标签"继承自全局"或"空间默认"，显示继承源的值 | 直接改 → 写入空间本地层 |
| 已覆写（空间本地层写过这项） | 高亮标签"本地覆写" + "恢复继承"按钮 | 改 → 更新本地值；点恢复 → 删掉本地键，回落继承源 |
| 悬停诊断 | 标签浮窗 | 看全貌：全局是什么、空间默认是什么、本地覆盖是什么、最终生效是哪个 |

标签数据来自 `GET /config-v2`——引擎从自己的加载状态直接回答，来源判定与合并算法同源。面板自己不碰任何文件，也不感知文件路径——它只知道"用户全局 / 空间"两个作用域和引擎给的数据。

---

## When Settings Take Effect

- `ellamaka` 段：CLI 写完文件 → 引擎文件监听热重载 → 当前实例即时生效。
- `wopal.pluginConfig` 段：WopalSpace 模式下引擎与 TUI 配置链各自加载时合并三层结果，插件装载时消费（server 插件经 `PluginInput.pluginConfig`，TUI 插件经 `TuiPluginApi.pluginConfig`）。写入后插件重新装载时取得新值；面板在写入响应里提示这一点，并在面板关闭时触发空间插件重建，让新配置尽快就位。`tui` 段由 TUI 配置链消费。

---

## Reference Documents

| Document | Purpose |
|----------|---------|
| `references/ellamaka-config-mechanism.md` | 引擎配置加载与合并的现状机制（代码级参考） |
| `./API-CONTRACT.md` | Runtime API 的 schema、OpenAPI 与 SDK 生成纪律 |
