# Kilocode 上游合并机制分析

> **日期**: 2026-07-07
> **状态**: 研究完成
> **结论**: 方案可行，建议一次性完整复刻

## 一、背景

ellamaka 是 OpenCode 的 WopalSpace 引擎 fork。每次合并上游版本都极其痛苦——最近一次 v1.15.13 合并产生 329 个冲突，其中 ~300 个是 modify/delete（精简目录），29 个是内容冲突。手动逐文件解决耗时巨大，且经常导致品牌定制丢失。

Kilocode 面临完全相同的问题（也是 OpenCode fork），但他们建立了一套成熟的自动化合并机制。本文深入分析其方案，评估 ellamaka 一次性完整复刻的可行性与工作量。

## 二、Kilocode 的合并架构

Kilocode 维护了一套总计约 **11,300 行** 的自动化合并工具链（位于 `script/upstream/`），核心思路是 **"预转换上游，再合并"**。

### 核心流程（8 步）

```
1. 环境验证 → 2. Fetch 上游 → 3. 确定目标版本 → 4. 冲突分析报告
→ 5. 创建分支（backup + kilo + opencode 兼容分支）
→ 6. 【关键】对 opencode 分支做预合并转换
→ 7. 合并 + 自动解决残留冲突
→ 8. 重新生成 lock 文件 + SDK
```

### 第 6 步：预转换清单（在合并前对上游分支执行）

| 转换 | 作用 |
|------|------|
| `skipFiles` | 删除上游独有文件（桌面端、SaaS、翻译 README 等） |
| `package-names` | `opencode-ai` → `@kilocode/cli` |
| `preserve-versions` | 保留 Kilo 的版本号 |
| `transform-i18n` | OpenCode → Kilo 品牌字符串替换 |
| `transform-take-theirs` | UI 组件品牌化（无逻辑变更） |
| `transform-package-json` | 包名、依赖注入 |
| `transform-scripts` | GitHub API 引用替换 |
| `transform-extensions` | Zed 等扩展品牌化 |
| `transform-web` | 文档品牌化 |
| `keep-ours` | 重置 Kilo 独有文件 |

**关键洞察**：因为品牌化转换在合并**之前**完成，两个分支的品牌字符串已经一致，git 不会产生品牌差异冲突。最终只剩**真正有代码逻辑差异**的文件需要手动处理。

### 第 7 步：自动解决工具链

合并后，对残留冲突按优先级自动处理：

1. **`mergiraf`** — 语法感知合并工具，处理 import 重组、JSON/YAML/TOML 结构冲突
2. **`git rerere`** — 从历史合并中学习冲突解决方案，自动重放
3. **分类转换** — i18n、品牌文件、package.json、脚本、扩展、web 文档
4. **`kilocode_change` 标记检测** — 有标记的文件标记为需人工审查

## 三、支撑体系

### `kilocode_change` 标记系统（三层机制）

标记系统的运作依赖 **人工 + 工具 + CI** 三层：

**第一层：开发时人工添加**。日常开发中，开发者在共享文件中手动添加标记，遵循 `.kilo/skills/kilocode-merge-minimizer/SKILL.md` 规范：

```ts
const value = 42 // kilocode_change

// kilocode_change start
registerKiloFeature(app)
// kilocode_change end
```

对于全新文件：`// kilocode_change - new file`

**第二层：工具修复/重建**。当标记过时、缺失或范围不准确时：

- **`fix-kilocode-markers.ts`**（104 行）— 对单个文件对比上游版本，自动剥离旧标记并重建新标记
- **`find-reset-candidates.ts`**（414 行）— 批量扫描共享文件，自动分类漂移程度：
  - `markers-only`：内容与上游完全一致，仅多了标记 → 自动重置
  - `cosmetic-only`：仅空格/换行差异 → 自动重置
  - `small-diff`：≤5 行非标记差异 → 自动重置
  - `large-diff`：更多差异 → 跳过，需人工审查
- **`reset-to-upstream.ts`**（97 行）— 将单个文件重置为上游转换后版本

