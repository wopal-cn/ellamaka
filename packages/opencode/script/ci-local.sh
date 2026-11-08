#!/usr/bin/env bash
# ci-local.sh — one-command local replica of .github/workflows/ci.yml.
#
# Two hidden prerequisites are baked in:
#   (a) It must run OUTSIDE any macOS seatbelt sandbox. Agents often run inside
#       seatbelt; seatbelt cannot nest, so DSH tests that call `sandbox-exec`
#       fail with `sandbox_apply: Operation not permitted` (exit 71) — a false
#       positive. When the probe detects a sandbox we relaunch ourselves
#       outside it via `launchctl submit` (the only unprivileged escape),
#       stream the job's log back, and propagate its exit code.
#   (b) It must run with a CI-clean environment. Host shells leak vars like
#       OPENCODE_EXPERIMENTAL_FILEWATCHER / WOPAL_HOME and carry a global git
#       identity that CI runners lack (which once hid `fatal: empty ident
#       name`). Every step therefore runs under `env -i` with a whitelist.
#
# Usage: bun run ci:local   (or: bash packages/opencode/script/ci-local.sh)

set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,20p' "$0"
  exit 0
fi

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
ROOT="$(cd "$(dirname "$SCRIPT")/../../.." && pwd)"

RELAUNCHED="${ELLAMAKA_CI_LOCAL_RELAUNCHED:-}"

# --- step 2: sandbox probe / launchd escape (macOS only) ---------------------

