# PLAN-TODOS — dsh 双引擎融合进度管理

> **用途**：本分支（poc-ellamaka-cordis）进度索引与批次管理。
> **分工**：`DESIGN-dsh-poc.md` 管设计真相（按标题引用，不使用章节号）；dev-flow Plan（`.wopal-space/plans/ellamaka/`）管跨文件、多任务的大步实施；本文件管总览与执行顺序。
> **推进原则**：小步快跑，每一步交付可应用的具体成果，步内不掺杂后续步骤内容。
> **编号规则**：P = 已完成批次（历史）；A = 生态对齐（当前执行）；W = wopal 插件包（下一主线）；E = 多空间解耦与实验 profile（独立主线）；S = 壳单端口化与 workbench 精简（独立主线）；G = 门槛轨道（workbench 互通）。编号一经分配不复用、不重排。

---

## 已完成批次

| 批次 | 名称 | 完成说明 |
|------|------|----------|
| P1 | 双引擎容器宿主 | dsh 引擎在 ellamaka 进程内完整运行 |
| P2 | fs-search 落地 | 桥轨首个实证 |
| P3/P3.5 | 工具沙箱 + 动态装配 | tool-fs/str_replace/bash 沙箱接入 |
| P3.5+ | DSH home 收口 | 物化到 `$WOPAL_HOME/dsh` 唯一锚点 |
| P4 | Web 单端口统一 | `/dsh/*` 同源挂载 |
| P5 | 运行时隔离 + 物化生产化 | 统一 Runtime Manager，验收基线达成（2026-09-01） |
| P6 | 插件供应链（store 版） | 命令式安装 + 热挂载（2026-09-02；机制由 A 线退役替换） |
| P7 | 界面承载 | DSH 迁入「助理」tab（2026-09-03） |
| P8 | 拆雷 + 闭包升级 | 移除伪造 loader.internal；闭包升 0.1.2-rc.1 + browser-auth（2026-09-05） |
| P9 | dump-config 离线诊断 | `ellamaka dsh dump-config`（2026-09-05） |

---

## 当前执行：A 线（生态对齐，2026-09-05 立项）

设计真相见 `DESIGN-dsh-poc.md`「唯一 home 与目录所有权」「插件供应链」「dshmarket 插件市场接入」。**决策**：dsh 插件生态全面对齐官方契约（声明与终态按官方语义），执行器换成 Bun（零 pnpm、零官方 dsh CLI）；home 布局对齐（`DSH_HOME=$WOPAL_HOME/dsh/home`）。对齐原则：凡是官方生态有既定机制的，对齐它，不自研平行路。

| 步 | 名称 | 交付成果 | 验收标准 | 实施形态 | 状态 |
|---|------|---------|---------|---------|------|
| **A1** | home 布局迁移 | `state/`→`home/`、`profiles/`→`home/profiles/`、`.agent-presets`→`home/.agent-presets`；dev.sh + Desktop sidecar env 改指 `home/`；state README 退役 | preset 发现正常；dsh 会话 bash 的 DSH_HOME 指向 home；官方包 env 直读落 home | 迁移脚本 + 代码 retarget + TDD | **已完成**（`20260905-feature-dsh-a1-home-layout-migration` 归档，用户验证通过） |
| **A2** | 安装器 retarget + bun-hmr | 一个 Plan 完成：① Bun 安装器写官方终态（profile node_modules + package.json 声明），`installed.json`/`composePluginLayers`/旧 store 轮询退役（风暴缺陷随之消灭）；② bun-hmr 适配器（`registerConfig` 配置监听 + generation 候选校验 + 空闲窗口原子替换），watch 对象直接指向 profile 组合文件，Node 路径保持官方插件 | add/remove/install 产出官方语义终态；引擎加载新装插件；编辑 profile 补丁层运行中容器热应用；候选校验失败保留旧栈；失败不触碰 profile | dev-flow Plan（TDD + rook 审查） | **已完成**（`20260906-feature-dsh-installer-retarget-bun-hmr` 归档，用户验证通过） |
| **A3** | 宿主安装工契约 + 市场端到端验收 | `desktopProfiles` + `desktopPnpm` 注入 web 容器；dshmarket 以官方声明形态安装进 poc profile；通过 dshmarket 安装 dsh-better-sidebar | ① dshmarket 安装后 Settings → Plugin Market 页面可见可用；② 通过 market 一键安装 dsh-better-sidebar，引擎加载成功，右侧 sidebar UI 可见（含 explorer/git/terminal tab）；③ 已装列表与 profile package.json 声明一致；④ 禁用/启用 better-sidebar 后引擎热应用生效 | dev-flow Plan（依赖 A2） | 暂缓（plan 已写，研究不足——`desktopPnpm` 契约需补流式 handle / ndjson / pnpm 语义偏差研究，见 2026-09-07 进度记录） |
| **A4** | 生态互操作回归 | 官方 CLI（同一 home）↔ 引擎互操作验证；已装 poc 插件迁移官方声明形态 | 官方 CLI 装的插件引擎直接加载；已有 poc 插件迁移后热挂载正常 | 运营 + 回归清单 | 待排期 |

