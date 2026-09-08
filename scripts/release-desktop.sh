#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$(basename "$0")"

# 设置引擎上下文后进入共享发布主流程
SUBCOMMAND="desktop"
PRODUCT="ellamaka-desktop"
LABEL="Desktop"
WORKFLOW="publish-ellamaka-desktop.yml"
PRERELEASE_KIND="beta"
ALLOWED_BUMPS="--patch --minor --major --beta"

# Desktop 单开关模型：--beta = beta 渠道 + beta bump；缺席即 prod 渠道。
AUTO_BUMP="stable"
CHANNEL="prod"
DRY_RUN=false
NO_PUSH=false
NO_WATCH=false
NO_CLEANUP=""
ASSUME_YES=false
VERSION=""
REMOTE="origin"

usage() {
  cat <<EOF
$SCRIPT — 发布 Desktop 版本：版本推断 → bump → 提交 → tag → push（tag 触发 workflow）→ watch

发布模型（docs/DISTRIBUTION.md §3.2/§4.1）：cli 与 desktop 各自独立序列，
以已成功发布的 git tag 记录为版本推进唯一依据（无版本线/锚点）。本产品
package.json 发布时写目标版本，根 + 依赖包统一镜像两产品较高 base。

用法:
  $SCRIPT [选项] [--] [version]

Bump 类型:
  --beta      beta 发布：同 base 已有 -beta.N 则 N+1（2.0.5-beta.1 →
              2.0.5-beta.2）；base 已转正则下一 patch 的 -beta.1（2.0.4 已发
              → 2.0.5-beta.1）
  --patch     prod 发布：无已发正式版时转正现行 beta 候选，否则已发正式版 +1
              （2.0.4 → 2.0.5）
  --minor     现行 base minor +1（2.0.5 → 2.1.0），开新线
  --major     现行 base major +1（2.0.5 → 3.0.0），开新线
  （默认 --patch）

选项:
  --dry-run    只打印发布计划，不写入、不 tag、不 push、不 dispatch
  --no-push    bump 并提交 + 本地 tag，但不 push（留待人工检查）
  --no-watch   不 watch workflow 运行结果
  --no-cleanup 发布成功后跳过历史清理 workflow（默认自动触发）
  -y, --yes    工作区有未提交变更时不征询，直接继续（非交互场景需显式给出）
  -h, --help   显示本帮助

渠道规则：
  --beta 给出 → beta 渠道（发布到 ellamaka-desktop/beta/，版本必须为 X.Y.Z-beta.N）
  缺席     → prod 渠道（发布到 ellamaka-desktop/，版本必须为纯 X.Y.Z）
  渠道与版本号的匹配由版本推断自动保证，无需（也无法）手工指定 --channel。

分支渠道约束（branch-channel policy）：
  main 分支可发布全部版本；非 main 分支（poc-* 等）只允许 prerelease ——
  Desktop X.Y.Z-beta.N，且 prerelease base 必须高于已发布 prod/stable 的最高版本。

re-release（幂等）：目标 tag 已在远端存在时——
  tag 有有效 R2 manifest → 拒绝（发布不可变），请用更高版本号；
  tag 无 manifest（failed attempt）→ 以该 tag 重新 dispatch workflow，不重复 bump。

示例:
  $SCRIPT --beta          # 2.0.4 已发 → 2.0.5-beta.1；已有 2.0.5-beta.1 → 2.0.5-beta.2
  $SCRIPT --patch         # 无 stable 时转正 beta（2.0.5-beta.1 → 2.0.5）；
                          # 已发 2.0.4 → 2.0.5（semver patch+1 直接发正式版）
  $SCRIPT --minor         # 现行 base 2.0.5 → 2.1.0（后续 --beta 发 2.1.0-beta.1）
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
    --beta) AUTO_BUMP="beta"; CHANNEL="beta"; shift ;;
    --patch) AUTO_BUMP="stable"; CHANNEL="prod"; shift ;;
    --minor) AUTO_BUMP="minor"; CHANNEL="prod"; shift ;;
    --major) AUTO_BUMP="major"; CHANNEL="prod"; shift ;;
    --rc) die "Desktop 没有 rc 渠道；候选请用 --beta" ;;
    --channel) die "release-desktop.sh 不接受 --channel：--beta 即 beta 渠道，缺席即 prod" ;;
    *) die "未知选项: $1" ;;
  esac
done

# 显式版本参数的渠道自动推断（beta.N → beta，纯 X.Y.Z → prod）
if [ -n "$VERSION" ]; then
  if [[ "$VERSION" =~ -beta\.[0-9]+$ ]]; then
    CHANNEL="beta"
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "$(realpath "$0")")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$REPO_ROOT/scripts/lib/release.sh"

# 显式版本走 stable 通道推断（version-line 只做 base 一致性校验）
if [ -n "$VERSION" ]; then
  AUTO_BUMP="stable"
fi

CHANNEL_LABEL="$CHANNEL"
run_release
