# Ellamaka — Distribution

> **Status**: Active
> **Updated**: 2026-10-14
> **Parent Architecture**:
>
> - `../../../docs/products/wopal-space/DESIGN-distribution.md`（产品级分发总设计）
> - `../../../docs/products/wopal-space/DESIGN-onboarding.md`
>   **Parent**: `./DESIGN.md`

本文件是 Ellamaka 产品分发与版本身份的唯一真相源。它定义 Ellamaka CLI 与 Desktop 的 release backbone、产品 SemVer、构建身份、manifest 契约、兼容规则、不可变发布与更新授权。产品级通用规则（WOPAL_HOME、R2 bucket/URL/缓存、归档格式、跨产品协调总则）见 `../../../docs/products/wopal-space/DESIGN-distribution.md`，本文只保留 ellamaka 特有语义。

---

## Scope

Ellamaka CLI 与 Desktop 分别发布为独立制品，使用各自的 SemVer、namespaced tag、workflow、R2 latest 和回滚边界。产品安装、补齐、修复和跨产品 inventory 继续由 Wopal CLI Product 能力拥有；Ellamaka Runtime/WopalSpace Setup 不承担 product completion。

Release identity 必须回答三个互不混淆的问题：

1. 这是哪个 Ellamaka 产品的哪个版本？
2. 它属于哪个发布 channel？
3. 它由哪个 Ellamaka commit、tag 和构建生成？

### Product Boundaries

- **Ellamaka CLI**（`ellamaka-cli`）是可独立安装的 Engine/CLI 产品，支持 Wopal 完整安装、cli-only 安装和手动下载。其 SemVer 表达 CLI 与 Engine 公共契约的演进。
- **Ellamaka Desktop**（`ellamaka-desktop`）是原生 Electron 产品，拥有独立的 UI、平台集成、签名、公证、自动更新、stable/beta channel 和回滚边界。其 SemVer 不随 CLI 的每次修复锁步递增。
- **Embedded Sidecar** 是从当前 Ellamaka source commit 构建的 Node runtime，不是外部 CLI binary，也不是第三个面向用户的发布产品。Desktop manifest 记录 sidecar 的 Ellamaka source commit 和 engine API，但不为它创建第三套 SemVer。

共享 Engine 源码发生变化时，CLI 与 Desktop 可能需要协调发布；协调发布不要求二者版本相同。

---

## Release Backbone

ellamaka 是 OpenCode 的 fork，构建与发布体系由 `@wopal/ellamaka-release` 包集中承载：`packages/ellamaka-release/src/cli/build.ts` 注入品牌（`BINARY_NAME=ellamaka`，import 自 `@wopal/ellamaka-brand`）与裁剪，构建期版本/渠道解析由同包 `build-env` 模块提供。对上游的裁剪仅限于：

- **平台裁剪**：`--arch primary` 构建 8 个平台（5 native + 3 baseline），排除 musl、Windows arm64 变体；baseline 兼容不支持 AVX2 的老 x64 CPU。
- **发布位置**：binary 只存放在 Cloudflare R2；GitHub/Gitee Release 只保留下载索引。

canonical release source：Cloudflare R2（`https://download.coursedao.com/ellamaka/`）是唯一 binary 分发源；`wopal-cn/ellamaka` 与 `wopal-cn/wopal-space-ontology` 的 GitHub/Gitee Releases 仅保留 markdown 索引页面，不携带 binary 附件。

canonical consumers：Wopal CLI Product 读取本文定义的 manifest/ReleaseIdentity 完成显式产品安装与补齐；external CLI 的日常更新由 `ellamaka upgrade` 负责，Desktop 的日常更新由自身 auto-updater 负责；GUI Onboarding 不安装产品。人工下载从 Release 页面进入 R2。

### 平台矩阵

| OS      | Arch  | Variant        | Artifact                              |
| ------- | ----- | -------------- | ------------------------------------- |
| macOS   | arm64 | native         | `ellamaka-darwin-arm64.tar.gz`        |
| macOS   | x64   | native         | `ellamaka-darwin-x64.tar.gz`          |
| macOS   | x64   | baseline       | `ellamaka-darwin-x64-baseline.tar.gz` |
| Linux   | arm64 | glibc          | `ellamaka-linux-arm64.tar.gz`         |
| Linux   | x64   | glibc          | `ellamaka-linux-x64.tar.gz`           |
| Linux   | x64   | glibc-baseline | `ellamaka-linux-x64-baseline.tar.gz`  |
| Windows | x64   | native         | `ellamaka-windows-x64.zip`            |
| Windows | x64   | baseline       | `ellamaka-windows-x64-baseline.zip`   |

Contract：

1. archive 内的 binary 名称固定为 `ellamaka` / `ellamaka.exe`，consumer 依赖稳定文件名。
2. `manifest.json` 是 installer 的机器可读入口，其中 `url` 指向 R2 自定义域名；`checksumsUrl` 指向同版本 `checksums.txt`。
3. `checksums.txt` 与 `release-notes.md` 作为元数据文件与 artifacts 一同发布到 R2。
4. 归档格式与 wopal-cli 对齐：macOS / Linux 使用 `.tar.gz`，Windows 使用 `.zip`。
5. release build 的 build channel 为 `stable`（`@wopal/ellamaka-brand` 的 `branding.ts:CHANNEL_RELEASE`）；本地开发 build channel 为 `main`（`CHANNEL_DEV`，build.sh 默认）与 `local`（dev.sh）。`latest` 只是 R2 feed 别名（`ellamaka/latest/`），不是通道值。

### 构建接口

`@wopal/ellamaka-release` 的 `build-env` 模块（原 `@wopal/ellamaka-script` 的 `Script`，2026-09-01 收编）仍作为 CLI 构建接口使用，但注入的是已经由 release context 验证的 Ellamaka CLI 产品版本：

