#!/usr/bin/env bash
# scripts/lib/release.sh — release-cli.sh / release-desktop.sh 共享发布引擎。
#
# 每产品独立发布模型（docs/DISTRIBUTION.md §3.2/§4.1）：
#   cli 与 desktop 各自独立的版本序列，互不牵制。版本推进唯一依据是**该产品已
#   成功发布的 git tag 记录**（最高 stable + 该产品通道最高 -rc.N/-beta.N），
#   不读取 package.json 作"版本线/锚点"候选状态。
#
# 写入（发布动作内）：本产品 package.json 写目标 VERSION（带 rc/beta 后缀或纯
#   X.Y.Z，成功即成为记录）；根 + 其余 workspace 依赖包统一镜像纯 base，且单调
#   不减——仅当本次 BASE 高于根当前版本时抬升（依赖包 base = 两产品较高者）。
#   失败/中断发布不构成记录，可同版本重发。
#
# 版本推断（packages/ellamaka-release/src/version-line.ts）：
#   rc/beta → 该产品通道：候选 base 未转正则续 N+1，否则已发 stable patch+1 的
#             .1 起步；stable → 候选未转正则转正其 base，否则已发 stable patch+1
#             直接发新正式版；minor/major → 现行 base 升位。
#   分支策略：非 main 只许 prerelease（通道级预检在版本推断前执行）。

set -euo pipefail

# REPO_ROOT 由薄壳脚本在 source 本文件前设置
: "${REPO_ROOT:?REPO_ROOT must be set before sourcing lib/release.sh}"

source "$REPO_ROOT/scripts/lib/version.sh"

WITHDRAWN_FILE="$REPO_ROOT/release/withdrawn-versions.json"
LEGACY_INVENTORY_FILE="$REPO_ROOT/release/legacy-inventory.json"

die() {
  printf '错误: %b\n' "$*" >&2
  exit 1
}

# ── 检查函数──────────────────

# 返回值：0=干净；1=工作区/暂存区有未提交变更。
# 只报告、不阻断 —— 是否继续由 confirm_dirty_release 征询用户。
check_workspace_clean() {
  local dirty=0
  if ! git -C "$REPO_ROOT" diff --quiet HEAD -- . 2>/dev/null; then
    echo "⚠️  工作区有未提交变更:"
    git -C "$REPO_ROOT" status --short
    dirty=1
  fi
  if ! git -C "$REPO_ROOT" diff --cached --quiet HEAD -- . 2>/dev/null; then
    echo "⚠️  暂存区有未提交变更:"
    git -C "$REPO_ROOT" diff --cached --stat
    dirty=1
  fi
  return "$dirty"
}

# confirm_dirty_release — 工作区不干净时征询用户是否继续发布
#   --yes/-y       : 跳过征询（调用方已知晓风险）
#   非交互（无 TTY）: 保持阻断，避免 CI/自动化静默带着脏工作区发布
confirm_dirty_release() {
  : "${ASSUME_YES:=false}"
  if $ASSUME_YES; then
    echo "→ --yes 已指定：忽略工作区未提交变更，继续发布"
    return 0
  fi
  echo ""
  echo "说明：本次发布以 bump commit（HEAD）为 ref 触发 ${WORKFLOW}，"
  echo "      上述未提交变更不会进入发布产物；bump commit 只提交版本文件，"
  echo "      暂存区里的其他改动会原样保留。"
  if [ ! -t 0 ]; then
    die "工作区不干净且当前不是交互终端（无法征询）。确认要继续请显式加 --yes。"
  fi
  local reply=""
  printf '是否继续发布 %s %s？[y/N] ' "$PRODUCT" "$VERSION"
  read -r reply || true
  case "$reply" in
    y|Y|yes|YES) echo "→ 已确认，继续发布" ;;
    *) die "已取消发布（工作区有未提交变更）" ;;
  esac
}

check_remote_branch() {
  local branch remote_branch unpushed
  branch=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)
  git -C "$REPO_ROOT" fetch "$REMOTE" "$branch" 2>/dev/null || true
  remote_branch=$(git -C "$REPO_ROOT" rev-parse "$REMOTE/$branch" 2>/dev/null || echo "")
  if [ -z "$remote_branch" ]; then
    die "$REMOTE/$branch 不存在，请先 git push $REMOTE $branch"
  fi
  unpushed=$(git -C "$REPO_ROOT" rev-list --count HEAD "^$REMOTE/$branch" 2>/dev/null)
  if [ "$unpushed" -gt 0 ]; then
    echo "local $branch 有 $unpushed 个 commit 未推送至 $REMOTE/$branch:"
    git -C "$REPO_ROOT" log --oneline "$REMOTE/$branch..HEAD"
    die "请先 git push $REMOTE $branch"
  fi
}

