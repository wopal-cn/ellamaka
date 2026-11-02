#!/bin/bash
# scripts/lib/version.sh — shared build version resolution for ellamaka
# CLI / Desktop / sidecar builds. Sourced by scripts/build.sh,
# scripts/dev.sh and the release scripts.
#
# Product version anchors (docs/DISTRIBUTION.md §3.2):
#   CLI product     → packages/ellamaka-cli/package.json
#   Desktop product → packages/ellamaka-desktop/package.json
#   Dependents      → root package.json (mirrors the CLI prerelease base,
#                     never carries -rc/-beta suffixes)

# anchor_map <product> <project_root>
#
# Prints the package.json path that carries the product's version anchor.
# Prints the root package.json for the dependents line ("deps").
function anchor_map() {
  local product="$1" project_root="${2:-$PROJECT_ROOT}"
  case "$product" in
    cli) echo "$project_root/packages/ellamaka-cli/package.json" ;;
    desktop) echo "$project_root/packages/ellamaka-desktop/package.json" ;;
    deps) echo "$project_root/package.json" ;;
    *) echo "$project_root/package.json" ;;
  esac
}

# current_version <cli|desktop|deps> [project_root]
#
# Reads the version anchor of the product (or the dependents line).
# Prints "0.0.0" when unreadable.
function current_version() {
  local product="$1" project_root="${2:-$PROJECT_ROOT}"
  local pkg
  pkg=$(anchor_map "$product" "$project_root")
  node -p "require('$pkg').version" 2>/dev/null || echo "0.0.0"
}

# bump_version <product> <patch|minor|major|rc|beta> [project_root]
#
# Prints the next version for the product's anchor. patch/minor/major bump
# the base and drop any prerelease; rc/beta continue the same-kind sequence
# on the current base, otherwise start a fresh -rc.1/-beta.1 on the next
# patch. Superseded by packages/ellamaka-release/src/version-line.ts
# (unified version-line model) — kept only for callers outside release.
function bump_version() {
  local product="$1" bump="$2" project_root="${3:-$PROJECT_ROOT}"
  local core
  core=$(current_version "$product" "$project_root")
  node -e "
    const v = process.argv[1]
    const bump = process.argv[2]
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(beta|rc)\.(\d+))?\$/)
    if (!m) { console.log(v); process.exit(0) }
    const ma = Number(m[1]), mi = Number(m[2]), pa = Number(m[3])
    const kind = m[4] || null
    const n = m[5] ? Number(m[5]) : 0
    if (bump === 'patch') console.log(ma + '.' + mi + '.' + (pa + 1))
    else if (bump === 'minor') console.log(ma + '.' + (mi + 1) + '.0')
    else if (bump === 'major') console.log((ma + 1) + '.0.0')
    else if (bump === 'rc') {
      if (kind === 'rc') console.log(ma + '.' + mi + '.' + pa + '-rc.' + (n + 1))
      else console.log(ma + '.' + mi + '.' + (pa + 1) + '-rc.1')
    }
    else if (bump === 'beta') {
      if (kind === 'beta') console.log(ma + '.' + mi + '.' + pa + '-beta.' + (n + 1))
      else console.log(ma + '.' + mi + '.' + (pa + 1) + '-beta.1')
    }
    else console.log(v)
  " "$core" "$bump"
}

