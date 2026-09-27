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

## Reference Documents

| 文档 | 说明 |
|------|------|
| `./DESIGN-dsh-web.md` | Web profile 设计（DSH 插件包、多 profile 解耦） |
| `./DESIGN-workbench.md` | Workbench 设计规范 |
| `./DESIGN-distribution.md` | 分发与版本身份唯一真相源 |
| `./DESIGN-ellamaka-tools.md` | 工具容器 profile：能力采用与沙箱 |
| `./DESIGN-onboarding.md` | Desktop onboarding 设计 |
