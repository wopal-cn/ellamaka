# DSH Space Skins, Isolated Experimental Profiles, and Workbench Plugin Slots

Status: proposed

- **Class**: feature
- **Created**: 2026-10-14

## Problem

当前 [DESIGN-dsh-web.md](../../../DESIGN-dsh-web.md) 与 [DESIGN-workbench.md](../../../DESIGN-workbench.md) 已提供固定 DSH Web Tab、核心双 profile（`web` 与 `ellamaka-tools`）以及单一公开端口承载，但仍缺少面向空间与实验场景的定制扩展能力：

1. DSH Web 界面无法感知当前 WopalSpace 的品牌皮肤或空间级扩展插槽；
2. 需要尝试历史闭包版本或第三方实验性 DSH profile 时，若放进主进程或共享 `$WOPAL_HOME/dsh/home`，会引发单进程双版本官方包冲突、故障扩散以及 Home 代际污染；
3. DSH 前端插件与基于 SolidJS 的 Workbench 属于两套前端框架，当前没有跨框架的受控界面互通机制。

## Proposal

在不改变正式产品核心 `web` / `ellamaka-tools` 容器与固定 Active Home 契约的前提下，规划三条可独立选型的扩展能力：

1. **空间皮肤插件**：由 DSH 服务端插件根据会话工作目录（含 `.wopal-space/` 标记）解析所属空间，并在 `/dsh/*` 同源通道下暴露主题变量覆盖、品牌资源与声明式插槽开关（品牌位、输入框上下信息条、会话头部动作位、自定义工具卡片），不整区替换 DSH 内部界面结构。
2. **独立隔离的实验 Profile 进程**：
   - 将 Workbench 顶栏空间类型从 `assistant` 与固定 `dsh` 扩展出注册式的实验标签（`dsh-profile:<id>`）；
   - 每个实验 profile 由用户显式启动的独立进程承载（如 `ellamaka dsh up --profile <name> --closure <fingerprint> [--port 0]`），使用隔离的 `DSH_HOME`，严禁共享正式 `$WOPAL_HOME/dsh/home` 或充当 Home 回滚目标；
   - 扩展 Runtime Manager 允许按显式指纹物化历史闭包到 `closures/<fingerprint>`（沿用只增不减与指纹校验流程），Workbench 通过注册的服务器健康探针管理实验标签和保活 iframe 池。
3. **Web Component 跨框架前端插件互通（带启动前提门禁）**：仅当“自建与留存插件生态已进入日常使用”且“Workbench 已沉淀 3–5 个声明式挂载点与属性契约”两个前提同时满足后，才允许插件包通过 Web Component + Shadow DOM 向 Workbench 插槽注入界面，由 Bridge 提供静态路由并由 Workbench 加载器承担降级与错误隔离。

## Design Boundaries and Open Questions

- **配置与权限边界**：核心 `wopal.dsh.web.enabled`、`ELLAMAKA_DSH_TOOLS` 与 `wopal.pluginConfig.dsh-adapter` 归正式 Active 设计所有；实验 profile 在明确独立进程身份、认证和生命周期前，不复用核心开关，也不引入 `ellamaka.dsh.*` 第二份真相。Web Component 与 Workbench 同页面上下文，仅靠显式安装与风险提示把关，不触碰官方闭包。
- **待决开放问题**：
  1. 固定 DSH 版本实际提供的稳定主题与插槽扩展接口及配置校验失败隔离方式；
  2. 实验 profile 标签的状态持久化、导航及远端 Server 切换如何接入现有 General/DSH Tab；
  3. 实验 profile 的注册、认证、健康与退出由谁负责，历史 closure 不兼容 Bridge 时如何明确拒绝；
  4. 保活 iframe 池的资源上限与关闭语义；
  5. 前端插件互通的真实需求与插槽前提是否成立。

## Alternatives considered

- **在主 Server 进程内直接挂载多个实验或历史版本 DSH profile**：会触发单进程内多版本官方包冲突，实验插件的崩溃或死锁也会波及主进程与正式会话，且容易污染正式 `$WOPAL_HOME/dsh/home`，因此排除。
- **让核心入口选举 single-owner Home 或通过代理跨进程共享 Web profile**：与多 `serve`/Desktop/TUI 并存的产品要求冲突，也会在产品层引入复杂的单主选举与代理状态同步，因此不采用。
- **在缺少稳定插槽与真实生态需求前提前建设跨框架插件平台**：会引入额外加载器、样式隔离与维护复杂度而无实际使用方，因此把跨框架互通列为双条件门禁后的阶段能力。

## Acceptance criteria

1. **皮肤插件隔离**：启用空间皮肤插件时，仅影响声明式插槽与主题变量，加载失败或配置缺失时退回默认 DSH 皮肤而不阻塞会话。
2. **实验 Profile 物理隔离**：实验 profile 进程使用独立 `DSH_HOME` 与端口，不读写 `$WOPAL_HOME/dsh/home`，其崩溃或退出不影响主 Ellamaka Server 与正式 DSH Web Tab。
3. **历史闭包拒绝边界**：物化或启动与当前 Bridge 不兼容的历史闭包指纹时，系统明确拒绝并给出诊断，不静默降级运行。
4. **前端插件门禁与降级**：在双启动前提满足并启用 Web Component 插槽后，当对应容器未运行或组件加载失败时，仅该插槽展示不可用态，不污染或崩坏 Workbench 宿主界面。

## Risks

- **保活 iframe 池的内存与连接开销**：多个实验 profile 标签长期保活会占用较高内存与 WebSocket 连接数，需要定义明确的 LRU 上限或显式休眠策略。
- **跨包版本兼容性漂移**：实验 profile 允许加载历史闭包时，Bridge 接口可能与历史闭包存在隐性差异，需建立明确的 compatibility matrix 或拒绝清单。
- **上游多进程并发限制**：多个正式 DSH 实例共享同一 `$WOPAL_HOME/dsh/home` 仍受限于 DSH 自身并发保证，本提案不掩盖或替上游消除该已知限制。

## Reference Documents

- [DSH Web Profile DESIGN](../../../DESIGN-dsh-web.md)
- [DSH Base Integration DESIGN](../../../DESIGN-dsh-base.md)
- [Ellamaka Workbench DESIGN](../../../DESIGN-workbench.md)