**执行顺序**：A1 → A2 → A3 → A4（严格顺序，每步落地后引擎可运行）。原 B2（bun-hmr）并入 A2，其设计主体不变、watch 对象一步到位（设计依据：`DESIGN-dsh-poc.md`「Bun 宿主 HMR 适配器（bun-hmr）」+「插件供应链 · 实现决策 D-02」）。

**已交付**：A2 实施过程中 Plan 223（enhance）完成了 `ellamaka dsh` 命令面与官方 `dsh` CLI 的对齐——plugin 官方序（`plugin --profile <name> add/remove/install` + 扩展 enable/disable/list，verbatim args）、dump-config 根 flags（`--dump-config`/`--dump-default-config` + repeatable `--patch` overlay，缺失文件 throw）、rejectParentOptions 与 boot 报错提示 serve。命令面形状见 `DESIGN-dsh-poc.md`「ellamaka dsh shim 命令面」。

---

## 下一主线：W 线（wopal 插件包，A4 之后启动）

设计真相见 `DESIGN-dsh-poc.md`「wopal 插件包（Agent 配置随包发布）」。主战场是 dsh 界面本身。

| 步 | 名称 | 交付成果 | 验收标准 | 实施形态 | 状态 |
|---|------|---------|---------|---------|------|
| **W1** | wopal 插件包 v1 | 标准 dsh 插件包 `@wopal/dsh-wopal-pack`：presets/（wopal/fae/rook 配置单）+ lib/（武器架能力）+ cordis.patch.yml（roots 注册） | `ellamaka dsh plugin add` 后 wopal/fae/rook 配置单出现于配置单列表；用其建会话：模型工具视野仅含 allow 名单；空间技能目录加载；空间 `AGENTS.md` 规则生效 | dev-flow Plan（TDD + rook 审查，依赖 A2） | 待排期 |
| **W2** | 配置单内容打磨 | wopal/fae/rook 配置单按实际使用反馈迭代（工具行、allow 名单、技能路径、团队协作） | 配置单与灵魂意图一致；token 占用随 allow 名单收窄；团队角色分化生效 | 运营 + 文档（废弃自动生成） | 待排期 |
| **W3** | 空间皮肤插件 v1 | 第一个自建 dsh GUI 客户端插件（服务端 cwd→空间识别 + 客户端主题 token + 2–3 个声明式 slots） | 编码/多媒体两演示空间视觉可区分；replaceRisk 全为 none；插件崩溃被错误隔离 | dev-flow Plan | 待排期 |
| **W4** | 插件生态使用与运营 | 外部/官方 dsh 插件评估清单 + 自建插件模板与规范；日常实际使用 | 至少 2 个外部插件留用；自建插件有标准化模板；产出评估报告 | 运营 + 文档 | 待排期 |

**执行顺序**：W1 → W2 → W3（W3 与 W4 可并行）。W 步骤的插件安装全部走 A 线落地的新供应链（官方声明终态）。W2 不含自动生成器（2026-09-05 修订：配置单只能按相似设计意图人工适配，不能自动生成）。

---

## 独立主线：E 线（多空间解耦与实验 profile）

