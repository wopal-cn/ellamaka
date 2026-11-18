#!/bin/bash
# ellamaka 编译脚本入口
# build.sh cli [options]      — 构建 CLI 二进制（本机跨平台构建）
# build.sh desktop [options]  — 构建 Electron 桌面应用
#
# Desktop 平台策略：
#   本机 mac + --platform mac（默认）→ 本地构建
#   --platform linux|win（或本机非 mac）→ GitHub Actions CI 构建并下载产物
#   CI 构建产物下载到 --out（默认 dist/ci）；--install 仅本地构建生效，
#   非本机平台构建时 --install 不进行实际安装。

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BINARY_NAME="ellamaka"
REPO="wopal-cn/ellamaka"

show_help() {
  cat <<'EOF'
Usage: build.sh <target> [options]

Targets:
  cli        Build CLI binary
  desktop    Build Desktop app

CLI options:
  --version <ver>         Override build version (e.g. "1.15.14-dev")
  --channel <main|local>  Channel (default: main). main → ellamaka-main.db;
                          local → ellamaka-local.db (independent dev databases).
  --platform <mac|linux|win>
                          Target platform (comma-separated, e.g. "mac,linux")
  --arch <arm64|x64>      Target architecture (comma-separated)
  --web-ui <value>        Embedded web UI: "ellamaka-app" (default), "app", "none"
  --install               Install binary (symlink to ~/.wopal/bin)
  --verbose               Show full subprocess output (vite, generators)

Desktop options:
  --channel <main|beta|stable>
                          Channel (default: main). Controls bundle ID, app name, icons.
                          CI builds accept only beta|stable (main is local-only).
  --version <ver>         Override build version (e.g. "1.15.13-main.202607271834")
  --platform <mac|linux|win>
                          Target platform (default: mac). mac builds locally;
                          linux/win dispatch a GitHub Actions build.
  --arch <arm64|x64>      CI artifact architecture (default: x64; Windows: x64 only)
  --out <dir>             CI download directory (default: dist/ci)
  --no-wait               CI: trigger the workflow and exit without waiting
  --force                 CI: skip dirty-tree / unpushed confirmation
  --install               Install locally (mac: .app to /Applications).
                          Skipped for CI builds of non-host platforms.
EOF
  exit 0
}

TARGET="${1:-}"
shift 2>/dev/null || true

# Shared version resolution for CLI / Desktop builds.
source "$PROJECT_ROOT/scripts/lib/version.sh"

# ── DSH runtime manifest freshness ────────────────────────────────
# The CLI binary inlines generated/dsh-runtime-manifest.json at bundle time
# (static JSON import in @wopal/ellamaka-cordis/runtime). Release builds
# (ELLAMAKA_RELEASE=1, CI) only verify with `--check`; dev builds regenerate
# when the committed manifest is missing or dirty. The build entry itself
# (ellamaka-release build.ts) also gates — this keeps the local chain explicit.
ensure_dsh_manifest() {
  # Absolute path: the generators resolve their package root themselves, but a
  # bare relative path only resolves when the caller's cwd is the repo root
  # (build.sh is invoked from arbitrary directories, e.g. the space root).
  local generator="$PROJECT_ROOT/packages/ellamaka-cordis/script/generate-dsh-runtime-manifest.ts"
  if [ -n "${ELLAMAKA_RELEASE:-}" ]; then
    bun "$generator" --check --quiet
    return 0
  fi
  if bun "$generator" --check --quiet 2>/dev/null; then
    return 0
  else
    bun "$generator" --quiet
  fi
}

# ── DSH runtime lock freshness ─────────────────────────────────
# Same gate as the manifest: release/CI only verifies the embedded lock binds
# the current manifest fingerprint; dev builds regenerate when the lock is
# missing or drifted (only happens after a dependency version bump; the
# generator's fast path exits in milliseconds when the fingerprint matches).
ensure_dsh_lock() {
  local generator="$PROJECT_ROOT/packages/ellamaka-cordis/script/generate-dsh-runtime-lock.ts"
  if [ -n "${ELLAMAKA_RELEASE:-}" ]; then
    bun "$generator" --check --quiet
    return 0
  fi
  bun "$generator" --quiet
}

