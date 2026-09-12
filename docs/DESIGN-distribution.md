# Ellamaka — Distribution

> **状态**: Active
> **更新**: 2026-09-12
> **上级架构**:
>
> - `../../../docs/products/wopal-space/DESIGN-distribution.md`（产品级分发总设计）
> - `../../../docs/products/wopal-space/DESIGN-onboarding.md`
> **上级**: `./DESIGN.md`

本文件是 Ellamaka 产品分发与版本身份的唯一真相源。它定义 Ellamaka CLI 与 Desktop 的 release backbone、产品 SemVer、OpenCode upstream lock、构建身份、manifest 契约、兼容规则、不可变发布与更新授权。产品级通用规则（WOPAL_HOME、R2 bucket/URL/缓存、归档格式、跨产品协调总则）见 `./DESIGN-distribution.md`，本文只保留 ellamaka 特有语义。

---

## Scope

Ellamaka CLI 与 Desktop 分别发布为独立制品，使用各自的 SemVer、namespaced tag、workflow、R2 latest 和回滚边界。Desktop manifest 声明兼容约束，Wopal CLI 读取并校验 CLI latest，把两个制品组合为一个可安装产品。默认 `wopal ellamaka install` 安装完整产品，`wopal setup` 复用该能力并启动 Desktop onboarding。

Release identity 必须回答四个互不混淆的问题：

1. 这是哪个 Ellamaka 产品的哪个版本？
2. 它采用了哪个 OpenCode baseline？
3. 它与哪些外部组件兼容？
4. 它由哪个 Ellamaka commit、tag 和构建生成？

### Product Boundaries

- **Ellamaka CLI**（`ellamaka-cli`）是可独立安装的 Engine/CLI 产品，支持 Wopal 完整安装、cli-only 安装和手动下载。其 SemVer 表达 CLI 与 Engine 公共契约的演进。
- **Ellamaka Desktop**（`ellamaka-desktop`）是原生 Electron 产品，拥有独立的 UI、平台集成、签名、公证、自动更新、stable/beta channel 和回滚边界。其 SemVer 不随 CLI 的每次修复锁步递增。
- **Embedded Sidecar** 是从当前 Ellamaka source commit 构建的 Node runtime，不是外部 CLI binary，也不是第三个面向用户的发布产品。Desktop manifest 记录 sidecar 的 source commit、OpenCode baseline 和 engine API，但不为它创建第三套 SemVer。

共享 Engine 源码发生变化时，CLI 与 Desktop 可能需要协调发布；协调发布不要求二者版本相同。

---

## Release Backbone

ellamaka 是 OpenCode 的 fork，构建与发布体系由 `@wopal/ellamaka-release` 包集中承载：`packages/ellamaka-release/src/cli/build.ts` 注入品牌（`BINARY_NAME=ellamaka`，import 自 `@wopal/ellamaka-brand`）与裁剪，构建期版本/渠道解析由同包 `build-env` 模块提供。对上游的裁剪仅限于：

- **平台裁剪**：`--arch primary` 构建 8 个平台（5 native + 3 baseline），排除 musl、Windows arm64 变体；baseline 兼容不支持 AVX2 的老 x64 CPU。
- **发布位置**：binary 分发从 GitHub Release 迁移到 Cloudflare R2。

canonical release source：Cloudflare R2（`https://download.coursedao.com/ellamaka/`）是唯一 binary 分发源；`wopal-cn/ellamaka` 与 `wopal-cn/wopal-space-ontology` 的 GitHub/Gitee Releases 仅保留 markdown 索引页面，不携带 binary 附件。

canonical consumer：`wopal ellamaka install`（完整产品 / `--cli`）、`wopal setup`（确保完整产品并拉起 Desktop onboarding）、Desktop-first（Desktop bootstrap Wopal CLI 后通过 machine operation 安装并校验 CLI latest）、人工从 Release 页面点击 R2 链接下载。

### 平台矩阵

| OS | Arch | Variant | Artifact |
| --- | ---- | ------- | -------- |
| macOS | arm64 | native | `ellamaka-darwin-arm64.tar.gz` |
| macOS | x64 | native | `ellamaka-darwin-x64.tar.gz` |
| macOS | x64 | baseline | `ellamaka-darwin-x64-baseline.tar.gz` |
| Linux | arm64 | glibc | `ellamaka-linux-arm64.tar.gz` |
| Linux | x64 | glibc | `ellamaka-linux-x64.tar.gz` |
| Linux | x64 | glibc-baseline | `ellamaka-linux-x64-baseline.tar.gz` |
| Windows | x64 | native | `ellamaka-windows-x64.zip` |
| Windows | x64 | baseline | `ellamaka-windows-x64-baseline.zip` |

Contract：

1. archive 内的 binary 名称固定为 `ellamaka` / `ellamaka.exe`，consumer 依赖稳定文件名。
2. `manifest.json` 是 installer 的机器可读入口，其中 `url` 指向 R2 自定义域名；`checksumsUrl` 指向同版本 `checksums.txt`。
3. `checksums.txt` 与 `release-notes.md` 作为元数据文件与 artifacts 一同发布到 R2。
4. 归档格式与 wopal-cli 对齐：macOS / Linux 使用 `.tar.gz`，Windows 使用 `.zip`。
5. release build 的 channel 对外固定为 `latest`（`@wopal/ellamaka-brand` 的 `branding.ts:CHANNEL_RELEASE`）；本地开发 channel 保持 `main`（`CHANNEL_DEV`）。

### 构建接口

`@wopal/ellamaka-release` 的 `build-env` 模块（原 `@wopal/ellamaka-script` 的 `Script`，2026-09-01 收编）仍作为 CLI 构建接口使用，但注入的是已经由 release context 验证的 Ellamaka CLI 产品版本：

