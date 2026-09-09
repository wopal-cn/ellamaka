#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$(basename "$0")"

# --- Utility ---
die() {
  echo "错误: $*" >&2
  exit 1
}

# --- Help ---
usage() {
  cat <<EOF
$SCRIPT — 整版撤回 ellamaka 产品版本

按 docs/DISTRIBUTION.md §7.3，撤回是操作员显式决策：将目标版本登记到
release/withdrawn-versions.json（提交并推送），再 dispatch cleanup-releases.yml
withdraw 模式执行远端删除（恢复 aliases → 删 R2 prefix → 删 Release 页面与 tag）。

版本默认取该渠道最新发布版本；fallback 固定为该渠道的上一版本，
无需也无法手动指定 —— 渠道内版本线是线性有序的，自动回退即符合直觉。

用法:
  $SCRIPT <cli|desktop> [--channel <stable|beta>] [version] [--dry-run]

━━━ 参数 ━━━
  product     cli | desktop（必选，二选一，不能同时撤回两个产品）
  version     要撤回的版本号（可选；省略时撤回该渠道最新发布版本）

━━━ 选项 ━━━
  -h, --help             显示此帮助
  --channel <stable|beta>  撤回目标渠道（desktop 为多渠道，必须选择；
                           cli 只有 stable，忽略此选项；rc 候选属于 stable 渠道）
  --dry-run              只做全部校验与计划展示，不登记、不提交、不 dispatch

━━━ 校验（全部通过后才产生任何变更）━━━
  1. product 必须为 cli 或 desktop
  2. desktop 必须指定 --channel；version 显式给出时其渠道必须与 --channel 一致
  3. version 必须真实存在：远端有 namespaced tag 且 R2 有 versioned manifest
  4. version 已登记时幂等：跳过重复登记，仍可重新 dispatch
  5. fallback 自动取同渠道上一版本；不存在或被撤回时中止（fail-closed）
  6. 工作区干净（withdrawn-versions.json 无未提交修改）、分支为 main
  7. 登记、提交、推送失败时中止（fail-closed）

━━━ 示例 ━━━
  # 撤回 desktop beta 渠道最新发布版本（fallback 自动为上一 beta）
  $SCRIPT desktop --channel beta

  # 撤回 desktop stable 渠道指定版本
  $SCRIPT desktop --channel stable 2.0.0

  # 撤回 cli 最新版本（cli 只有 stable 渠道）
  $SCRIPT cli

  # 只校验与预览，不做任何变更
  $SCRIPT desktop --channel beta --dry-run
EOF
  exit 0
}

# --- Argument parsing ---
PRODUCT=""
CHANNEL=""
VERSION=""
DRY_RUN=false
ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage ;;
    --channel)
      if [[ $# -lt 2 || "$2" == --* ]]; then
        die "--channel 需要 stable | beta"
      fi
      if [ "$2" != "stable" ] && [ "$2" != "beta" ]; then
        die "--channel 只能是 stable 或 beta（收到: $2）"
      fi
      CHANNEL="$2"
      shift 2
      ;;
    --dry-run) DRY_RUN=true; shift ;;
    cli|desktop)
      [ -n "$PRODUCT" ] && die "不能同时撤回两个产品（已指定 ${PRODUCT}，又收到 $1）"
      PRODUCT="$1"
      shift
      ;;
    -*) die "未知选项: $1" ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

if [ -z "$PRODUCT" ]; then
  echo "错误: 缺少产品参数（cli | desktop）" >&2
  echo "用法: $SCRIPT <cli|desktop> [--channel <stable|beta>] [version] [--dry-run]" >&2
  echo "试试: $SCRIPT --help" >&2
  exit 1
fi

VERSION="${ARGS[0]:-}"
[ "${#ARGS[@]}" -le 1 ] || die "多余的位置参数: ${ARGS[*]:1}"