**第三层：CI 验证**。`check-opencode-annotations.ts`（291 行）在 PR 时检查：所有共享文件的 Kilo 特有改动是否都有 `kilocode_change` 标记。缺失标记的 PR 被 CI 拦截。

### 合并冲突最小化原则（日常开发纪律）

来自 `.kilo/skills/kilocode-merge-minimizer/SKILL.md`：

- Kilo 特有代码优先放 `packages/opencode/src/kilocode/` 等专属目录（10 个专属目录）
- 共享文件只放最小注入点（import + 调用），业务逻辑外提
- 不重构上游代码结构，不重命名、不拆文件
- 保持上游格式和 import 风格
- 加性功能提取到专属目录，修改上游行为则内联标记

### 配置驱动

`utils/config.ts` 集中管理所有合并策略：

```ts
keepOurs: ["README.md", "AGENTS.md", ...]     // 永远保留 Kilo 版本
skipFiles: ["packages/desktop/**", ...]         // 永远删除
takeTheirsAndTransform: ["packages/ui/**", ...] // 取上游 + 品牌转换
kiloDirectories: ["packages/opencode/src/kilocode", ...] // Kilo 专属目录（免标记）
```

### 其他支撑机制

- **`.opencode-version`** — 记录上次合并的上游 tag，供工具链定位基线
- **`merge.conflictStyle=zdiff3`** — 冲突标记包含共同祖先，mergiraf 和手动解决都依赖此格式
- **worktree 参考快照** — 自动创建三个 worktree（上游原始版、Kilo 基线、自动合并结果），供人工审查时参考
- **Bun 版本安全** — 合并后验证 `packageManager` 版本不低于任一方，防止上游降级
- **git rerere 训练** — 从历史合并 commit 中学习冲突解决方案，`merge.ts` 启动时自动训练

## 四、与 Ellamaka 现状对比

| 维度 | Kilocode | Ellamaka |
|------|----------|----------|
| **合并方式** | 自动化脚本（~11,300 行工具链） | 手动 Plan 驱动 |
| **预转换** | ✅ 合并前转换上游分支 | ❌ 无 |
| **品牌常量** | 分散在共享文件中 | 集中在 `packages/ellamaka/branding.ts` |
| **变更标记** | `kilocode_change`（人工+工具+CI 三层） | 无 |
| **冲突自动解决** | mergiraf + rerere + 分类转换 | 手动逐文件解决 |
| **文件保护** | 配置驱动 `keepOurs` | `.gitattributes merge=ours` |
| **专属目录** | `packages/opencode/src/kilocode/` 等 10 个 | `packages/ellamaka/` 1 个 |
| **合并后验证** | CI 自动检查标记完整性 | 手动 grep 验证 |
| **版本追踪** | `.opencode-version` 文件 | `UPSTREAM-MERGE-LOG.md` |
| **漂移重置** | `find-reset-candidates.ts` 批量工具 | 无 |
| **典型冲突数** | 个位数（仅代码逻辑差异） | 329 个（v1.15.13） |

## 五、Ellamaka 的合并痛点根因

1. **没有预转换**：上游的 "OpenCode" 字符串和 ellamaka 的 "Ellamaka" 字符串被 git 视为冲突，而这些冲突本可以通过预转换消除
2. **没有变更标记**：无法区分"有意的 ellamaka 改动"和"无意的漂移"，每次合并都要重新判断
3. **没有自动解决**：modify/delete 冲突（~300 个）本可以自动 `git rm`，但每次都要手动处理
4. **没有漂移管理**：共享文件中与上游差异微小的文件越积越多，增加合并负担

## 六、工具清单与移植评估

Kilocode 的完整工具链位于 `labs/research/kilocode/script/upstream/`，总计 ~11,300 行 TypeScript，分为以下几类：

### 可直接移植的工具（仅需全局替换关键词）

这些工具的代码逻辑与品牌无关，只需要把 `kilocode_change` → `ellamaka_change`、`kilo` → `ellamaka` 等标识符全局替换即可。