| 环境变量            | 作用             | 约束                                                                                                              |
| ------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ELLAMAKA_VERSION`  | 产品版本注入     | release build 必须等于 namespaced tag 中的产品版本                                                                |
| `ELLAMAKA_RELEASE`  | release 模式开关 | wrapper 拦截上游 tag/GitHub Release 副作用，正式 tag 与 publication 只由 workflow 拥有                            |
| `ELLAMAKA_CHANNEL`  | build channel    | 取值限于 `{stable, beta, main, local}`（[Build Channels](#build-channels)）；未设置时按 Build Channels 决策树推导 |
| `ELLAMAKA_BUILD_ID` | 构建指纹         | 注入打包产物（Desktop build version），取 commit SHA                                                              |
| `BINARY_NAME`       | 产物名前缀       | 构建时替换所有硬编码 `"opencode"`，控制输出目录名、binary 名、archive 名                                          |

这些变量是 Ellamaka 构建接口，由 `build-env` 单点解析，不是 Ellamaka release identity 的权威存储。完整版本、channel 和 build identity 由 [Version Identity](#version-identity)、[Release Workflow](#release-workflow) 与生成的 `release-context.json` 约束。

---

## Version Identity

### SemVer 子集

Ellamaka 发布的 `version` 遵循 SemVer 2.0：

- MAJOR：Ellamaka 对外公共契约发生不兼容变化。
- MINOR：新增向后兼容能力，或完成较大的向后兼容能力演进。
- PATCH：向后兼容的 bug、安全或兼容性修复。
- prerelease：Desktop 使用 `-beta.N`；CLI 使用 `-rc.N`（release candidate）。

发布版本格式：

```text
CLI stable:   X.Y.Z
CLI rc:       X.Y.Z-rc.N
Desktop beta: X.Y.Z-beta.N
Desktop stable: X.Y.Z
```

CLI rc 与 stable 使用同一 tag namespace、R2 versioned path、latest feed 和 Release 页面；`-rc.N` 只是标准 SemVer prerelease。归档的 `X.Y.Z-N.rcM` 格式只由兼容 reader 识别，不进入当前发布序列。rc 一经提交同样不可变。

发布版本禁止 `+build` metadata：build metadata 不参与 precedence，允许它会产生两个不同构建排序相等的问题。构建信息统一放入结构化 `build` 字段。

### 设计原则

1. **产品版本独立**：CLI 与 Desktop 是两个独立发布单元，各自使用标准 SemVer 2.0、tag、workflow、latest feed 和 changelog，版本序列互不牵制（cli 可发 `2.0.6-rc.1` 而 desktop 仍停在 `2.0.5-beta.N`）。
2. **已成功发布的 tag 记录是版本推进依据**：每产品的下一个版本由该产品已发布的最高记录按 semver 推断，不读仓库 package.json 里"上次写了什么"。发布成功即打 tag 记录、不可变；失败/中断不构成记录，可同版本重发。cli/desktop 的 package.json 平时不承载 rc/beta"候选状态"，只在发布动作内写入本次版本。
3. **一个公开 service SDK**：private `@wopal/wopalspace` 留在 workspace 内，不作为 consumer package 发布；`@wopal/ellamaka-sdk` 同时发布 Runtime 与 WopalSpace public contract，并在 `/local` 中组装 trusted-local Worker 所需 private implementation。发布 tarball 不保留对 private package 的 npm runtime dependency。
4. **上游来源不进入产品身份**：OpenCode 只作为选择性 fix/功能来源；具体来源由 Git 变更记录追踪，不进入 release identity 或版本排序，也不定义 Ellamaka SDK 的公开兼容边界。
5. **CLI/Desktop 没有机器全局版本门禁**：组件可独立安装/更新，stable/beta/development/dormant 版本可以共存。Host 可以一次选择多个 component 以提升用户便利性，但每个 artifact 独立验证和提交。DSH activation 安全只由实际 target closure Home version and backup check 决定。
6. **一个排序真相源**：发布顺序只比较 `releaseIdentity.version`。build date、Git hash 和 artifact hash 都不参与排序。
7. **提交后不可变**：有效 versioned manifest 是正式发布提交点；提交后同一个 `product + version` 只能对应一个 source tag、一个 Ellamaka commit 和一组固定 artifact hashes。
8. **归档格式只读兼容**：reader 可以识别 `X.Y.Z-N` 等归档版本；当前 publisher 只生成标准 SemVer 与 Manifest Schema v2。
9. **会改变 DSH 持久行为的重大 closure 变更至少提升 Ellamaka MINOR**：这是发布纪律，不是 Home 兼容判据。Core 只按实际 `closureVersion` 执行 Home generation 协议。

### OpenCode Reference Policy

ellamaka 不维护可升级的 OpenCode release baseline。`labs/ref-repos/opencode/` 是只读参考源；需要的安全修复、bug fix 或功能按变更逐项 review 后 cherry-pick 或手工移植。

选择性吸收遵循以下约束：

1. 只引入当前 Ellamaka 需要的行为及其必要依赖，不整体同步 OpenCode release。
2. 每个引入变更都按 Ellamaka 当前 Engine、SDK、Desktop 与 Plugin contract 做影响检查。
3. 来源信息由 Git commit、cherry-pick 元数据或提交说明保留；产品 manifest 不声明单一 OpenCode version/commit。
4. Ellamaka 自身的 source commit 是发布构建的完整源码身份。

### Release Context

每个 workflow checkout 精确 product tag 后，先生成一次 `release-context.json`，CLI/Desktop build、manifest、release notes 和上传步骤全部读取同一文件：

```text
product/version/channel  ← namespaced tag
build.gitCommit          ← checked-out release commit
build.builtAt            ← UTC release-context assembly time
artifacts                ← build outputs + SHA-256
```

workflow input 不能作为 version 的第二真相源。re-release 的 dispatch 输入只能被 anchor match gate 断言等于产品锚点文件（版本真相源），不能覆盖 tag 或锚点。CLI 与 Desktop 各自生成并在自身 matrix 内共享 context，不要求两个产品复用同一 context 文件。

---

## Release Workflow

### Tags 与 Channels

产品 tag 使用独立命名空间：

```text
ellamaka-cli-v1.17.1
ellamaka-cli-v2.0.4-rc.1
ellamaka-desktop-v1.16.2
ellamaka-desktop-v1.17.0-beta.1
```

禁止再创建通用 `vX.Y.Z` Ellamaka tag，避免与 OpenCode 上游 tag 冲突。CLI 与 Desktop workflow 独立触发、独立 checkout tag、独立发布和回滚。

### Build Channels

通道（channel）回答一个问题：这份产物由谁构建、供谁使用。整个体系只承认一个通道词汇表，由 Release Identity 拥有（`packages/ellamaka-release/src/identity.ts`）：

```text
发布通道:
  stable   正式发布。CLI 接受 X.Y.Z 与 X.Y.Z-rc.N；Desktop 接受纯 X.Y.Z。
  beta     Desktop beta 发布，接受 X.Y.Z-beta.N。CLI 无此通道。

开发通道:
  main     本地构建（scripts/build.sh 的默认通道）。
  local    源码直接运行（scripts/dev.sh）。