# --- Product key mapping ---
case "$PRODUCT" in
  cli)     PRODUCT_KEY="ellamaka-cli" ;;
  desktop) PRODUCT_KEY="ellamaka-desktop" ;;
esac

# --- Locate repo ---
SCRIPT_DIR="$(cd "$(dirname "$(realpath "$0")")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WITHDRAWN_FILE="$REPO_ROOT/release/withdrawn-versions.json"

# --- Repo guard ---
REPO_URL="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || echo "")"
if ! echo "$REPO_URL" | grep -qE '[/:]wopal-cn/ellamaka(\.git)?$'; then
  die "remote 'origin' 不是 wopal-cn/ellamaka
  remote: $REPO_URL
  仓库: $REPO_ROOT"
fi

# --- gh availability ---
HAVE_GH=false
if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
  HAVE_GH=true
fi

# --- Version helpers ---
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-(beta|rc)\.[0-9]+)?$'

# channel_of <version> — 输出 stable | beta（rc 候选属于 stable 渠道）
channel_of() {
  if [[ "$1" == *-beta.* ]]; then echo "beta"; else echo "stable"; fi
}

# r2_root <product_key> <channel> — 该产品渠道的 R2 前缀
r2_root() {
  local key="$1" channel="$2"
  if [ "$key" = "ellamaka-cli" ]; then
    echo "ellamaka"
  elif [ "$channel" = "beta" ]; then
    echo "ellamaka-desktop/beta"
  else
    echo "ellamaka-desktop"
  fi
}

# highest_released <product> <channel> — 远端该渠道最高已发布版本（product 为短名）
highest_released() {
  local product="$1" channel="$2"
  git -C "$REPO_ROOT" ls-remote --tags origin "ellamaka-${product}-v*" 2>/dev/null | node -e "
    const product = process.argv[1]
    const channel = process.argv[2]
    const cmp = (a, b) => {
      const pa = a.split('-'), pb = b.split('-')
      const ca = pa[0].split('.').map(Number), cb = pb[0].split('.').map(Number)
      for (let i = 0; i < 3; i++) if (ca[i] !== cb[i]) return ca[i] - cb[i]
      const rank = (s) => (s === undefined ? 2 : s.startsWith('rc.') ? 1 : 0)
      const ra = rank(pa[1]), rb = rank(pb[1])
      if (ra !== rb) return ra - rb
      const na = pa[1] ? Number(pa[1].split('.')[1]) : 0
      const nb = pb[1] ? Number(pb[1].split('.')[1]) : 0
      return na - nb
    }
    let best = null
    for (const line of require('fs').readFileSync(0, 'utf8').split('\n')) {
      const m = line.match(new RegExp('refs/tags/ellamaka-' + product + '-v(\\\\d+\\\\.\\\\d+\\\\.\\\\d+(?:-(?:beta|rc)\\\\.\\\\d+)?)\\\$'))
      if (!m) continue
      const v = m[1]
      const isBeta = v.includes('-beta.')
      if (channel === 'beta' ? !isBeta : isBeta) continue
      if (!best || cmp(v, best) > 0) best = v
    }
    console.log(best || '')
  " "$product" "$channel"
}

