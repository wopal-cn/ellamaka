# GAPS — ellamaka 设计与实现差距

> **Status**: Active
> **Updated**: 2026-09-14
> **Design Source**: `./DESIGN.md`（差距对照的设计真相源，引擎侧细节见文档集内各子设计）
> **Companion**: 追踪 ellamaka 引擎与 Desktop 侧的目标态差距，逐项解决后关闭。

---

## 会话级能力权限

### ELL-G1: 技能可见性未支持会话级权限（P0）

**Current**: `packages/opencode/src/skill/index.ts` 的 `available()` 只接收 `agent` 并按 `agent.permission` 过滤；`packages/opencode/src/session/system.ts` 的技能段注入同样只依据角色基线。会话级权限无法影响技能可见性。

**Target**: 技能可见性判定综合角色基线与会话级权限，使 Wopal 为会话装配的技能能出现在该会话的可用技能清单中。

**Design**: `./DESIGN.md` 的 Ontology Loading Contract 与权限合并规则

**Exit**:
- [ ] 技能可见性判定接收并合并会话级权限
- [ ] 会话级权限覆盖角色基线
- [ ] 未授予的技能在该会话不可见
- [ ] 技能执行授权综合两侧规则

### ELL-G2: MCP 工具未纳入权限过滤（P1）

**Current**: MCP 工具按连接状态收集（`packages/opencode/src/mcp/index.ts` 的 `tools()`），不经过权限规则过滤。

**Target**: MCP 工具的可见性与执行授权纳入权限规则判定，可按会话装配。

**Design**: `./DESIGN-ellamaka-tools.md`

**Exit**:
- [ ] MCP 服务可按会话授予
- [ ] 未授予的 MCP 工具在该会话不可见
- [ ] 执行时按会话权限授权

---

## DSH 插件包

### ELL-G3: wopal 插件包未实现（P0）

**Current**: wopal 的灵魂与能力以分散形态存在（`.wopal/dsh/agents-presets/` 下的三个配置单目录），未打包为可发布的 dsh 插件。

**Target**: `@wopal/dsh-wopal-pack` 作为标准 dsh 插件包发布，内含 `package.json`、`lib/index.js`（插件入口与武器架能力注册）、`lib/weapon-rack.js` 与 `presets/{wopal,fae,rook}/` 配置单，以及 `cordis.patch.yml`；用户经 `ellamaka dsh plugin add @wopal/dsh-wopal-pack` 安装即得三个配置单。

**Design**: `./DESIGN-dsh-web.md` 的 wopal 插件包

**Exit**:
- [ ] 插件包结构符合 `DESIGN-dsh-web.md` 的包结构定义
- [ ] `ellamaka dsh plugin add @wopal/dsh-wopal-pack` 完成安装与注册
- [ ] 安装后三个配置单出现在配置单列表
- [ ] 升级包不覆盖用户对配置单的个性化修改

### ELL-G4: 武器架能力未实现（P0）

**Current**: 工具可见性由角色基线与配置单静态决定，无按配置单收窄的机制。

**Target**: 插件包内的武器架能力在配置单行挂载时读取自身允许名单，对当前 agent 作用域收窄工具可见性；不在允许名单内的工具从模型视野中移除，工具定义不下发。

**Design**: `./DESIGN-dsh-web.md` 的武器架能力

**Exit**:
- [ ] 配置单行挂载武器架能力并传入允许名单
- [ ] 不在允许名单内的工具定义不下发给模型
- [ ] 收窄只影响加入该配置单的 agent 作用域

### ELL-G5: 空间皮肤插件未实现（P0）

**Current**: 界面按空间定制无实现，主题与界面件为全局统一。

**Target**: 空间皮肤插件含服务端与客户端两半：服务端从会话工作目录反查所属空间，在 `/dsh/*` 下暴露该空间的皮肤配置（主题变量覆盖、界面件开关、品牌资源）；客户端按配置应用主题变量与声明式插槽（品牌位、输入框信息条、会话头部动作位、自定义工具对话卡片）。

**Design**: `./DESIGN-dsh-web.md` 的空间皮肤插件

**Exit**:
- [ ] 服务端从工作目录反查空间并暴露皮肤配置
- [ ] 客户端同源请求并应用主题变量
- [ ] 界面件经声明式插槽应用，不整区替换
- [ ] 主题变量与 workbench 设计语言对齐

### ELL-G6: 实验 profile 独立进程未实现（P0）

**Current**: 核心容器（Web 与工具）与 ellamaka serve 同进程，无隔离的实验 profile 承载方式；Workbench 空间类型为单一形态。

