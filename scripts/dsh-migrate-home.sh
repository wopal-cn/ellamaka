#!/usr/bin/env bash
# dsh-migrate-home.sh — one-shot A1 home layout migration (Plan
# feature-dsh-a1-home-layout-migration Task 5).
#
# Moves the legacy layout into the official-layout DSH home:
#   $WOPAL_HOME/dsh/state/*    -> $WOPAL_HOME/dsh/home/
#   $WOPAL_HOME/dsh/profiles/* -> $WOPAL_HOME/dsh/home/profiles/
#
# Semantics:
# - Idempotent: when `state/` is gone and `home/profiles` exists, this is a
#   no-op (exit 0). A partially-completed prior run resumes: entries whose
#   destination already exists are skipped with a warning.
# - Engine-stop guard: `lsof +D` scans `state/` and `profiles/`; any bun/node/
#   ellamaka process holding files there aborts the migration (exit 1).
# - `.DS_Store` files are deleted, never migrated.
# - Writes `home/README.md` as the new sentinel: this directory IS the
#   DSH_HOME, official layout.

set -euo pipefail

WOPAL_HOME="${WOPAL_HOME:-$HOME/.wopal}"
DSH_DIR="$WOPAL_HOME/dsh"
STATE_DIR="$DSH_DIR/state"
PROFILES_DIR="$DSH_DIR/profiles"
HOME_DIR="$DSH_DIR/home"

die() { echo "dsh-migrate-home: $*" >&2; exit 1; }
info() { echo "dsh-migrate-home: $*"; }

# --- engine-stop guard ------------------------------------------------------
guard_engine_stopped() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  command -v lsof >/dev/null 2>&1 || die "lsof not found — cannot verify the engine is stopped; aborting for safety"
  local lsof_out rc=0
  lsof_out="$(lsof +D "$dir" 2>/dev/null)" || rc=$?
  # lsof exit codes: 0 = matches listed, 1 = no matches (clean), >=2 = error.
  if [[ $rc -ge 2 ]]; then
    die "lsof scan of $dir failed (exit $rc) — aborting for safety"
  fi
  local offenders
  offenders="$(printf '%s\n' "$lsof_out" | awk 'NR>1 {print $1}' | sort -u | grep -Ei '^(bun|node|ellamaka)' || true)"
  if [[ -n "$offenders" ]]; then
    die "engine appears to be running (lsof found: $offenders holding $dir). Stop the engine, then re-run."
  fi
}

guard_engine_stopped "$STATE_DIR"
guard_engine_stopped "$PROFILES_DIR"
# The destination is live data for the new layout: a resumed migration must
# never write into a home that a running engine (new code) is using.
guard_engine_stopped "$HOME_DIR"

# --- idempotency ------------------------------------------------------------
# A prior completed migration leaves BOTH legacy dirs absent. Only then is this
# a no-op. If either legacy dir is still present, we must (re)run its migration;
# silently skipping would strand leftover entries forever.
if [[ ! -d "$STATE_DIR" && ! -d "$PROFILES_DIR" ]]; then
  info "already migrated (legacy state/ and profiles/ both absent) — no-op"
  exit 0
fi

[[ -d "$DSH_DIR" ]] || die "$DSH_DIR does not exist"

# --- migrate ----------------------------------------------------------------
mkdir -p "$HOME_DIR"

# Drop junk files (recursively); they are deleted, never migrated.
for _junk_dir in "$STATE_DIR" "$PROFILES_DIR"; do
  [[ -d "$_junk_dir" ]] || continue
  find "$_junk_dir" -name '.DS_Store' -type f -delete
done

move_entries() {
  local src_dir="$1" dest_dir="$2"
  [[ -d "$src_dir" ]] || return 0
  mkdir -p "$dest_dir"
  shopt -s dotglob nullglob
  local entry
  for entry in "$src_dir"/*; do
    local base
    base="$(basename "$entry")"
    if [[ -e "$dest_dir/$base" ]]; then
      info "skip $base: destination already exists (resumed prior run?)"
      continue
    fi
    mv "$entry" "$dest_dir/$base"
    info "moved $base"
  done
  shopt -u dotglob nullglob
}

info "migrating $STATE_DIR -> $HOME_DIR"
move_entries "$STATE_DIR" "$HOME_DIR"

info "migrating $PROFILES_DIR -> $HOME_DIR/profiles"
move_entries "$PROFILES_DIR" "$HOME_DIR/profiles"

# --- retire the legacy directories ------------------------------------------
if [[ -d "$STATE_DIR" ]]; then
  rmdir "$STATE_DIR" 2>/dev/null || die "$STATE_DIR not empty after migration — inspect manually"
fi
if [[ -d "$PROFILES_DIR" ]]; then
  rmdir "$PROFILES_DIR" 2>/dev/null || die "$PROFILES_DIR not empty after migration — inspect manually"
fi

# --- sentinel README ---------------------------------------------------------
cat > "$HOME_DIR/README.md" <<'README'
# dsh/home — DSH_HOME

This directory is the DSH home of the Ellamaka engine: a 100% official-layout
harness home (`profiles/`, `.agent-presets/`, `sessions/`, `settings.yaml`, ...).

Both official resolution paths converge here:
- A-class config injection (`config.dshHome` patch rows) set by the host;
- B-class `$DSH_HOME` env reads (the host sets `DSH_HOME=$WOPAL_HOME/dsh/home`
  at process launch).

The official dsh CLI pointed at this home interoperates with the engine
(profiles, presets, sessions). The parent `$WOPAL_HOME/dsh` is the Ellamaka
territory root, NOT the DSH home; `closures/`, `plugins/`, `locks/` and
`staging/` live there and are engine-owned.
README

info "migration complete: $HOME_DIR is the DSH_HOME (official layout)"
