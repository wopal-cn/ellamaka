// packages/ellamaka-desktop/src/main/updater-policy.ts
//
// Update authorization policy gate. Per docs/DISTRIBUTION.md §10,
// electron-updater only handles platform feed/download/install. The
// authorization decision (same channel, no downgrade, manifest version
// match) is made here before electron-updater is allowed to proceed.
//
// This module is pure (no electron/electron-updater imports) so it can be
// tested without the electron mock.

export type UpdateAuthorizationInput = {
  currentVersion: string
  currentChannel: string
  targetVersion: string
  targetChannel: string
  targetManifestVersion: string
}

export type UpdateAuthorization = {
  authorized: boolean
  reason?: string
}

export type UpdateAuthorizationResult = UpdateAuthorization & {
  // true when the decision is "do not proceed" due to a fetch/parse failure
  // (distinct from a policy rejection). Callers map this to {failed:true}.
  failed?: boolean
}

function compareSemVer(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => Number(n))
  const pb = b.split(/[.-]/).map((n) => Number(n))
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  // prerelease rank: stable > rc > beta. Use the raw string identifier
  // (Number("rc") and Number("beta") are NaN, so numeric coercion fails).
  const idOf = (v: string) => {
    if (!v.includes("-")) return "stable"
    if (v.includes("-rc.")) return "rc"
    if (v.includes("-beta.")) return "beta"
    return "unknown"
  }
  const rank = (v: string) => {
    const id = idOf(v)
    if (id === "stable") return 3
    if (id === "rc") return 2
    if (id === "beta") return 1
    return 0
  }
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra - rb
  // Same rank: if prerelease, compare the prerelease number.
  if (ra < 3) {
    return (pa[4] ?? 0) - (pb[4] ?? 0)
  }
  return 0
}

/**
 * Authorize an update from currentVersion/channel to targetVersion/channel.
 * The target manifest version must equal the updater-reported version.
 * Returns authorized=true only when all checks pass.
 */
export function authorizeUpdate(input: UpdateAuthorizationInput): UpdateAuthorization {
  if (input.currentChannel !== input.targetChannel) {
    return {
      authorized: false,
      reason: `cross-channel update denied: ${input.currentChannel} -> ${input.targetChannel}`,
    }
  }
  if (compareSemVer(input.targetVersion, input.currentVersion) <= 0) {
    return { authorized: false, reason: `downgrade or no-op denied: ${input.currentVersion} -> ${input.targetVersion}` }
  }
  if (input.targetManifestVersion !== input.targetVersion) {
    return {
      authorized: false,
      reason: `manifest version ${input.targetManifestVersion} mismatches updater version ${input.targetVersion}`,
    }
  }
  return { authorized: true }
}

// ---------------------------------------------------------------------------
// W-07: manifest-backed authorization.
//
// The third gate (updater-reported version must equal the authoritative
// manifest version) must fetch the feed manifest independently. Passing
// the updater-reported version as targetManifestVersion makes the gate
// self-proving. This function fetches the manifest, extracts
// releaseIdentity.version, and delegates to authorizeUpdate.
// ---------------------------------------------------------------------------

export type AuthorizeFromFeedInput = {
  fetch: typeof globalThis.fetch
  feedManifestUrl: string
  currentVersion: string
  currentChannel: string
  targetVersion: string
  targetChannel: string
}

/**
 * Fetch the feed manifest, extract its releaseIdentity.version, and
 * authorize the update. If the fetch fails or the manifest is not valid
 * JSON, fail closed (authorized=false, failed=true).
 */
export async function authorizeUpdateFromFeed(input: AuthorizeFromFeedInput): Promise<UpdateAuthorizationResult> {
  let manifestVersion: string
  try {
    const resp = await input.fetch(input.feedManifestUrl)
    if (!resp.ok) {
      return {
        authorized: false,
        failed: true,
        reason: `manifest fetch failed: HTTP ${resp.status}`,
      }
    }
    const manifest = await resp.json()
    const ri = manifest?.releaseIdentity
    manifestVersion = ri?.version ?? manifest?.version
    if (typeof manifestVersion !== "string" || !manifestVersion) {
      return {
        authorized: false,
        failed: true,
        reason: "manifest fetch: releaseIdentity.version missing",
      }
    }
  } catch (err) {
    return {
      authorized: false,
      failed: true,
      reason: `manifest fetch error: ${(err as Error).message}`,
    }
  }
  return authorizeUpdate({
    currentVersion: input.currentVersion,
    currentChannel: input.currentChannel,
    targetVersion: input.targetVersion,
    targetChannel: input.targetChannel,
    targetManifestVersion: manifestVersion,
  })
}