**Target**: 实验性第三方 profile 以独立进程运行，带独立 DSH_HOME，不进入主 Web 容器、不共享 profile 目录。`ellamaka dsh up --profile <name> --closure <fingerprint> [--port 0]` 独立跑出认证入口，经服务器管理界面注册为 `dsh-profile:<id>` 空间标签；Workbench 顶栏空间类型扩展为助理、DSH、实验 profile 三类。

**Design**: `./DESIGN-dsh-web.md` 的多 profile 解耦

**Exit**:
- [ ] `ellamaka dsh up` 支持指定 profile 与闭包指纹独立启动
- [ ] 实验进程使用独立 DSH_HOME，不共享 profile 目录
- [ ] Workbench 支持注册实验空间并展示独立入口地址与健康状态
- [ ] 实验进程可绑定历史闭包，主进程继续运行当前闭包

---

## Workbench 交互

### ELL-G7: 跨空间会话重复绑定拦截未实现（P0）

**Current**: `packages/ellamaka-app/src/pages/workbench/parts/session-tree-services.ts` 的 `openSessionInPanel` 直接执行 `openTab` 并解析目标面板（empty 槽位、扩容或覆盖询问），未先检索该会话是否已在其他面板打开。

**Target**: 打开会话前先检索该会话是否已在工作台的任何面板（含其他空间）中打开；若已打开则拒绝重复绑定，自动跨空间切换 Tab 聚焦并闪烁高亮对应面板。

**Design**: `./DESIGN-workbench.md` 的跨空间智能 Tab/Panel 分发与定位

**Exit**:
- [ ] 已打开会话的重复打开请求不创建新绑定
- [ ] 自动切换到该会话所在空间与 Tab
- [ ] 目标面板闪烁高亮定位
- [ ] 未打开的会话维持既有的槽位分发与扩容逻辑

### ELL-G8: 对话轮变更汇总未实现（P0）

**Current**: 对话轮末尾无文件变更汇总行，文件改动只在单次编辑块中呈现。

**Target**: `TurnChangeSummary` 位于对话轮末尾，以无框紧凑摘要行显示修改文件数、增删行数与进入 Review 的操作入口，与单次文件编辑块形成过程与结果的关系。

**Design**: `./DESIGN-workbench.md` 的 Chat 视图

**Exit**:
- [ ] 对话轮末尾渲染变更汇总行
- [ ] 汇总显示修改文件数与增删行数
- [ ] 提供进入 Review 的操作入口
- [ ] 无文件变更的轮次不渲染该行

---

## 分发流水线

### ELL-G9: Release workflow 未断言机器身份一致性（P1）

**Current**: `publish-ellamaka-cli.yml` 与 `publish-ellamaka-desktop.yml` 中 identity 仅出现在注释里，构建产物内嵌身份与 release context 的一致性无校验步骤。

**Target**: release workflow 在产物构建后断言 CLI machine identity、Desktop embedded identity、manifest 与该产品 workflow 内唯一的 release context 四者完全一致，不一致时 fail closed。

**Design**: `./DESIGN-distribution.md` 的 Canonical Manifest 与 Runtime Identity Surfaces

**Exit**:
- [ ] CLI workflow 断言 binary 内嵌身份与 release context 一致
- [ ] Desktop workflow 断言应用内嵌身份与 release context 一致
- [ ] 断言失败时中断发布

---

## Desktop 与 onboarding

### ELL-G10: Desktop onboarding 消费契约需对齐（P0）

**Current**: `packages/ellamaka-desktop/src/main/onboarding-ipc.ts` 消费 `availableTypes`（fallback 仍是 `[{ type: "common", branch: "main" }]`）；`setup-machine-client.ts` 为 `prepare-ontology` 特设 300s 超时；`onboarding-ipc.test.ts` / `setup-machine-client.test.ts` 的 mock 契约沿用 type/* 分支语义。

**Target**: `prepare-ontology` 返回契约为「装配单类型列表」后，Desktop 的消费逻辑与测试随之对齐。

**Design**: `./DESIGN-onboarding.md`

**Exit**:
- [ ] `onboarding-ipc.ts` 消费逻辑对齐新契约
- [ ] 复核 300s 超时与探测逻辑
- [ ] 两处测试 mock 更新为新契约语义

---

## Reference Documents

| 文档 | 说明 |
|------|------|
| `./DESIGN-dsh-web.md` | Web profile 设计（DSH 插件包、多 profile 解耦） |
| `./DESIGN-workbench.md` | Workbench 设计规范 |
| `./DESIGN-distribution.md` | 分发与版本身份唯一真相源 |
| `./DESIGN-ellamaka-tools.md` | 工具容器 profile：能力采用与沙箱 |
| `./DESIGN-onboarding.md` | Desktop onboarding 设计 |
