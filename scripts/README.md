# scripts — 构建、开发与发布脚本

本目录集中了 ellamaka 的构建、开发、发布与上游合并工具。所有脚本基于脚本自身位置解析项目根，因此**可在任意 worktree 内执行**，产物落在当前 worktree 的 `dist/` 等目录，不污染 main。

## 目录边界

本目录**只放面向用户使用的便利脚本**：构建、开发、发布、调试四类。

- 新增脚本必须在下表登记，并补齐对应小节说明（做什么、怎么调、有什么前提）。
- CI 门禁、测试检查器、跨包工具这类代码**不放这里**，放在拥有该能力的 package 内。
  例如测试分层 runner 与测试隔离门禁在 `packages/opencode/script/`。
- `ci/` 与 `lib/` 是上述脚本的内部实现，不对外承诺接口。

## 脚本索引

| 脚本                  | 用途                                     |
| --------------------- | ---------------------------------------- |
| `build.sh`            | 构建 CLI / Desktop                       |
| `release-cli.sh`      | CLI 一步发布（推断 → bump → tag → push） |
| `release-desktop.sh`  | Desktop 一步发布                         |
| `release-npm.sh`      | SDK / Plugin 独立 npm 发布               |
| `withdraw-release.sh` | 整版撤回已发布版本                       |
| `dev.sh`              | 本地开发服务器（tui / serve / desktop）  |
| `scalar-doc.ts`       | Scalar API 文档调试                      |
| `dsh-migrate-home.sh` | DSH home 布局一次性迁移                  |

## 构建与发布

### `build.sh` — 编译 CLI / Desktop

```bash
./scripts/build.sh cli [options]      # 构建 CLI 二进制（本机跨平台）
./scripts/build.sh desktop [options]  # 构建 Electron 桌面应用
```

CLI 常用选项：

| 选项                           | 说明                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `--channel <main\|local>`      | 渠道（默认 `main`）。`main` → `ellamaka-main.db`；`local` → `ellamaka-local.db`；`stable`/`beta` → `ellamaka.db`（共享发布库） |
| `--version <ver>`              | 覆盖构建版本                                                                                                                   |
| `--platform <mac\|linux\|win>` | 目标平台（逗号分隔）                                                                                                           |
| `--arch <arm64\|x64>`          | 目标架构（逗号分隔）                                                                                                           |
| `--web-ui <value>`             | 内嵌 Web UI：`ellamaka-app`（默认）、`app`、`none`                                                                             |
| `--install`                    | 安装二进制（软链到 `~/.wopal/bin`）                                                                                            |

Desktop 平台策略：本机 mac + `--platform mac`（默认）→ 本地构建；`--platform linux\|win` → dispatch GitHub Actions CI 并下载产物。CI 构建仅接受 `--channel beta\|stable`（`main` 仅本地）。

### `release-cli.sh` / `release-desktop.sh` — 一步发布 CLI / Desktop 版本

```bash
./scripts/release-cli.sh [--patch|--minor|--major|--rc] [--dry-run] [--no-push] [--no-watch] [--no-cleanup] [version]
./scripts/release-desktop.sh [--patch|--minor|--major|--beta] [--dry-run] [--no-push] [--no-watch] [--no-cleanup] [version]
```

CLI 与 Desktop 各自按已成功发布的 namespaced tag 独立推进版本；产品 package.json 在发布动作内写目标版本。根 package.json 与产品内部 workspace 支持包只镜像两个产品现行 base 的较高者，`@wopal/ellamaka-sdk` / `@wopal/ellamaka-plugin` 明确排除，它们拥有独立 npm SemVer。

- `--patch`（默认）：候选未转正时转正现行 rc/beta base；否则 stable patch +1
- `--rc` / `--beta`：候选通道续发；无开放候选时从 stable 下一 patch 的 `.1` 起步
- `--minor` / `--major`：从该产品现行 base 升位开新线
- Desktop 无独立渠道参数：`--beta` 即 beta 渠道（发布到 `ellamaka-desktop/beta/`），缺席即 stable

流程：推断 → bump 产品/必要的内部版本 → 提交 → namespaced tag → 推送（tag push 触发对应 product workflow）→ watch → 自动历史清理。产品 workflow 不发布 npm 包，也不要求 npm 版本与产品版本一致。非 main 分支只允许 prerelease。目标 tag 已在远端时：有 manifest 拒绝（不可变），无 manifest 以该 tag 重发（幂等）。`--dry-run` 只打印发布计划不执行。