```

通道词汇表是闭合的：任何产物、构建注入、manifest、feed 与判定逻辑都只使用上述四个值，不存在第五个通道值。通道与构建身份（kind）的绑定是单向的：release 产物只能取发布通道，开发通道只出现在开发构建；反向不成立——Desktop 本地打包可以选用 stable/beta 构建发布形状的应用用于手动验证，其身份仍为 development、不内嵌 release identity。`prod` 不是通道值——它只作为 electron-builder 的 publish feed 名与 updater feed 路径词汇存在，映射到 `stable`；`latest` 只作为 R2 feed 别名存在，映射到对应产品发布通道的最新版本（`ellamaka/latest/`、`ellamaka-desktop/latest/`）。feed 名与通道值的映射由 identity 模块单一持有（`FEED_TO_CHANNEL`），任何代码不得自建映射。

**单一注入点**：构建通道经单一环境变量 `ELLAMAKA_CHANNEL`（构建接口族，与 `ELLAMAKA_VERSION`/`ELLAMAKA_RELEASE` 同族）传入，取值限于 `{stable, beta, main, local}`，由 `build-env` 模块统一解析：

```text
发布构建（ELLAMAKA_RELEASE 已设置）
  → 通道由版本形状决定：X.Y.Z-beta.N → beta，其余（X.Y.Z、X.Y.Z-rc.N）→ stable。
    已设置的 ELLAMAKA_CHANNEL 必须与推导结果一致，不一致即构建失败。

本地构建（ELLAMAKA_RELEASE 未设置）
  → 通道由调用方显式传入：CLI 接受 main | local，Desktop 接受 main | beta | stable。
    未传入时，git 分支为 main 取 main，其余取 local。