设计真相见 `DESIGN-dsh-poc.md`「多空间解耦与实验 profile」。「助理」tab 的遮蔽耦合是 P7 的设计债；实验性第三方插件（依赖历史闭包、安全边界存疑）不应当进主 Web 容器。E 线拆掉遮蔽、把 DSH 空间配置化，并以独立进程承载实验 profile。

| 步 | 名称 | 交付成果 | 验收标准 | 实施形态 | 状态 |
|---|------|---------|---------|---------|------|
| **E1** | 去遮蔽 + 空间配置化 | 「助理」与「DSH」拆为两个独立空间 tab；DSH 空间开关两层模型（`settings.jsonc` 默认值 + 设置面板运行时覆盖）；`ellamaka.dsh.enabled` 配置键与 `ELLAMAKA_DSH` 逃生舱并存 | 启用 DSH 时显示独立 DSH tab（非「助理」），助理 tab 独立开关；面板修改立即生效并持久化；`ELLAMAKA_DSH=0` 仍能硬禁用 | dev-flow Plan（TDD + rook 审查） | 待排期 |
| **E2** | 实验 profile 独立进程 | `ellamaka dsh up --profile <name> --closure <fp>` 独立进程启动；实验进程独立 DSH_HOME；workbench 服务器管理式注册为空间 tab；闭包历史版本物化能力 | 实验 profile 以独立进程运行、崩溃不影响主进程；dsh-oil-creator 类插件在实验空间跑通并可用；注册后可持久化、健康圆点、keep-alive iframe | dev-flow Plan（依赖 E1 + A2 + 闭包物化扩展） | 待排期 |

**执行顺序**：E1 → E2。E1 不依赖 A 线施工内容（A 线动 home/安装器，不碰 tab 模型），可与 A 线并行排期；E2 依赖 E1 的前端 tab 模型扩展、A2 的官方声明供应链，以及「物化指定历史版本闭包」的新能力。W4 是 E2 的首个实证消费者（通过实验空间评估外部插件）。E 线立项（2026-09-06），设计已落入 `DESIGN-dsh-poc.md`。

---

## 门槛轨道：G 线（workbench × dsh 前端插件互通）

设计真相与执行清单见 `DESIGN-dsh-poc.md`「workbench × dsh 前端插件互通」（V1–V5）。

**启动前提**（两条同时满足才排期）：
1. W4 产出至少 1 个在日常中被证明有真实价值、值得搬进 workbench 的 dsh 前端插件。
2. workbench 侧完成 slot 化（3–5 个挂载点与 props 契约）。

---

## 独立事项

| 编号 | 事项 | 内容 | 时机 |
|------|------|------|------|
| B4 | 创造模式技能适配 dsh-in-ellamaka | `editing-cordis-compositions` 与 `cordis-plugin-development` 两技能补「dsh in ellamaka」章节；随 A 线各步落地按新布局增量修订 | skill-creator 修订（文档类），随时可做 |

---

## 独立主线：B5（认证联盟修补，2026-09-06 立项）

设计真相见 `DESIGN-dsh-poc.md`「浏览器认证（rc.1 browser-auth）· 认证联盟的架构定位」。Basic（ellamaka 外层）与 browser-auth cookie（dsh 内层）双信任域格局定稿，不做 Basic-only 统一；修补联盟的四个缺口。auth-fix-3 是 E 线（实验 profile 多挂载）的前置。

| 步 | 名称 | 交付成果 | 验收标准 | 实施形态 | 状态 |
|---|------|---------|---------|---------|------|
| **B5a** | trustedHosts 配置化 | `ellamaka.dsh.trustedHosts` 配置项（settings.jsonc 默认值层）经 profile 补丁层注入 connection 插件 | LAN 部署（`OPENCODE_SERVER_PASSWORD` + 声明 trustedHosts）下 DSH iframe 正常认证可用；默认空数组行为不变（loopback-only） | dev-flow Plan（TDD + rook 审查） | 待排期 |
| **B5b** | iframe 401 自愈 | `DshSurface` 401 探测 + 自动重取 `/workbench/dsh-url` 重载 iframe（token 重载即重新铸 cookie） | cookie 过期或引擎重启后 iframe 自动恢复，无需用户手动刷新；恢复过程无感 | dev-flow Plan（TDD + rook 审查） | 待排期 |
| **B5c** | 挂载认证策略显式化 | `NodeRouteMount` 增加强制 `auth: "self" \| "public"` 声明；dispatcher 固化「新 mount 不允许默认无认证」不变量 | 现有 `/dsh` 挂载声明为 `self`；新增 mount 缺少声明时报错；E 线实验 profile 挂载复用该契约 | dev-flow Plan（依赖项，E2 前置） | 待排期 |
| **B5d** | WS upgrade 认证探针 | 探针测试：未带 cookie 对 `/dsh/api/events*` 发起 upgrade，实证认证路径 | 探针给出确定结论：握手被拒（记录官方机制事实）或未被拒（宿主挂载层补 upgrade 前置 cookie 检查） | 探针测试（.tmp 或 test/） | 待排期 |