# ── CLI build ──────────────────────────────────────────────

function build_cli() {
  MODE="single"
  INSTALL=false
  VERBOSE=false
  CUSTOM_VERSION=""
  CHANNEL="main"
  BUILD_ARGS=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        show_help
        ;;
      --version)
        if [[ $# -lt 2 || "$2" == --* ]]; then
          echo "❌ --version requires a version string value"
          exit 1
        fi
        CUSTOM_VERSION="$2"
        shift 2
        ;;
      --channel)
        if [[ $# -lt 2 || "$2" == --* ]]; then
          echo "❌ --channel requires a value: main or local"
          exit 1
        fi
        case "$2" in
          main|local) CHANNEL="$2" ;;
          *) echo "❌ Invalid channel: $2 (must be main or local)"; exit 1 ;;
        esac
        shift 2
        ;;
      --platform)
        if [[ $# -lt 2 || "$2" == --* ]]; then
          echo "❌ --platform requires a value: mac, linux, win (comma-separated)"
          exit 1
        fi
        BUILD_ARGS+=("--platform" "$2")
        shift 2
        ;;
      --arch)
        MODE="arch"
        BUILD_ARGS+=("--arch" "$2")
        shift 2
        ;;
      --web-ui)
        if [[ $# -lt 2 || "$2" == --* ]]; then
          echo "❌ --web-ui requires a value: ellamaka-app, app, or none"
          exit 1
        fi
        BUILD_ARGS+=("--web-ui" "$2")
        shift 2
        ;;
      --install)
        INSTALL=true
        shift
        ;;
      --verbose)
        VERBOSE=true
        shift
        ;;
      --single|--skip-deps|--skip-install)
        shift
        ;;
      *)
        BUILD_ARGS+=("$1")
        shift
        ;;
    esac
  done

  # Resolve version + channel first so the header precedes all steps.
  if [[ -n "${CUSTOM_VERSION:-}" ]]; then
    export ELLAMAKA_VERSION="$CUSTOM_VERSION"
  elif [[ -z "${ELLAMAKA_VERSION:-}" ]]; then
    # CLI builds use the channel as the version suffix; the branch name is
    # not part of the version string.
    export ELLAMAKA_VERSION="$(resolve_build_version "ellamaka-cli" "$CHANNEL")"
  fi
  # Release builds must not inject a channel: the version shape is the single
  # source of truth (build-env fail-closed derivation). An unconditional
  # export of the dev default ("main") contradicted the derived release
  # channel and broke every CLI release build with ELLAMAKA_RELEASE=true.
  if [[ -z "${ELLAMAKA_RELEASE:-}" ]]; then
    export ELLAMAKA_CHANNEL="$CHANNEL"
  fi

  local total=4
  $INSTALL && total=5

  echo "" >&2
  echo "ellamaka cli · $CHANNEL · $ELLAMAKA_VERSION" >&2
  echo "" >&2

  # Step 1: DSH closure check
  if [ -t 2 ]; then printf "  1/%d  dsh closure   checking..." "$total" >&2; fi
  ensure_dsh_manifest
  ensure_dsh_lock
  if [ -t 2 ]; then printf "\r\033[K" >&2; fi
  printf "  1/%d  dsh closure   ✓ manifest + lock ready\n" "$total" >&2

  cd "$PROJECT_ROOT/packages/opencode"

  case "$MODE" in
    single)
      BUILD_ARGS+=("--single")
      ;;
    arch)
      ;;
  esac

  if $VERBOSE; then
    export ELLAMAKA_BUILD_VERBOSE=1
  fi
  export ELLAMAKA_BUILD_STEPS_TOTAL="$total"

  BINARY_NAME="$BINARY_NAME" bun "$PROJECT_ROOT/packages/ellamaka-release/src/cli/build.ts" "${BUILD_ARGS[@]}"

  # Final step: Install (if requested)
  if $INSTALL; then
    PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
    ARCH="$(uname -m)"
    [[ "$ARCH" == "x86_64" ]] && ARCH="x64"

    DIST_DIR="$PROJECT_ROOT/dist/${BINARY_NAME}-${PLATFORM}-${ARCH}/bin"
    SRC="$DIST_DIR/$BINARY_NAME"

    if [[ ! -f "$SRC" ]]; then
      printf "  %d/%d  install       ✗ binary not found\n" "$total" "$total" >&2
      exit 1
    fi

    if [ -t 2 ]; then printf "  %d/%d  install       linking..." "$total" "$total" >&2; fi
    mkdir -p "$HOME/.wopal/bin"
    SYMLINK="$HOME/.wopal/bin/${BINARY_NAME}-main"

    NEW_VER=$("$SRC" --version 2>/dev/null || echo "unknown")
    OLD_VER=$([[ -L "$SYMLINK" ]] && "$SYMLINK" --version 2>/dev/null || echo "none")

    rm -f "$SYMLINK" && ln -s "$SRC" "$SYMLINK"
    if [ -t 2 ]; then printf "\r\033[K" >&2; fi
    printf "  %d/%d  install       ✓ %s → %s\n" "$total" "$total" "$OLD_VER" "$NEW_VER" >&2
  fi
}

