#!/bin/bash
# Desktop CDP port wiring shared by scripts/dev.sh and its tests.
#
# The port has three sources, in precedence order:
#   1. explicit argument to `desktop --cdp-debug <port>`
#   2. ELLAMAKA_DESKTOP_CDP_PORT
#   3. 9222 (historical default)
#
# Resolving it in one place keeps the free-port check, the environment handed
# to Electron, and the listener ledger from disagreeing about which port is in
# use — a mismatch showed up as the custom CDP port being reported as the
# sidecar port.

# Print the CDP port for an explicit `--cdp-debug` argument ("" when absent).
desktop_cdp_resolve_port() {
  local explicit="${1:-}"
  if [[ "$explicit" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$explicit"
    return 0
  fi
  local from_env="${ELLAMAKA_DESKTOP_CDP_PORT:-}"
  if [[ "$from_env" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$from_env"
    return 0
  fi
  printf '9222\n'
}

# Print the environment pair handed to Electron for the given CDP port.
# Keeping this beside the resolver means the value we checked for availability
# is the value Electron actually binds.
desktop_cdp_env_flags() {
  local port="$1"
  printf 'ELLAMAKA_DESKTOP_CDP=1\nELLAMAKA_DESKTOP_CDP_PORT=%s\n' "$port"
}