**执行顺序**：B5d（探针先行，结论决定是否需要宿主侧补防护）→ B5a → B5b → B5c（B5c 可与 E 线 E2 合并实施）。B5 各步独立可交付，不阻塞 A 线。

---

## 独立主线：S 线（壳单端口化与 workbench 精简，2026-09-06 立项）

设计真相见 `DESIGN-dsh-poc.md`「壳单端口化与 workbench 精简」。终局形态「一个 runtime，N 个壳」：desktop 删除 4123 代理层与 `oc://` 渲染宿主，renderer 加载 sidecar 端口上的 workbench；官方 opencode app 移除，`/` 变设备协商前门；i18n/theme 数据收敛。Phase 1（POC 内）保留 sidecar 构建链（dsh 生态 Bun 兼容未收敛，desktop 引擎需 node 环境），Phase 2（收敛后）引擎产物唯一化、sidecar 构建链退役——本线只排 Phase 1 与精简项，Phase 2 待 Bun 兼容收敛后另立批次。

| 步 | 名称 | 交付成果 | 验收标准 | 实施形态 | 状态 |
|---|------|---------|---------|---------|------|
| **S1** | workbench 精简（数据层） | i18n：两包 18 语言收敛为 en/zh（删 30 文件 + Locale 四张表 + 设置项 + parity test 同步收缩）；theme：37 主题 json 收敛为 ellamaka（+最多 1–2 备选），default-themes.ts 清空重写，loader/注册机制保留 | 两包各剩 en/zh（theme 仅 ellamaka）；设置页语言/主题列表收敛；构建通过、e2e 通过、i18n parity 测试通过 | dev-flow Plan（纯数据删除，TDD 豁免边界内；rook 审查） | 待排期 |
| **S2** | 官方 app 移除 + `/` 设备路由 | SPA 删 HomeRoute/`/:dir`/session 路由与官方壳（home/directory-layout/session/layout/titlebar）；服务端 `GET /` 显式 302（移动 UA → `/dsh/`，桌面 UA → `/workbench`）；dev 模式 SPA 根路由兜底 | `/` 桌面 UA 302 到 /workbench、移动 UA 302 到 /dsh/；官方路由 404/回落；workbench 与 dsh 表面回归正常；死代码清扫 + i18n 键清理 + e2e session-timeline 用例改写/删除 | dev-flow Plan（TDD + rook 审查；依赖 S1 的 i18n 收敛减少键清理面） | 待排期 |
| **S3** | sidecar serve SPA | sidecar 从 resources 目录 serve electron-vite `out/renderer` 产物；serveUI 目录 fallback（env 指定 UI 目录）；sidecar 重启保持同端口；utilityProcess IPC（sqlite 进度/日志级别）换 HTTP 健康检查 + 日志流 | desktop renderer 能从 `http://127.0.0.1:<sidecarPort>/workbench` 完整加载工作台；sidecar 重启端口不变、页内 reconnect；web serve 模式回归正常 | dev-flow Plan（TDD + rook 审查；与 S2 无依赖可并行排期） | 待排期 |
| **S4** | renderer 迁移 + 4123 退役 | packaged renderer 改 loadURL `http://127.0.0.1:<sidecarPort>/workbench`（onboarding 仍 oc://，转场顺序导航）；删除 `dshHttpProxy`/`createDshProxy`/cookie jar/`platform.dshProxyOrigin` 全链路/`dsh-surface.tsx` 的 `oc:` 分支；Electron 加固复核（will-navigate 守卫、preload 暴露面） | 打包 desktop 无 4123 监听；DSH iframe 同源（cookie/WS 浏览器原生处理）；两个 desktop 实例并行运行互不冲突；localStorage 重置一次性接受（PoC 裁定） | dev-flow Plan（依赖 S3；TDD + rook 审查 + 实机验收） | 待排期 |