```

CLI 的发布注入据此实现为 `build.ts` 的 `Script.release ? CHANNEL_RELEASE : Script.channel`（`CHANNEL_RELEASE = "stable"`）；Desktop 的发布构建由 workflow 显式传入通道并与 tag 版本形状校验一致。运行时从 define 读取通道（`InstallationChannel` / Desktop `CHANNEL`），并按下面两张契约表消费，禁止在业务代码中直接书写通道字面量比较。

**CLI 通道契约**（`packages/opencode/src/cli/upgrade.ts`）：

| build channel | 升级检查                     | 数据库              | 行为                                                                                            |
| ------------- | ---------------------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `stable`      | 参与（SemVer 对比 CDN feed） | `ellamaka.db`       | 发布通道：自动升级与提示按 [Update Authorization](#update-authorization) 与 autoupdate 配置执行 |
| `main`        | 不参与                       | `ellamaka-main.db`  | 本地构建：静默跳过，不请求 CDN、不提示、不自动升级                                              |
| `local`       | 不参与                       | `ellamaka-local.db` | dev.sh 源码运行：同上                                                                           |

**Desktop 通道契约**（`src/main/constants.ts`、`updater.ts`、`electron-builder.config.ts`）：

| build channel | updater                 | feed                            | appId                      |
| ------------- | ----------------------- | ------------------------------- | -------------------------- |
| `stable`      | 启用                    | `ellamaka-desktop/latest/`      | `ai.ellamaka.desktop`      |
| `beta`        | 启用（allowPrerelease） | `ellamaka-desktop/beta/latest/` | `ai.ellamaka.desktop.beta` |
| `main`        | 禁用                    | —                               | `ai.ellamaka.desktop.main` |
| `local`       | 禁用                    | —                               | 开发态动态分配             |

升级参与判定是通道契约表的一行：CLI 以 `isUpdateChannel(channel)` 表达"该通道是否参与升级检查"，其唯一真值为 `stable`；Desktop 以 `UPDATER_ENABLED` 表达同一语义。两者都是契约表的直接投影，修改通道行为只改契约表。

发布是一步制（脚本 `scripts/release-cli.sh` / `scripts/release-desktop.sh`）：版本准备与发布触发在同一脚本内完成，`--dry-run` 承担预演职责。

版本推断（`packages/ellamaka-release/src/version-line.ts`）以**已成功发布的 tag 记录**为版本推进唯一依据，两个产品独立计数。package.json 不承载"候选锚点"状态——发布的版本在发布动作内才写入，发布成功即成为记录：

1. 计算目标版本：读**该产品**已发布的最高记录（stable 最高版 + rc/beta 序列），按 `--patch`/`--minor`/`--major`/`--rc`/`--beta` 或显式版本推断，展示给用户确认：
   - rc/beta：该 base 已有同 kind 序列 → 续 N+1。该 base 已发 stable → 升下一 patch 的 `.1`（如 2.0.4 已发布 → `--rc` 给 `2.0.5-rc.1`）。
   - `--patch`（stable）：该产品无 stable 记录 → 取现行 rc/beta base 转正（`2.0.5-rc.2 → 2.0.5`）；已有 stable R → semver patch+1 直接发新正式版（`2.0.4 → 2.0.5`）。
   - minor/major：从该产品现行 base 升位开新线（`2.0.5 → 2.1.0` / `3.0.0`），通道重置。
2. 写入：把确认的目标版本写入该产品 package.json（带 `-rc.N`/`-beta.N` 或纯 `X.Y.Z`），产品内部支持模块（不含公开 SDK）统一镜像纯 base `X.Y.Z` = **两个产品现行 base 的较高者**；cli 先发 `2.0.6-rc.1` 时依赖包升 `2.0.6`，随后 desktop 仍可发 `2.0.5-beta.2`（只写 desktop，依赖包不动）。
3. 提交 bump、创建 namespaced tag（`ellamaka-cli-vX.Y.Z[-rc.N]` / `ellamaka-desktop-vX.Y.Z[-beta.N]`）、推送当前分支与 tag。tag push 触发目标 workflow（`push: tags`），不再手工 dispatch。
4. 监听 workflow 至完成，成功后自动触发历史清理。

Desktop 渠道为单开关模型：`--beta` 即 beta 通道（版本必然为 `X.Y.Z-beta.N`，发布到 `ellamaka-desktop/beta/`），缺席即 stable（版本必然为纯 `X.Y.Z`）；不存在独立 `--channel` 参数。

failed attempt 的 re-release（幂等）：目标 tag 在远端已存在时——有有效 R2 manifest 则拒绝（发布不可变，请用更高版本）；无 manifest 则按两种情况重发，均不重复 bump：

- **纯流程重试**（失败 tag 指向的 commit 仍是当前分支 HEAD）：以该 tag 为 `--ref` 重新 `workflow_dispatch`，tag 不移动。
- **source bug 自愈重试**（失败源于代码缺陷，已在其后提交修复，当前分支 HEAD 的产品版本文件已等于目标 VERSION）：脚本将失败 tag 重指到修复后的 HEAD 并 force-push（tag push 触发 `push: tags` workflow），构建修复代码。因失败 tag 从未写入有效 manifest，仍属 failed attempt，重指 tag 不违反不可变原则。

分支渠道约束（branch-channel policy）：

- `main`：CLI stable/rc 与 Desktop stable/beta 均可发布。
- 非 `main` 分支（特性分支等）：只允许 prerelease —— CLI `X.Y.Z-rc.N`、Desktop `X.Y.Z-beta.N`；禁止发布裸 `X.Y.Z`。该约束以**通道级预检**在版本推断之前执行：非 main 分支上 `--patch`/`--minor`/`--major`（stable 目标：候选转正或开新正式版）直接拒绝并提示切回 main；`--rc`/`--beta` 进入推断。dry-run 同样触发，让分支策略在发布计划第一屏显式可见。
- prerelease 的 base `X.Y.Z` 必须高于该产品已发布 stable 的最高版本：已发布 `2.0.3` 时，prerelease 从 `2.0.4-rc.1` / `2.0.4-beta.1` 开始，`2.0.3-rc.1` / `2.0.3-beta.1` 被拒绝。
- 版本单调：同类产品的全部发布（stable、rc、beta）处于同一单调递增序列。rc 占用 base slot 后，后续修复只能发更高版本（`2.0.5-rc.2`、`2.1.0`……），不能回退到已发 rc 的 base 之下。

bump 写入前校验：版本符合 SemVer 子集、version/channel 一致、branch-channel policy 满足、目标版本未列入 `release/withdrawn-versions.json` 且高于该产品已发布的最高标准版本、当前标准版本高于 [Archived Version Compatibility](#archived-version-compatibility) 规定的归档版本下限。OpenCode 来源不是发布版本输入；选择性吸收的 fix/功能已经体现在最终 Ellamaka source commit 中。

### 发布流程

**触发条件**：`push: tags`（前缀 `ellamaka-cli-v*` / `ellamaka-desktop-v*`）由 `scripts/release-cli.sh` / `scripts/release-desktop.sh` 一步制发布触发；`workflow_dispatch` 仅用于 failed-attempt re-release（`--ref <tag>`）与 CI dev 构建（`publish=false`）。所有 job 有 `if: github.repository == 'wopal-cn/ellamaka'` 仓库守卫。每个发布构建在最早阶段执行 anchor match gate：从 tag 解析的版本必须等于对应产品锚点 package.json 的 version，不一致即失败，任何构建都不会启动。

CLI rc 与 stable 走完全相同的 release job：同一 versioned path（`ellamaka/v<version>/`）、同一 latest promotion、同一 Release 页面。`-rc.N` 仅作为版本字符串进入 tag、build 注入与 manifest，任何步骤都不区分 rc 与 stable。

CLI 发布流程（release job）：

1. anchor match gate 已断言 tag 版本等于 `packages/ellamaka-cli/package.json`（[Tags 与 Channels](#tags-与-channels)）；release context 生成时校验 checkout commit、source tag 与本次 Ellamaka product/version/channel 一致。
2. 构建 CLI（`BINARY_NAME=ellamaka ELLAMAKA_VERSION=<ver> ELLAMAKA_RELEASE=true bun packages/ellamaka-release/src/cli/build.ts --arch primary --web-ui ellamaka-app`），产出 8 平台产物。
3. 运行 `bun packages/ellamaka-release/src/cli/manifest.ts manifest` 生成 `manifest.json`、`checksums.txt`、`release-notes.md`。
4. 按 manifest-last 提交点协议发布：staging 上传 → 回读校验 → 禁止覆盖写入 versioned path → 最后写 `manifest.json` 作为提交点（契约细节见 [构建接口](./DESIGN-distribution.md#构建接口)）。
5. CLI/Desktop immutable release 与 component latest/updater feed 独立提交和 promotion。每个 component 只校验自己的 immutable manifest、channel、平台与 ReleaseIdentity；stable/beta 可以跨 minor。多组件 UX 直接组合已经提交的 component manifests，release identity 与发布元数据继续按 component 独立。写入 mutable alias 后主动 purge CDN。
6. 创建 4 个 markdown-only release 条目（GitHub/Gitee × `wopal-cn/ellamaka`/`wopal-cn/wopal-space-ontology`），不挂 binary；ontology 仓库使用独立索引 tag/body，不复用 Ellamaka 产品 tag namespace。

Desktop 发布流程：matrix 构建（macos-latest 产 dmg+zip、windows-latest 产 NSIS、ubuntu-latest 产 AppImage+deb）。R2 上传、manifest 校验与 CDN purge 复用 CLI 的既有机制。

**重试状态**：tag 存在但没有有效 versioned manifest（failed attempt）时，release 脚本自动重发。当该失败 tag 指向的 commit 就是当前分支 HEAD（纯流程重试）时以该 tag 为 `--ref` 重新 `workflow_dispatch`（tag 不移动、版本文件不重复 bump）；当失败源于 source bug、当前分支 HEAD 已含修复且产品版本文件已等于目标版本时，脚本把失败 tag 重指到 HEAD 并 force-push（tag push 触发 workflow，tag 移动但从未产生有效 manifest，不违反不可变）。有效 immutable manifest 已提交时只能重试 release page 或 latest promotion，不能重新 build。已提交 release 出现 identity/hash mismatch 或重大运行问题时执行 [Failed Attempt and Whole-Version Withdrawal](#failed-attempt-and-whole-version-withdrawal) 整版 withdrawal，版本号永久作废，后续使用更高版本。

---

## Canonical Manifest

### CLI Manifest

```json
{
  "manifestSchemaVersion": 2,
  "version": "1.17.1",
  "releaseIdentity": {
    "schemaVersion": 2,
    "kind": "release",
    "product": "ellamaka-cli",
    "version": "1.17.1",
    "channel": "stable",
    "build": {
      "sourceTag": "ellamaka-cli-v1.17.1",
      "gitCommit": "<40-char-ellamaka-commit>",
      "builtAt": "2026-08-03T08:30:00Z",
      "workflowRunId": "123456789"
    }
  },
  "artifacts": [
    {
      "name": "ellamaka-darwin-arm64.tar.gz",
      "os": "darwin",
      "arch": "arm64",
      "url": "https://download.coursedao.com/ellamaka/v1.17.1/ellamaka-darwin-arm64.tar.gz",
      "sha256": "<artifact-sha256>",
      "size": 123456
    }
  ],
  "checksumsUrl": "https://download.coursedao.com/ellamaka/v1.17.1/checksums.txt"
}
```

### Desktop Manifest

```json
{
  "manifestSchemaVersion": 2,
  "version": "1.16.2",
  "releaseIdentity": {
    "schemaVersion": 2,
    "kind": "release",
    "product": "ellamaka-desktop",
    "version": "1.16.2",
    "channel": "stable",
    "build": {
      "sourceTag": "ellamaka-desktop-v1.16.2",
      "gitCommit": "<40-char-ellamaka-commit>",
      "builtAt": "2026-08-03T08:30:00Z",
      "workflowRunId": "123456789"
    }
  },
  "artifacts": []
}
```

### Field Authority

| 字段                      | 权威来源                  | 是否参与发布排序                  |
| ------------------------- | ------------------------- | --------------------------------- |
| `releaseIdentity.product` | 发布目标                  | 否，只用于隔离产品                |
| `releaseIdentity.kind`    | build mode                | 否，只区分正式发布与开发构建      |
| `releaseIdentity.version` | namespaced product tag    | 是，标准 SemVer                   |
| `releaseIdentity.channel` | SemVer prerelease + feed  | 先过滤 channel，不跨 channel 排序 |
| `build.sourceTag`         | 触发发布的 namespaced tag | 否                                |
| `build.gitCommit`         | workflow checkout commit  | 否                                |
| `build.builtAt`           | release context 生成时间  | 否                                |
| artifact `sha256`         | 实际构建产物              | 否，只用于完整性                  |

顶层 `version` 是 `releaseIdentity.version` 的兼容别名，二者必须完全相等。`channel` 与 SemVer 必须一致：CLI stable channel 接受 `X.Y.Z` 与 `X.Y.Z-rc.N`；Desktop beta 只接受 `-beta.N`。electron-builder 的 publish feed 名 `prod` 映射为 identity channel `stable`（`FEED_TO_CHANNEL`，见 [Build Channels](#build-channels)）。

### Runtime Identity Surfaces

manifest 只能证明远端 release，不能单独证明本机正在运行的 binary/app。release build 必须把同一个 release context 嵌入产物，并提供只读身份表面：

- CLI 内嵌 ReleaseIdentity，通过 `ellamaka debug release-info --json --api-version 1` 输出 `{ releaseIdentity }`。命令不访问网络、不读取安装收据；`ellamaka --version` 继续只输出产品 SemVer。
- Desktop package 在 resources 中内嵌 `release-identity.json`。Main 启动时验证其 product/version 与当前 app package version、channel/appId 一致，再用于 updater、兼容门禁和诊断。
- `$WOPAL_HOME/ellamaka/state/ellamaka-install.json` 是 Ellamaka host product manager 的 managed provenance/cache，不是 machine inventory 真相源。它可以记录 CLI、stable Desktop、beta Desktop 的来源、artifact 与最后观察 identity；任何判断都必须重新探测实际 binary/app identity。缺失、损坏或过期 state 产生诊断，但不会覆盖健康的实际安装事实。

ReleaseIdentity 是显式判别联合：

- 正式产物固定 `kind: "release"`，要求标准发布 `channel`、`build.sourceTag`、40 位 `build.gitCommit`、`build.builtAt` 和 `build.workflowRunId` 全部存在；它只能来自 namespaced product tag。
- 本地/开发产物固定 `kind: "development"`，使用 `channel: "local" | "main"` 和清楚可辨的开发版本；允许记录当前 `gitCommit` / `builtAt`，但禁止出现 `build.sourceTag` 或 `build.workflowRunId`，也不能进入正式 manifest、versioned path 或 latest alias。

consumer 必须先按 `kind` 选择 schema，再校验对应 required/forbidden fields；缺失、损坏或未知 kind 都是不可确认身份。release workflow 必须断言 CLI machine identity、Desktop embedded identity、manifest 和该产品 workflow 内唯一的 release context 完全一致。

---

## Compatibility and Latest Consumption

### Independent Facts

Ellamaka 明确区分四个互不替代的事实：

1. **channel policy**：CLI stable/rc、Desktop stable/beta；决定各 component 的 feed 和允许版本序列。
2. **ReleaseIdentity**：证明某个实际 binary/App 是哪个不可变构建。
3. **multi-component orchestration**：host 可以一次选择 external CLI + 一个 Desktop target；两个 target 各自遵守 component contract，不建立跨组件版本兼容关系。
4. **closureVersion**：标识当前构建携带的固定 DSH 依赖闭包，并参与 Home 版本保护；它不证明 DSH 私有数据格式兼容。

SemVer/channel 不推断 DSH Home compatibility，closure 也不建立机器级 CLI/Desktop compatibility。

### Product Inventory and Operations

Ellamaka distribution 只定义可被外部产品管理器读取的产品事实：实际 executable/App path、ReleaseIdentity、manifest、channel、artifact integrity 与 update feed。

Wopal CLI Product 是跨产品 inventory/install/repair 的 owner。它可以同时管理 external CLI、Desktop stable/beta，但这些 mutation 不通过 WopalSpace Setup 或 Ellamaka Server API 执行。

Stable/Beta 是不同 appId/路径，可以跨 minor 共存。Actual ReleaseIdentity/文件探测是真相；任何 managed receipt 只能提供 provenance/cache。

### Component Update

- `ellamaka upgrade` 只更新 external CLI；
- Desktop updater 只更新当前 Desktop channel；
- Wopal CLI Product 可以执行用户显式要求的跨产品安装/修复；
- 一个 component 的失败不要求回滚另一个已经成功的 component；
- 任何产品操作完成后都重新 probe 实际磁盘 identity。

### Managed Product State

`$WOPAL_HOME/ellamaka/state/ellamaka-install.json` 可以作为 Wopal CLI Product/安装器的 provenance/cache，但不是 Runtime readiness 或 machine inventory 的真相源。实际 binary/App identity 始终优先。

### DSH Closure Release Discipline

DSH closure 是产品 Runtime 的固定组成。Ellamaka 源码维护一个递增 closureVersion，CLI 和 Desktop 使用同一值；锁文件固定实际 DSH 依赖。已知会影响 Home 的闭包变更提升 closureVersion，产品 SemVer/channel 不替代该值。

备份成功后才允许较新 closure 写 Home；备份或版本状态写入失败时拒绝 DSH 启动。

同一 closureVersion 的多进程使用沿用 DSH 自身的并发行为；Ellamaka 不预测 DSH 内部写入格式或建立额外的 single-writer hosting。

### SDK Ownership and Release Order

Runtime 与 WopalSpace public contract 统一由 `@wopal/ellamaka-sdk` 发布。private `@wopal/wopalspace` 不进入 npm release train；`@wopal/ellamaka-sdk/local` 构建时组装 trusted-local application Worker 所需 private implementation。

SDK npm release 与 Ellamaka CLI/Desktop product release 解耦。SDK workflow 必须完成 build、contract tests、`npm pack` 与 clean-install smoke；Wopal CLI 消费正式发布的 exact SDK versions。Ellamaka 不依赖 Wopal CLI 版本、tag 或 machine protocol 才能 build/start/update。

## Immutability and Cleanup

### Immutable Publication

immutable publication 使用 manifest-last commit protocol：先在 workflow-run staging prefix 上传并校验全部 artifacts/metadata，再以禁止覆盖的写入复制到目标 versioned path，最后才写入 `manifest.json` 作为正式发布提交点并回读验证。目标路径出现部分对象但没有有效 manifest 时属于 failed attempt，不是已发布版本；只有在确认没有 latest/updater/Release 页面引用，并能用 workflow run/transaction metadata 证明对象 ownership 时，才允许显式清理后从修复 commit 同版本重试。无法证明 ownership 时 fail closed。

versioned manifest 已提交后，mutable latest promotion 可以独立重试，但必须直接读取已提交的 immutable release，不重新构建或生成第二份 release context。新的 workflow dispatch 不能接管已经提交或部分写入的同一 product/version。

版本化 R2 路径不可覆盖。若 source、配置或 artifact 有任何变化：stable 增加 PATCH，Desktop beta 增加 prerelease 序号，创建新的 namespaced tag 和 versioned path。

已提交的正式 release 禁止 retag。cleanup 对未知 tag/manifest fail-closed；解析失败的对象报告错误并保留，不默认删除。latest 引用对象在任何 retention 规则之前受到保护；正式 namespaced product tag 不进入普通 retention 删除候选，只有 [Failed Attempt and Whole-Version Withdrawal](#failed-attempt-and-whole-version-withdrawal) 显式 withdrawal 能在健康 aliases 恢复后删除指定失败版本的 tag。

### Cleanup Contract

release cleanup 不得使用字符串比较、`sort -V`、文件修改时间或旧 `X.Y.Z-N` comparator 推断“更新版本”。它先构建各 component 自己的 release reference graph：

1. 读取 CLI component latest 与 Desktop stable/beta latest/updater feed。
2. 校验 alias 引用的 product/channel/version 与目标 immutable manifest 一致；任一 live component alias 引用的 release 都是 protected root，不受普通 retention 数量删除。
3. 对未被 live alias 保护的候选，只在同一 product/channel 内用标准 SemVer 评估 retention；归档格式 release 单独分类，不与当前版本混排或自动删除。
4. 未知目录、schema 错误、悬空引用或 hash 不一致的对象全部保留并使 cleanup 失败。

cleanup 输出待删除对象与保护原因的审计清单后才执行。任何 cleanup 失败都不能阻止客户端继续读取上一次有效 aliases。

**Retention 保留数量**（release 脚本发布成功后自动触发 cleanup 时使用的默认值）：

| 产品               | 渠道   | 保留数量 | 说明                                                                                                                        |
| ------------------ | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ellamaka-cli`     | stable | 3        | 保留最新 3 个正式版本                                                                                                       |
| `ellamaka-cli`     | rc     | 2        | 保留最新 2 个 rc 候选；与 stable 共用同一个 R2 存储桶（`ellamaka/v*`），语义等同 stable，但保留计数独立，不占用 stable 名额 |
| `ellamaka-desktop` | stable | 3        | 保留最新 3 个正式版本                                                                                                       |
| `ellamaka-desktop` | beta   | 2        | 保留最新 2 个 beta 候选版本                                                                                                 |