| 源文件 | 行数 | 功能 | 移植要点 |
|--------|------|------|----------|
| `utils/markers.ts` | 448 | 标记解析、清理、注释风格检测、diff 计算、标记重建核心逻辑 | 替换 `kilocode_change` → `ellamaka_change`，`kilo-` → `ellamaka-` |
| `utils/reset.ts` | 136 | 单文件重置 + 漂移分类（10 种 bucket） | 替换标识符 |
| `utils/upstream.ts` | 211 | 上游版本追踪（`.opencode-version` 读写）、文件读取、批量 blob size 查询、品牌转换管线 | 替换 `.opencode-version` → `.ellamaka-version`，`anomalyco/opencode` → `anomalyco/opencode`（不变），workflow 仓库引用替换为 ellamaka 的 |
| `utils/logger.ts` | ~50 | 彩色日志输出（step/header/success/warn/error/list/divider） | 零改动 |
| `utils/version.ts` | ~80 | 版本号解析、排序 | 零改动 |
| `utils/git.ts` | 512 | Git 操作封装（fetch/merge/branch/commit/rerere/worktree 等） | 替换分支命名约定中的 `kilo` → `ellamaka` |
| `utils/match.ts` | ~50 | Glob 模式匹配 | 零改动 |
| `fix-kilocode-markers.ts` | 104 | 单文件标记修复 CLI | 替换关键词，重命名为 `fix-ellamaka-markers.ts` |
| `reset-to-upstream.ts` | 97 | 单文件重置 CLI | 替换关键词 |
| `find-reset-candidates.ts` | 414 | 批量漂移检测 + 自动重置 CLI | 替换关键词，调 `--review-limit` 阈值 |
| `list-versions.ts` | ~60 | 列出版本 CLI | 替换 remote 检查逻辑 |
| `find-conflict-markers.sh` | ~20 | Shell 脚本：检测残留冲突标记 | 零改动 |
| **小计** | **~2,200** | | |

### 需要适配的工具（品牌/配置映射不同）

这些工具的核心逻辑可复用，但需要根据 ellamaka 的实际情况调整配置映射和品牌替换规则。

