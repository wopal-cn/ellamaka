#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SDK_PACKAGE="$REPO_ROOT/packages/sdk/js/package.json"
PLUGIN_PACKAGE="$REPO_ROOT/packages/plugin/package.json"
PUBLISH_CLI="$REPO_ROOT/packages/ellamaka-release/src/cli/publish-npm.ts"
WORKFLOW="publish-ellamaka-npm.yml"
REMOTE="origin"

CONFIRM=false
DRY_RUN=false
ASSUME_YES=false
NO_PUSH=false
NO_WATCH=false
BUMP="patch"
BUMP_EXPLICIT=false
VERSION=""

usage() {
  cat <<EOF_USAGE
$SCRIPT — 独立发布 @wopal/ellamaka-sdk / @wopal/ellamaka-plugin

npm 包拥有自己的 SemVer，不跟随 CLI/Desktop 产品版本。两个公开包共享同一 npm
release version，SDK 先发布、Plugin 后发布。

用法:
  $SCRIPT [--patch|--minor|--major] [选项] [--] [version]

默认 dry-run；加 --confirm 才执行版本写入、提交、tag、push，并由独立 workflow
发布 npm。当前 SDK/Plugin 均为已发布版本时，默认 --patch 推进一个 patch。

选项:
  --patch      patch +1（默认）
  --minor      minor +1
  --major      major +1
  --confirm    执行发布
  --dry-run    显式预览（与 --confirm 互斥）
  -y, --yes    非交互确认
  --no-push    只 bump/commit/tag，不 push
  --no-watch   push 后不等待 workflow
  -h, --help   显示帮助

也可显式给出版本，例如:
  $SCRIPT 2.0.11
  $SCRIPT 2.1.0 --confirm -y
EOF_USAGE
}

die() {
  printf '错误: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --patch|--minor|--major)
      [ "$BUMP_EXPLICIT" = false ] || die "只能指定一个 bump 类型"
      BUMP="${1#--}"
      BUMP_EXPLICIT=true
      shift
      ;;
    --confirm) CONFIRM=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -y|--yes) ASSUME_YES=true; shift ;;
    --no-push) NO_PUSH=true; shift ;;
    --no-watch) NO_WATCH=true; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) die "未知选项: $1" ;;
    *)
      [ -z "$VERSION" ] || die "重复的版本参数: $1"
      VERSION="$1"
      shift
      ;;
  esac
done
while [ "$#" -gt 0 ]; do
  [ -z "$VERSION" ] || die "重复的版本参数: $1"
  VERSION="$1"
  shift
done

$CONFIRM && $DRY_RUN && die "--confirm 与 --dry-run 互斥"
$CONFIRM || DRY_RUN=true

CURRENT_SDK="$(node -p "require('$SDK_PACKAGE').version")"
CURRENT_PLUGIN="$(node -p "require('$PLUGIN_PACKAGE').version")"
[ "$CURRENT_SDK" = "$CURRENT_PLUGIN" ] || die "SDK/Plugin 版本不一致: sdk=$CURRENT_SDK plugin=$CURRENT_PLUGIN"

SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+$'
[[ "$CURRENT_SDK" =~ $SEMVER_RE ]] || die "当前 npm 版本必须是 stable X.Y.Z: $CURRENT_SDK"

if [ -z "$VERSION" ]; then
  [[ "$CURRENT_SDK" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || die "当前 npm 版本无效: $CURRENT_SDK"
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  patch="${BASH_REMATCH[3]}"
  case "$BUMP" in
    patch) VERSION="$major.$minor.$((patch + 1))" ;;
    minor) VERSION="$major.$((minor + 1)).0" ;;
    major) VERSION="$((major + 1)).0.0" ;;
  esac
fi
[[ "$VERSION" =~ $SEMVER_RE ]] || die "npm 发布入口只支持 stable X.Y.Z，得到: $VERSION"
node - "$CURRENT_SDK" "$VERSION" <<'NODE' || die "目标版本 $VERSION 低于当前 npm 版本 $CURRENT_SDK"
const semver = require('semver')
const current = process.argv[2]
const target = process.argv[3]
if (!semver.valid(current) || !semver.valid(target) || semver.lt(target, current)) process.exit(1)
NODE