保留数量按同一 product/channel 内标准 SemVer 降序计数，从最老的版本开始删除，直到只剩保留数量个。CLI rc 与 stable 处于同一路径空间、以稳定渠道语义对待，但在保留计数上与 bare stable 独立：rc 按 `-rc.N` 序列单独保留 2 个，stable 单独保留 3 个，二者互不蚕食名额。latest 别名通常指向最新版本，天然在保留名额内；作为防御，latest 指向的版本即使落在保留名额之外也永不删除。归档格式版本 fail-closed 保留。`cleanup-releases.yml` 的 `keep-stable`/`keep-beta`/`keep-rc` inputs 可覆盖这些默认值。

### Failed Attempt and Whole-Version Withdrawal

发布失败处理只保留两个边界：

1. **提交前 retry**：不存在有效 versioned manifest，且目标版本未被 latest/updater/正式 Release 页面引用时，可精确清理失败 attempt 的 staging、partial objects 和尚未提交的 product tag；修复 workflow 或 source 后允许同版本重试。
2. **提交后 withdraw**：有效 versioned manifest 已提交但版本存在重大运行、identity、hash 或打包问题时，先把该 `product + version` 写入受版本控制的 `release/withdrawn-versions.json`，再把受影响 latest/updater aliases 恢复到显式指定并验证兼容的健康版本，回读并 purge CDN，最后删除该版本完整 R2 prefix、GitHub/Gitee Release 页面和正式 product tag。

