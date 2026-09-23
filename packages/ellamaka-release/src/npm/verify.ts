// packages/ellamaka-release/src/npm/verify.ts
//
// Guard for the idempotent skip: a version already on the registry is only
// skipped when the registry really holds what this source tree builds.
//
// The failure this prevents is silent, not loud. The release publishes the npm
// packages, then fails before its immutable R2 commit; the operator fixes the
// source and re-runs the same tag. The npm step finds the version present and
// skips it — leaving the registry on the *old* contents while the release
// proceeds as if it shipped the new ones. Comparing the two builds before the
// skip turns that into a hard failure.
//
// A mismatch is unrecoverable by design: npm versions are immutable, so the
// only remedy is a new version. The error says so.

import { tarballContentDigest } from "./content"
import { errorMessage } from "./error"
import type { PublishPlanEntry } from "./plan"

export interface VerifySkippedVersionOptions {
  registry: string
  /** Read the published tarball bytes for `<name>@<version>`. */
  fetchTarball: (name: string, version: string, registry: string) => Uint8Array
  /** Build and pack the local checkout, returning its tarball bytes. */
  packLocal: (entry: PublishPlanEntry) => Uint8Array
  log: (line: string) => void
}

/**
 * Confirm a skipped version is byte-for-byte the same *package* as the local
 * build. Throws — never returns a "skip anyway" — when the two differ or either
 * side cannot be read.
 */
export function verifySkippedVersion(entry: PublishPlanEntry, options: VerifySkippedVersionOptions): void {
  const label = `${entry.name}@${entry.version}`

  let registryDigest: string
  try {
    registryDigest = tarballContentDigest(options.fetchTarball(entry.name, entry.version, options.registry))
  } catch (err) {
    throw new Error(
      `cannot verify ${label} against the registry: ${errorMessage(err)} — ` +
        `the version cannot be skipped without proving it matches this build`,
      { cause: err },
    )
  }

  let localDigest: string
  try {
    localDigest = tarballContentDigest(options.packLocal(entry))
  } catch (err) {
    throw new Error(
      `cannot verify ${label} against this build: ${errorMessage(err)} — ` +
        `the version cannot be skipped without proving it matches this build`,
      { cause: err },
    )
  }

  if (registryDigest !== localDigest) {
    throw new Error(
      `${label} is already on ${options.registry}, but its contents differ from this build ` +
        `(registry ${registryDigest}, local ${localDigest}). npm versions are immutable and this ` +
        `version number is permanently burned: bump the version and re-release. ` +
        `Do not re-run this release — the published ${label} does not match the source.`,
    )
  }

  options.log(`  [skip] ${label} — verified identical to this build (${localDigest.slice(0, 12)})`)
}