# ── Desktop build ──────────────────────────────────────────

function build_desktop() {
  INSTALL=false
  CHANNEL="main"
  CUSTOM_VERSION=""
  PLATFORM="mac"
  CI_ARCH="x64"
  CI_OUT_DIR="$PROJECT_ROOT/dist/ci"
  CI_NO_WAIT=false
  CI_FORCE=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        show_help
        ;;
      --channel)
        if [[ $# -lt 2 || "$2" == --* ]]; then
          echo "❌ --channel requires a value: main, beta, or stable"
          exit 1
        fi
        case "$2" in
          main|beta|stable) CHANNEL="$2" ;;
          *) echo "❌ Invalid channel: $2 (must be main, beta, or stable)"; exit 1 ;; 
        esac
        shift 2
        ;;
      --version)
        if [[ $# -lt 2 || "$2" == --* ]]; then
          echo "❌ --version requires a version string value"
          exit 1
        fi
        CUSTOM_VERSION="$2"
        shift 2
        ;;
      --platform)
        if [[ $# -lt 2 || "$2" == --* ]]; then
          echo "❌ --platform requires a value: mac, linux, or win"
          exit 1
        fi
        case "$2" in
          mac|linux|win) PLATFORM="$2" ;;
          *) echo "❌ Invalid platform: $2 (must be mac, linux, or win)"; exit 1 ;;
        esac
        shift 2
        ;;
      --arch)
        if [[ $# -lt 2 || "$2" == --* ]]; then
          echo "❌ --arch requires a value: arm64 or x64"
          exit 1
        fi
        case "$2" in
          arm64|x64) CI_ARCH="$2" ;;
          *) echo "❌ Invalid arch: $2 (must be arm64 or x64)"; exit 1 ;;
        esac
        shift 2
        ;;
      --out)
        if [[ $# -lt 2 || "$2" == --* ]]; then
          echo "❌ --out requires a directory path"
          exit 1
        fi
        CI_OUT_DIR="$2"
        shift 2
        ;;
      --no-wait)
        CI_NO_WAIT=true
        shift
        ;;
      --force)
        CI_FORCE=true
        shift
        ;;
      --install)
        INSTALL=true
        shift
        ;;
      *)
        echo "❌ Unknown option: $1"
        exit 1
        ;;
    esac
  done

  # 平台分流：本机 mac + 目标 mac → 本地构建；否则走 GitHub Actions。
  HOST_OS="$(uname -s)"
  if [[ "$HOST_OS" != "Darwin" || "$PLATFORM" != "mac" ]]; then
    build_desktop_ci
    return
  fi

  export ELLAMAKA_CHANNEL="$CHANNEL"

  if [[ -n "${CUSTOM_VERSION:-}" ]]; then
    export ELLAMAKA_VERSION="$CUSTOM_VERSION"
  elif [[ -z "${ELLAMAKA_VERSION:-}" ]]; then
    export ELLAMAKA_VERSION="$(resolve_build_version "ellamaka-desktop" "$CHANNEL")"
  fi

  # Inject build hash so the packaged app shows which commit it was built from
  export ELLAMAKA_BUILD_ID="${ELLAMAKA_BUILD_ID:-$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || true)}"

  # Use the already-installed electron from node_modules instead of re-downloading
  local electron_dist="$PROJECT_ROOT/node_modules/electron/dist"
  if [[ -d "$electron_dist" ]]; then
    export ELECTRON_DIST="$electron_dist"
  fi

  case "$CHANNEL" in
    main) APP_NAME="Ellamaka Main" ;;
    beta) APP_NAME="Ellamaka Beta" ;;
    stable) APP_NAME="Ellamaka" ;;
  esac

  DESKTOP_DIR="$PROJECT_ROOT/packages/ellamaka-desktop"

  if $INSTALL && [[ "$(uname -s)" == "Darwin" ]]; then
    if pgrep -f "${APP_NAME}.app/Contents/MacOS" >/dev/null 2>&1; then
      printf "  ✗ %s is running. Quit it first.\n" "$APP_NAME" >&2
      exit 1
    fi
  fi

  local total=2
  $INSTALL && total=3

  echo "" >&2
  echo "ellamaka desktop · $CHANNEL · $ELLAMAKA_VERSION" >&2
  echo "" >&2

  cd "$DESKTOP_DIR"

  # Step 1: Build
  if [ -t 2 ]; then printf "  1/%d  build         building...\r" "$total" >&2; fi
  local build_out
  build_out=$(bun run build 2>&1) || {
    if [ -t 2 ]; then printf "\r\033[K" >&2; fi
    printf "  1/%d  build         ✗ failed\n" "$total" >&2
    echo "$build_out" | tail -30 >&2
    exit 1
  }
  if [ -t 2 ]; then printf "\r\033[K" >&2; fi
  printf "  1/%d  build         ✓ done\n" "$total" >&2
  # Show warnings from build output (non-empty, non-command-echo lines)
  local build_warn
  build_warn=$(echo "$build_out" | grep -v '^$' | grep -v '^$ ' | head -10)
  if [ -n "$build_warn" ]; then
    printf "    ⚠ warnings:\n" >&2
    echo "$build_warn" | sed 's/^/      /' >&2
  fi

  # Step 2: Package
  if [ -t 2 ]; then printf "  2/%d  package       packaging...\r" "$total" >&2; fi
  local pkg_out
  pkg_out=$(bun run package:mac 2>&1) || {
    if [ -t 2 ]; then printf "\r\033[K" >&2; fi
    printf "  2/%d  package       ✗ failed\n" "$total" >&2
    echo "$pkg_out" | tail -30 >&2
    exit 1
  }
  if [ -t 2 ]; then printf "\r\033[K" >&2; fi
  local pkg_warn
  pkg_warn=$(echo "$pkg_out" | grep -v '^$' | grep -v '^$ ' | head -10)
  if [ -n "$pkg_warn" ]; then
    printf "    ⚠ warnings:\n" >&2
    echo "$pkg_warn" | sed 's/^/      /' >&2
  fi
  APP_PATH=$(find "$DESKTOP_DIR/dist" -name "${APP_NAME}.app" -type d -maxdepth 3 2>/dev/null | head -1)
  if [[ -z "$APP_PATH" ]]; then
    printf "  2/%d  package       ✗ .app not found\n" "$total" >&2
    exit 1
  fi
  printf "  2/%d  package       ✓ %s\n" "$total" "${APP_PATH##*/}" >&2

  if $INSTALL; then
    if [ -t 2 ]; then printf "  3/%d  install       copying...\r" "$total" >&2; fi
    rm -rf "/Applications/${APP_NAME}.app"
    cp -R "$APP_PATH" "/Applications/"
    if [ -t 2 ]; then printf "\r\033[K" >&2; fi
    printf "  3/%d  install       ✓ /Applications/%s\n" "$total" "${APP_NAME}.app" >&2
  fi
}