`withdrawn-versions.json` 使用最小、受版本控制的 schema，数组内版本唯一并按标准 SemVer 排序。该文件是 tag allocator 防止版本复用的唯一真相源；它不参与版本 precedence，也不形成在线 release index 或 consumer revocation API。操作员必须先将待撤回版本加入该文件并提交，再运行 withdraw dry-run/apply；workflow 回读当前 ref 中的记录后才允许远端删除。withdraw 支持相同输入的幂等重试；未记录 withdrawn、仍被 alias 引用、fallback 未验证或删除范围不能精确限定到单一 product/version 时一律 fail closed。已撤回版本永久跳过，修复使用更高 PATCH 或 prerelease 序号。

撤回与回退必须同渠道：stable 只回退 stable，beta 只回退 beta，禁止跨渠道。CLI rc 与 stable 处于同一 stable 渠道，撤回 rc 时 fallback 在 stable 渠道内按 SemVer 选择最高可用版本（可以是更早的 rc 或 stable）。`withdraw-release.sh` 按渠道独立解析版本——省略撤回版本时先取跨渠道最高已发布版本（stable 优先）确定渠道，再撤回该渠道低于当前最高版本的最高版本；fallback 默认取同渠道当前最高已发布版本，显式 `--fallback` 必须与撤回版本同渠道，否则拒绝执行。

---

## Desktop Distribution

桌面端（`ellamaka-desktop`）是 Electron 应用，承载 `ellamaka-app` Workbench。它与 CLI 是两个独立发布单元：使用 `ellamaka-desktop-v<version>` namespaced tag，R2 子路径、CI build、manifest、updater feed 和回滚边界均独立。架构与运行时行为见 `DESIGN-desktop.md`，打包配置见 `packages/ellamaka-desktop/electron-builder.config.ts`。

### 系统构成

| 层            | 是什么                                 | 构建方式                                                          |
| ------------- | -------------------------------------- | ----------------------------------------------------------------- |
| Electron 壳子 | 窗口、菜单、系统集成、electron-updater | `electron-builder` 打包                                           |
| Sidecar 引擎  | Ellamaka HTTP/WS/PTY 后端              | `packages/opencode/script/build-node.ts` → Node.js runtime bundle |

Sidecar 是 Node.js runtime（`build-node.ts` 产 `dist/node/`），**不是** Bun compile 的 CLI binary，因此不存在 CLI 的 native vs baseline（AVX2）二分——Node.js 代码由 V8 JIT 在运行时自适应 CPU 指令集。