# find_previous_version <product> <channel> <current> — 同渠道低于 current 的最高已发布版本
find_previous_version() {
  local product="$1" channel="$2" current="$3"
  git -C "$REPO_ROOT" ls-remote --tags origin "ellamaka-${product}-v*" 2>/dev/null | node -e "
    const product = process.argv[1]
    const channel = process.argv[2]
    const current = process.argv[3]
    const cmp = (a, b) => {
      const pa = a.split('-'), pb = b.split('-')
      const ca = pa[0].split('.').map(Number), cb = pb[0].split('.').map(Number)
      for (let i = 0; i < 3; i++) if (ca[i] !== cb[i]) return ca[i] - cb[i]
      const rank = (s) => (s === undefined ? 2 : s.startsWith('rc.') ? 1 : 0)
      const ra = rank(pa[1]), rb = rank(pb[1])
      if (ra !== rb) return ra - rb
      const na = pa[1] ? Number(pa[1].split('.')[1]) : 0
      const nb = pb[1] ? Number(pb[1].split('.')[1]) : 0
      return na - nb
    }
    let best = null
    for (const line of require('fs').readFileSync(0, 'utf8').split('\n')) {
      const m = line.match(new RegExp('refs/tags/ellamaka-' + product + '-v(\\\\d+\\\\.\\\\d+\\\\.\\\\d+(?:-(?:beta|rc)\\\\.\\\\d+)?)\\\$'))
      if (!m) continue
      const v = m[1]
      const isBeta = v.includes('-beta.')
      if (channel === 'beta' ? !isBeta : isBeta) continue
      if (v === current || cmp(v, current) > 0) continue
      if (!best || cmp(v, best) > 0) best = v
    }
    console.log(best || '')
  " "$product" "$channel" "$current"
}

# list_channel_versions <product> <channel> — 该渠道全部已发布版本（供错误提示）
list_channel_versions() {
  local product="$1" channel="$2"
  git -C "$REPO_ROOT" ls-remote --tags origin "ellamaka-${product}-v*" 2>/dev/null \
    | grep -v '\^{}$' \
    | sed -E "s#.*ellamaka-${product}-v##" \
    | node -e "
      const channel = process.argv[1]
      const vs = require('fs').readFileSync(0, 'utf8').split('\n').filter(v => v)
        .filter(v => channel === 'beta' ? v.includes('-beta.') : !v.includes('-beta.'))
      console.log(vs.join(' '))
    " "$channel"
}

# tag_exists <product> <version> — 远端 namespaced tag 是否存在（短名）
tag_exists() {
  git -C "$REPO_ROOT" ls-remote --tags origin "ellamaka-${1}-v${2}" 2>/dev/null | grep -q "refs/tags/ellamaka-${1}-v${2}$"
}

# manifest_exists <product_key> <channel> <version> — R2 是否存在 versioned manifest（已提交发布的判定）
manifest_exists() {
  local root
  root="$(r2_root "$1" "$2")"
  curl -fsS -o /dev/null "https://download.coursedao.com/${root}/v${3}/manifest.json" 2>/dev/null
}

# is_withdrawn <product_key> <version> — 输出 yes/no
is_withdrawn() {
  local product="$1" version="$2"
  if [ ! -f "$WITHDRAWN_FILE" ]; then echo "no"; return 0; fi
  node -e "
const w = JSON.parse(require('fs').readFileSync('$WITHDRAWN_FILE', 'utf8'));
const arr = (w.products && w.products['$product']) || [];
process.stdout.write(arr.includes('$version') ? 'yes' : 'no');
" 2>/dev/null || echo "no"
}