TAG="ellamaka-npm-v$VERSION"

if $DRY_RUN; then
  cat <<EOF_PLAN

── npm dry-run 发布计划 ──
  current:   $CURRENT_SDK
  version:   $VERSION
  packages:  @wopal/ellamaka-sdk, @wopal/ellamaka-plugin
  tag:       $TAG
  workflow:  $WORKFLOW
  写入:      packages/sdk/js/package.json + packages/plugin/package.json
  push:      $REMOTE main + $TAG
EOF_PLAN
  exit 0
fi

BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "npm 正式发布只允许从 main 执行，当前分支: $BRANCH"
if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  git -C "$REPO_ROOT" status --short >&2
  die "工作区不干净；npm 发布要求 clean main"
fi

git -C "$REPO_ROOT" fetch "$REMOTE" main >/dev/null 2>&1 || die "无法 fetch $REMOTE/main"
LOCAL_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"
REMOTE_HEAD="$(git -C "$REPO_ROOT" rev-parse "$REMOTE/main")"
[ "$LOCAL_HEAD" = "$REMOTE_HEAD" ] || die "main 与 $REMOTE/main 不一致；请先同步后再发布"
REMOTE_TAG="$(git -C "$REPO_ROOT" ls-remote --tags "$REMOTE" "refs/tags/$TAG")" || \
  die "无法查询远端 tag $TAG；已停止发布"
if git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null || [ -n "$REMOTE_TAG" ]; then
  die "tag 已存在: $TAG；失败重试请使用 workflow_dispatch 并以该 tag 为 ref"
fi

if ! $ASSUME_YES; then
  [ -t 0 ] || die "非交互终端执行 --confirm 时必须加 -y/--yes"
  printf '确认发布 npm %s？[y/N] ' "$VERSION"
  read -r reply || true
  case "$reply" in y|Y|yes|YES) ;; *) die "已取消发布" ;; esac
fi

if [ "$VERSION" != "$CURRENT_SDK" ]; then
  node - "$SDK_PACKAGE" "$PLUGIN_PACKAGE" "$VERSION" <<'NODE'
const fs = require('fs')
for (const path of process.argv.slice(2, 4)) {
  const pkg = JSON.parse(fs.readFileSync(path, 'utf8'))
  pkg.version = process.argv[4]
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
}
NODE
  (cd "$REPO_ROOT" && bun install --lockfile-only >/dev/null) || die "bun install --lockfile-only 失败"
fi

# 独立 npm 预检：目标已存在时验证内容一致；目标未发布时仅确认 plan 可发布。
bun "$PUBLISH_CLI" --check --version "$VERSION" || die "npm 发布预检失败"

if [ "$VERSION" != "$CURRENT_SDK" ]; then
  git -C "$REPO_ROOT" add -- packages/sdk/js/package.json packages/plugin/package.json bun.lock
  git -C "$REPO_ROOT" commit --only -m "chore(release): bump npm packages to $VERSION" -- \
    packages/sdk/js/package.json packages/plugin/package.json bun.lock
fi

git -C "$REPO_ROOT" tag -a "$TAG" -m "Release $TAG"

if $NO_PUSH; then
  echo "ℹ️  已创建 $TAG（--no-push，未推送）"
  exit 0
fi

git -C "$REPO_ROOT" push "$REMOTE" main "$TAG"

if $NO_WATCH; then
  echo "ℹ️  已推送 $TAG；跳过 workflow 监控"
  exit 0
fi

if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
  echo "ℹ️  已推送 $TAG；gh 不可用，无法自动监控 workflow"
  exit 0
fi

HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
RUN_ID=""
for _ in $(seq 1 20); do
  RUN_ID="$(gh run list -R wopal-cn/ellamaka --workflow "$WORKFLOW" --event push \
    --json databaseId,headSha -q ".[] | select(.headSha == \"$HEAD_SHA\") | .databaseId" | head -n 1)"
  [ -n "$RUN_ID" ] && break
  sleep 3
done
[ -n "$RUN_ID" ] || die "已推送 $TAG，但未找到对应 npm workflow run"

gh run watch "$RUN_ID" -R wopal-cn/ellamaka --exit-status

echo "✅ npm release complete: $VERSION"
