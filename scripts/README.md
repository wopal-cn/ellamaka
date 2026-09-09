# scripts — 构建、开发与发布脚本

本目录集中了 ellamaka 的构建、开发、发布与上游合并工具。所有脚本基于脚本自身位置解析项目根，因此**可在任意 worktree 内执行**，产物落在当前 worktree 的 `dist/` 等目录，不污染 main。

## 构建与发布

### `build.sh` — 编译 CLI / Desktop

```bash
./scripts/build.sh cli [options]      # 构建 CLI 二进制（本机跨平台）
./scripts/build.sh desktop [options]  # 构建 Electron 桌面应用
```

CLI 常用选项：

| 选项 | 说明 |
|------|------|
| `--channel <main\|prod>` | 渠道（默认 `main`）。`main` → `ellamaka-main.db`；`prod` → `ellamaka.db`（共享发布库） |
| `--version <ver>` | 覆盖构建版本 |
| `--platform <mac\|linux\|win>` | 目标平台（逗号分隔） |
| `--arch <arm64\|x64>` | 目标架构（逗号分隔） |
| `--web-ui <value>` | 内嵌 Web UI：`ellamaka-app`（默认）、`app`、`none` |
| `--install` | 安装二进制（软链到 `~/.wopal/bin`） |

Desktop 平台策略：本机 mac + `--platform mac`（默认）→ 本地构建；`--platform linux\|win` → dispatch GitHub Actions CI 并下载产物。CI 构建仅接受 `--channel beta\|prod`（`main` 仅本地）。

### `release-cli.sh` / `release-desktop.sh` — 一步发布 CLI / Desktop 版本

```bash
./scripts/release-cli.sh [--patch|--minor|--major|--rc] [--dry-run] [--no-push] [--no-watch] [--no-cleanup] [version]
./scripts/release-desktop.sh [--patch|--minor|--major|--beta] [--dry-run] [--no-push] [--no-watch] [--no-cleanup] [version]
```

统一版本线模型：根 `package.json` 是产品版本线 base 的唯一真相源，两个产品锚点（`ellamaka-cli` / `ellamaka-desktop`）只承载通道状态（`-rc.N` / `-beta.N`）。目标 base 永远等于版本线 base，版本号自动推断：

- `--patch`（默认）：发布版本线 base 本身（`2.0.4-rc.2` → `2.0.4`，候选转正）
- `--rc` / `--beta`：候选通道续发（同 base 续 N+1，锚点落后时从新 base 的 `.1` 起步）
- `--minor` / `--major`：开新版本线（根 + 依赖包镜像同步 bump）
- Desktop 无独立渠道参数：`--beta` 即 beta 渠道（发布到 `ellamaka-desktop/beta/`），缺席即 prod

流程：推断 → bump 锚点 → 提交 → namespaced tag → 推送（tag push 触发 workflow）→ watch → 自动触发历史清理。非 main 分支只允许 prerelease。目标 tag 已在远端时：有 manifest 拒绝（不可变），无 manifest 以该 tag 重发（幂等）。`--dry-run` 只打印发布计划不执行。

### `withdraw-release.sh` — 整版撤回已发布版本

```bash
./scripts/withdraw-release.sh <cli|desktop> [--channel <stable|beta>] [version] [--dry-run]
```

按 `docs/DISTRIBUTION.md §7.3` 撤回：登记到 `release/withdrawn-versions.json`，再 dispatch cleanup 的 withdraw 模式执行远端删除。版本默认取该渠道最新发布版本，fallback 为该渠道上一版本。

## 开发

### `dev.sh` — 本地开发服务器

```bash
./scripts/dev.sh <command> [options]
```

| 命令 | 说明 |
|------|------|
| `tui` | 启动 TUI（默认进程内后端） |
| `serve` | 启动 HTTP 后端 + Workbench |
| `restart [target]` | 重启后端 / Workbench / 全部 |
| `status` | 显示运行中的开发实例 |
| `desktop` | 构建并启动 Electron 桌面应用（后台） |
| `stop [target]` | 停止后端 / Workbench / 桌面 / 全部 |

开发模式 channel 固定为 `local`（`ellamaka-local.db`）。

### `scalar-doc.ts` — Scalar API 文档调试

```bash
bun run scripts/scalar-doc.ts
# SCALAR_PORT=8080 SCALAR_API=http://127.0.0.1:3000 bun run scripts/scalar-doc.ts
```

在独立端口提供 Scalar UI，并把 API 请求代理到 ellamaka，支持 "Try it out" 调试。默认 `http://localhost:4100`，代理到 `http://127.0.0.1:4097`。

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