# record_withdrawn <product_key> <version> — 登记（去重 + SemVer 排序）并提交推送
record_withdrawn() {
  local product="$1" version="$2"
  if [ ! -f "$WITHDRAWN_FILE" ]; then
    printf '{\n  "schemaVersion": 1,\n  "products": {}\n}\n' > "$WITHDRAWN_FILE"
  fi
  node -e "
    const fs = require('fs')
    const p = process.argv[1]
    const w = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (w.schemaVersion === undefined) w.schemaVersion = 1
    if (w.products === undefined) w.products = {}
    const arr = w.products[process.argv[2]] || (w.products[process.argv[2]] = [])
    if (!arr.includes(process.argv[3])) {
      arr.push(process.argv[3])
      const cmp = (a, b) => {
        const pa = a.split('-'), pb = b.split('-')
        const ca = pa[0].split('.').map(Number), cb = pb[0].split('.').map(Number)
        for (let i = 0; i < 3; i++) if (ca[i] !== cb[i]) return ca[i] - cb[i]
        const rank = (s) => (s === undefined ? 2 : s.startsWith('rc.') ? 1 : 0)
        const ra = rank(pa[1]), rb = rank(pb[1])
        if (ra !== rb) return ra - rb
        const na = pa[1] ? Number(pa[1].split('.')[1]) : 0
        const nb = pb[1] ? Number(pb[1].split('.')[1]) : 0
        return na - nb
      }
      arr.sort(cmp)
    }
    fs.writeFileSync(p, JSON.stringify(w, null, 2) + '\n')
  " "$WITHDRAWN_FILE" "$product" "$version" || die "写入 withdrawn-versions.json 失败"
  git -C "$REPO_ROOT" add release/withdrawn-versions.json
  git -C "$REPO_ROOT" commit -m "chore(release): withdraw $product v$version" || die "提交 withdrawn-versions.json 失败"
  git -C "$REPO_ROOT" push origin main || die "推送 withdrawn-versions.json 失败"
  echo "  ✓ 已登记并推送: $WITHDRAWN_FILE"
  echo "    条目: $product → $version"
  echo "    提交: $(git -C "$REPO_ROOT" log -1 --format='%h %s')"
}

# validate_version_exists <product> <version> — version 必须真实存在（tag + R2 manifest）
validate_version_exists() {
  local product="$1" version="$2" channel
  channel="$(channel_of "$version")"
  if [ "$(is_withdrawn "$PRODUCT_KEY" "$version")" = "yes" ]; then
    die "版本 v${version} 已在 withdrawn-versions.json 中登记（已执行过撤回）
  无需重复撤回；若 latest alias 仍指向该版本，请发布新版本自愈"
  fi
  if ! tag_exists "$product" "$version"; then
    local available
    available="$(list_channel_versions "$product" "$channel")"
    die "远端不存在 tag ellamaka-${product}-v${version}
  该渠道已发布版本: ${available:-（无）}
  请检查版本号是否正确"
  fi
  if ! manifest_exists "$PRODUCT_KEY" "$channel" "$version"; then
    die "版本 v${version} 没有已提交的 versioned manifest（发布从未完成或已被清理）
  该版本无法执行整版撤回"
  fi
}

# --- Pre-flight: 分支与工作区（仅实际登记前检查） ---
preflight_repo() {
  local branch
  branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
  if [ "$branch" != "main" ]; then
    die "当前分支不是 main（${branch}），请在 main 上执行撤回登记"
  fi
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain -- release/withdrawn-versions.json)" ]; then
    die "release/withdrawn-versions.json 有未提交修改，请先提交或还原"
  fi
}

# --- Resolve channel ---
if [ -n "$VERSION" ]; then
  if ! [[ "$VERSION" =~ $SEMVER_RE ]]; then
    die "版本号格式无效: v${VERSION}（应为 X.Y.Z、X.Y.Z-rc.N 或 X.Y.Z-beta.N）"
  fi
  VERSION_CHANNEL="$(channel_of "$VERSION")"
  if [ -n "$CHANNEL" ] && [ "$CHANNEL" != "$VERSION_CHANNEL" ]; then
    die "版本 v${VERSION} 属于 ${VERSION_CHANNEL} 渠道，与 --channel ${CHANNEL} 不一致"
  fi
  CHANNEL="$VERSION_CHANNEL"
fi

if [ -z "$CHANNEL" ]; then
  if [ "$PRODUCT" = "cli" ]; then
    CHANNEL="stable"
  else
    die "desktop 是多渠道产品，必须用 --channel 指定撤回渠道（stable | beta）
  示例: $SCRIPT desktop --channel beta"
  fi
fi

if [ "$PRODUCT" = "cli" ] && [ "$CHANNEL" = "beta" ]; then
  die "cli 只有 stable 渠道，不能撤回 beta"
fi

echo "→ 撤回产品: ${PRODUCT}（channel=${CHANNEL}）"