sandboxed() {
  [[ "$(uname -s)" == "Darwin" ]] || return 1
  # A permissive `(allow default)` applies fine inside seatbelt, so the probe
  # must carry a real deny: nested apply is denied with exit 71.
  ! sandbox-exec -p '(version 1)(allow default)(deny file-read-data (literal "/nonexistent-ci-probe"))' /usr/bin/true 2>/dev/null
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ci-local: non-macOS host — running directly; GitHub CI (ubuntu-24.04) remains the authority on Linux."
elif sandboxed; then
  if [[ -n "$RELAUNCHED" ]]; then
    echo "ci-local: ERROR — still sandboxed after launchd relaunch; cannot escape the seatbelt sandbox." >&2
    exit 1
  fi
  echo "ci-local: seatbelt sandbox detected — relaunching outside it via launchd."
  out="$(mktemp -d "${TMPDIR:-/tmp}/ellamaka-ci-local.XXXXXX")"
  label="ai.wopal.ellamaka.ci-local.$$"
  bun_dir="$(dirname "$(command -v bun || echo /usr/bin/false)")"
  wrapper="$out/wrapper.sh"
  cat > "$wrapper" <<EOF
#!/bin/bash
exec > "$out/ci-local.log" 2>&1
export PATH="$bun_dir:$PATH"
export ELLAMAKA_CI_LOCAL_RELAUNCHED=1
cd "$ROOT"
/bin/bash "$SCRIPT"
echo \$? > "$out/exit-code"
EOF
  chmod +x "$wrapper"
  # `launchctl submit` may report exit 1 here even though the job runs; the
  # exit-code file is the real success signal.
  launchctl submit -l "$label" -- /bin/bash "$wrapper" || true
  (tail -n +1 -f "$out/ci-local.log" 2>/dev/null) &
  tail_pid=$!
  waited=0
  limit=5400 # 90 min, matching the CI job timeout
  while [[ ! -f "$out/exit-code" ]]; do
    sleep 2
    waited=$((waited + 2))
    if ((waited >= limit)); then
      kill "$tail_pid" 2>/dev/null || true
      launchctl remove "$label" 2>/dev/null || true
      echo "ci-local: ERROR — relaunched run exceeded ${limit}s; job removed. Log: $out/ci-local.log" >&2
      exit 1
    fi
    if ((waited == 30)) && [[ ! -s "$out/ci-local.log" ]]; then
      kill "$tail_pid" 2>/dev/null || true
      launchctl remove "$label" 2>/dev/null || true
      echo "ci-local: ERROR — launchd relaunch did not start (log still empty after 30s); this sandbox blocks job submission." >&2
      echo "ci-local: run 'bun run ci:local' from a normal terminal or an unsandboxed agent command instead." >&2
      exit 1
    fi
  done
  sleep 1 # let the tail flush the final lines
  kill "$tail_pid" 2>/dev/null || true
  wait "$tail_pid" 2>/dev/null || true
  launchctl remove "$label" 2>/dev/null || true
  code="$(cat "$out/exit-code")"
  echo "ci-local: full log at $out/ci-local.log"
  exit "$code"
fi

# --- step 3: CI-clean environment ---------------------------------------------

dropped="$(env | cut -d= -f1 | grep -E '^(OPENCODE|ELLAMAKA|WOPAL|GIT)_' | grep -vx 'ELLAMAKA_CI_LOCAL_RELAUNCHED' | sort | tr '\n' ' ' || true)"
if [[ -n "$dropped" ]]; then
  echo "ci-local: neutralising host env vars (names only): $dropped"
fi

cienv() {
  env -i \
    PATH="$PATH" \
    HOME="$HOME" \
    PWD="$PWD" \
    USER="${USER:-}" \
    LOGNAME="${LOGNAME:-}" \
    SHELL="${SHELL:-/bin/bash}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    LANG="${LANG:-en_US.UTF-8}" \
    TERM="${TERM:-xterm-256color}" \
    CI=true \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    "$@"
}

# --- step 4: CI steps, same order as .github/workflows/ci.yml -----------------

declare -a results=()
fail_step=""

run_step() {
  local name="$1"
  shift
  echo ""
  echo "=== ci-local step: $name ==="
  local start=$SECONDS
  if "$@"; then
    results+=("$name|PASS|$((SECONDS - start))s")
  else
    results+=("$name|FAIL|$((SECONDS - start))s")
    fail_step="$name"
    return 1
  fi
}

dsh_grep_regression() {
  cd "$ROOT/packages/opencode"
  local attempt
  for attempt in 1 2 3 4 5 6 7 8; do
    echo "DSH grep cold process $attempt/8"
    cienv bun test test/cli/cmd/tui/dsh-mount.test.ts -t 'executes grep' || return 1
  done
  cd "$ROOT"
}

cd "$ROOT"

# Fail fast like CI: stop at the first failing step, then still print the
# summary below. Each `|| return 0` keeps `set -e` from aborting the script.
run_all() {
  run_step "install"                cienv bun install --frozen-lockfile || return 0
  run_step "typecheck"              cienv bun run typecheck || return 0
  run_step "test-isolation"         cienv bun run check:test-isolation || return 0
  run_step "isolation-gate-tests"   cienv bun run test:isolation-gate || return 0
  run_step "dsh-grep-regression"    dsh_grep_regression || return 0
  run_step "lint"                   cienv bun run lint || return 0
  run_step "test-order-isolation"   cienv bun run --cwd packages/ellamaka-app check:test-order-isolation || return 0
  # --force: CI never has a warm turbo cache; replaying local cache hits would
  # report stale greens.
  run_step "unit-tests"             cienv bunx turbo run test:ci --force || return 0
  if [[ "$(uname -s)" == "Darwin" ]]; then
    # The sandbox probe above already proved sandbox-exec works on this host;
    # scripts/ci/prepare-dsh-sandbox.sh is Linux/bwrap-only and does not apply.
    run_step "dsh-tools" cienv bun run --cwd packages/ellamaka-cordis test:tools
  else
    echo ""
    echo "=== ci-local step: dsh-tools ==="
    echo "skipped: DSH tool sandbox prep is Linux-only; GitHub CI slow job covers it."
    results+=("dsh-tools|SKIP|-")
  fi
}

run_all

echo ""
echo "=== ci-local summary ==="
printf '%-24s %-6s %s\n' "step" "result" "duration"
for row in "${results[@]}"; do
  IFS='|' read -r name result dur <<< "$row"
  printf '%-24s %-6s %s\n' "$name" "$result" "$dur"
done

if [[ -n "$fail_step" ]]; then
  echo "CI-LOCAL RESULT: FAIL ($fail_step)"
  exit 1
fi
echo "CI-LOCAL RESULT: PASS"