**执行顺序**：S1 → S2（S2 依赖 S1 的 i18n 收敛，减少键清理面）；S3 与 S1/S2 无依赖可并行；S4 依赖 S3 收口。S 线不阻塞 A/W/E/B5 任一线；建议 A3 排期前或穿插插入（S1/S2 纯前端数据与路由层，与 A 线供应链施工零交叠）。Phase 2（sidecar 构建链退役 + 引擎产物唯一化）待 dsh Bun 兼容收敛后另立批次，不在本线排期。

---

## 待定事项（未排期）

| 事项 | 说明 | 关联设计 |
|------|------|----------|
| per-角色武器装备（自定义招人 provider） | 仅当 W1–W4 落地后仍存在「队员必须带不同武器」的真需求时才立项 | DESIGN-dsh-poc「组队语义」 |
| 界面演进（iframe → 原生） | W3 的插槽纪律保证定制件可无损迁移 | DESIGN-dsh-poc「空间皮肤插件」 |
| 插件 entry 级配置命令（`plugin config`） | 供应链 Plan 的 Out of Scope，独立后续 | DESIGN-dsh-poc「插件供应链 · 配置与信任」 |
| dsh 协处理器（借引擎跑子任务） | 不紧急；涉及托管会话语义设计，暂挂起 | — |
| pnpm-lock 兼容生成 | 若市场更新自动回滚的降级语义不可接受，评估 Bun 安装器产出最小合法 pnpm-lock | DESIGN-dsh-poc「插件供应链 · 已知偏差」 |

---

## 进度记录

