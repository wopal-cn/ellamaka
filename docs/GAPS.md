# GAPS — ellamaka 设计与实现差距

> **Status**: Active
> **Updated**: 2026-09-14
> **Design Source**: `./DESIGN.md`（差距对照的设计真相源，引擎侧细节见文档集内各子设计）
> **Companion**: 追踪 ellamaka 引擎与 Desktop 侧的目标态差距，逐项解决后关闭。

---

## 运行时能力装配

### ASSEMBLY-G1: 技能可见性未支持会话级权限（P0）

**Current**: `packages/opencode/src/skill/index.ts` 的 `available()` 只接收 `agent` 并按 `agent.permission` 过滤；`packages/opencode/src/session/system.ts` 的技能段注入同样只依据角色基线。会话级权限无法影响技能可见性。

**Target**: 技能可见性判定综合角色基线与会话级权限，使 Wopal 为会话装配的技能能出现在该会话的可用技能清单中。

**Design**: `./DESIGN.md` 的 Ontology Loading Contract 与权限合并规则

**Exit**:
- [ ] 技能可见性判定接收并合并会话级权限
- [ ] 会话级权限覆盖角色基线
- [ ] 未授予的技能在该会话不可见
- [ ] 技能执行授权综合两侧规则

### ASSEMBLY-G2: MCP 工具未纳入权限过滤（P1）

**Current**: MCP 工具按连接状态收集（`packages/opencode/src/mcp/index.ts` 的 `tools()`），不经过权限规则过滤。

**Target**: MCP 工具的可见性与执行授权纳入权限规则判定，可按会话装配。

**Design**: `./DESIGN-ellamaka-tools.md`

**Exit**:
- [ ] MCP 服务可按会话授予
- [ ] 未授予的 MCP 工具在该会话不可见
- [ ] 执行时按会话权限授权

---

## Desktop 与 onboarding

### ELL-G1: Desktop onboarding 消费契约需对齐（P0）

**Current**: `packages/ellamaka-desktop/src/main/onboarding-ipc.ts` 消费 `availableTypes`（fallback 仍是 `[{ type: "common", branch: "main" }]`）；`setup-machine-client.ts` 为 `prepare-ontology` 特设 300s 超时；`onboarding-ipc.test.ts` / `setup-machine-client.test.ts` 的 mock 契约沿用 type/* 分支语义。

**Target**: `prepare-ontology` 返回契约为「装配单类型列表」后，Desktop 的消费逻辑与测试随之对齐。

**Design**: `./DESIGN-onboarding.md`

**Exit**:
- [ ] `onboarding-ipc.ts` 消费逻辑对齐新契约
- [ ] 复核 300s 超时与探测逻辑
- [ ] 两处测试 mock 更新为新契约语义

---

## 参考文档

| 文档 | 说明 |
|------|------|
| `./DESIGN-onboarding.md` | Desktop onboarding 设计（ELL-G1 的实现侧契约） |