# resolve_build_version <product> <suffix> [project_root]
#
# Resolves the local/dev build version as <next>-<suffix>.<timestamp>: the next
# release version of the product (stable preferred over prerelease, e.g. latest
# ellamaka-cli-v2.0.1 → 2.0.2), suffixed with the channel ("main" for CLI, the
# channel for Desktop), then a local timestamp. When the highest beta or rc
# base is ahead of the highest stable base, that base itself is the next
# version (e.g. ellamaka-desktop-v2.0.4-beta.1 with highest stable v2.0.3 →
# 2.0.4, not 2.0.5 — the unreleased patch slot must not be skipped). Local
# builds are always identifiable by this suffix — release versions come from
# product anchors and never pass through this function.
function resolve_build_version() {
  local product="$1" suffix="$2" project_root="${3:-$PROJECT_ROOT}"
  local version_tag timestamp
  local product_filter="${product}-v*"

  # Next release version for this product, mirroring suggest_release_version's
  # stable branch: next patch after the highest stable tag, or the highest
  # prerelease base itself when it is ahead. git's own --sort=v:refname does
  # not follow SemVer prerelease precedence, so selection happens in node.
  version_tag=$(git -C "$project_root" tag -l "$product_filter" 2>/dev/null | node -e "
    const cmp3 = (a, b) => a[0]-b[0] || a[1]-b[1] || a[2]-b[2]
    let stable = null, prerelease = null
    for (const raw of require('fs').readFileSync(0, 'utf8').split('\n')) {
      const m = raw.trim().match(/(\d+)\.(\d+)\.(\d+)(?:-(.+))?\$/)
      if (!m) continue
      const key = [Number(m[1]), Number(m[2]), Number(m[3])]
      if (m[4] === undefined) {
        if (!stable || cmp3(key, stable) > 0) stable = key
      } else {
        if (!prerelease || cmp3(key, prerelease) > 0) prerelease = key
      }
    }
    if (!stable && !prerelease) { console.log(''); process.exit(0) }
    const preAhead = prerelease && (!stable || cmp3(prerelease, stable) > 0)
    const base = preAhead ? prerelease : (stable || prerelease)
    console.log([base[0], base[1], base[2] + (preAhead ? 0 : 1)].join('.'))
  ")

  if [[ -n "$version_tag" ]]; then
    timestamp=$(date +"%Y%m%d%H%M%S")
    echo "${version_tag}-${suffix}.${timestamp}"
  else
    timestamp=$(date +"%Y%m%d%H%M%S")
    echo "0.0.0-${suffix}.${timestamp}"
  fi
}

# highest_release_tag <product> <channel> [project_root]
#
# Prints the highest SemVer tag for the product/channel: stable-only tags
# for stable channels, -beta.N tags for beta, -rc.N tags for rc. Prints
# nothing when no such tag exists. Used by lib/release.sh to detect
# failed-attempt retries (highest tag without an effective manifest was
# never released).
function highest_release_tag() {
  local product="$1" channel="$2" project_root="${3:-$PROJECT_ROOT}"
  git -C "$project_root" tag -l "${product}-v*" 2>/dev/null | node -e "
    const stable = [], beta = [], rc = []
    for (const raw of require('fs').readFileSync(0, 'utf8').split('\n')) {
      const m = raw.trim().match(/(\d+)\.(\d+)\.(\d+)(?:-(beta|rc)\.(\d+))?\$/)
      if (!m) continue
      const key = [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? null : Number(m[5])]
      if (m[4] === undefined) stable.push(key)
      else if (m[4] === 'beta') beta.push(key)
      else rc.push(key)
    }
    const cmp = (a, b) => a[0]-b[0] || a[1]-b[1] || a[2]-b[2] || (a[3] ?? 0) - (b[3] ?? 0)
    const list = '$channel' === 'beta' ? beta : ('$channel' === 'rc' ? rc : stable)
    list.sort((a, b) => cmp(b, a))
    const top = list[0]
    if (!top) { console.log(''); process.exit(0) }
    const suffix = top[3] !== null ? ('$channel' === 'rc' ? '-rc.' : '-beta.') + top[3] : ''
    console.log(top[0] + '.' + top[1] + '.' + top[2] + suffix)
  "
}

# highest_rc_tag <product> [project_root]
#
# Prints the highest -rc.N tag for the product (CLI rc candidates live in
# the stable channel). Prints nothing when no rc tag exists.
function highest_rc_tag() {
  local product="$1" project_root="${2:-$PROJECT_ROOT}"
  git -C "$project_root" tag -l "${product}-v*" 2>/dev/null | node -e "
    let best = null
    for (const raw of require('fs').readFileSync(0, 'utf8').split('\n')) {
      const m = raw.trim().match(/(\d+)\.(\d+)\.(\d+)-rc\.(\d+)\$/)
      if (!m) continue
      const key = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
      if (!best) { best = key; continue }
      for (let i = 0; i < 4; i++) {
        if (key[i] !== best[i]) { if (key[i] > best[i]) best = key; break }
      }
    }
    console.log(best ? best[0] + '.' + best[1] + '.' + best[2] + '-rc.' + best[3] : '')
  "
}

# suggest_release_version <product> <channel> [project_root]
#
# Suggests the next release version (no timestamp) for release:
#   channel stable: next patch after the highest stable tag; if the
#   highest beta base is ahead of the highest stable base, the beta base
#   itself (2.0.0-beta.4 → 2.0.0); never below an already-released rc base
#   (monotonic sequence).
#   channel beta: bump N while the beta sequence is ongoing (highest beta
#   base ahead of the highest stable base), otherwise a fresh -beta.1 on
#   the next patch of the highest stable base.
#   channel rc: rc.N+1 on the ongoing rc base, otherwise a fresh -rc.1 on
#   the next patch of the highest stable base.
# No tags at all → 0.1.0 (operator may override interactively).
function suggest_release_version() {
  local product="$1" channel="$2" project_root="${3:-$PROJECT_ROOT}"
  local product_filter="${product}-v*"
  git -C "$project_root" tag -l "$product_filter" 2>/dev/null | node -e "
    const cmp3 = (a, b) => a[0]-b[0] || a[1]-b[1] || a[2]-b[2]
    let stable = null, beta = null, rc = null
    for (const raw of require('fs').readFileSync(0, 'utf8').split('\n')) {
      const m = raw.trim().match(/(\d+)\.(\d+)\.(\d+)(?:-(beta|rc)\.(\d+))?$/)
      if (!m) continue
      const key = [Number(m[1]), Number(m[2]), Number(m[3])]
      if (m[4] === undefined) {
        if (!stable || cmp3(key, stable) > 0) stable = key
      } else if (m[4] === 'beta') {
        if (!beta || cmp3(key, beta) > 0 || (cmp3(key, beta) === 0 && Number(m[5]) > beta[3])) beta = [...key, Number(m[5])]
      } else {
        if (!rc || cmp3(key, rc) > 0 || (cmp3(key, rc) === 0 && Number(m[5]) > rc[3])) rc = [...key, Number(m[5])]
      }
    }
    const baseStr = (k) => k[0] + '.' + k[1] + '.' + k[2]
    const patchUp = (k) => k[0] + '.' + k[1] + '.' + (k[2] + 1)
    const betaAhead = beta && (!stable || cmp3(beta, stable) > 0)
    const rcAhead = rc && (!stable || cmp3(rc, stable) > 0)
    let out
    if ('$channel' === 'beta') {
      if (betaAhead) out = baseStr(beta) + '-beta.' + (beta[3] + 1)
      else out = (stable ? patchUp(stable) : (beta ? patchUp(beta) : '0.1.0')) + '-beta.1'
    } else if ('$channel' === 'rc') {
      const base = rcAhead ? baseStr(rc) : (stable ? patchUp(stable) : (rc ? patchUp(rc) : '0.1.0'))
      out = base + '-rc.' + (rc && baseStr(rc) === base ? rc[3] + 1 : 1)
    } else {
      let base = stable ? patchUp(stable) : (beta ? patchUp(beta) : '0.1.0')
      if (rc && cmp3(rc, base.split('.').map(Number)) > 0) base = baseStr(rc)
      out = base
    }
    console.log(out)
  "
}
