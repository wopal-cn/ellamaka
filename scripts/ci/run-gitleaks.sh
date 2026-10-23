#!/usr/bin/env bash
# Run a pinned, checksum-verified gitleaks binary.
#
# The first run downloads the release archive into the user cache, verifies it
# against the official SHA256, extracts the binary and executes it. Later runs
# reuse the cached archive and binary, so no global install is required and no
# binary ever lands in the repository.
#
# Usage:
#   scripts/ci/run-gitleaks.sh                 # scan the staged diff (pre-commit)
#   scripts/ci/run-gitleaks.sh <gitleaks args> # passthrough, e.g. "version"
#
# GITLEAKS_DOWNLOAD_BASE_URL may point at a mirror; the pinned checksum still
# decides whether the downloaded bytes are accepted.
set -euo pipefail

GITLEAKS_VERSION="8.30.1"

# Official SHA256 values from gitleaks_<version>_checksums.txt in the release.
pinned_checksum() {
  case "$1" in
    darwin_arm64) echo "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5" ;;
    darwin_x64) echo "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709" ;;
    linux_arm64) echo "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080" ;;
    linux_x64) echo "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb" ;;
    *) echo "" ;;
  esac
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *)
    echo "error: gitleaks bootstrap does not support OS $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *)
    echo "error: gitleaks bootstrap does not support architecture $(uname -m)" >&2
    exit 1
    ;;
esac

expected_checksum="$(pinned_checksum "${os}_${arch}")"
if [ -z "$expected_checksum" ]; then
  echo "error: no pinned gitleaks checksum for ${os}/${arch}" >&2
  exit 1
fi

asset="gitleaks_${GITLEAKS_VERSION}_${os}_${arch}.tar.gz"
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/ellamaka/gitleaks/${GITLEAKS_VERSION}"
archive="${cache_root}/${asset}"
binary="${cache_root}/gitleaks"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "error: gitleaks bootstrap needs sha256sum or shasum" >&2
    exit 1
  fi
}

checksum_ok() {
  [ "$(sha256_of "$1")" = "$expected_checksum" ]
}

extract_binary() {
  tar -xzf "$archive" -C "$cache_root" gitleaks
  chmod +x "$binary"
}

download_archive() {
  local base_url tmp
  base_url="${GITLEAKS_DOWNLOAD_BASE_URL:-https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}}"
  tmp="${archive}.download.$$"
  echo "gitleaks: fetching ${asset} (${GITLEAKS_VERSION}) into ${cache_root}" >&2
  if ! curl -fsSL --retry 3 --retry-delay 1 --connect-timeout 20 --max-time 300 -o "$tmp" "${base_url}/${asset}"; then
    rm -f "$tmp"
    echo "error: could not download ${base_url}/${asset}" >&2
    exit 1
  fi
  if ! checksum_ok "$tmp"; then
    rm -f "$tmp"
    echo "error: gitleaks ${asset} checksum mismatch (expected ${expected_checksum})" >&2
    exit 1
  fi
  mv "$tmp" "$archive"
  extract_binary
}

mkdir -p "$cache_root"

if [ -f "$archive" ]; then
  if ! checksum_ok "$archive"; then
    echo "gitleaks: cached archive failed checksum verification, refetching" >&2
    rm -f "$archive" "$binary"
  fi
fi

if [ ! -f "$archive" ]; then
  download_archive
elif [ ! -x "$binary" ]; then
  extract_binary
fi

if [ "$#" -eq 0 ]; then
  set -- git --pre-commit --staged --redact --verbose --no-banner --exit-code 1
fi

exec "$binary" "$@"