| 环境变量 | 作用 | 约束 |
| -------- | ---- | ---- |
| `OPENCODE_VERSION` | 兼容上游构建接口 | release build 必须等于 namespaced tag 中的 CLI 产品版本；不能表达 OpenCode baseline |
| `OPENCODE_RELEASE` | 上游 release 模式开关 | Ellamaka wrapper 必须拦截上游 tag/GitHub Release 副作用，正式 tag 与 publication 只由 workflow 拥有 |
| `OPENCODE_CHANNEL` | 更新渠道 | 设置时作为 `Script.channel`；未设置时自动推导 |
| `BINARY_NAME` | 产物名前缀 | 构建时替换所有硬编码 `"opencode"`，控制输出目录名、binary 名、archive 名 |

这些变量是上游构建接口，不是 Ellamaka release identity 的权威存储。完整版本、上游、channel 和 build identity 由 [Version Identity](#version-identity)、[Release Workflow](#release-workflow) 与生成的 `release-context.json` 约束。

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
Desktop prod: X.Y.Z
```

CLI rc 与 stable 发布完全同构——同一 tag namespace、同一 R2 versioned path、同一 latest feed、同一 Release 页面，`-rc.N` 只是版本字符串上的候选标记。rc 不是 legacy `X.Y.Z-N.rcM` 迭代格式（见 [Legacy Migration](#legacy-migration)）；rc 发布一经提交即不可变，同样适用 [Immutability and Cleanup](#immutability-and-cleanup) 的 retry/withdraw 边界。

发布版本禁止 `+build` metadata：build metadata 不参与 precedence，允许它会产生两个不同构建排序相等的问题。构建信息统一放入结构化 `build` 字段。

### 设计原则

1. **产品版本独立**：CLI 与 Desktop 是两个独立发布单元，各自使用标准 SemVer 2.0、tag、workflow、latest feed 和 changelog，版本序列互不牵制（cli 可发 `2.0.6-rc.1` 而 desktop 仍停在 `2.0.5-beta.N`）。
2. **已成功发布的 tag 记录是版本推进依据**：每产品的下一个版本由该产品已发布的最高记录按 semver 推断，不读仓库 package.json 里"上次写了什么"。发布成功即打 tag 记录、不可变；失败/中断不构成记录，可同版本重发。cli/desktop 的 package.json 平时不承载 rc/beta"候选状态"，只在发布动作内写入本次版本。
3. **依赖包统一镜像纯 base**：除 cli/desktop 两个产品外，全部 workspace 包 version 字段统一为纯 `X.Y.Z`，取两产品现行 base 的**较高者**（cli 发 `2.0.6-rc.1` 时依赖包为 `2.0.6`）。依赖包不发布、内部依赖走 `workspace:*`，其 version 只是版本演进的记录记号。
4. **上游不是产品版本**：OpenCode version/commit 是 provenance 与 v1 兼容基线，不参与 Ellamaka 产品版本排序。
5. **兼容性不是版本相等**：Desktop 不锁定外部 CLI 的精确产品版本；安装器读取 CLI `latest` 并验证其满足 Desktop 兼容约束。
6. **一个排序真相源**：发布顺序只比较 `releaseIdentity.version`。upstream、build date、Git hash 和 artifact hash 都不参与排序。
7. **提交后不可变**：有效 versioned manifest 是正式发布提交点；提交后同一个 `product + version` 只能对应一个 source tag、一个 Ellamaka commit 和一组固定 artifact hashes。
8. **安全迁移**：新 manifest 在迁移期保留必要的顶层兼容字段；旧 `X.Y.Z-N` 只读不写。

### OpenCode Upstream Lock

OpenCode baseline 不是每次 build/release 的人工输入。仓库维护受版本控制的单一真相源 `release/upstreams.lock.json`：

```json
{
  "schemaVersion": 1,
  "sources": {
    "opencode": {
      "relationship": "baseline",
      "repository": "https://github.com/anomalyco/opencode.git",
      "version": "1.15.13",
      "gitCommit": "385cb694419f98103af0e8fc6187ddcbcbb6eecb"
    }
  },
  "componentBaselines": {}
}
```

`componentBaselines` 记录仍按独立复制策略冻结的上游目录来源，只用于 drift 检查和审计，不参与产品版本排序或 CLI 兼容过滤。上游 `packages/app`、`packages/desktop` 已删除（2026-08-31），不再作为冻结 component baseline；参考代码从 `labs/ref-repos/opencode/` 读取。

只有"正式采用新的 OpenCode Engine baseline"时才更新 `sources.opencode`：专用命令接收目标 OpenCode version，解析上游 tag 对应的完整 commit，校验后写入 lock；baseline 更新与上游合并在同一变更中审查和提交。component baseline 使用独立的显式更新动作，禁止被 Engine baseline 升级顺带改写。release workflow 禁止通过 input、环境变量或网络上的"最新 OpenCode tag"覆盖 lock。

发布前必须验证：

1. lock 通过 schema 校验，所有 version 均为稳定 SemVer，commit 均为完整 40 位 SHA。
2. `sources.opencode.gitCommit` 存在，并且是 Ellamaka release commit 的祖先。
3. 冻结目录检查分别读取自己的 `componentBaselines[<path>].gitCommit`，并验证工作树目录与该 upstream snapshot 一致。
4. release context 保存整个 lock snapshot；公开 manifest 的 `releaseIdentity.upstream` 与构建内嵌 Engine metadata 必须等于 `sources.opencode`。

### Release Context

每个 workflow checkout 精确 product tag 后，先生成一次 `release-context.json`，CLI/Desktop build、manifest、release notes 和上传步骤全部读取同一文件：

```text
product/version/channel  ← namespaced tag
upstream                 ← release/upstreams.lock.json
build.gitCommit          ← checked-out release commit
build.builtAt            ← UTC release-context assembly time
artifacts                ← build outputs + SHA-256
```

workflow input 不能作为 version 或 upstream 的第二真相源。re-release 的 dispatch 输入只能被 anchor match gate 断言等于产品锚点文件（版本真相源），不能覆盖 tag 或锚点。CLI 与 Desktop 各自生成并在自身 matrix 内共享 context，不要求两个产品复用同一 context 文件。

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

channel 规则：

- CLI 单一发布流：stable `X.Y.Z` 与候选 `X.Y.Z-rc.N` 同流发布，latest 总是指向最新发布的 CLI 版本（含 rc）。
- Desktop stable latest 只引用无 prerelease 的版本。
- Desktop beta latest 只引用 `-beta.N`，并与 stable 使用不同 appId/feed。
- 不进行隐式跨 channel 更新或比较。

发布是一步制（脚本 `scripts/release-cli.sh` / `scripts/release-desktop.sh`）：版本准备与发布触发在同一脚本内完成，`--dry-run` 承担预演职责。

版本推断（`packages/ellamaka-release/src/version-line.ts`）以**已成功发布的 tag 记录**为版本推进唯一依据，两个产品独立计数。package.json 不承载"候选锚点"状态——发布的版本在发布动作内才写入，发布成功即成为记录：

1. 计算目标版本：读**该产品**已发布的最高记录（stable 最高版 + rc/beta 序列），按 `--patch`/`--minor`/`--major`/`--rc`/`--beta` 或显式版本推断，展示给用户确认：
   - rc/beta：该 base 已有同 kind 序列 → 续 N+1。该 base 已发 stable → 升下一 patch 的 `.1`（如 2.0.4 已发布 → `--rc` 给 `2.0.5-rc.1`）。
   - `--patch`（stable）：该产品无 stable 记录 → 取现行 rc/beta base 转正（`2.0.5-rc.2 → 2.0.5`）；已有 stable R → semver patch+1 直接发新正式版（`2.0.4 → 2.0.5`）。
   - minor/major：从该产品现行 base 升位开新线（`2.0.5 → 2.1.0` / `3.0.0`），通道重置。
2. 写入：把确认的目标版本写入该产品 package.json（带 `-rc.N`/`-beta.N` 或纯 `X.Y.Z`），其余依赖包模块统一镜像纯 base `X.Y.Z` = **两个产品现行 base 的较高者**；cli 先发 `2.0.6-rc.1` 时依赖包升 `2.0.6`，随后 desktop 仍可发 `2.0.5-beta.2`（只写 desktop，依赖包不动）。
3. 提交 bump、创建 namespaced tag（`ellamaka-cli-vX.Y.Z[-rc.N]` / `ellamaka-desktop-vX.Y.Z[-beta.N]`）、推送当前分支与 tag。tag push 触发目标 workflow（`push: tags`），不再手工 dispatch。
4. 监听 workflow 至完成，成功后自动触发历史清理。

Desktop 渠道为单开关模型：`--beta` 即 beta 渠道（版本必然为 `X.Y.Z-beta.N`，发布到 `ellamaka-desktop/beta/`），缺席即 prod（版本必然为纯 `X.Y.Z`）；不存在独立 `--channel` 参数。

failed attempt 的 re-release（幂等）：目标 tag 在远端已存在时——有有效 R2 manifest 则拒绝（发布不可变，请用更高版本）；无 manifest 则按两种情况重发，均不重复 bump：

- **纯流程重试**（失败 tag 指向的 commit 仍是当前分支 HEAD）：以该 tag 为 `--ref` 重新 `workflow_dispatch`，tag 不移动。
- **source bug 自愈重试**（失败源于代码缺陷，已在其后提交修复，当前分支 HEAD 的产品版本文件已等于目标 VERSION）：脚本将失败 tag 重指到修复后的 HEAD 并 force-push（tag push 触发 `push: tags` workflow），构建修复代码。因失败 tag 从未写入有效 manifest，仍属 failed attempt，重指 tag 不违反不可变原则。

分支渠道约束（branch-channel policy）：

- `main`：CLI stable/rc 与 Desktop prod/beta 均可发布。
- 非 `main` 分支（特性分支等）：只允许 prerelease —— CLI `X.Y.Z-rc.N`、Desktop `X.Y.Z-beta.N`；禁止发布裸 `X.Y.Z`。该约束以**通道级预检**在版本推断之前执行：非 main 分支上 `--patch`/`--minor`/`--major`（stable/prod 目标：候选转正或开新正式版）直接拒绝并提示切回 main；`--rc`/`--beta` 进入推断。dry-run 同样触发，让分支策略在发布计划第一屏显式可见。
- prerelease 的 base `X.Y.Z` 必须高于该产品已发布 prod/stable 的最高版本：已发布 `2.0.3` 时，prerelease 从 `2.0.4-rc.1` / `2.0.4-beta.1` 开始，`2.0.3-rc.1` / `2.0.3-beta.1` 被拒绝。
- 版本单调：同类产品的全部发布（stable、rc、beta）处于同一单调递增序列。rc 占用 base slot 后，后续修复只能发更高版本（`2.0.5-rc.2`、`2.1.0`……），不能回退到已发 rc 的 base 之下。

bump 写入前校验：版本符合 SemVer 子集、version/channel 一致、branch-channel policy 满足、目标版本未列入 `release/withdrawn-versions.json` 且高于该产品已发布的最高标准版本、第一批标准版本高于 [Update Authorization](#update-authorization) 的 migration floor。OpenCode baseline 始终由 upstream lock 随最终 source commit 确定，发布不接收 OpenCode baseline/revision 作为版本输入。

### 发布流程

**触发条件**：`push: tags`（前缀 `ellamaka-cli-v*` / `ellamaka-desktop-v*`）由 `scripts/release-cli.sh` / `scripts/release-desktop.sh` 一步制发布触发；`workflow_dispatch` 仅用于 failed-attempt re-release（`--ref <tag>`）与 CI dev 构建（`publish=false`）。所有 job 有 `if: github.repository == 'wopal-cn/ellamaka'` 仓库守卫。每个发布构建在最早阶段执行 anchor match gate：从 tag 解析的版本必须等于对应产品锚点 package.json 的 version，不一致即失败，任何构建都不会启动。

CLI rc 与 stable 走完全相同的 release job：同一 versioned path（`ellamaka/v<version>/`）、同一 latest promotion、同一 Release 页面。`-rc.N` 仅作为版本字符串进入 tag、build 注入与 manifest，任何步骤都不区分 rc 与 stable。

CLI 发布流程（release job）：

1. anchor match gate 已断言 tag 版本等于 `packages/ellamaka-cli/package.json`（[Tags 与 Channels](#tags-与-channels)）；release context 生成时校验 `sources.opencode.gitCommit` 是当前 release commit 的祖先，并对每个冻结 component baseline 执行目录 drift check。
2. 构建 CLI（`BINARY_NAME=ellamaka OPENCODE_VERSION=<ver> OPENCODE_RELEASE=true bun packages/ellamaka-release/src/cli/build.ts --arch primary --web-ui ellamaka-app`），产出 8 平台产物。
3. 运行 `bun packages/ellamaka-release/src/cli/manifest.ts manifest` 生成 `manifest.json`、`checksums.txt`、`release-notes.md`。
4. 按 manifest-last 提交点协议发布：staging 上传 → 回读校验 → 禁止覆盖写入 versioned path → 最后写 `manifest.json` 作为提交点（契约细节见 [构建接口](./DESIGN-distribution.md#构建接口)）。
5. 直接更新 CLI latest（含 rc；CLI 是独立产品，发布不受任何 Desktop 版本约束）并主动 purge CDN。
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
    "upstream": {
      "name": "opencode",
      "version": "1.15.13",
      "gitCommit": "<40-char-upstream-commit>"
    },
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
    "upstream": {
      "name": "opencode",
      "version": "1.15.13",
      "gitCommit": "<40-char-upstream-commit>"
    },
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

| 字段 | 权威来源 | 是否参与发布排序 |
| ---- | -------- | ---------------- |
| `releaseIdentity.product` | 发布目标 | 否，只用于隔离产品 |
| `releaseIdentity.kind` | build mode | 否，只区分正式发布与开发构建 |
| `releaseIdentity.version` | namespaced product tag | 是，标准 SemVer |
| `releaseIdentity.channel` | SemVer prerelease + feed | 先过滤 channel，不跨 channel 排序 |
| `upstream.version/gitCommit` | upstream lock | 否 |
| `build.sourceTag` | 触发发布的 namespaced tag | 否 |
| `build.gitCommit` | workflow checkout commit | 否 |
| `build.builtAt` | release context 生成时间 | 否 |
| artifact `sha256` | 实际构建产物 | 否，只用于完整性 |

顶层 `version` 是 `releaseIdentity.version` 的兼容别名，二者必须完全相等。`channel` 与 SemVer 必须一致：CLI stable channel 接受 `X.Y.Z` 与 `X.Y.Z-rc.N`；Desktop beta 只接受 `-beta.N`。Desktop 内部 feed 名 `prod` 映射为 identity channel `stable`。

### Runtime Identity Surfaces

manifest 只能证明远端 release，不能单独证明本机正在运行的 binary/app。release build 必须把同一个 release context 嵌入产物，并提供只读身份表面：

- CLI 内嵌 ReleaseIdentity，通过 `ellamaka debug release-info --json --api-version 1` 输出 `{ releaseIdentity }`。命令不访问网络、不读取安装收据；`ellamaka --version` 继续只输出产品 SemVer。
- Desktop package 在 resources 中内嵌 `release-identity.json`。Main 启动时验证其 product/version 与当前 app package version、channel/appId 一致，再用于 updater、兼容门禁和诊断。
- `$WOPAL_HOME/ellamaka/state/ellamaka-install.json` 只缓存安装来源、artifact hash 和上次探测 identity。Wopal status/repair 必须以 binary machine identity + 实际 artifact/文件探测为准，不能仅信任收据。

ReleaseIdentity 是显式判别联合：

- 正式产物固定 `kind: "release"`，要求标准发布 `channel`、`build.sourceTag`、40 位 `build.gitCommit`、`build.builtAt` 和 `build.workflowRunId` 全部存在；它只能来自 namespaced product tag。
- 本地/开发产物固定 `kind: "development"`，使用 `channel: "local" | "main"` 和清楚可辨的开发版本；允许记录当前 `gitCommit` / `builtAt`，但禁止出现 `build.sourceTag` 或 `build.workflowRunId`，也不能进入正式 manifest、versioned path 或 latest alias。

consumer 必须先按 `kind` 选择 schema，再校验对应 required/forbidden fields；缺失、损坏或未知 kind 都是不可确认身份。release workflow 必须断言 CLI machine identity、Desktop embedded identity、manifest 和该产品 workflow 内唯一的 release context 完全一致。

---

## Compatibility and Latest Consumption

### 运行时版本保证

Desktop 与 CLI 是同一产品的两种形态，运行时对两种二进制分别做版本保证（`src/main/version-check.ts`，纯函数模块，updater 与 onboarding 共用）：

| 对象 | 约束 | 语义 |
| ---- | ---- | ---- |
| wopal-cli | `>= MIN_WOPAL_CLI_VERSION` | 协议兼容域下界（构建注入，`.ci/versions.json` 自动跟随 `@wopal/cli-capability-schema` 依赖下界） |
| ellamaka CLI（外部 engine） | 主版本 `vX.Y` 与 Desktop 一致 | 同一引擎两种形态，`major.minor` 相等即匹配（Desktop 2.0.1 与 CLI 2.0.3 匹配；Desktop 2.1.0 与 CLI 2.0.x 不匹配） |

检查时点为 onboarding 安装（setup 操作前检查 wopal-cli 下界；装完 engine 后检查主版本匹配）与 Desktop 更新（授权通过后、下载前）。两个时点都是"装之前看一眼，不够先补，补不上就停"，不做启动轮询。检查失败不静默放行：wopal-cli 过低 → 提示先升级；engine 主版本不匹配 → 提示重装 engine。版本无法探测时跳过对应检查并记日志，不阻塞流程。

### Current-Release Support Policy

自动安装只支持当前公开推荐组合：Desktop stable latest、Desktop beta latest（若已发布）和 CLI latest。版本化 manifest/artifact 继续保留用于审计、手动回滚和显式迁移，但不建立 release index，也不用于默认兼容版本搜索。发布系统保证：CLI latest 是独立发布面；aliases 顺序更新产生的短暂不一致由 consumer fail-closed 并提示重试；较旧 Desktop 若已不符合当前 CLI latest，必须先更新 Desktop。

### Runtime Version Guarantees

运行时对两种二进制分别做版本保证（`src/main/version-check.ts`，纯函数模块，updater 与 onboarding 共用）：

| 对象 | 约束 | 语义 |
| ---- | ---- | ---- |
| wopal-cli | `>= MIN_WOPAL_CLI_VERSION` | 协议兼容域下界（构建注入，`.ci/versions.json` 自动跟随 `@wopal/cli-capability-schema` 依赖下界） |
| ellamaka CLI（外部 engine） | 主版本 `vX.Y` 与 Desktop 一致 | 同一引擎两种形态，`major.minor` 相等即匹配（Desktop 2.0.1 与 CLI 2.0.3 匹配；Desktop 2.1.0 与 CLI 2.0.x 不匹配） |

检查时点为 onboarding 安装（setup 操作前检查 wopal-cli 下界；装完 engine 后检查主版本匹配）与 Desktop 更新（授权通过后、下载前）。两个时点都是"装之前看一眼，不够先补，补不上就停"，不做启动轮询。检查失败不静默放行：wopal-cli 过低 → 提示先升级；engine 主版本不匹配 → 提示重装 engine。版本无法探测时跳过对应检查并记日志，不阻塞流程。

### Schema 契约单一真相源

ellamaka 的 Wopal 集成模块（`packages/opencode/src/wopal/`）通过 npm 依赖消费共享契约包 `@wopal/cli-capability-schema`（`^` 下界，如 `^0.3.16`），不再维护手写 Schema 副本。npm `^` 语义即最低版本语义：编译期类型、运行时最低版本检查、发布门禁三环节复用同一声明。

- 数据 schema（`spaceListSchema`/`spaceProjectsListSchema`/`spaceSearchSchema`/`skillsListSchema`）从共享包导入，运行时用 `Value.Check`/`Value.Errors` 验证。
- `CliEnvelope`（稳定协议层）保留本地 TypeBox 定义；运行时错误类（`CapabilityContractError`/`SpaceControlUnavailable`/`StableErrorCode`）保留 Effect。
- `MIN_WOPAL_CLI_VERSION` 构建注入：`.ci/versions.json` 的 `minWopalCli` 构建时自动跟随依赖下界（`scripts/lib/version.sh` 的 `resolve_min_wopal_cli_version` 取依赖下界与配置的更高者），可手动覆盖（提前声明）。`build.sh`/`dev.sh`/`build-node.ts`/`build.ts`/`electron.vite.config.ts` 统一注入。
- 开发联调用 `bun link` 本地 schema 包（不修改 package.json），发布前 `bun unlink` 切回 npm 包。

---

## Immutability and Cleanup

### Immutable Publication

immutable publication 使用 manifest-last commit protocol：先在 workflow-run staging prefix 上传并校验全部 artifacts/metadata，再以禁止覆盖的写入复制到目标 versioned path，最后才写入 `manifest.json` 作为正式发布提交点并回读验证。目标路径出现部分对象但没有有效 manifest 时属于 failed attempt，不是已发布版本；只有在确认没有 latest/updater/Release 页面引用，并能用 workflow run/transaction metadata 证明对象 ownership 时，才允许显式清理后从修复 commit 同版本重试。无法证明 ownership 时 fail closed。

versioned manifest 已提交后，mutable latest promotion 可以独立重试，但必须直接读取已提交的 immutable release，不重新构建或生成第二份 release context。新的 workflow dispatch 不能接管已经提交或部分写入的同一 product/version。

版本化 R2 路径不可覆盖。若 source、配置或 artifact 有任何变化：stable 增加 PATCH，Desktop beta 增加 prerelease 序号，创建新的 namespaced tag 和 versioned path。

已提交的正式 release 禁止 retag。cleanup 对未知 tag/manifest fail-closed；解析失败的对象报告错误并保留，不默认删除。latest 引用对象在任何 retention 规则之前受到保护；正式 namespaced product tag 不进入普通 retention 删除候选，只有 [Failed Attempt and Whole-Version Withdrawal](#failed-attempt-and-whole-version-withdrawal) 显式 withdrawal 能在健康 aliases 恢复后删除指定失败版本的 tag。

### Cleanup Contract

release cleanup 不得使用字符串比较、`sort -V`、文件修改时间或旧 `X.Y.Z-N` comparator 推断"更新版本"。它先构建 release reference graph：

1. 分别读取 CLI latest（含 rc）、Desktop stable latest、Desktop beta latest 和 updater feed。
2. 校验引用的 product/channel/version 与目标 versioned manifest 一致。
3. 只在同一 product/channel 内用标准 SemVer 评估明确的 retention 候选；legacy release 由 legacy reader 分类，但不与新 release 混排后自动删除。
4. 未知目录、schema 错误、悬空引用或 hash 不一致的对象全部保留并使 cleanup 失败。

cleanup 输出待删除对象与保护原因的审计清单后才执行。任何 cleanup 失败都不能阻止客户端继续读取上一次有效 aliases。

**Retention 保留数量**（release 脚本发布成功后自动触发 cleanup 时使用的默认值）：

| 产品 | 渠道 | 保留数量 | 说明 |
|------|------|---------|------|
| `ellamaka-cli` | stable | 3 | 保留最新 3 个正式版本 |
| `ellamaka-cli` | rc | 2 | 保留最新 2 个 rc 候选；与 stable 共用同一个 R2 存储桶（`ellamaka/v*`），语义等同 stable，但保留计数独立，不占用 stable 名额 |
| `ellamaka-desktop` | stable | 3 | 保留最新 3 个正式版本 |
| `ellamaka-desktop` | beta | 2 | 保留最新 2 个 beta 候选版本 |

保留数量按同一 product/channel 内标准 SemVer 降序计数，从最老的版本开始删除，直到只剩保留数量个。CLI rc 与 stable 处于同一路径空间、以稳定渠道语义对待，但在保留计数上与 bare stable 独立：rc 按 `-rc.N` 序列单独保留 2 个，stable 单独保留 3 个，二者互不蚕食名额。latest 别名通常指向最新版本，天然在保留名额内；作为防御，latest 指向的版本即使落在保留名额之外也永不删除。legacy 版本 fail-closed 保留。`cleanup-releases.yml` 的 `keep-stable`/`keep-beta`/`keep-rc` inputs 可覆盖这些默认值。

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

| 层 | 是什么 | 构建方式 |
| --- | ------ | -------- |
| Electron 壳子 | 窗口、菜单、系统集成、electron-updater | `electron-builder` 打包 |
| Sidecar 引擎 | Ellamaka HTTP/WS/PTY 后端 | `packages/opencode/script/build-node.ts` → Node.js runtime bundle |

Sidecar 是 Node.js runtime（`build-node.ts` 产 `dist/node/`），**不是** Bun compile 的 CLI binary，因此不存在 CLI 的 native vs baseline（AVX2）二分——Node.js 代码由 V8 JIT 在运行时自适应 CPU 指令集。

构建链路：`bun packages/opencode/script/build-node.ts`（sidecar）→ `cd packages/ellamaka-desktop && bun run build`（electron-vite 编译 main/preload/renderer）→ `bun run package:mac|win|linux`（electron-builder 打包）。本地快捷方式：`./scripts/build.sh desktop [--channel main|beta|prod] [--platform mac|linux|win] [--install]`——mac 平台本地打包，linux/win 平台自动走 GitHub Actions 构建并下载产物（CI 仅支持 beta|prod 渠道，`--install` 仅本地构建生效）。

### Artifact Contract

产物由 `electron-builder` 按 `electron-builder.config.ts` 生成，`artifactName` 模板为 `ellamaka-desktop-${os}-${arch}.${ext}`：

| OS | Arch | 产物 | 说明 |
| --- | ---- | ---- | ---- |
| macOS | arm64 | `.dmg` + `.zip` | DMG 是用户安装包；ZIP 供 electron-updater 使用 |
| macOS | x64 | `.dmg` + `.zip` | 同上 |
| Windows | x64 | `.exe`（NSIS） | 一键安装及 updater payload |
| Linux | arm64 | `.AppImage` + `.deb` | AppImage 免安装，deb 可选 |
| Linux | x64 | `.AppImage` + `.deb` | AppImage 免安装，deb 可选 |

Contract：

1. `main` 只用于本地构建；发布 workflow 只接受 `beta` / `prod`。
2. `prod` channel 的 `appId` 为 `ai.ellamaka.desktop`，deep link scheme 为 `ellamaka://`。
3. beta 与 prod 的版本化目录和 latest feed 相互独立，也不与 CLI 混用。
4. 自动更新 feed（`latest-mac.yml` / `latest.yml` / `latest-linux.yml`）与安装包同传 R2。
5. Release 下载表展示 DMG、EXE、AppImage 和 deb。ZIP 与 blockmap 属于 updater 资产。

### 安装入口

Desktop 有两个安装入口：wopal-site 下载页和 `wopal ellamaka install`。两者消费相同 Desktop manifest 与原生安装包。

手动入口由用户下载对应平台安装包。CLI 入口优先发现已有系统安装。缺失时，macOS 从 ZIP 安装到 `~/Applications/Ellamaka.app`，Windows 通过 NSIS current-user 模式安装到 `%LOCALAPPDATA%\Programs\Ellamaka`，Linux 把 AppImage 安装到 `${XDG_DATA_HOME:-~/.local/share}/ellamaka/` 并创建 desktop entry。完成后重新探测应用版本。Sidecar 和 Ellamaka 配置仍写入 `WOPAL_HOME`。

`wopal ellamaka install --beta` 安装 beta Desktop 到独立位置（不同 appId，不覆盖 prod 安装）：

| 平台 | CLI-managed beta Desktop 位置 |
| ---- | ----------------------------- |
| macOS | `~/Applications/Ellamaka Beta.app` |
| Windows | `%LOCALAPPDATA%\Programs\Ellamaka Beta\` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/ellamaka-beta/Ellamaka Beta.AppImage` |

Beta Desktop 与 prod Desktop 可共存。CLI 通过 appId 区分，不混淆安装位置。

### 自动更新

`electron-builder` 的 `publish` 配置使用 generic provider，feedURL 指向 R2 `ellamaka-desktop/latest/`，**不走 GitHub Release**（与 CLI canonical source 一致）。macOS 用 `latest-mac.yml`，Windows 用 `latest.yml`，Linux 用 `latest-linux.yml`。

beta 与 prod 启用 electron-updater。prod 使用稳定 latest feed；beta 使用独立 beta latest feed 并允许 prerelease。main 本地构建不启用 updater。macOS ZIP、Windows NSIS EXE、AppImage 及对应 blockmap 位于 updater latest 路径，普通下载表只展示用户安装产物。

增量更新机制：macOS ZIP、Windows NSIS、Linux AppImage 基于 blockmap 支持增量；macOS DMG 不支持（必须全量下载）。增量更新生效条件：feed 包含 `packages[].path` 和 `sha2` 字段、R2 上传包含对应 `.blockmap` 文件、客户端版本严格小于已通过 manifest policy gate 授权的 feed 版本。

**Channel 隔离**：不同 channel 是独立应用（`electron-builder.config.ts` 分配不同 appId）：

| Channel | appId |
| ------- | ----- |
| main | `ai.ellamaka.desktop.main` |
| beta | `ai.ellamaka.desktop.beta` |
| prod | `ai.ellamaka.desktop` |

不允许跨 channel 升级：prod 用户不能直接升到 beta，beta 用户不能直接切到 prod——macOS/Windows 视为不同应用，必须卸载后重装。`autoUpdater.allowDowngrade` 即使因兼容 electron-updater 的技术路径暂时保留，也不能授权更新；ReleaseIdentity policy gate 只允许同一 product/channel 的标准 SemVer 前进。切换 channel 是显式操作（卸载重装），不应该是自动行为。

macOS 特殊处理：ad-hoc 签名的 app 升级时，`quitAndInstall` 可能因 quarantine 导致启动失败。安装前 `xattr -d com.apple.quarantine` 新版本（如果可能），并引导用户在新版本首次启动时执行"右键 → 打开"操作。

### 代码签名

P1 使用 ad-hoc 签名。该签名保证 macOS app bundle 结构完整并通过 `codesign --verify --deep --strict`，不提供开发者身份认证或 Apple notarization。

未签名的用户体验约束：macOS 首次打开需右键 → 打开或"仍要打开"；Windows SmartScreen 警告需"仍要运行"；Linux AppImage 需 `chmod +x`。

正式签名属于后续阶段：macOS 需 Apple Developer ID Application 证书 + `notarytool` 公证（`hardenedRuntime`/`notarize`）；Windows 需代码签名证书（OV 或 EV，`CSC_LINK`/`CSC_KEY_PASSWORD` 经 CI secrets 注入）；Linux 可选 GPG 签名。

---

## Install Contract

所有用户级路径都解析到 `WOPAL_HOME`（默认值见产品级文档 [`安装路径与 WOPAL_HOME`](../../../docs/products/wopal-space/DESIGN-distribution.md#13-安装路径与-wopal_home)）。

| Platform | Binary path | Runtime roots |
| -------- | ----------- | ------------- |
| macOS / Linux | `$WOPAL_HOME/bin/ellamaka` | `$WOPAL_HOME/ellamaka/{config,data,cache,state}` |
| Windows | `$WOPAL_HOME/bin/ellamaka.exe` | `$WOPAL_HOME/ellamaka/{config,data,cache,state}` |

### 分发渠道与安装契约

ellamaka CLI 的分发渠道：主路径 `wopal ellamaka install` 完整安装或 Desktop onboarding 的 `install-engine` machine operation；CLI-only 路径 `wopal ellamaka install --cli`；手动下载（Release 页面点击 R2 链接）。

consumer（wopal-cli 或 Desktop）安装 ellamaka 时遵循以下契约：

- 只从 R2 读取机器契约：cli-only 读取 CLI `latest/manifest.json`；完整产品读取 Desktop channel latest 与 CLI latest。
- CLI-only 安装默认使用 Engine latest；完整产品安装和 onboarding 校验同一个 CLI latest。
- 修改本机前解析并验证完整安装计划；CLI latest 不兼容时明确失败并建议刷新或重试，不搜索历史版本。
- 根据平台和稳定 artifact naming 计算目标文件名，不依赖 GitHub API 解析 release 页面。
- 安装目标固定为上述 binary path；放置前必须校验 SHA-256；安装后执行 `ellamaka --version` 作为健康验证。
- `$WOPAL_HOME/bin/` 只保存 executable。artifact 收据写入 `$WOPAL_HOME/ellamaka/state/ellamaka-install.json`；旧 `.ellamaka.meta.json` 在成功安装时迁移并删除。
- consumer 负责下载、校验、放置和状态报告；ellamaka 的运行目录（`$WOPAL_HOME/ellamaka/`）由 ellamaka 自身管理。

### Channel Consumption

`wopal ellamaka install --beta` 安装 beta Desktop 与 stable CLI。`--beta` 只影响 Desktop manifest 来源，不把 CLI 隐式切换到 prerelease channel。`--beta --cli` 是无意义的参数组合，必须返回 option conflict。

CLI rc 与 stable 共用同一 feed：`ellamaka/latest` 指向最新 CLI 发布（含 rc）。`wopal ellamaka install --cli` 与 `ellamaka upgrade` 通过 latest 直接获得 rc 版本，无需任何额外参数。rc 一经进入 latest，即对所有 CLI 消费者可见——发布 rc 与发布 stable 承担相同的质量承诺。Desktop 消费侧不受 CLI rc 影响，其稳定 feed 只引用无 prerelease 的 Desktop 版本。

### Runtime Handoff

ellamaka 安装完成后，运行时加载链路按 WopalSpace mode 工作：

1. 读取全局配置根 `~/.wopal/ellamaka/config/`
2. 自动检测到 WopalSpace 后加载 `<space>/.wopal/`
3. 合并 `<space>/.wopal/config/settings.jsonc` 中的 `ellamaka` 与 `tui` 配置
4. 加载 `<space>/.wopal/agents/*.md`
5. 加载 `<space>/.wopal/commands/*.md`
6. 加载 `<space>/.wopal/plugins/`

分发阶段只负责 binary 可达。space-local 配置与 plugin 依赖由 ontology 提供、ellamaka 加载；`.wopal-space/` runtime files 由 CLI materialize、ontology commands 维护；setup orchestration 由 wopal-cli 的 `wopal setup` 负责。

---

## Update Authorization

更新决策按以下顺序执行：

1. 校验 manifest schema、product、channel 和不可变字段。
2. 按兼容契约校验目标 latest manifest。
3. 使用标准 SemVer 比较同一产品、同一 channel 的 `releaseIdentity.version`。CLI rc 与 stable 同 channel，直接按 SemVer precedence 比较（`2.0.3` < `2.0.4-rc.1` < `2.0.4`），无需特判。
4. 校验预期 version、source identity 和 artifact SHA-256。
5. 运行时版本检查（[Runtime Version Guarantees](#runtime-version-guarantees)）：本机 wopal-cli `>= MIN_WOPAL_CLI_VERSION`，且本机 ellamaka CLI 主版本与目标 Desktop 主版本一致；不满足 → 拒绝更新并提示，不静默放行。
6. 在修改本机前先形成包含 Desktop、外部 CLI 和 Wopal CLI requirement 的完整安装计划，并确认所有 manifest 和下载均可验证。
7. 才允许按"外部 CLI → Desktop → 最终健康检查与收据"的顺序落盘；失败不得把未验证的部分安装状态报告为成功。

Desktop 保留自己的 manifest policy gate。electron-updater 负责平台 feed、下载、签名检查和安装，不单独决定跨 channel、兼容性或 release identity 授权。其返回的 update version 必须等于已经授权的 Desktop manifest version。

---

## Legacy Migration

历史 `X.Y.Z-N` 和 `X.Y.Z-N.rcM` 保持不可变归档。迁移 reader 可以将它们解析为 legacy identity，供识别当前安装和迁移路径使用，但新 publisher 不再生成这些格式，也不把 legacy comparator 用于新 release。新 CLI rc 的标准 SemVer 形状 `X.Y.Z-rc.N` 与 legacy `X.Y.Z-N.rcM` 迭代格式无关，publisher 将其作为正式 release 处理，沿用 [Immutability and Cleanup](#immutability-and-cleanup) 的 immutability 边界。

第一批标准 Ellamaka 产品版本必须在 SemVer precedence 上高于所有已发布 legacy 版本。legacy `X.Y.Z-N` 是 prerelease，同 base 的正式版 `X.Y.Z` 在 SemVer 2.0 中天然高于它，因此 migration floor 是最高 legacy 版本的同 base 正式版（如 `1.15.13-4` → floor `1.15.13`）。同 base 版本本身已被 tag/R2 占用检查拦截，后续 patch（`1.15.14`）可跟随 OpenCode baseline 发布。实际版本由迁移时的最高已发布版本决定。

迁移期规则：

1. 生成一次 legacy inventory（现存 tag、R2 versioned path、manifest、artifact SHA-256、channel alias 和可确认的 source commit）并从此冻结。若历史上同一个 legacy version 曾被覆盖，只能把切换时仍可验证的 R2 snapshot 归档为当前事实；无法重建的旧 build 不得伪造 identity。
2. 检测到本机 legacy binary 与 inventory hash 不一致时，将其标记为 `legacy-unknown-build`，允许迁移到第一批标准版本，但不能据此覆盖或回写历史 release。
3. 先发布支持新旧 manifest 的 reader，publisher 双写顶层兼容字段与结构化 ReleaseIdentity，再切换 tag、workflow、latest 和 cleanup 到新规则，最后迁移 Desktop 与 Wopal CLI 消费者。达到旧客户端淘汰门槛后再删除旧字段和 legacy parser；历史对象不重写。

---

## Related Documents

| 文档 | 说明 |
| ---- | ---- |
| `../../../docs/products/wopal-space/DESIGN-distribution.md` | 产品级分发总设计：R2 架构、缓存策略、完整性模型、版本体系、跨产品协调、Release 索引策略 |
| `../../../docs/products/wopal-space/DESIGN.md` | 产品级架构与版本体系 |
| `../../../docs/products/wopal-space/DESIGN-onboarding.md` | onboarding 架构、setup 完整流程、版本兼容矩阵维护 |
| [`./BRANDING.md`](./BRANDING.md#ellamaka-desktop-桌面应用) | ellamaka 品牌注入点清单与桌面分发身份 |
| `../../wopal-cli/docs/DESIGN-distribution.md` | wopal-cli 对 ellamaka release 的消费契约 |
| `../../../.wopal/docs/DESIGN-distribution.md` | ontology materialization 与 runtime handoff 边界 |