# ── Desktop CI build（GitHub Actions，非本机平台）──────────

function build_desktop_ci() {
  local version
  if [[ -n "$CUSTOM_VERSION" ]]; then
    version="$CUSTOM_VERSION"
  else
    version="$(resolve_build_version "ellamaka-desktop" "$CHANNEL" "$PROJECT_ROOT")"
  fi

  local total=4
  $CI_NO_WAIT && total=3

  echo "" >&2
  echo "ellamaka desktop · $CHANNEL · $version" >&2
  echo "" >&2

  if $INSTALL; then
    printf "  1/%d  pre-flight    ℹ --install skipped (CI downloads to %s)\n" "$total" "$CI_OUT_DIR" >&2
  fi

  case "$CHANNEL" in
    beta|stable) ;;
    *)
      echo "❌ CI build only supports --channel beta|stable; main is local-only."
      exit 1
      ;;
  esac

  case "$PLATFORM" in
    linux)
      OS_LABEL="Linux"
      RUNNER="ubuntu-latest"
      ;;
    win)
      OS_LABEL="Windows"
      RUNNER="windows-latest"
      ;;
    *)
      echo "❌ Unsupported CI platform: $PLATFORM"
      exit 1
      ;;
  esac

  if [[ "$PLATFORM" == "win" && "$CI_ARCH" == "arm64" ]]; then
    echo "❌ Windows CI builds support x64 only"
    exit 1
  fi

  if ! command -v gh >/dev/null 2>&1; then
    echo "❌ gh CLI is required (brew install gh)"
    exit 1
  fi
  if ! gh auth status >/dev/null 2>&1; then
    echo "❌ gh is not authenticated. Run 'gh auth login' first."
    exit 1
  fi

  local branch
  branch="$(git -C "$PROJECT_ROOT" branch --show-current)"
  if [[ -z "$branch" ]]; then
    echo "❌ Not on a branch (detached HEAD). Check out a branch first."
    exit 1
  fi

  # CI builds the pushed code. A dirty tree or an unpushed branch means the
  # build would not contain local changes — confirm before burning a run.
  local dirty upstream ahead
  dirty="$(git -C "$PROJECT_ROOT" status --porcelain)"
  upstream="$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref "@{u}" 2>/dev/null || true)"
  ahead=""
  if [[ -n "$upstream" ]]; then
    ahead="$(git -C "$PROJECT_ROOT" rev-list --count "@{u}..HEAD" 2>/dev/null || echo 0)"
  fi
  if [[ -n "$dirty" || -z "$upstream" || ( -n "$ahead" && "$ahead" != "0" ) ]]; then
    if ! $CI_FORCE; then
      echo "CI builds the pushed code on branch '$branch'."
      if [[ -n "$dirty" ]]; then
        echo "  Working tree has uncommitted changes — they will NOT be in the build:"
        echo "$dirty" | head -10
      fi
      if [[ -z "$upstream" ]]; then
        echo "  Branch has no upstream — it has not been pushed."
      elif [[ -n "$ahead" && "$ahead" != "0" ]]; then
        echo "  Branch is $ahead commit(s) ahead of its upstream."
      fi
      read -r -p "Continue anyway? [y/N] " answer
      if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
        echo "Aborted."
        exit 1
      fi
    fi
  fi

  local workflow="publish-ellamaka-desktop.yml"
  local artifact_name="desktop-$RUNNER"
  printf "  1/%d  pre-flight    ✓ %s/%s on branch %s\n" "$total" "$OS_LABEL" "$CI_ARCH" "$branch" >&2

  # Step 2: Dispatch
  if [ -t 2 ]; then printf "  2/%d  dispatch      dispatching...\r" "$total" >&2; fi
  if ! gh workflow run "$workflow" -R "$REPO" --ref "$branch" \
      -f "channel=$CHANNEL" -f "os=$PLATFORM" -f "version=$version" -f "publish=false"; then
    if [ -t 2 ]; then printf "\r\033[K" >&2; fi
    printf "  2/%d  dispatch      ✗ failed\n" "$total" >&2
    exit 1
  fi

  # The dispatch response does not include a run id; poll the run list for the
  # newest run on this branch. Sleep briefly so the new run appears first.
  sleep 3
  local run_id
  run_id="$(gh run list --workflow "$workflow" -R "$REPO" --branch "$branch" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"
  if [[ -z "$run_id" ]]; then
    printf "  2/%d  dispatch      ✗ could not find run id\n" "$total" >&2
    echo "    https://github.com/$REPO/actions" >&2
    exit 1
  fi
  local run_url="https://github.com/$REPO/actions/runs/$run_id"
  if [ -t 2 ]; then printf "\r\033[K" >&2; fi
  printf "  2/%d  dispatch      ✓ dispatched\n" "$total" >&2
  echo "    $run_url" >&2

  if $CI_NO_WAIT; then
    printf "  3/%d  ci wait       ℹ triggered (--no-wait)\n" "$total" >&2
    echo "    $run_url" >&2
    return 0
  fi

  # Step 3: Wait for CI
  if [ -t 2 ]; then printf "  3/%d  ci wait       watching...\r" "$total" >&2; fi
  if ! gh run watch "$run_id" -R "$REPO" --exit-status >/dev/null 2>&1; then
    if [ -t 2 ]; then printf "\r\033[K" >&2; fi
    printf "  3/%d  ci wait       ✗ run failed\n" "$total" >&2
    gh run view "$run_id" -R "$REPO" --log-failed 2>/dev/null | tail -50 >&2 || true
    exit 1
  fi
  if [ -t 2 ]; then printf "\r\033[K" >&2; fi
  printf "  3/%d  ci wait       ✓ completed\n" "$total" >&2
  echo "    $run_url" >&2

  # Step 4: Download
  mkdir -p "$CI_OUT_DIR"
  if [ -t 2 ]; then printf "  4/%d  download      fetching...\r" "$total" >&2; fi
  if ! gh run download "$run_id" -R "$REPO" --name "$artifact_name" --dir "$CI_OUT_DIR"; then
    if [ -t 2 ]; then printf "\r\033[K" >&2; fi
    printf "  4/%d  download      ✗ failed\n" "$total" >&2
    exit 1
  fi

  flatten_artifact() {
    local name="$1" source destination
    source="$(find "$CI_OUT_DIR" -type f -name "$name" -print -quit 2>/dev/null)"
    if [[ -z "$source" ]]; then
      return 1
    fi
    destination="$CI_OUT_DIR/$(basename "$source")"
    if [[ "$source" != "$destination" ]]; then
      mv "$source" "$destination"
    fi
    printf '%s\n' "$destination"
  }

  # electron-builder artifact prefix: beta channel gets -beta suffix.
  local primary_prefix="ellamaka-desktop"
  [[ "$CHANNEL" == "beta" ]] && primary_prefix="ellamaka-desktop-beta"
  local primary
  if [[ "$PLATFORM" == "linux" ]]; then
    primary="${primary_prefix}-linux-${CI_ARCH}.AppImage"
  else
    primary="${primary_prefix}-win-${CI_ARCH}.exe"
  fi

  local app
  app="$(flatten_artifact "$primary" || true)"
  if [[ -z "$app" ]]; then
    if [ -t 2 ]; then printf "\r\033[K" >&2; fi
    printf "  4/%d  download      ✗ %s not found\n" "$total" "$primary" >&2
    find "$CI_OUT_DIR" -type f | head -20
    exit 1
  fi

  local -a packages=("$app")
  if [[ "$PLATFORM" == "linux" ]]; then
    local deb_package
    deb_package="$(flatten_artifact "${primary_prefix}-linux-${CI_ARCH}.deb" || true)"
    if [[ -n "$deb_package" ]]; then
      packages+=("$deb_package")
    fi
  fi

  local size
  size="$(du -h "$app" | cut -f1)"
  if [ -t 2 ]; then printf "\r\033[K" >&2; fi
  printf "  4/%d  download      ✓ %s (%s)\n" "$total" "${app##*/}" "$size" >&2
  for package in "${packages[@]}"; do
    echo "    $package" >&2
  done
  echo "    $run_url" >&2
}

# ── Dispatch ───────────────────────────────────────────────

case "$TARGET" in
  -h|--help|"")
    show_help
    ;;
  cli)
    build_cli "$@"
    ;;
  desktop)
    build_desktop "$@"
    ;;
  *)
    echo "❌ Unknown target: $TARGET"
    echo "   Usage: build.sh cli|desktop [options]"
    exit 1
    ;;
esac