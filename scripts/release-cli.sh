#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$(basename "$0")"

# 参数解析在 source lib/release.sh 之前执行，而 lib 中的 die 定义在 source
# 后才生效——这里先提供一个同语义的最小实现（source 后会被 lib 同名函数覆盖），
# 避免解析错误路径崩溃成 "die: command not found" 的误导性报错。
die() {
  printf '错误: %b\n' "$*" >&2
  exit 1
}

# 设置引擎上下文后进入共享发布主流程
SUBCOMMAND="cli"
PRODUCT="ellamaka-cli"
LABEL="CLI"
WORKFLOW="publish-ellamaka-cli.yml"
CHANNEL_LABEL="stable"
PRERELEASE_KIND="rc"
ALLOWED_BUMPS="--patch --minor --major --rc"

AUTO_BUMP=""
CONFIRM=false
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

默认 dry-run：只打印发布计划（含 npm base 预检），不做任何写入。加
--confirm 才真正执行（执行前仍会 y/N 确认；自动化用 --confirm -y）。

Bump 类型:
  --patch     正式版发布：无已发正式版时转正现行 rc 候选，否则已发正式版 +1
              直接发新正式版（2.0.4 → 2.0.5）
  --minor     现行 base minor +1（2.0.4 → 2.1.0），开新线
  --major     现行 base major +1（2.0.4 → 3.0.0），开新线
  --rc        候选发布：同 base 已有 -rc.N 则 N+1，否则已发正式版下一 patch
              的 -rc.1（2.0.4 已发 → 2.0.5-rc.1）
  （默认 --patch）

选项:
  --confirm    执行发布（默认只打印计划；执行前交互终端还会 y/N 确认）
  --dry-run    显式预览（默认行为，兼容写法；与 --confirm 互斥）
  --no-push    bump 并提交 + 本地 tag，但不 push（留待人工检查）
  --no-watch   不 watch workflow 运行结果
  --no-cleanup（已废弃：清理由 publish workflow 的 cleanup job 负责）
  -y, --yes    跳过交互确认（--confirm 的非交互场景必须显式给出；工作区有
               未提交变更时也直接继续）
  -h, --help   显示本帮助

分支渠道约束（branch-channel policy）：
  main 分支可发布全部版本；非 main 分支（poc-* 等）只允许 prerelease ——
  CLI X.Y.Z-rc.N，且 prerelease base 必须高于已发布 stable 的最高版本。

re-release（幂等）：目标 tag 已在远端存在时——
  tag 有有效 R2 manifest → 拒绝（发布不可变），请用更高版本号；
  tag 无 manifest（failed attempt）→ 以该 tag 重新 dispatch workflow，不重复 bump。

示例:
  $SCRIPT --rc            # 预览：2.0.4 已发 → 2.0.5-rc.1；已有 2.0.5-rc.1 → 2.0.5-rc.2
  $SCRIPT --rc --confirm  # 执行上述发布
  $SCRIPT --patch --confirm -y   # 自动化执行（跳过 y/N，工作区脏也继续）
  $SCRIPT --dry-run       # 显式预览（同默认）
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage ;;
    --) shift; continue ;;
    --confirm) CONFIRM=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --no-push) NO_PUSH=true; shift ;;
    --no-watch) NO_WATCH=true; shift ;;
    --no-cleanup) shift ;; # 已废弃，占位兼容
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
$CONFIRM && $DRY_RUN && die "--confirm 与 --dry-run 互斥：去掉 --dry-run 即为执行模式"
# 语义映射：confirm 模型下 DRY_RUN=非 confirm（lib 的所有 $DRY_RUN 判定沿用）
$CONFIRM || DRY_RUN=true

SCRIPT_DIR="$(cd "$(dirname "$(realpath "$0")")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$REPO_ROOT/scripts/lib/release.sh"
run_release
