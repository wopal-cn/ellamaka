import semver from "semver"

declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"

/**
 * Strip the prerelease segment from a version string, keeping the pure `x.y.z`
 * base. Product releases may carry a candidate tag (`2.0.5-rc.7`) while the
 * plugin contract package follows the base version (`2.0.5`) — this is the
 * single implementation of that rule. Inputs that are not a semver version
 * (notably the dev `"local"` build version) pass through unchanged.
 */
export function stripPrerelease(version: string): string {
  const parsed = semver.parse(version)
  return parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : version
}

/** `InstallationVersion` with its prerelease segment removed. */
export const InstallationVersionBase = stripPrerelease(InstallationVersion)
