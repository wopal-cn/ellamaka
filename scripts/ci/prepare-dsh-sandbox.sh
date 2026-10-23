#!/usr/bin/env bash
# Prepare and probe the system sandbox DSH needs on Linux.
#
# DSH's local backend runs confined commands under bubblewrap. Ubuntu 24.04
# restricts unprivileged user namespaces through AppArmor, so the hosted
# runners need both the package and the sysctl before bwrap can create a
# namespace. The probes below run the exact read-only and workspace-write
# profiles the backend uses; any failure exits non-zero so a release gate
# cannot pass without a working sandbox.
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
  echo "error: DSH system sandbox preparation is Linux-only (got $(uname -s))" >&2
  exit 1
fi

SUDO=()
if [ "$(id -u)" -ne 0 ]; then
  SUDO=(sudo)
fi

if ! command -v bwrap >/dev/null 2>&1; then
  echo "DSH sandbox: installing bubblewrap"
  "${SUDO[@]}" apt-get update -y
  "${SUDO[@]}" apt-get install -y --no-install-recommends bubblewrap
fi

restrict_userns=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
if [ -f "$restrict_userns" ] && [ "$(cat "$restrict_userns")" != "0" ]; then
  echo "DSH sandbox: allowing unprivileged user namespaces (AppArmor)"
  "${SUDO[@]}" sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi

clone_userns=/proc/sys/kernel/unprivileged_userns_clone
if [ -f "$clone_userns" ] && [ "$(cat "$clone_userns")" != "1" ]; then
  echo "DSH sandbox: allowing unprivileged user namespaces (sysctl)"
  "${SUDO[@]}" sysctl -w kernel.unprivileged_userns_clone=1
fi

read_only_probe=(bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent)

# Probe 1: the backend's read-only profile must start a process.
if ! "${read_only_probe[@]}" -- true; then
  echo "error: bubblewrap probe failed to create DSH's read-only sandbox" >&2
  echo "       if this is a fresh Ubuntu 24.04 host, unprivileged user namespaces are restricted" >&2
  exit 1
fi

# Probe 2: confinement must be real, not just a successful exec.
if "${read_only_probe[@]}" -- sh -c 'echo probe > /ellamaka-sandbox-probe' >/dev/null 2>&1; then
  echo "error: bubblewrap did not enforce a read-only root inside the sandbox" >&2
  exit 1
fi

# Probe 3: the workspace-write profile used by DSH's tool container.
workspace="$(mktemp -d)"
trap 'rm -rf "$workspace"' EXIT
if ! bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent \
  --tmpfs /tmp --bind "$workspace" "$workspace" -- sh -c "echo ok > '${workspace}/probe'"; then
  echo "error: bubblewrap cannot create DSH's workspace-write sandbox profile" >&2
  exit 1
fi

echo "ok: DSH system sandbox is available ($(bwrap --version))"