# target_is_prerelease — resolve 前判定本次 bump 目标是否为 prerelease 通道
# （不依赖版本号，只看调用意图）：
#   cli:     仅 --rc 是 prerelease；--patch/--minor/--major 是 stable 通道
#   desktop: CHANNEL=beta（--beta）是 prerelease；CHANNEL=prod 是 stable 通道
target_is_prerelease() {
  if [ "$SUBCOMMAND" = "cli" ]; then
    [ "$AUTO_BUMP" = "rc" ]
  else
    [ "$CHANNEL" = "beta" ]
  fi
}

# check_branch_allows_channel — 通道级预检（在版本推断之前执行，dry-run 同样
# 触发）：非 main 分支只许发布 prerelease（rc/beta）。stable/prod 目标
# （--patch/--minor/--major：候选转正或开新正式版本线）在非 main 上直接拒绝，
# 让分支渠道约束在进入版本推断前就显式体现，而不是淹没在版本推断错误里。
check_branch_allows_channel() {
  local branch
  branch=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)
  [ "$branch" = "main" ] && return 0
  if target_is_prerelease; then
    return 0
  fi
  die "分支 $branch 不是 main：只允许发布 prerelease（CLI --rc / Desktop --beta），禁止 stable/prod（--patch/--minor/--major）。要发正式版或把候选转正，请切到 main 分支。"
}

# check_branch_channel_policy — 版本级校验（resolve 后）：prerelease 时 base
# 必须高于该产品已发布的最高 stable。通道级拦截已由 check_branch_allows_channel
# 在推断前完成，此函数只兜底 prerelease base 的版本约束。
check_branch_channel_policy() {
  local branch
  branch=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)
  [ "$branch" = "main" ] && return 0

  local is_prerelease=false
  if [ "$SUBCOMMAND" = "cli" ]; then
    [[ "$VERSION" =~ -rc\.[0-9]+$ ]] && is_prerelease=true
  else
    [[ "$VERSION" =~ -beta\.[0-9]+$ ]] && is_prerelease=true
  fi
  if ! $is_prerelease; then
    die "分支 $branch 不是 main：只允许发布 prerelease（CLI X.Y.Z-rc.N / Desktop X.Y.Z-beta.N），禁止裸 X.Y.Z"
  fi

  local highest_stable
  highest_stable=$(highest_release_tag "$PRODUCT" "stable" "$REPO_ROOT")
  if [ -n "$highest_stable" ]; then
    node -e "
      const cmp = (a, b) => {
        const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
        for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
        return 0
      }
      process.exit(cmp(process.argv[1], process.argv[2]) > 0 ? 0 : 1)
    " "$BASE" "$highest_stable" || die "prerelease base $BASE 必须高于已发布 stable 最高版本 $highest_stable"
  fi
}

check_withdrawn() {
  [ -f "$WITHDRAWN_FILE" ] || return 0
  local listed
  listed=$(node -e "
const w = JSON.parse(require('fs').readFileSync('$WITHDRAWN_FILE', 'utf8'));
const arr = (w.products && w.products['$PRODUCT']) || [];
process.stdout.write(arr.includes('$VERSION') ? 'yes' : 'no');
" 2>/dev/null || echo "no")
  [ "$listed" != "yes" ] || die "版本 $VERSION 已列入 withdrawn-versions.json，永久不得复用"
}

check_migration_floor() {
  [ -f "$LEGACY_INVENTORY_FILE" ] || die "legacy-inventory.json 缺失；必须先用 packages/ellamaka-release/src/cli/inventory.ts 真实盘点并冻结后才能发布"
  node -e "
const inv = JSON.parse(require('fs').readFileSync('$LEGACY_INVENTORY_FILE', 'utf8'));
if (inv.source !== 'live') {
  console.error('legacy-inventory.json source=' + (inv.source || 'undefined') + ' 不是 live；fixture/dry-run inventory 不得用于真实发布门禁');
  process.exit(2);
}
const entries = inv.products && inv.products['$PRODUCT'];
if (!entries) process.exit(0);
// Numeric tuple comparison — lexicographic string comparison of dotted
// version strings misorders components of different widths.
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; if (d) return d; } return 0; };
let highest = null;
for (const t of (entries.tags || [])) {
  const m = t.name.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)-(\d+)/);
  if (!m) continue;
  const key = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (!highest || cmp(key, highest) > 0) highest = key;
}
if (!highest) process.exit(0);
const floor = [highest[0], highest[1], highest[2]];
const v = '$VERSION'.split(/[.-]/).map(Number);
const vkey = [v[0], v[1], v[2]];
if (cmp(vkey, floor) < 0) {
  console.error('版本 ' + '$VERSION' + ' 低于 migration floor ' + floor.join('.'));
  process.exit(1);
}
" || {
  local rc=$?
  if [ $rc -eq 2 ]; then
    die "legacy-inventory.json 不是 live capture；不得用 fixture/dry-run inventory 门禁真实发布"
  fi
  die "版本 $VERSION 低于 migration floor（见 ${LEGACY_INVENTORY_FILE}）"
}
}