### `release-npm.sh` — 独立发布 SDK / Plugin npm 版本

```bash
./scripts/release-npm.sh [--patch|--minor|--major] [--dry-run] [--no-push] [--no-watch] [version]
```

`@wopal/ellamaka-sdk` 与 `@wopal/ellamaka-plugin` 共用一条独立 npm SemVer 线，当前版本以 SDK package.json 为锚点，两个 package.json 必须精确一致。当前发布入口只开放 stable `X.Y.Z`（尚未定义 npm prerelease/dist-tag 通道）；默认 `--patch`，也可显式给版本；正式执行只允许 clean `main` 且必须与 `origin/main` 对齐。

流程：版本 bump（仅 SDK + Plugin）→ npm publish preflight → commit → `ellamaka-npm-vX.Y.Z` tag → push → `publish-ellamaka-npm.yml`。独立 workflow 在 publish 前运行 publisher 回归测试、真实 pack，并在源码树外执行 clean-install smoke；npm OIDC trusted publisher 需授权该 workflow 文件。

### `withdraw-release.sh` — 整版撤回已发布版本

```bash
./scripts/withdraw-release.sh <cli|desktop> [--channel <stable|beta>] [version] [--dry-run]
```

按 [`docs/DESIGN-distribution.md` 整版撤回](./DESIGN-distribution.md#failed-attempt-and-whole-version-withdrawal) 规则撤回：登记到 `release/withdrawn-versions.json`，再 dispatch cleanup 的 withdraw 模式执行远端删除。版本默认取该渠道最新发布版本，fallback 为该渠道上一版本。

## 开发

### `dev.sh` — 本地开发服务器

```bash
./scripts/dev.sh <command> [options]
```

| 命令               | 说明                                 |
| ------------------ | ------------------------------------ |
| `tui`              | 启动 TUI（默认进程内后端）           |
| `serve`            | 启动 HTTP 后端 + Workbench           |
| `restart [target]` | 重启后端 / Workbench / 全部          |
| `status`           | 显示运行中的开发实例                 |
| `desktop`          | 构建并启动 Electron 桌面应用（后台） |
| `stop [target]`    | 停止后端 / Workbench / 桌面 / 全部   |

开发模式 channel 固定为 `local`（`ellamaka-local.db`）。

### `scalar-doc.ts` — Scalar API 文档调试

```bash
bun run scripts/scalar-doc.ts
# SCALAR_PORT=8080 SCALAR_API=http://127.0.0.1:3000 bun run scripts/scalar-doc.ts
```

在独立端口提供 Scalar UI，并把 API 请求代理到 ellamaka，支持 "Try it out" 调试。默认 `http://localhost:4100`，代理到 `http://127.0.0.1:4097`。

## 迁移

### `dsh-migrate-home.sh` — DSH home 布局一次性迁移

```bash
./scripts/dsh-migrate-home.sh
```

把旧布局搬进 official-layout DSH home（`$WOPAL_HOME/dsh/state/` → `home/`，
`profiles/` → `home/profiles/`）。幂等：已完成则 no-op，中断后可续跑。
迁移前用 `lsof +D` 检查是否有 bun/node/ellamaka 进程占用旧目录，有则直接退出。

## 共享库

### `lib/version.sh` — 版本解析

被 `build.sh` / `dev.sh` / `release-cli.sh` / `release-desktop.sh` 等 source 的共享函数库：

- `resolve_build_version <product> <suffix>` — 解析构建版本（下一 patch + 后缀 + 时间戳）
- `current_version <cli|desktop|deps>` — 版本源读取（产品锚点 package.json 是唯一版本源）
- `sync_min_wopal_cli_version` — 同步 `@wopal/cli-capability-schema` 依赖下界
- `resolve_min_wopal_cli_version` — 解析有效 `MIN_WOPAL_CLI_VERSION`
- `highest_release_tag` — 发布版本最高 tag 查询（failed-attempt 判定用）

发布版本推断已迁移至 `packages/ellamaka-release/src/version-line.ts`（统一版本线模型），由 `scripts/lib/release.sh` 调用。

## 推荐工作流

- **日常开发**：`dev.sh serve` → 改代码 → `build.sh cli` 验证
- **发布**：`release-cli.sh --rc` / `release-desktop.sh --beta`（一步制：推断 → bump → tag → push 触发 workflow）
- **撤回**：`withdraw-release.sh <product>`
