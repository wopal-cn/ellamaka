# GAPS — ellamaka 设计与实现差距

> **Status**: Active
> **Updated**: 2026-09-15
> **Design Source**: `./DESIGN.md`（差距对照的设计真相源，引擎侧细节见文档集内各子设计）
> **Companion**: 追踪 ellamaka 引擎与 Desktop 侧的目标态差距，逐项解决后关闭。

---

## 会话级能力权限

### ELL-G1: 会话中可用的技能只看角色，不看这个会话实际需要什么（P0）

**Current**: 一个会话能用哪些技能，由它扮演的角色预先定好，全程不变。Wopal 即便判断某个会话需要额外某项技能，也无法让它在那个会话里出现——用户只能看到角色自带的那些。

**Target**: 会话的可用技能综合角色与该会话实际被赋予的能力共同决定：额外赋予的技能会出现在该会话的可用清单里，未赋予的技能在该会话不可见、也无法调用。

**Design**: `./DESIGN.md` 的 Ontology Loading Contract 与权限合并规则

**Exit**:
- [ ] 为某个会话赋予额外技能后，该技能出现在该会话的可用清单中
- [ ] 未赋予该会话的技能不可见，且无法被调用
- [ ] 会话的赋予结果能覆盖角色默认，而不是只做叠加
- [ ] 其他会话不受影响

### ELL-G2: 外部工具服务无法按会话授予（P1）

**Current**: 接入的外部工具服务只要连上就对所有会话可见，「这个会话只该用这几个服务」无法表达；用户也没有办法把某个服务限制在特定用途的会话里。

**Target**: 外部工具服务与其中的工具按会话授予：只有被赋予的服务与工具在该会话可见、可调用，其余不可见。

**Design**: `./DESIGN-ellamaka-tools.md`

**Exit**:
- [ ] 可按会话授予具体的外部服务
- [ ] 未授予的服务及其工具在该会话不可见
- [ ] 未授予的工具即便被要求调用也不会执行

---

## Config Consumption

### ELL-G11: 引擎没有空间级配置消费面，面板写入无落点（P0）

**Current**: 引擎能读三层配置文件，但 `Config.Service` 只有 `get`/`getGlobal`/`update`（写死项目目录 `config.json`）/`updateGlobal`，没有空间级读写与来源标注；`config-v2` 路由组尚未实现，Workbench 面板查不到继承状态、也没有写入入口；`DialogSettings` 是本地偏好 dialog，无作用域切换。

**Target**: 按 `./DESIGN-config-engine.md` 实现：`GET /config-v2` 由引擎加载状态直答（生效树 + 每项来源）；`PATCH /config-v2` 与 `reset-key` 经 CLI adapter 转发 `config.operation`（引擎无写入代码，空间 `settings.jsonc` 写请求返回只读错误码）；面板作用域切换 + 继承状态标签（覆盖 `wopal.pluginConfig` 插件配置）；配置写入后 `ellamaka` 段经文件监听热重载即时生效。

**Design**: `./DESIGN-config-engine.md`；`../../../docs/products/wopal-space/DESIGN-config-settings.md`（总体分层与唯一写入者）

**Exit**:
- [ ] `GET /config-v2` 返回生效配置树与每项来源（全局/空间公共/空间本地），与引擎合并链同源
- [ ] `PATCH /config-v2` 经 adapter 落到 CLI，写目标为 `settings.local.jsonc`；目标为空间 `settings.jsonc` 时返回只读错误码
- [ ] `reset-key` 删除本地层键后配置回落继承源
- [ ] 面板作用域切换可用，继承态/覆写态/悬停诊断按数据渲染，含插件配置项
- [ ] CLI 写入 `ellamaka` 段后当前实例热重载生效，无需重启

---

## Plugin Config Delivery

### ELL-G13: 引擎不把插件行为配置交给插件，插件各自读配置文件（P0）

**Current**: 引擎读空间三层 settings 时只提取 `ellamaka` 段，`wopal` 段（含 `wopal.pluginConfig`）被丢弃；`PluginInput` 与 `TuiPluginApi` 都没有插件配置字段，插件装载时拿不到任何配置。三个本体插件因此各自定位空间根、读三层文件、deep merge 后取自己那一份——`dsh-adapter` 的 `settingsLayerPaths()`、`tui-ellamaka/config.ts`、`wopal-plugin/src/config/loader.ts` 各写一遍同样的合并逻辑。

**Target**: 按 `./DESIGN-config-engine.md` 的 Plugin Configuration Assembly 实现：引擎读三层 settings 时把 `wopal.pluginConfig` 一并合并成一张生效表，合并结果与叶键级来源标注留在实例内存状态，配置热重载时随之更新；装载插件时整表交付——server 插件经 `PluginInput.pluginConfig`、TUI 插件经 `TuiPluginApi.pluginConfig`，引擎不解析插件身份也不按身份切片；非空间实例与无 `wopal` 段时为空对象。插件缺席或装载失败不改变已经得到的生效配置。

**Design**: `./DESIGN-config-engine.md`（Plugin Configuration Assembly）

**Exit**:
- [ ] 三层 deep merge 正确（后层覆盖、对象深层合并、数组整键替换）；缺层按空处理不抛错
- [ ] 每个叶键记录来源层，被覆盖键只标生效层，缺省值不占键
- [ ] server 插件收到完整整表（其他插件名条目原样可见，未切片）；装配条目内联 options 仍走既有第二参数
- [ ] TUI 插件经 `api.pluginConfig` 收到同一张表；非空间实例两处均为空对象
- [ ] 配置热重载后插件重新装载取得新值

---

## Reference Documents

| 文档 | 说明 |
|------|------|
| `./DESIGN-dsh-web.md` | Web profile 设计（DSH 插件包、多 profile 解耦） |
| `./DESIGN-workbench.md` | Workbench 设计规范 |
| `./DESIGN-distribution.md` | 分发与版本身份唯一真相源 |
| `./DESIGN-ellamaka-tools.md` | 工具容器 profile：能力采用与沙箱 |
| `./DESIGN-onboarding.md` | Desktop onboarding 设计 |