构建链路：`bun packages/opencode/script/build-node.ts`（sidecar）→ `cd packages/ellamaka-desktop && bun run build`（electron-vite 编译 main/preload/renderer）→ `bun run package:mac|win|linux`（electron-builder 打包）。本地快捷方式：`./scripts/build.sh desktop [--channel main|beta|stable] [--platform mac|linux|win] [--install]`——mac 平台本地打包，linux/win 平台自动走 GitHub Actions 构建并下载产物（CI 仅接受 beta|stable 通道，`--install` 仅本地构建生效）。

### Artifact Contract

产物由 `electron-builder` 按 `electron-builder.config.ts` 生成，`artifactName` 模板为 `ellamaka-desktop-${os}-${arch}.${ext}`：

| OS      | Arch  | 产物                 | 说明                                           |
| ------- | ----- | -------------------- | ---------------------------------------------- |
| macOS   | arm64 | `.dmg` + `.zip`      | DMG 是用户安装包；ZIP 供 electron-updater 使用 |
| macOS   | x64   | `.dmg` + `.zip`      | 同上                                           |
| Windows | x64   | `.exe`（NSIS）       | 一键安装及 updater payload                     |
| Linux   | arm64 | `.AppImage` + `.deb` | AppImage 免安装，deb 可选                      |
| Linux   | x64   | `.AppImage` + `.deb` | AppImage 免安装，deb 可选                      |

Contract：

1. `main` 只用于本地构建；发布 workflow 只产出 `stable` / `beta` 通道。
2. `stable` 通道的 `appId` 为 `ai.ellamaka.desktop`，deep link scheme 为 `ellamaka://`。
3. beta 与 stable 的版本化目录和 latest feed 相互独立，也不与 CLI 混用。
4. 自动更新 feed（`latest-mac.yml` / `latest.yml` / `latest-linux.yml`）与安装包同传 R2。
5. Release 下载表展示 DMG、EXE、AppImage 和 deb。ZIP 与 blockmap 属于 updater 资产。

### 安装入口

Desktop 的直接安装入口是 wopal-site 下载页/公开 Release 索引；Wopal CLI Product 也可以消费同一 Desktop manifest 与原生安装包完成用户显式要求的安装。Onboarding/Setup 不负责补齐 Desktop。Desktop 已安装后的版本更新只由自身 auto-updater 负责。

手动入口由用户下载对应平台安装包。CLI 入口优先发现已有系统安装。缺失时，macOS 从 ZIP 安装到 `~/Applications/Ellamaka.app`，Windows 通过 NSIS current-user 模式安装到 `%LOCALAPPDATA%\Programs\Ellamaka`，Linux 把 AppImage 安装到 `${XDG_DATA_HOME:-~/.local/share}/ellamaka/` 并创建 desktop entry。完成后重新探测应用版本。Sidecar 和 Ellamaka 配置仍写入 `WOPAL_HOME`。

当 Wopal CLI Product 显式安装 beta Desktop target 时，将 beta Desktop 放到独立位置（不同 appId，不覆盖 stable 安装）：