# --- Resolve version（默认该渠道最新发布版本）---
LATEST="$(highest_released "$PRODUCT" "$CHANNEL")"
if [ -z "$LATEST" ]; then
  die "远端没有 $PRODUCT 的 $CHANNEL 渠道已发布版本，无法撤回"
fi

if [ -z "$VERSION" ]; then
  VERSION="$LATEST"
  echo "  默认撤回最新发布版本: v${VERSION}"
else
  echo "  指定撤回版本: v${VERSION}"
  echo "  该渠道当前最高已发布版本: v${LATEST}"
fi

# --- Validate the withdraw target exists（在任何变更之前）---
validate_version_exists "$PRODUCT" "$VERSION"

# --- Derive fallback: 同渠道上一版本（撤回最新版时才真正需要恢复）---
FALLBACK="$(find_previous_version "$PRODUCT" "$CHANNEL" "$VERSION")"
if [ "$VERSION" = "$LATEST" ]; then
  # 撤回的正是渠道最新版本：latest alias 必须回退到上一版
  if [ -z "$FALLBACK" ]; then
    die "该渠道没有低于 v${VERSION} 的已发布版本可作为回退目标
  无法撤回当前 latest（回退目标不存在，fail-closed）"
  fi
  if [ "$(is_withdrawn "$PRODUCT_KEY" "$FALLBACK")" = "yes" ]; then
    die "回退目标 v${FALLBACK} 本身已被撤回
  无法撤回当前 latest（该渠道没有健康的上一版本，fail-closed）"
  fi
  echo "  fallback 自动取同渠道上一版本: v${FALLBACK}"
else
  # 撤回的不是最新版本：latest alias 不受影响，无需恢复
  if [ -z "$FALLBACK" ]; then
    FALLBACK="$LATEST"
  fi
  echo "  撤回的不是渠道最新版本，latest alias 不受影响（fallback 仅作记录: v${FALLBACK}）"
fi

# --- Plan ---
echo ""
echo "→ 撤回计划: $PRODUCT v${VERSION}（channel=${CHANNEL}，fallback: v${FALLBACK}）"
echo "  1. 登记 withdrawn-versions.json 并推送"
if [ "$DRY_RUN" = true ]; then
  echo "  2. [DRY RUN] 不 dispatch cleanup-releases.yml"
  echo ""
  echo "  校验全部通过。若执行，将运行:"
  echo "    gh workflow run cleanup-releases.yml -R wopal-cn/ellamaka \\"
  echo "      -f mode=withdraw -f product=$PRODUCT_KEY \\"
  echo "      -f withdraw-version=$VERSION -f fallback-version=$FALLBACK -f apply=true"
  exit 0
fi
echo "  2. dispatch cleanup-releases.yml withdraw 模式（apply=true）"
echo ""

# --- Record + dispatch ---
preflight_repo
record_withdrawn "$PRODUCT_KEY" "$VERSION"

if [ "$HAVE_GH" = false ]; then
  echo "ℹ️  gh CLI 不可用或未认证，请手动在 GitHub Actions 触发 cleanup-releases.yml（mode=withdraw）。"
  exit 0
fi

echo "→ 触发 withdraw workflow ($PRODUCT v$VERSION → fallback v$FALLBACK)..."
gh workflow run cleanup-releases.yml -R wopal-cn/ellamaka \
  -f mode=withdraw \
  -f product="$PRODUCT_KEY" \
  -f withdraw-version="$VERSION" \
  -f fallback-version="$FALLBACK" \
  -f apply=true || die "withdraw workflow 触发失败（已登记 withdrawn-versions.json，可手动重试 dispatch）"

echo ""
echo "✅ 撤回已触发: $PRODUCT v${VERSION}（channel=${CHANNEL}，fallback: v${FALLBACK}）"
echo "   跟踪: https://github.com/wopal-cn/ellamaka/actions/workflows/cleanup-releases.yml"
