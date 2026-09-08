#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$(basename "$0")"

# 设置引擎上下文后进入共享发布主流程
SUBCOMMAND="cli"
PRODUCT="ellamaka-cli"
LABEL="CLI"
WORKFLOW="publish-ellamaka-cli.yml"
CHANNEL_LABEL="stable"
PRERELEASE_KIND="rc"
ALLOWED_BUMPS="--patch --minor --major --rc"

AUTO_BUMP=""
DRY_RUN=false
NO_PUSH=false
NO_WATCH=false
NO_CLEANUP=""
ASSUME_YES=false
VERSION=""
REMOTE="origin"

usage() {
  cat <<EOF
$SCRIPT — 发布 CLI 版本：版本推断 → bump → 提交 → tag → push（tag 触发 workflow）→ watch

发布模型（docs/DISTRIBUTION.md §3.2/§4.1）：cli 与 desktop 各自独立序列，
以已成功发布的 git tag 记录为版本推进唯一依据（无版本线/锚点）。本产品
package.json 发布时写目标版本，根 + 依赖包统一镜像两产品较高 base。

用法:
  $SCRIPT [选项] [--] [version]

Bump 类型:
  --patch     正式版发布：无已发正式版时转正现行 rc 候选，否则已发正式版 +1
              直接发新正式版（2.0.4 → 2.0.5）
  --minor     现行 base minor +1（2.0.4 → 2.1.0），开新线
  --major     现行 base major +1（2.0.4 → 3.0.0），开新线
  --rc        候选发布：同 base 已有 -rc.N 则 N+1，否则已发正式版下一 patch
              的 -rc.1（2.0.4 已发 → 2.0.5-rc.1）
  （默认 --patch）

选项:
  --dry-run    只打印发布计划，不写入、不 tag、不 push、不 dispatch
  --no-push    bump 并提交 + 本地 tag，但不 push（留待人工检查）
  --no-watch   不 watch workflow 运行结果
  --no-cleanup 发布成功后跳过历史清理 workflow（默认自动触发）
  -y, --yes    工作区有未提交变更时不征询，直接继续（非交互场景需显式给出）
  -h, --help   显示本帮助

分支渠道约束（branch-channel policy）：
  main 分支可发布全部版本；非 main 分支（poc-* 等）只允许 prerelease ——
  CLI X.Y.Z-rc.N，且 prerelease base 必须高于已发布 prod/stable 的最高版本。

re-release（幂等）：目标 tag 已在远端存在时——
  tag 有有效 R2 manifest → 拒绝（发布不可变），请用更高版本号；
  tag 无 manifest（failed attempt）→ 以该 tag 重新 dispatch workflow，不重复 bump。

示例:
  $SCRIPT --rc            # 2.0.4 已发 → 2.0.5-rc.1；已有 2.0.5-rc.1 → 2.0.5-rc.2
  $SCRIPT --patch         # 无 stable 时转正 rc（2.0.5-rc.1 → 2.0.5）；
                          # 已发 2.0.4 → 2.0.5（semver patch+1 直接发正式版）
  $SCRIPT --minor         # 现行 base 2.0.5 → 2.1.0
  $SCRIPT --dry-run       # 预览
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage ;;
    --dry-run) DRY_RUN=true; shift ;;
    --no-push) NO_PUSH=true; shift ;;
    --no-watch) NO_WATCH=true; shift ;;
    --no-cleanup) NO_CLEANUP="true"; shift ;;
    -y|--yes) ASSUME_YES=true; shift ;;
    --patch) AUTO_BUMP="stable"; shift ;;
    --minor) AUTO_BUMP="minor"; shift ;;
    --major) AUTO_BUMP="major"; shift ;;
    --rc) AUTO_BUMP="rc"; shift ;;
    --channel|--beta) die "CLI 只支持 --patch/--minor/--major/--rc；beta 渠道属于 Desktop" ;;
    -*) die "未知选项: $1" ;;
    *)
      [ -z "$VERSION" ] || die "重复的版本参数: ${VERSION} 与 $1"
      VERSION="$1"
      shift
      ;;
  esac
done

[ -n "$AUTO_BUMP" ] || AUTO_BUMP="stable"

SCRIPT_DIR="$(cd "$(dirname "$(realpath "$0")")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$REPO_ROOT/scripts/lib/release.sh"
run_release