| 平台    | CLI-managed beta Desktop 位置                                           |
| ------- | ----------------------------------------------------------------------- |
| macOS   | `~/Applications/Ellamaka Beta.app`                                      |
| Windows | `%LOCALAPPDATA%\Programs\Ellamaka Beta\`                                |
| Linux   | `${XDG_DATA_HOME:-~/.local/share}/ellamaka-beta/Ellamaka Beta.AppImage` |

Beta Desktop 与 stable Desktop 可共存。CLI 通过 appId 区分，不混淆安装位置。

### 自动更新

`electron-builder` 的 `publish` 配置使用 generic provider，feedURL 指向各自 R2 channel；macOS 用 `latest-mac.yml`，Windows 用 `latest.yml`，Linux 用 `latest-linux.yml`。stable 与 beta 独立 appId/feed，main 开发构建不启用 updater。

Desktop updater 只授权和更新**当前 Desktop component**：校验自身 product/channel、target ReleaseIdentity、标准 SemVer、平台 feed 与签名/完整性，不在下载前探测 Wopal CLI，也不把 external Ellamaka CLI 当前版本作为授权条件。electron-updater 继续拥有 Desktop self-replace/restart 的平台 executor 生命周期。

更新完成并重启后，Desktop Main 重新 probe 自身实际 identity。Desktop updater 不检查或修改 external CLI；embedded sidecar 的 Core/DSH runtime 只使用当前 Desktop 自身 closure。

增量更新机制保持：macOS ZIP、Windows NSIS、Linux AppImage 基于 blockmap；macOS DMG 只用于人工安装。增量生效要求 updater feed 与 blockmap 完整且目标版本通过 component policy gate。

**Channel 隔离**：stable、beta、main 是独立应用：

| build channel | appId                      |
| ------------- | -------------------------- |
| main          | `ai.ellamaka.desktop.main` |
| beta          | `ai.ellamaka.desktop.beta` |
| stable        | `ai.ellamaka.desktop`      |

自动 updater 不跨 channel。Stable/Beta 可以同时安装，某一 channel 的 updater/启动不会把另一个 channel 当作 incompatibility。切换 channel 是显式安装/卸载行为。

macOS 特殊处理：ad-hoc 签名的 app 更新仍遵守 quarantine/Gatekeeper 约束；正式签名策略见下一节。

### 代码签名

P1 使用 ad-hoc 签名。该签名保证 macOS app bundle 结构完整并通过 `codesign --verify --deep --strict`，不提供开发者身份认证或 Apple notarization。

未签名的用户体验约束：macOS 首次打开需右键 → 打开或"仍要打开"；Windows SmartScreen 警告需"仍要运行"；Linux AppImage 需 `chmod +x`。

正式签名属于后续阶段：macOS 需 Apple Developer ID Application 证书 + `notarytool` 公证（`hardenedRuntime`/`notarize`）；Windows 需代码签名证书（OV 或 EV，`CSC_LINK`/`CSC_KEY_PASSWORD` 经 CI secrets 注入）；Linux 可选 GPG 签名。

---

## Install Contract

所有用户级路径都解析到 `WOPAL_HOME`（默认值见产品级文档 [`安装路径与 WOPAL_HOME`](../../../docs/products/wopal-space/DESIGN-distribution.md#13-安装路径与-wopal_home)）。

| Platform      | Binary path                    | Runtime roots                                    |
| ------------- | ------------------------------ | ------------------------------------------------ |
| macOS / Linux | `$WOPAL_HOME/bin/ellamaka`     | `$WOPAL_HOME/ellamaka/{config,data,cache,state}` |
| Windows       | `$WOPAL_HOME/bin/ellamaka.exe` | `$WOPAL_HOME/ellamaka/{config,data,cache,state}` |

### 分发渠道与安装契约

Wopal CLI Product 消费本文定义的 manifest、ReleaseIdentity、channel 与平台安装规则，拥有 inventory / install / repair 事务。WopalSpace Setup、GUI Onboarding 和 Ellamaka Runtime 不复制这套产品 mutation。

产品可以独立安装/更新；不存在 CLI/Desktop machine-global major.minor gate。Stable/beta Desktop 使用不同 appId/路径。

### DSH Runtime Binding

Ellamaka 制品捆绑固定的 DSH manifest/lock、Bridge 和内部 adapter。依赖求解或用户配置不能为同一制品选择另一版 DSH。所有正式本地入口共享固定 Home $WOPAL_HOME/dsh/home，并携带 closureVersion。

Product service 不处理 DSH 私有数据格式，也不通过 CLI/Desktop SemVer 判断 Home 是否可用。Home 版本、备份和旧版本拒绝规则由 DESIGN-dsh-base.md 拥有；不实现通用数据转换或自动恢复。

Bridge ABI 可继续作为 closure loader 的内部机械校验，但不参与 Home 兼容判断。固定 Home、closure version、切换前备份和启动规则由 DESIGN-dsh-base.md 拥有。

### Channel Consumption

CLI stable/rc 使用自己的 component feed；Desktop stable/beta 使用独立 feed/appId。每个 updater 只消费自己的 channel。Wopal CLI Product 在用户显式要求安装/修复时可以选择目标 channel，但不会因为运行 Setup 自动扩大产品集合。

### Runtime Handoff

ellamaka 安装完成后，运行时加载链路按 WopalSpace mode 工作：

1. 读取全局配置根 `$WOPAL_HOME/config/`
2. 自动检测到 WopalSpace 后加载 `<space>/.wopal/`
3. 合并 `<space>/.wopal/config/settings.jsonc` 中的 `ellamaka` 与 `tui` 配置
4. 加载 `<space>/.wopal/agents/*.md`
5. 加载 `<space>/.wopal/commands/*.md`
6. 加载 `<space>/.wopal/plugins/`

分发阶段只负责产品制品。Space-local 声明与 plugin 引用由 ontology 提供、Ellamaka 加载；private `@wopal/wopalspace` 承载 ontology lifecycle 与 Space init/sync/capability 等共享 application implementation，外部消费者通过统一 `@wopal/ellamaka-sdk` 使用这些 operations。Evolution、Skill Lifecycle 与 Plan Scheduling 当前仍由 Wopal CLI 实现；Core runtime 不承担这些 WopalSpace 业务语义。

---

## Update Authorization

### Component updater

每个 component updater 只校验自身 target 的 product/channel、标准 SemVer precedence、manifest/hash/platform 与 ReleaseIdentity。另一个 component 的存在和版本不是授权条件。

### Multi-component Product Operation

Wopal CLI Product 可以在一次用户明确请求中处理多个 targets；每个 component 独立校验和提交。该能力属于 Wopal CLI，不形成 WopalSpace/Server `product.ensure` API。

### Runtime activation

CLI/Desktop SemVer 不作为 DSH Home gate。实际启动的产品携带自己的 closureVersion；若 Home 记录更高版本则拒绝访问，若目标版本更高则先备份再切换。

## NPM 包发布机制

Ellamaka monorepo 把 SDK npm release 与 CLI/Desktop product release 分开。

### 包身份与归属

| Package | Source directory | Contract |
| --- | --- | --- |
| `@wopal/wopalspace` | `packages/wopalspace` | private/not published；Setup/Ontology/Space implementation |
| `@wopal/ellamaka-sdk` | `packages/sdk/js` | 唯一公开 service SDK；Runtime + WopalSpace contract/client，`/http` 与 self-contained `/local` Worker |
| `@wopal/ellamaka-plugin` | plugin contract workspace | plugin author contract；不是 service SDK |

`@wopal/ellamaka-sdk/local` 构建时组装 WopalSpace local application 所需 private implementation，但 npm runtime dependency 不指向 unpublished private packages。完整 contract 通过 `@wopal/ellamaka-sdk/openapi.json` 发布。

### SDK 版本策略

`@wopal/ellamaka-sdk` 只有一条独立 SemVer 版本线，表达整个公开 service contract；不镜像 CLI/Desktop Product SemVer。private `@wopal/wopalspace` 不拥有外部 compatibility SemVer。

### SDK 发布流程

独立 npm workflow 负责 side-effect-free Public Platform contract export、generated client/types、完整 public OpenAPI、`/http` helper、self-contained `/local` Worker、`npm pack` 与 source-tree 外 clean-install。Official App BFF contract/client 随 `ellamaka-app` 产品构建校验，不进入 SDK tarball。CLI/Desktop product workflow 不隐式发布 SDK。

### 消费者契约

- Browser/Desktop/Workbench 的 Runtime/WopalSpace 平台能力消费 `@wopal/ellamaka-sdk/http`；官方 App BFF 由 `ellamaka-app` 私有 client 消费；
- Wopal CLI 的 Ontology/Space 本机调用消费 `@wopal/ellamaka-sdk/local`；
- Wopal CLI Product 继续使用自己拥有的产品管理实现，不通过 SDK WopalSpace API；
- Ellamaka build/start/update 不依赖 Wopal CLI minimum version 或 machine protocol。

## Archived Version Compatibility

当前 publisher 只生成标准 SemVer 与 Manifest Schema v2。分发 reader 仍能识别归档版本格式 `X.Y.Z-N` / `X.Y.Z-N.rcM`，用于读取已经存在的安装与发布记录；这些格式永远只读，不参与当前版本分配、latest 推进或自动 cleanup 排序。

归档版本遵循以下固定规则：

1. 无法按当前 ReleaseIdentity 证明的本机 binary 标记为 `archived-unknown-build`，不能据此改写任何远端发布记录。
2. 当前标准版本必须在 SemVer 顺序上高于同产品归档发布线的最高可用版本。
3. Cleanup 对归档格式 fail closed：保留对象，不与标准 SemVer 混排删除。
4. 当前 manifest 可以保留 reader 仍需要的兼容字段，但这些字段不是第二份版本真相源。

## Related Documents

| 文档                                                      | 说明                                             |
| --------------------------------------------------------- | ------------------------------------------------ |
| `../../../docs/products/wopal-space/DESIGN.md`            | 产品级架构与版本体系                             |
| `../../../projects/wopal-cli/docs/DESIGN-distribution.md` | wopal-cli 对 ellamaka release 的消费契约         |
| `../../../.wopal/docs/DESIGN-distribution.md`             | ontology materialization 与 runtime handoff 边界 |