manifest_url() {
  echo "https://download.coursedao.com/ellamaka/v${VERSION}/manifest.json"
}

has_effective_manifest() {
  command -v curl >/dev/null 2>&1 || die "curl 不可用，无法判定远端 tag 是否为 failed attempt"
  local url code
  url="$(manifest_url)"
  code=$(curl -s -o /dev/null -w "%{http_code}" --noproxy '*' --max-time 15 "$url" 2>/dev/null || echo "000")
  [ "$code" = "200" ]
}

check_min_wopal_cli_released() {
  local req_ver="${MIN_WOPAL_CLI_VERSION:-}"
  [ -n "$req_ver" ] || return 0
  echo "→ 检查 minWopalCli (v${req_ver}) 是否已在 wopal-cli 仓库发布..."
  local tag_found=""
  if git ls-remote --tags "https://github.com/wopal-cn/wopal-cli.git" "refs/tags/v${req_ver}" 2>/dev/null | grep -q "refs/tags/v${req_ver}$"; then
    tag_found="yes"
  elif command -v gh &>/dev/null && gh release view "v${req_ver}" -R wopal-cn/wopal-cli &>/dev/null; then
    tag_found="yes"
  fi
  [ "$tag_found" = "yes" ] || die "终止发布: .ci/versions.json 要求的 minWopalCli (v${req_ver}) 尚未在 wopal-cli 仓库发布！"
  echo "  ✓ 已确认 wopal-cli v${req_ver} 存在于远端"
}