| 日期 | 记录 |
|------|------|
| 2026-08-16 ~ 09-01 | P1–P5 完成（明细见 git 历史） |
| 2026-09-02 | 插件供应链定稿并全周期完成（Plan 6 Task + rook 8 Blocker 修复 + 实机验证）；审批桥接 Plan 归档 |
| 2026-09-03 | DSH 迁入「助理」tab（P7）；设计文档重写为无章节号版本；主线确立为空间 × Agent 配置体系 |
| 2026-09-04 | B1（拆雷）+ B1.5（dump-config）完成。事故教训：运行中引擎 `profiles/` 是引擎领地——内容幂等写 ≠ mtime 幂等，standing 重建按 mtime/size 触发；测试/dump/诊断一律 temp-home 注入（Live-home quarantine 已写入 poc AGENTS.md） |
| 2026-09-05 | B3 完成（rc.1 闭包 + browser-auth）；B1.5 分支合并回 poc 主线 |
| 2026-09-05 | **生态对齐定稿**：preset 消失事故实证官方包 env 直读绕开 config 注入；确立对齐方向——home 布局对齐官方、真相源改为官方 profile package.json（installed.json 退役）、Bun 执行器 shim 官方 dsh（零 pnpm）、dshmarket 走宿主安装工契约 |
| 2026-09-05 | **编号体系重排**：历史批次统一为 P1–P9；执行轨道重编为 A（生态对齐）、W（wopal 插件包）、G（门槛轨道）；原 B2 并入 A2，原 S 线更名 W 线，B4 保留原名入独立事项 |
| 2026-09-05 | **A1 代码+脚本落地**（Plan feature-dsh-a1-home-layout-migration Task 1–4 + Task 5 脚本，rook 两轮审查通过）：`DshLayout` 单点重定义 `homeDir=dsh/home`、供应链/mount/dump 三层 retarget、`stateHomePatches`→`homePatches`、dev.sh/sidecar env 改指 `home/`、迁移脚本 `scripts/dsh-migrate-home.sh`（幂等+守卫+哨兵）；live home 迁移待引擎停止后执行 |
| 2026-09-05 | **A1 live 迁移完成**（引擎停止后由 wopal 亲自执行）：`state/*`→`home/`、`profiles/*`→`home/profiles/`，state/profiles 退役，`home/README.md` 哨兵就位；AC#5/#6/#7 实证通过，二次执行 no-op。A1 全部落地，待用户验证 |
| 2026-09-06 | **E 线立项（多空间解耦与实验 profile）**：P7「助理」tab 遮蔽耦合确立为设计债；DSH 空间配置化（settings.jsonc 默认值 + 设置面板覆盖）；实验 profile 独立进程 + 独立 DSH_HOME + 服务器注册式空间 tab；设计落入 DESIGN-dsh-poc.md，暂不排期（用户裁定 E 线独立立项，暂不写 plan） |
| 2026-09-06 | **A2 代码完成**（Plan feature-dsh-installer-retarget-bun-hmr Task 1–7，TDD 红/绿分阶段提交）：真相源切为 profile package.json（dependencies + dsh.profile.bundles，profile-manifest 读写层）；composePluginLayers 改读用户 bundles 段（官方段归 loadProfile，stackContext bundle 层同步收窄防 duplicate id）；Bun 安装器官方终态（失败不触碰 profile、github: 明确报错、覆盖更新）；store 退役 + 一次性迁移（installed.json → retired-<date> 可回退）；重放服务 chokidar 事件驱动 + 失败保留 hash（风暴消灭）；bun-hmr 适配器接线 watchUserPatches（Bun 路径热加载 0→1）；CLI add/remove/list/enable/disable 全走官方终态 + patch-layer 补丁层语义 + 迁移钩子 |
| 2026-09-06 | **S 线立项（壳单端口化与 workbench 精简）**：desktop 删 4123 硬编码代理端口与 `oc://` 渲染宿主，renderer 加载 sidecar 端口 workbench（Phase 1 保留 sidecar 构建链——dsh Bun 兼容未收敛，Phase 2 收敛后引擎产物唯一化）；官方 app 移除 + `/` 设备协商前门（移动 UA → /dsh/，桌面 UA → /workbench；/dsh 不升根——前缀自治不变量、适配层改写已完成、B5 信任域边界三重理由）；i18n 18→2 语言、theme 37→1 主题数据收敛；设计落入 DESIGN-dsh-poc.md「壳单端口化与 workbench 精简」+ 设计约束 #23；批次 S1（精简数据层）→ S2（官方 app 移除 + 设备路由）→ S3（sidecar serve SPA）→ S4（renderer 迁移 + 4123 退役），S3 与 S1/S2 可并行 |
| 2026-09-07 | **A1/A2 状态校正**：两 plan 的 User Validation checkbox 均已勾选（用户验收通过），归档确认完整，PLAN-TODOS 状态列从"待用户验证"改为"已完成"。**223（dsh CLI 命令面对齐）归档**：用户验证通过，verify + archive `--keep-worktree` 完成，worktree `poc-ellamaka-cordis` 保留供演进。 |
| 2026-09-07 | **A3 研究诊断（plan feature-dsh-host-install-worker-contract-market-e2e 暂缓）**：源码实证（labs/research/dsh/dsh-market，v1.42.0）显示 plan 的 `desktopPnpm` 契约假设不成立，实施将失败：(1) 市场 `createDesktopPluginRuntime` 要求 `runPlugin` 返回**流式 handle**（`{stdout/stderr: ReadableStream, done: Promise<{exitCode,signal}>, cancel()}`，dsh-cli.ts:949-1076），不是 plan 声称的普通结果对象——Bun 安装器（函数式 `installPackage: Promise`）无法直接包装；(2) 市场经 handle 流解析 **pnpm ndjson 进度**（`--reporter=ndjson` 注入 + 状态路由），Bun 不产 ndjson → 进度 UI 空；(3) `install`/`remove` 按 **pnpm 语义**（workspace/`-w`/node_modules 拓扑 + `ERR_PNPM_*` 失败分类），与 Bun 逐包直写模型冲突；(4) plan Task 1 声称 `installAll` 动词，installer.ts 实际无此导出（仅 `installPackage`/`removePackage`）。结论：直接映射 Bun 安装器到 `desktopPnpm` 不可行；需先补契约研究决定取舍（流式 handle 适配 / spawn ellamaka CLI 模拟 / 接受进度残缺）。A3 暂缓实施。 |
