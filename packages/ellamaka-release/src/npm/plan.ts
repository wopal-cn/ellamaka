// packages/ellamaka-release/src/npm/plan.ts
//
// Publish planning for the fork contract packages (`@wopal/ellamaka-sdk`,
// `@wopal/ellamaka-plugin`).
//
// Two rules drive the plan:
//
// 1. Idempotency — npm versions are immutable, so a version already on the
//    registry is skipped. This lets the release workflow re-run after a failed
//    attempt: the gap is filled, an already-published version is never
//    republished.
// 2. The packages follow the product base version. A release tag may carry a
//    prerelease (`2.0.5-rc.7`) while the packages are pinned at the
//    prerelease-free base (`2.0.5`); the strip is `stripPrerelease` in
//    `@wopal/ellamaka-core` — the single implementation of that rule. The
//    base version must match every package exactly, otherwise the plan fails
//    before any registry access.

import { stripPrerelease } from "@wopal/ellamaka-core/installation/version"
import { join } from "path"
import { rewriteExports, type DistExportTarget } from "./exports"
import { readJsonObject } from "./json"

/**
 * Package directories in publish order. The plugin depends on the SDK
 * (including its `/v2` subpaths), so the SDK must be on the registry first.
 */
export const NPM_PUBLISH_PACKAGE_DIRS = ["packages/sdk/js", "packages/plugin"] as const

/** Version anchor for CLI releases (docs/DESIGN-distribution.md §3.2). */
export const VERSION_ANCHOR = "packages/ellamaka-cli/package.json"

export interface PackageManifest {
  name: string
  version: string
  exports?: unknown
}

export interface NpmPublishTarget {
  /** Package directory relative to the repository root. */
  dir: string
  manifest: PackageManifest
}

export type PublishDecision = "publish" | "skip"

export interface PublishPlanEntry {
  name: string
  version: string
  dir: string
  /** Tarball `bun pm pack` produces for this package. */
  tarball: string
  decision: PublishDecision
  reason: string
  /** Shipped `exports` map — resolved only for packages that will be published. */
  distExports?: Record<string, DistExportTarget>
}

export interface PublishPlan {
  /** Prerelease-free base version every package must be pinned to. */
  version: string
  entries: PublishPlanEntry[]
}

/** The tarball name npm/bun produce for `<name>@<version>`. */
export function tarballFileName(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`
}

/** Read the release version anchor (the CLI package.json). */
export function readProductVersion(repoRoot: string): string {
  const path = join(repoRoot, VERSION_ANCHOR)
  const value = readJsonObject(path)
  if (typeof value.version !== "string") throw new Error(`${path}: expected a string "version" field`)
  return value.version
}

function readPackageManifest(path: string): PackageManifest {
  const value = readJsonObject(path)
  const { name, version } = value
  if (typeof name !== "string" || typeof version !== "string") {
    throw new Error(`${path}: expected string "name" and "version" fields`)
  }
  return { name, version, exports: value.exports }
}

/** Load the publish targets from the workspace, in publish order. */
export function loadPublishTargets(repoRoot: string): NpmPublishTarget[] {
  return NPM_PUBLISH_PACKAGE_DIRS.map((dir) => ({
    dir,
    manifest: readPackageManifest(join(repoRoot, dir, "package.json")),
  }))
}

export function buildPublishPlan(options: {
  targets: NpmPublishTarget[]
  /** Raw product version (release tag or CLI anchor); may carry a prerelease. */
  productVersion: string
  /** Returns true when `<name>@<version>` already exists on the registry. */
  isPublished: (name: string, version: string) => boolean
}): PublishPlan {
  const version = stripPrerelease(options.productVersion)

  // Validate every package before probing the registry: a release whose
  // packages disagree with the tag is invalid regardless of what npm holds.
  for (const target of options.targets) {
    const { name, version: packageVersion } = target.manifest
    if (packageVersion !== version) {
      throw new Error(
        `release version ${options.productVersion} (base ${version}) does not match ` +
          `${name}@${packageVersion} (${target.dir}/package.json) — ` +
          `bump the package version with the release, or fix the tag`,
      )
    }
  }

  return {
    version,
    entries: options.targets.map((target) => {
      const { name, version: packageVersion } = target.manifest
      const published = options.isPublished(name, packageVersion)
      const entry: PublishPlanEntry = {
        name,
        version: packageVersion,
        dir: target.dir,
        tarball: tarballFileName(name, packageVersion),
        decision: published ? "skip" : "publish",
        reason: published ? "already published on the registry" : "not published yet",
      }
      // Resolve the publish shape only for packages we are about to ship, so a
      // skipped package can never fail the run on an unrelated manifest issue.
      if (!published) entry.distExports = rewriteExports(target.manifest.exports)
      return entry
    }),
  }
}