| 源文件 | 行数 | 功能 | 适配要点 |
|--------|------|------|----------|
| `utils/config.ts` | 246 | 合并策略配置中心 | 改为 ellamaka 的 `keepOurs`、`skipFiles`、`ellamakaDirectories` 等映射。**当前 ellamaka 的 [`BRANDING.md` 项目精简](../BRANDING.md#项目精简 已有完整精简清单，可直接翻译为配置** |
| `utils/report.ts` | 377 | 冲突分析报告生成（Markdown） | 替换品牌名、分支命名 |
| `utils/worktree.ts` | ~80 | Worktree 参考快照管理 | 替换路径命名 |
| `transforms/package-names.ts` | 186 | 包名字符串替换（`opencode-ai` → `@kilocode/cli`） | ellamaka **不改变包名**（保持 `opencode-ai` 等），此文件简化为空操作或移除 |
| `transforms/preserve-versions.ts` | 149 | 保留 Kilo 版本号 | 适配 ellamaka 版本号来源 |
| `transforms/keep-ours.ts` | ~120 | keep-ours 文件重置逻辑 | 指向 ellamaka 的配置 |
| `transforms/skip-files.ts` | 217 | skip 文件删除逻辑 | 指向 ellamaka 的配置 |
| `transforms/transform-i18n.ts` | 366 | i18n 品牌字符串替换（OpenCode → Kilo） | 替换为 OpenCode → Ellamaka |
| `transforms/transform-take-theirs.ts` | 320 | 品牌文件转换（取上游 + 替换品牌字符串） | 替换品牌字符串映射 |
| `transforms/transform-package-json.ts` | 1080 | package.json 深度转换（名称、依赖注入、Bun 版本协调） | ellamaka **不改变包名**，此文件可大幅简化 |
| `transforms/transform-scripts.ts` | 260 | 脚本文件转换（GitHub API 引用） | 适配 ellamaka 的 GitHub 仓库引用 |
| `transforms/transform-extensions.ts` | 294 | 扩展文件转换 | 适配或移除（ellamaka 无需扩展） |
| `transforms/transform-web.ts` | 296 | Web/文档文件转换 | 适配或移除 |
| `transforms/lock-files.ts` | 162 | Lock 文件冲突解决 | 零改动（逻辑通用） |
| `codemods/transform-imports.ts` | 190 | AST 级 import 语句转换（依赖 ts-morph） | ellamaka 不改变包名，可简化或移除 |
| `codemods/transform-strings.ts` | 186 | AST 级字符串字面量转换（依赖 ts-morph） | 替换品牌字符串 |
| `analyze.ts` | 197 | 独立冲突分析 CLI | 替换配置和品牌引用 |
| `opencode-changesets.ts` | 285 | 上游 Release Notes → changeset 生成 | 适配 ellamaka 的 changeset 包名 |
| `merge.ts` | 957 | **核心编排脚本**：8 步完整合并流程 | 最大适配项。替换所有品牌引用、配置路径、分支命名约定。ellamaka 不需要的部分（SDK 重新生成、扩展、web）可移除 |
| `index.ts` | 70 | 模块导出汇总 | 替换导出路径 |
| **小计** | **~5,700** | | |

### 外部依赖

| 依赖 | 用途 | 安装方式 |
|------|------|----------|
| `mergiraf` | 语法感知合并（import/JSON/YAML/TOML 结构冲突） | `brew install mergiraf` |
| `ts-morph` | AST 级代码转换（codemods） | `bun add ts-morph` 到 `script/upstream/package.json` |
| `bun` | 脚本运行时 | 已有 |

### CI 检查

| 源文件 | 行数 | 功能 | 移植要点 |
|--------|------|------|----------|
| `script/check-opencode-annotations.ts` | 291 | CI：检查共享文件改动是否有标记 | 替换 `kilocode_change` → `ellamaka_change`，免检路径映射 |

### Git 配置

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `merge.conflictStyle` | `zdiff3` | 冲突标记包含共同祖先，mergiraf 依赖此格式 |
| `rerere.enabled` | `true` | 启用冲突解决方案记录与重放 |
| `.gitattributes` | 无需 `merge=ours` | 改由配置驱动 `keepOurs` 替代 |

### 不需要移植的部分

以下 Kilocode 特有功能 ellamaka 不需要：

- **包名转换**（`package-names.ts`、`transform-imports.ts`）：ellamaka 保持 `opencode-ai` 等上游包名不变
- **扩展转换**（`transform-extensions.ts`）：ellamaka 无 Zed/VS Code 扩展
- **Web 文档转换**（`transform-web.ts`）：ellamaka 无 kilo-docs 网站
- **changeset 生成**（`opencode-changesets.ts`）：可选，ellamaka 发布流程不同
- **SDK 重新生成**：ellamaka 目前不需要
- **workflow allowlist 检查**：ellamaka CI 流程不同
- **Effect facade ratchet 检查**：ellamaka 无此约束

## 七、一次性实施计划

### 总体工作量估算

| 类别 | 行数 | 工作内容 |
|------|------|----------|
| 直接移植 | ~2,200 | 全局替换关键词 + 路径调整 |
| 需要适配 | ~5,700 | 配置映射重写 + 品牌替换规则定制 + 不必要的功能裁剪 |
| CI 检查 | ~290 | 关键词替换 |
| Git 配置 | 0 | 一次性配置命令 |
| 外部依赖 | 0 | `brew install` + `bun add` |
| **总计** | **~8,200** | 估计 2-3 个工作日 |

### 实施步骤

#### 第一阶段：基础设施（2-4 小时）

1. 创建 `projects/ellamaka/script/upstream/` 目录结构
2. 复制 `package.json` 并安装依赖（`ts-morph`）
3. 移植 `utils/` 下全部文件（logger、version、git、match、markers、reset、upstream、config、report、worktree）
4. 全局替换关键词：`kilocode_change` → `ellamaka_change`、`kilo` → `ellamaka`、`Kilo` → `Ellamaka`、`.opencode-version` → `.ellamaka-version`
5. 编写 `utils/config.ts` 的 ellamaka 配置：
   - `keepOurs`：从 [`BRANDING.md` 项目精简](../BRANDING.md#项目精简 "保留文件" + 现有 `.gitattributes merge=ours` 翻译
   - `skipFiles`：从 [`BRANDING.md` 项目精简](../BRANDING.md#项目精简 "已删除目录/文件" 翻译
   - `takeTheirsAndTransform`：ellamaka 范围较窄（无 kilo-ui/kilo-vscode 等），仅需少量文件
   - `ellamakaDirectories`：`packages/opencode/src/ellamaka/`、`packages/ellamaka/`、`packages/ellamaka-app/`、`script/upstream/`
   - `packageMappings`：**空数组**（ellamaka 不改变包名，这是与 Kilocode 最大的区别）
   - `upstreamRemote`：`upstream`（指向 `anomalyco/opencode`）
6. 配置 Git：
   ```bash
   git config merge.conflictStyle zdiff3
   git config rerere.enabled true
   ```
7. 创建 `.ellamaka-version` 文件，写入当前已合并的上游版本（如 `v1.15.13`）
8. 安装 `mergiraf`：`brew install mergiraf`

#### 第二阶段：转换器适配（4-6 小时）

9. 移植 `transforms/skip-files.ts` — 指向 ellamaka 配置
10. 移植 `transforms/keep-ours.ts` — 指向 ellamaka 配置
11. 移植 `transforms/preserve-versions.ts` — 适配 ellamaka 版本号来源
12. 移植 `transforms/transform-i18n.ts` — 替换品牌字符串：`OpenCode` → `Ellamaka`
13. 移植 `transforms/transform-take-theirs.ts` — 替换品牌字符串映射
14. 简化 `transforms/package-names.ts` — 空操作（ellamaka 不改变包名）
15. 简化 `transforms/transform-package-json.ts` — 移除 Kilo 依赖注入逻辑，保留 Bun 版本协调
16. 移植 `transforms/transform-scripts.ts` — 适配 ellamaka 的 GitHub 仓库引用
17. 移植 `transforms/lock-files.ts` — 零改动
18. 移除 `transforms/transform-extensions.ts` 和 `transforms/transform-web.ts`（ellamaka 不需要）
19. 评估是否保留 `codemods/`（AST 级转换）：ellamaka 品牌字符串较少，文本替换可能足够，暂跳过 ts-morph 依赖以降低复杂度

#### 第三阶段：CLI 工具移植（2-3 小时）

20. 移植 `fix-kilocode-markers.ts` → `fix-ellamaka-markers.ts`
21. 移植 `reset-to-upstream.ts`
22. 移植 `find-reset-candidates.ts`
23. 移植 `list-versions.ts`
24. 移植 `analyze.ts`
25. 移植 `find-conflict-markers.sh`

#### 第四阶段：核心编排脚本适配（4-6 小时）

26. 适配 `merge.ts`（957 行）— 最大工作量：
    - 替换所有品牌/配置/分支引用
    - 移除不需要的步骤（SDK 重新生成、扩展转换、web 转换）
    - 适配分支命名约定（`<author>/kilo-opencode-<version>` → `<author>/ellamaka-opencode-<version>`）
    - 适配提交消息格式
    - 适配 worktree 路径
    - 保留：环境验证、版本确定、冲突分析、分支创建、预转换、合并、冲突自动解决、lock 文件再生

#### 第五阶段：CI + 清理（1-2 小时）

27. 移植 `check-opencode-annotations.ts` → `script/check-ellamaka-annotations.ts`
28. 更新 `AGENTS.md` 和 `AGENTS.zh-CN.md`，添加合并工具使用说明
29. 更新 `BRANDING.md`，添加 `ellamaka_change` 标记规范
30. 创建 `script/upstream/README.md`
31. 首次运行 `fix-ellamaka-markers.ts` 对所有现有共享文件改动添加标记
32. 运行 `find-reset-candidates.ts` 清理漂移文件
33. 用 `merge.ts --dry-run --version v1.15.13` 验证工具链完整性（因为 v1.15.13 已合并，dry-run 应显示无冲突或极少冲突）

#### 第六阶段：日常开发纪律落地

34. 创建 `docs/ELLAMAKA_CHANGE_MARKERS.md`（标记规范文档，等价于 kilocode 的 `kilocode-merge-minimizer/SKILL.md`）
35. 在 ellamaka 的 `AGENTS.md` 中加入标记规范引用
36. 扩展专属目录：将 `config/wopal-space.ts`、TUI 品牌化逻辑等移入 `packages/opencode/src/ellamaka/`

## 八、与 Kilocode 的关键差异及简化点

Ellamaka 的情况比 Kilocode **更简单**，因此实施工作量比 Kilocode 的 ~11,300 行要少：

| 差异点 | Kilocode | Ellamaka | 简化效果 |
|--------|----------|----------|----------|
| **包名** | 需要大量替换（opencode→kilo 6种映射） | 不变 | 移除 `package-names.ts`、`transform-imports.ts`，大幅简化 `transform-package-json.ts` |
| **产品矩阵** | CLI + VS Code + JetBrains + Gateway + Telemetry + UI + Docs | 仅 CLI | 移除扩展/web 转换，精简 `takeTheirsAndTransform` |
| **品牌字符串** | 分散在共享文件中 | 集中在 `packages/ellamaka/branding.ts` | 品牌注入点更少，标记范围更窄 |
| **精简目录** | ~40 条 skipFiles 规则 | ~20 条（[`BRANDING.md` 项目精简](../BRANDING.md#项目精简 已有完整清单） | 配置更简单 |
| **专属目录** | 10 个 | 3-4 个（ellamaka + ellamaka-app + opencode/src/ellamaka + upstream） | 免检范围更小 |
| **CI 复杂度** | 5+ 个检查 | 1 个（`check-ellamaka-annotations.ts`） | 验证更简单 |

**预计最终 ellamaka 工具链规模**：~5,000-6,000 行（比 Kilocode 减半）。

## 九、可行性评估

Kilocode 的方案**完全可行且高度合理**。核心逻辑清晰：

> 合并困难的本质是"两个分支对同一段代码做了不同修改"。如果能把一方的修改"翻译"成另一方的语言，冲突就消失了。预转换就是这个翻译过程。

**一次性复刻的可行性很高**，原因：
1. 所有源码在 `labs/research/kilocode/script/upstream/` 中可直接参考
2. ellamaka 的定制比 Kilocode 少，工具链可以大幅简化
3. 品牌常量已集中管理，标记范围天然更窄
4. [`BRANDING.md` 项目精简](../BRANDING.md#项目精简 已有完整的精简/保留清单，直接翻译为配置即可
5. 两个项目使用相同的上游（`anomalyco/opencode`），`upstream` remote 无需改变
6. 包名不变，消除了最复杂的转换逻辑

**一次性实施优于分阶段**，原因：
1. 工具链内部高度耦合（`merge.ts` 依赖所有 transforms 和 utils）
2. 分阶段会产生中间态问题：部分工具有、部分没有，反而增加维护负担
3. 首次一次性标记所有共享文件改动，后续只需增量维护
4. 全部就位后，下次合并即可享受 90%+ 冲突自动解决的收益

## 十、参考资料

- Kilocode 合并工具链：`labs/research/kilocode/script/upstream/`（~11,300 行）
- Kilocode 合并配置：`labs/research/kilocode/script/upstream/utils/config.ts`
- Kilocode 标记工具：`labs/research/kilocode/script/upstream/utils/markers.ts`（448 行）
- Kilocode 漂移分类：`labs/research/kilocode/script/upstream/utils/reset.ts`（136 行）
- Kilocode 合并最小化技能：`labs/research/kilocode/.kilo/skills/kilocode-merge-minimizer/SKILL.md`
- Kilocode 合并文档：`labs/research/kilocode/script/upstream/README.md`
- Kilocode CI 注释检查：`labs/research/kilocode/script/check-opencode-annotations.ts`（291 行）
- Ellamaka 品牌化设计：`projects/ellamaka/docs/BRANDING.md`
- Ellamaka 合并记录：`projects/ellamaka/docs/UPSTREAM-MERGE-LOG.md`