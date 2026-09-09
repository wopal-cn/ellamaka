// packages/ellamaka-release/src/cleanup/core.ts
//
// Product-agnostic cleanup kernel. Encapsulates the protection model
// (docs/DISTRIBUTION.md §7.2) shared by the ellamaka-cli and
// ellamaka-desktop cleanup flows: build a reference graph, plan retention,
// plan whole-version withdrawal, and (in the CLI) execute against R2,
// GitHub and Gitee. Product differences (channels, R2 roots, alias names,
// restore strategy) come from src/cleanup/products.ts.

import {
  compareSemVer,
  parseLegacyVersion,
  parseReleaseVersion,
  type ReleaseChannel,
} from "../identity"
import type {
  AliasMap,
  ProductConfig,
  ReferenceGraph,
  ReleaseSnapshot,
  RetentionPlan,
  WithdrawPlan,
} from "./types"

// ---------------------------------------------------------------------------
// Path helpers — delegated to ProductConfig (product-agnostic kernel)
// ---------------------------------------------------------------------------

function versionFromPath(config: ProductConfig, p: string): string | null {
  return config.versionFromPath(p)
}

function channelFromPath(config: ProductConfig, p: string): ReleaseChannel {
  return config.channelFromPath(p)
}

function pathForVersion(config: ProductConfig, version: string, channel: ReleaseChannel): string {
  return config.pathForVersion(version, channel)
}

// ---------------------------------------------------------------------------
// Reference graph
// ---------------------------------------------------------------------------

/**
 * Build the release reference graph. Any versioned path referenced by a
 * latest alias is protected. Legacy/unknown objects are classified but not
 * protected (fail-closed: retained, never auto-deleted).
 */
export function buildReferenceGraph(
  snapshot: ReleaseSnapshot,
  aliases: AliasMap,
  config: ProductConfig,
): ReferenceGraph {
  const protected_ = new Set<string>()
  const protectedReason = new Map<string, string>()
  const legacy = new Set<string>()
  const standard = new Set<string>()

  for (const [alias, version] of Object.entries(aliases)) {
    const aliasChannel = config.channelForAlias(alias)
    if (aliasChannel === null) continue
    const path = pathForVersion(config, version, aliasChannel)
    if (snapshot.versionedPaths.includes(path)) {
      protected_.add(path)
      protectedReason.set(path, `latest alias ${alias}`)
    }
  }

  for (const p of snapshot.versionedPaths) {
    const version = versionFromPath(config, p)
    if (!version) continue
    try {
      parseReleaseVersion(version)
      standard.add(p)
      continue
    } catch {
      // fall through to legacy classification
    }
    try {
      parseLegacyVersion(version)
      legacy.add(p)
      continue
    } catch {
      // unknown — fail closed, treat as legacy (retained)
      legacy.add(p)
    }
  }

  return { protected: protected_, protectedReason, legacy, standard }
}

// ---------------------------------------------------------------------------
// Retention planning
// ---------------------------------------------------------------------------

/**
 * Plan retention deletion for a product/channel. Uses standard SemVer
 * descending order. Protected releases are never deleted. Legacy releases
 * are retained (fail-closed).
 */
export function planRetention({
  config,
  channel,
  snapshot,
  aliases,
  keepStable,
  keepRc = 0,
  dryRun = false,
}: {
  config: ProductConfig
  channel: ReleaseChannel
  snapshot: ReleaseSnapshot
  aliases: AliasMap
  keepStable: number
  keepRc?: number
  dryRun?: boolean
}): RetentionPlan {
  const graph = buildReferenceGraph(snapshot, aliases, config)
  const candidates = []
  const legacyRetained: string[] = []

  for (const p of snapshot.versionedPaths) {
    const version = versionFromPath(config, p)
    if (!version) continue
    if (graph.legacy.has(p)) {
      legacyRetained.push(version)
      continue
    }
    if (!graph.standard.has(p)) continue
    // Desktop paths encode the channel (/beta/); for desktop, gate on the
    // path too so a beta version never leaks into stable retention and
    // vice-versa. CLI paths are channel-agnostic, so only the parsed
    // version channel is authoritative.
    if (config.product === "ellamaka-desktop" && channelFromPath(config, p) !== channel) continue
    try {
      const parsed = parseReleaseVersion(version)
      if (parsed.channel !== channel) continue
    } catch {
      continue
    }
    candidates.push({ version, path: p, protected: graph.protected.has(p) })
  }

  candidates.sort((a, b) => compareSemVer(b.version, a.version))

  // Fail-closed (B-02): a non-finite or negative keep would make the
  // deletion loop delete every unprotected release (i < NaN is always
  // false). Guard at the kernel level so no caller can trigger it.
  if (!Number.isFinite(keepStable) || keepStable < 0) {
    throw new Error(`keepStable must be a finite non-negative integer, got '${keepStable}'`)
  }
  if (!Number.isFinite(keepRc) || keepRc < 0) {
    throw new Error(`keepRc must be a finite non-negative integer, got '${keepRc}'`)
  }

  // Retention keeps the newest N releases of the bucket and deletes the
  // oldest beyond that. The latest alias normally points at the newest
  // release, so it is naturally retained; as a defensive guard, a release
  // the latest alias references is never deleted even if it falls outside
  // the newest N (e.g. a release whose alias promotion lagged).
  //
  // CLI rc releases form an independent retention bucket within the stable
  // channel: they are counted separately from bare stable versions, so a
  // long rc sequence never evicts the stable history (docs/DISTRIBUTION.md
  // §7.2). Desktop has no rc shape; keepRc is inert there.
  const deleteCandidates = []
  let stableKept = 0
  let rcKept = 0
  for (const c of candidates) {
    const isRc = c.version.includes("-rc.")
    if (isRc) {
      if (rcKept < keepRc) {
        rcKept++
        continue
      }
    } else {
      if (stableKept < keepStable) {
        stableKept++
        continue
      }
    }
    // Beyond the newest N: delete, unless the latest alias references it
    // (defensive guard — never delete what the latest alias points at).
    if (c.protected) continue
    deleteCandidates.push(c)
  }

  return { deleteCandidates, legacyRetained, dryRun }
}

