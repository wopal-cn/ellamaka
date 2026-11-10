#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PUBLISH_CLI="$REPO_ROOT/packages/ellamaka-release/src/cli/publish-npm.ts"
VERIFY_CLI="$REPO_ROOT/packages/ellamaka-release/src/cli/verify-npm.ts"
WORKFLOW="publish-ellamaka-npm.yml"
SDK="@wopal/ellamaka-sdk"
PLUGIN="@wopal/ellamaka-plugin"
CONFIRM=false
DRY_RUN=false
ASSUME_YES=false
NO_PUSH=false
NO_WATCH=false
BUMP=patch
VERSION=""
packages=()

die() { printf '错误: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
独立发布 SDK 和 Plugin。默认预览并选择两个包；可重复 --package 选择具体包。
用法: release-npm.sh [--package @wopal/ellamaka-sdk|@wopal/ellamaka-plugin] [--patch|--minor|--major] [version] [--confirm -y] [--no-push] [--no-watch]
显式 version 仅用于单包。选中包按各自的当前版本推进，SDK 先于 Plugin。
USAGE
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --package) [ "$#" -ge 2 ] || die '--package requires a value'; packages+=("$2"); shift 2 ;;
    --patch|--minor|--major) BUMP="${1#--}"; shift ;;
    --confirm) CONFIRM=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -y|--yes) ASSUME_YES=true; shift ;;
    --no-push) NO_PUSH=true; shift ;;
    --no-watch) NO_WATCH=true; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; [ "$#" -le 1 ] || die 'too many version arguments'; VERSION="${1:-}"; break ;;
    -*) die "unknown option: $1" ;;
    *) [ -z "$VERSION" ] || die 'duplicate version'; VERSION="$1"; shift ;;
  esac
done
$CONFIRM && $DRY_RUN && die '--confirm and --dry-run are mutually exclusive'
$CONFIRM || DRY_RUN=true
[ "${#packages[@]}" -gt 0 ] || packages=("$SDK" "$PLUGIN")
select_sdk=false
select_plugin=false
for pkg in "${packages[@]}"; do
  case "$pkg" in
    "$SDK") $select_sdk && die "duplicate package: $pkg"; select_sdk=true ;;
    "$PLUGIN") $select_plugin && die "duplicate package: $pkg"; select_plugin=true ;;
    *) die "unknown or private package: $pkg" ;;
  esac
done
[ -z "$VERSION" ] || [ "${#packages[@]}" -eq 1 ] || die 'explicit version requires one package'
packages=()
paths=()
$select_sdk && { packages+=("$SDK"); paths+=(packages/sdk/js/package.json); }
$select_plugin && { packages+=("$PLUGIN"); paths+=(packages/plugin/package.json); }
versions=()
for path in "${paths[@]}"; do
  current="$(node -p "require('$REPO_ROOT/$path').version")"
  target="$(cd "$REPO_ROOT" && node - "$current" "$BUMP" "$VERSION" <<'NODE'
const semver = require('semver')
const [current, bump, target] = process.argv.slice(2)
if (!semver.valid(current) || semver.prerelease(current)) process.exit(1)
const next = target || semver.inc(current, bump)
if (!semver.valid(next) || semver.prerelease(next) || semver.lt(next, current)) process.exit(1)
console.log(next)
NODE
)" || die "invalid version for $path"
  versions+=("$target")
done
TAG="ellamaka-npm"
for i in "${!packages[@]}"; do
  if [ "${packages[$i]}" = "$SDK" ]; then label=sdk; else label=plugin; fi
  TAG="${TAG}-v${versions[$i]}-${label}"
done
args=()
for pkg in "${packages[@]}"; do args+=(--package "$pkg"); done
printf '\n── npm release plan ──\n'
for i in "${!packages[@]}"; do printf '  %s: %s\n' "${packages[$i]}" "${versions[$i]}"; done
printf '  tag: %s\n  workflow: %s\n' "$TAG" "$WORKFLOW"
$DRY_RUN && exit 0
[ "$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)" = main ] || die 'npm release requires main'
[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ] || die 'npm release requires a clean worktree'
git -C "$REPO_ROOT" fetch origin main >/dev/null 2>&1 || die 'cannot fetch origin/main'
[ "$(git -C "$REPO_ROOT" rev-parse HEAD)" = "$(git -C "$REPO_ROOT" rev-parse origin/main)" ] || die 'main differs from origin/main'
remote_tag="$(git -C "$REPO_ROOT" ls-remote --tags origin "refs/tags/$TAG")" || die 'cannot check remote tag'
if git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null || [ -n "$remote_tag" ]; then die "tag exists: $TAG"; fi
if ! $ASSUME_YES; then
  [ -t 0 ] || die '--confirm requires --yes in a non-interactive terminal'
  read -r -p "确认发布 $TAG？[y/N] " reply || true
  case "$reply" in y|Y|yes|YES) ;; *) die 'cancelled' ;; esac
fi
for i in "${!paths[@]}"; do
  node - "$REPO_ROOT/${paths[$i]}" "${versions[$i]}" <<'NODE'
const fs = require('fs')
const [path, version] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(path, 'utf8'))
pkg.version = version
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
NODE
done
(cd "$REPO_ROOT" && bun install --lockfile-only >/dev/null) || die 'lockfile update failed'
bun "$PUBLISH_CLI" --check "${args[@]}" || die 'npm preflight failed'
bun "$VERIFY_CLI" "${args[@]}" || die 'npm clean-install failed'
if ! git -C "$REPO_ROOT" diff --quiet -- "${paths[@]}" bun.lock; then
  git -C "$REPO_ROOT" add -- "${paths[@]}" bun.lock
  git -C "$REPO_ROOT" commit --only -m "chore(release): bump npm packages" -- "${paths[@]}" bun.lock
fi
git -C "$REPO_ROOT" tag -a "$TAG" -m "Release $TAG"
$NO_PUSH && { echo "Created $TAG locally"; exit 0; }
git -C "$REPO_ROOT" push origin main "$TAG"
$NO_WATCH && { echo "Pushed $TAG"; exit 0; }
if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then echo "Pushed $TAG; gh unavailable"; exit 0; fi
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
RUN_ID=""
for _ in $(seq 1 20); do
  RUN_ID="$(gh run list -R wopal-cn/ellamaka --workflow "$WORKFLOW" --event push --json databaseId,headSha -q ".[] | select(.headSha == \"$HEAD_SHA\") | .databaseId" | head -n 1)"
  [ -n "$RUN_ID" ] && break
  sleep 3
done
[ -n "$RUN_ID" ] || die "pushed $TAG but workflow run not found"
gh run watch "$RUN_ID" -R wopal-cn/ellamaka --exit-status