check_dep_floor_synced() {
  local dep_floor="" config_floor=""
  dep_floor=$(node -e "
    const pkg = require('$REPO_ROOT/packages/opencode/package.json')
    const range = pkg.dependencies && pkg.dependencies['@wopal/cli-capability-schema']
    if (!range) { console.log(''); process.exit(0) }
    const m = String(range).match(/(\d+)\.(\d+)\.(\d+)/)
    console.log(m ? m[1] + '.' + m[2] + '.' + m[3] : '')
  " 2>/dev/null || true)
  config_floor=$(node -e "
    const v = require('$REPO_ROOT/.ci/versions.json')
    console.log(typeof v.minWopalCli === 'string' ? v.minWopalCli : '')
  " 2>/dev/null || true)
  [ -n "$dep_floor" ] && [ -n "$config_floor" ] || return 0
  node -e "
    const norm = (s) => { const m = String(s).match(/(\d+)\.(\d+)\.(\d+)/); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null }
    const na = norm(process.argv[1]), nb = norm(process.argv[2])
    if (!na || !nb) process.exit(0)
    const cmp = na[0]-nb[0] || na[1]-nb[1] || na[2]-nb[2]
    process.exit(cmp > 0 ? 1 : 0)
  " "$config_floor" "$dep_floor" || die "依赖下界未同步：@wopal/cli-capability-schema (^$dep_floor) 低于 .ci/versions.json minWopalCli ($config_floor)。请先运行 ./scripts/build.sh cli 或 dev.sh 完成同步并提交。"
}

# ── dispatch / 监控 ───────────────────────────────────────

HAVE_GH=false
if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
  HAVE_GH=true
fi

dispatch_workflow() {
  local -a extra_args=(-f "version=$VERSION" -f "publish=true")
  [ "$SUBCOMMAND" = "desktop" ] && extra_args+=(-f "channel=$CHANNEL")
  local output
  echo "→ dispatch $WORKFLOW (ref=$TAG, version=$VERSION, publish=true)" >&2
  if ! output=$(gh workflow run "$WORKFLOW" -R wopal-cn/ellamaka --ref "$TAG" "${extra_args[@]}" 2>&1); then
    echo "$output" >&2
    return 1
  fi
  echo "$output" >&2
  if [[ "$output" =~ actions/runs/([0-9]+) ]]; then
    echo "${BASH_REMATCH[1]}"
    return 0
  fi
  echo "错误: dispatch 未返回 workflow run ID，已停止监控以避免匹配历史 run。" >&2
  return 1
}

poll_run() {
  # 判定完成以 jobs 为准：run 级 status/conclusion 在最后一个 job 完成后
  # 有短暂翻转延迟，若只看 run 字段会多等一轮造成"watch 不结束"的错觉。
  gh run view "$1" -R wopal-cn/ellamaka --json status,conclusion,jobs -q '
    . as $r | ($r.jobs // []) as $jobs |
    if $r.status == "completed" then
      "completed \($r.conclusion // "unknown")"
    elif ($jobs | length > 0) and all($jobs[]; .status == "completed") then
      if any($jobs[]; .conclusion == "failure") then "completed failure"
      elif any($jobs[]; .conclusion == "cancelled") then "completed cancelled"
      else "completed success" end
    else
      "\($r.status) \($r.conclusion // "")"
    end,
    ($jobs | map("       [\(.status)] \(.name): \(.conclusion // "running...")") | join("\n"))
  ' 2>/dev/null || echo "unknown"
}

watch_run() {
  local RUN_ID="$1" i=0
  echo "→ Watching run (Ctrl+C 中断)..."
  POLL_INTERVAL=15
  while true; do
    i=$((i + 1))
    FULL="$(poll_run "$RUN_ID")"
    STATUS="$(echo "$FULL" | head -n 1)"
    echo "  [#$i] $STATUS"
    echo "$FULL" | tail -n +2
    case "$STATUS" in
      "completed failure"|"completed cancelled")
        echo "⚠️  Workflow 失败或取消 (conclusion: ${STATUS#completed })"
        return 1 ;;
      "completed success")
        break ;;
    esac
    sleep $POLL_INTERVAL
  done
}

trigger_cleanup() {
  [ "$HAVE_GH" = true ] || return 0
  [ "$NO_CLEANUP" != "true" ] || return 0
  echo "→ 触发 cleanup workflow ($PRODUCT, retention apply)..."
  if [ "$SUBCOMMAND" = "cli" ]; then
    gh workflow run cleanup-releases.yml -R wopal-cn/ellamaka \
      -f mode=retention -f product=ellamaka-cli -f apply=true -f keep-stable=2 \
      || echo "⚠️  cleanup workflow 触发失败（可手动触发）"
  else
    gh workflow run cleanup-releases.yml -R wopal-cn/ellamaka \
      -f mode=retention -f product=ellamaka-desktop -f apply=true -f keep-stable=2 -f keep-beta=2 \
      || echo "⚠️  cleanup workflow 触发失败（可手动触发）"
  fi
}

# ── 版本推断（以该产品已发布 tag 记录为唯一依据，产品独立）────────────

# product_released_stable — 该产品已发布最高 stable (X.Y.Z)，无则空串
product_released_stable() {
  highest_release_tag "$PRODUCT" "stable" "$REPO_ROOT"
}

# product_released_candidate — 该产品通道最高 prerelease（cli=-rc.N /
# desktop=-beta.N），无则空串
product_released_candidate() {
  if [ "$SUBCOMMAND" = "cli" ]; then
    highest_release_tag "$PRODUCT" "rc" "$REPO_ROOT"
  else
    highest_release_tag "$PRODUCT" "beta" "$REPO_ROOT"
  fi
}

# resolve_target_version <stable|rc|beta|minor|major>
#
# 通过 version-line CLI 从该产品已发布记录推断目标版本。推断不读 package.json
# （无版本线/锚点概念），只依赖 git tag：cli/desktop 各自独立序列，互不牵制。
# 显式版本（${VERSION_OVERRIDE}）时只做单调校验后原样返回。
resolve_target_version() {
  local bump="$1" stable candidate result
  stable="$(product_released_stable)"
  candidate="$(product_released_candidate)"
  result=$(bun packages/ellamaka-release/src/cli/version-line.ts "$bump" "$stable" "$candidate" "${VERSION_OVERRIDE:-}" 2>&1) \
    || die "$result"
  echo "$result"
}

# ── 发布主流程（由薄壳脚本在设置好上下文后调用）──────────

# run_release — 薄壳脚本约定：调用前必须设置
#   SUBCOMMAND (cli|desktop)  PRODUCT            WORKFLOW
#   CHANNEL (desktop: beta|prod)  CHANNEL_LABEL  PRERELEASE_KIND (rc|beta|"")
#   ALLOWED_BUMPS (空格分隔的合法 bump 开关)
run_release() {
  # dry-run 不做任何写入，永不检查工作区状态
  WORKSPACE_DIRTY=false
  if ! $DRY_RUN; then
    echo "→ 检查工作区..."
    check_workspace_clean || WORKSPACE_DIRTY=true
  fi

  if command -v jq >/dev/null 2>&1 && [ -f "$REPO_ROOT/.ci/versions.json" ]; then
    export MIN_WOPAL_CLI_VERSION=$(jq -r .minWopalCli "$REPO_ROOT/.ci/versions.json")
  fi
  check_min_wopal_cli_released
  check_dep_floor_synced

  # ── 通道级分支预检（resolve 之前）：非 main 只许 prerelease ──
  # 显式版本参数（$VERSION）可能带 rc/beta 后缀，会覆盖 AUTO_BUMP 的通道意图，
  # 这里据实标记 prerelease 属性，避免误拦 poc 分支上的 rc/beta 显式版本。
  if [ -n "$VERSION" ] && [[ "$VERSION" =~ (-rc|-beta)\.[0-9]+$ ]]; then
    AUTO_BUMP="$([ "$SUBCOMMAND" = "cli" ] && echo rc || echo beta)"
  fi
  check_branch_allows_channel

  # ── 版本推断（以该产品已发布 tag 记录为唯一依据）────────
  RELEASED_STABLE="$(product_released_stable)"
  RELEASED_CAND="$(product_released_candidate)"
  if [ -n "$VERSION" ]; then
    VERSION_OVERRIDE="$VERSION"
    TARGET="$(resolve_target_version stable)"
    VERSION="$TARGET"
  else
    VERSION_OVERRIDE=""
    TARGET="$(resolve_target_version "$AUTO_BUMP")"
    VERSION="$TARGET"
  fi
  echo "→ 版本推断: 该产品已发布 stable=${RELEASED_STABLE:-无} 候选=${RELEASED_CAND:-无} → $VERSION ($AUTO_BUMP)"

  BASE="${VERSION%%-*}"
  TAG="${PRODUCT}-v${VERSION}"

  # 产品级版本格式校验（推断保证一致，显式版本在此拦截）
  if [ "$SUBCOMMAND" = "cli" ]; then
    [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || die "CLI 版本号格式无效: $VERSION (期望 X.Y.Z 或 X.Y.Z-rc.N)"
  else
    if [ "$CHANNEL" = "beta" ]; then
      [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$ ]] || die "beta 渠道需要 X.Y.Z-beta.N 版本，得到: $VERSION"
    else
      [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "prod 渠道需要纯 X.Y.Z 版本，得到: $VERSION"
    fi
  fi

  check_branch_channel_policy
  check_withdrawn
  check_migration_floor

  # ── 工作区变更：征询而非阻断（版本号已确定，提示更有信息量）──
  if [ "$WORKSPACE_DIRTY" = true ]; then
    confirm_dirty_release
  fi

  # ── re-release 判定（幂等）────────────────────────────
  RE_RELEASE=false
  if git ls-remote --tags "$REMOTE" "$TAG" 2>/dev/null | grep -q "refs/tags/${TAG}$"; then
    if has_effective_manifest; then
      die "版本 $VERSION 已发布（tag $TAG 存在且有有效 manifest）—— 已发布 release 不可变，请使用更高版本号。"
    fi
    echo "→ 远端 tag $TAG 存在但无 manifest（failed attempt），以该 tag 重新发布。"
    RE_RELEASE=true
  fi

  if $RE_RELEASE; then
    # 中断重发：无"锚点"概念，直接以失败 tag 重新 dispatch（发布不可变只约束
    # 成功提交的 release；failed attempt 无有效 manifest，可同版本重发）。
    check_remote_branch
    if $DRY_RUN; then
      echo ""
      echo "── dry-run 重发计划 ──"
      echo "  product:  $PRODUCT"
      echo "  version:  $VERSION (tag 已存在，failed attempt)"
      echo "  channel:  $CHANNEL_LABEL"
      echo "  action:   workflow_dispatch (ref=$TAG)"
      exit 0
    fi
    if [ "$HAVE_GH" = false ]; then
      echo "ℹ️  gh CLI 不可用或未认证，跳过 dispatch + watch。"
      echo "    手动重发: gh workflow run $WORKFLOW -R wopal-cn/ellamaka --ref $TAG -f version=$VERSION -f publish=true$([ "$SUBCOMMAND" = "desktop" ] && echo " -f channel=$CHANNEL")"
      exit 0
    fi
    RUN_ID="$(dispatch_workflow)" || die "无法确定本次 workflow run"
    [ "$NO_WATCH" = "true" ] || watch_run "$RUN_ID"
    trigger_cleanup
    exit 0
  fi

  # ── 写入计划计算（无版本线/锚点）────────────────────────
  # 本产品 package.json 恒写目标 VERSION（发布成功即成为记录）。
  # 根 + 依赖包镜像纯 base，且单调不减：仅当本次 BASE 高于根当前版本时才同步
  # 抬升（如 cli 发 2.0.6-rc.1 → 依赖包升 2.0.6；随后 desktop 发 2.0.5-beta.2
  # 时 BASE 2.0.5 < 根 2.0.6，依赖包不动）。根当前版本 = 两产品已发布 base 较高者
  # 的记录产物。
  ROOT_VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
  RAISE_ROOT=false
  # ROOT_VERSION < BASE → 依赖包需抬升。node 退出码：1=需要抬升，0=不需要。
  if node -e "
    const a = process.argv[1].split('.').map(Number)
    const b = process.argv[2].split('.').map(Number)
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) process.exit(a[i] < b[i] ? 1 : 0)
    process.exit(0)
  " "$ROOT_VERSION" "$BASE"; then
    # ROOT_VERSION >= BASE：依赖包不抬升
    :
  else
    RAISE_ROOT=true
  fi
  # 本产品当前 package.json 版本（用于判定是否产生文件改动、需否 bump commit）
  PROD_VERSION="$(current_version "$SUBCOMMAND" "$REPO_ROOT")"

  # ── dry-run 发布计划 ─────────────────────────────────
  if $DRY_RUN; then
    PROD_WRITE=false
    [ "$PROD_VERSION" = "$VERSION" ] || PROD_WRITE=true
    echo ""
    echo "── dry-run 发布计划 ──"
    echo "  product:   $PRODUCT ($CHANNEL_LABEL)"
    echo "  version:   $VERSION"
    echo "  tag:       $TAG (打在 bump commit 上)"
    echo "  写入:      产品 package.json → $VERSION$([ "$RAISE_ROOT" = true ] && echo "；根 + 依赖包 → $BASE")
$([ "$PROD_WRITE" = false ] && [ "$RAISE_ROOT" = false ] && echo "  （产品与依赖均已到位，无版本文件改动，直接以当前 HEAD 打 tag）")"
    echo "  push:      $REMOTE 分支 + ${TAG}（tag 触发 ${WORKFLOW}）"
    echo "  watch:     $([ "$NO_WATCH" = "true" ] && echo 跳过 || echo 自动)"
    echo "  cleanup:   $([ "$NO_CLEANUP" = "true" ] && echo 跳过 || echo 自动触发)"
    exit 0
  fi

  # ── bump 写入（产品写目标 VERSION；根+依赖包仅当 BASE 更高时抬升）────
  if [ "$PROD_VERSION" = "$VERSION" ] && [ "$RAISE_ROOT" = false ]; then
    echo "→ 产品已是 ${VERSION} 且依赖包不需抬升，跳过 bump 与提交（直接以当前 HEAD 打 tag）"
  else
    echo "→ 写入版本 $VERSION..."
    node -e "
const fs = require('fs')
const path = require('path')
const root = process.argv[1]
const version = process.argv[2]
const depBase = process.argv[3]
const sub = process.argv[4]
const raiseRoot = process.argv[5] === 'true'

const write = (p, v) => {
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'))
  if (pkg.version === v) return false
  pkg.version = v
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n')
  return true
}

let changed = 0
// 本产品 package.json 写完整目标版本（发布成功即成为记录）
if (sub === 'cli') {
  if (write(path.join(root, 'packages/ellamaka-cli/package.json'), version)) changed++
} else {
  if (write(path.join(root, 'packages/ellamaka-desktop/package.json'), version)) changed++
}
// 根 + 其余 workspace 依赖包统一镜像纯 base，仅当本次 BASE 更高时抬升
if (raiseRoot) {
  for (const d of fs.readdirSync(path.join(root, 'packages'))) {
    const p = path.join(root, 'packages', d, 'package.json')
    if (!fs.existsSync(p)) continue
    if (d === 'ellamaka-cli' || d === 'ellamaka-desktop') continue
    if (write(p, depBase)) changed++
  }
  const sdk = path.join(root, 'packages', 'sdk', 'js', 'package.json')
  if (fs.existsSync(sdk) && write(sdk, depBase)) changed++
  if (write(path.join(root, 'package.json'), depBase)) changed++
}
console.log('  bumped ' + changed + ' package.json files')
" "$REPO_ROOT" "$VERSION" "$BASE" "$SUBCOMMAND" "$RAISE_ROOT"

    echo "→ 刷新 bun.lock..."
    (cd "$REPO_ROOT" && bun install --lockfile-only 2>/dev/null) || die "bun install --lockfile-only 失败"

    echo "→ 提交版本 bump"
    local -a bump_paths=(package.json)
    local p
    for p in packages/*/package.json packages/sdk/js/package.json bun.lock; do
      if [ -e "$REPO_ROOT/$p" ]; then bump_paths+=("$p"); fi
    done
    git -C "$REPO_ROOT" add -- "${bump_paths[@]}"
    # --only + pathspec：只提交版本文件，暂存区里其他改动原样保留（脏工作区发布时尤其重要）
    git -C "$REPO_ROOT" commit --only -m "chore: bump $PRODUCT version to $VERSION" -- "${bump_paths[@]}"
  fi

  # ── tag、push ────────────────────────────────────────
  BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
  echo "→ 创建 tag: $TAG"
  git -C "$REPO_ROOT" tag -d "$TAG" 2>/dev/null || true
  git -C "$REPO_ROOT" tag -a "$TAG" -m "Release $TAG"

  if $NO_PUSH; then
    echo "ℹ️  已 bump、提交、创建本地 tag ${TAG}（--no-push，未推送）。"
    echo "    推送发布: git push $REMOTE $BRANCH $TAG"
    exit 0
  fi

  echo "→ 推送 $BRANCH 和 tag ${TAG}（tag push 触发 ${WORKFLOW}）"
  git -C "$REPO_ROOT" push "$REMOTE" "$BRANCH" "$TAG"

  # ── watch ────────────────────────────────────────────
  if [ "$NO_WATCH" = "true" ] || [ "$HAVE_GH" = false ]; then
    if [ "$HAVE_GH" = false ]; then
      echo "ℹ️  gh CLI 不可用或未认证，跳过 dispatch + watch。tag 已推送，workflow 应已触发。"
    fi
  else
    COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    echo "→ 等待 workflow 启动..."
    RUN_ID=""
    for i in $(seq 1 12); do
      RUN_ID=$(gh run list -R wopal-cn/ellamaka --workflow "$WORKFLOW" --commit "$COMMIT" --status in_progress,queued --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || echo "")
      [ -n "$RUN_ID" ] && break
      RUN_ID=$(gh run list -R wopal-cn/ellamaka --workflow "$WORKFLOW" --commit "$COMMIT" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || echo "")
      [ -n "$RUN_ID" ] && break
      sleep 5
    done
    if [ -z "$RUN_ID" ]; then
      echo "⚠️  60s 内未找到 workflow run（可能需要手动检查 actions 页）。"
    else
      watch_run "$RUN_ID"
    fi
  fi

  trigger_cleanup

  echo ""
  echo "✅ Release complete"
  echo "   GitHub Release: https://github.com/wopal-cn/ellamaka/releases/tag/${TAG}"
  if [ "$SUBCOMMAND" = "cli" ]; then
    echo "   R2:             https://download.coursedao.com/ellamaka/v${VERSION}/"
  else
    echo "   R2:             https://download.coursedao.com/ellamaka-desktop$([ "$CHANNEL" = "beta" ] && echo "/beta")/v${VERSION}/"
  fi
}