/**
 * W-06: Re-validate a plan's delete candidates against a FRESH reference
 * graph right before apply. If a candidate became protected (e.g. latest
 * alias was concurrently moved to it), skip it and record a warning.
 *
 * Returns { kept, skipped } where skipped items carry the protection reason.
 */
export function applyRetentionWithRecheck(
  plan: { deleteCandidates: Array<{ version: string; path: string; protected: boolean }> },
  freshGraph: ReferenceGraph,
): {
  kept: Array<{ version: string; path: string; protected: boolean }>
  skipped: Array<{ version: string; path: string; protected: boolean; reason: string }>
} {
  const kept = []
  const skipped = []
  for (const c of plan.deleteCandidates) {
    if (freshGraph.protected.has(c.path)) {
      const reason = freshGraph.protectedReason.get(c.path) ?? "protected"
      skipped.push({ ...c, reason })
      continue
    }
    kept.push(c)
  }
  return { kept, skipped }
}

// ---------------------------------------------------------------------------
// Withdrawal planning
// ---------------------------------------------------------------------------

/**
 * Plan a whole-version withdrawal. Per §9.2, the version must be recorded
 * in withdrawn-versions.json, and a healthy fallback must be specified and
 * present in the snapshot. Steps: restore aliases → delete versioned path →
 * delete tag.
 */
export function planWithdraw({
  config,
  version,
  snapshot,
  aliases,
  withdrawn,
  fallbackVersion,
}: {
  config: ProductConfig
  version: string
  snapshot: ReleaseSnapshot
  aliases: AliasMap
  withdrawn: { products?: Record<string, string[]> } | undefined
  fallbackVersion: string
}): WithdrawPlan {
  const withdrawnList = withdrawn?.products?.[config.product] || []
  if (!withdrawnList.includes(version)) {
    return { allowed: false, reason: `version ${version} not in withdrawn-versions.json`, steps: [] }
  }

  // Determine channel from the version.
  const channel: ReleaseChannel = version.includes("-beta.") ? "beta" : "stable"

  const steps: WithdrawPlan["steps"] = []
  for (const [alias, aliasVersion] of Object.entries(aliases)) {
    if (aliasVersion === version) {
      if (config.ontologyRestore === "latest-channel") {
        // Restore the whole latest channel (manifest + updater feeds +
        // updater asset copies), not just the manifest — a dangling feed
        // breaks auto-update for every user of the channel.
        steps.push({ action: "restore-latest-channel", target: alias.replace(/\/manifest\.json$/, "") })
      } else {
        steps.push({ action: "restore-alias", target: alias })
      }
    }
  }

  // Fallback is only meaningful when the latest alias must be restored
  // (withdrawing the channel's current latest). Withdrawing an older
  // version never touches the alias, so the fallback is inert.
  const needsRestore = steps.length > 0
  if (needsRestore) {
    if (withdrawnList.includes(fallbackVersion)) {
      return { allowed: false, reason: `fallback ${fallbackVersion} is itself withdrawn — latest must never be restored to a withdrawn version`, steps: [] }
    }
    const fallbackPath = pathForVersion(config, fallbackVersion, channel)
    if (!snapshot.versionedPaths.includes(fallbackPath)) {
      return { allowed: false, reason: `fallback ${fallbackVersion} not found in versioned paths`, steps: [] }
    }
  }

  steps.push({ action: "delete-versioned-path", target: pathForVersion(config, version, channel) })
  steps.push({ action: "delete-tag", target: `${config.githubTagPrefix}${version}` })

  return { allowed: true, steps }
}

export type { ProductConfig, ReleaseSnapshot, AliasMap, ReferenceGraph, RetentionPlan, WithdrawPlan }
