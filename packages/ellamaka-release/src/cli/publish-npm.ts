// packages/ellamaka-release/src/cli/publish-npm.ts
//
// Thin CLI entry: publish the fork contract packages (`@wopal/ellamaka-sdk`,
// `@wopal/ellamaka-plugin`) on their independent npm release line.
//
// Usage:
//   bun packages/ellamaka-release/src/cli/publish-npm.ts [--dry-run] [--check] [--version <v>] [--registry <url>]
//
// The publish is idempotent (a version already on the registry is skipped), so
// the npm release workflow can re-run after a failed attempt. A skip is not blind:
// the registry tarball is compared against this build's tarball by canonical
// content digest, and a version whose contents have diverged aborts the release
// — see `../npm/verify.ts`. The SDK is published before the plugin (the plugin
// depends on the SDK, including its `/v2` subpaths). The npm release version
// must match both package manifests exactly, including any prerelease suffix.
//
// `--check` is a side-effect-free npm release preflight: same plan, full skip
// verification for every version already on the registry, zero publishes.
//
// Environment:
//   NODE_AUTH_TOKEN — npm publish token (optional; OIDC trusted publishing is
//                     used when the job grants `id-token: write`)

import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import {
  createAuthCheck,
  createBunRuntime,
  createRegistryProbe,
  createRegistryTarballFetcher,
  errorMessage,
  packLocalTarball,
  publishPackage,
} from "../npm/execute"
import {
  buildPublishPlan,
  loadPublishTargets,
  readSdkVersion,
  type NpmPublishTarget,
  type PublishPlanEntry,
} from "../npm/plan"
import { verifySkippedVersion } from "../npm/verify"

const DEFAULT_REGISTRY = "https://registry.npmjs.org/"

export interface PublishCliOptions {
  dryRun: boolean
  /**
   * Release preflight: run the full plan, then the skip verification (registry
   * tarball vs local build) for every version already on the registry, and
   * publish nothing. An immutable version whose registry contents differ from
   * this build fails here with the registry/local digests.
   */
  check: boolean
  registry: string
  /** Exact npm release version; defaults to the SDK version anchor. */
  version?: string
}

export interface PublishCliDeps {
  loadTargets: () => NpmPublishTarget[]
  readSdkVersion: () => string
  isPublished: (name: string, version: string, registry: string) => boolean
  /**
   * Confirm a version about to be skipped really holds this build. Throws when
   * the registry contents have diverged.
   */
  verifySkipped: (entry: PublishPlanEntry, registry: string) => void
  assertRegistryAuth: (registry: string) => void
  publishPackage: (entry: PublishPlanEntry, registry: string) => void
  log: (line: string) => void
  logError: (line: string) => void
}

export function parsePublishArgs(argv: string[]): { options: PublishCliOptions } | { error: string; exitCode: number } {
  const options: PublishCliOptions = { dryRun: false, check: false, registry: DEFAULT_REGISTRY, version: undefined }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--dry-run") {
      options.dryRun = true
      continue
    }
    if (arg === "--check") {
      options.check = true
      continue
    }
    if (arg === "--version" || arg === "--registry") {
      const value = argv[++index]
      if (!value || value.startsWith("--")) return { error: `${arg} requires a value`, exitCode: 2 }
      if (arg === "--version") options.version = value
      else options.registry = value
      continue
    }
    return { error: `unknown argument: ${arg}`, exitCode: 2 }
  }
  if (options.dryRun && options.check) return { error: "--dry-run and --check are mutually exclusive", exitCode: 2 }
  return { options }
}

export function runPublishCli(argv: string[], deps: PublishCliDeps): number {
  const parsed = parsePublishArgs(argv)
  if ("error" in parsed) {
    deps.logError(`Error: ${parsed.error}`)
    return parsed.exitCode
  }
  const { dryRun, check, registry } = parsed.options
  const releaseVersion = parsed.options.version ?? deps.readSdkVersion()

  let plan
  try {
    plan = buildPublishPlan({
      targets: deps.loadTargets(),
      releaseVersion,
      isPublished: (name, version) => deps.isPublished(name, version, registry),
    })
  } catch (err) {
    deps.logError(`Error: ${errorMessage(err)}`)
    return 1
  }

  const toPublish = plan.entries.filter((entry) => entry.decision === "publish")
  const toSkip = plan.entries.filter((entry) => entry.decision === "skip")

  deps.log(`npm publish plan — version ${plan.version} (registry ${registry})`)
  for (const entry of plan.entries) {
    deps.log(`  [${entry.decision}] ${entry.name}@${entry.version}  ${entry.dir}  ${entry.tarball}  — ${entry.reason}`)
    for (const [subpath, target] of Object.entries(entry.distExports ?? {})) {
      deps.log(`      ${subpath} -> ${target.import} (types ${target.types})`)
    }
  }

  if (dryRun) {
    // Zero side effects: no download, no build, no digest comparison.
    deps.log(
      toPublish.length === 0
        ? "npm publish: nothing to do — every version is already on the registry."
        : `npm publish: dry run — ${toPublish.length} package(s) would be published; ` +
            `no build, no package.json rewrite, no publish.`,
    )
    return 0
  }

  if (check) {
    // Preflight: verify every skip (the expensive registry-vs-build comparison)
    // and stop there — no auth check, no publish. An unpublished version is
    // reported publishable; an immutable-content mismatch fails with digests.
    try {
      for (const entry of toSkip) deps.verifySkipped(entry, registry)
    } catch (err) {
      deps.logError(`Error: ${errorMessage(err)}`)
      return 1
    }
    deps.log(
      toPublish.length === 0
        ? `npm check: version ${plan.version} is fully published and verified against this build.`
        : `npm check: version ${plan.version} is publishable — ${toPublish.length} package(s) not yet on the registry.`,
    )
    return 0
  }

  // Verify every skip before publishing anything. The comparison builds the
  // local checkout and downloads the registry tarball, so it is the expensive
  // step — and it must fail the release *before* a sibling package ships.
  try {
    for (const entry of toSkip) deps.verifySkipped(entry, registry)
  } catch (err) {
    deps.logError(`Error: ${errorMessage(err)}`)
    return 1
  }

  if (toPublish.length === 0) {
    deps.log("npm publish: nothing to do — every version is already on the registry, verified against this build.")
    return 0
  }

  try {
    deps.assertRegistryAuth(registry)
  } catch (err) {
    deps.logError(`Error: ${errorMessage(err)}`)
    return 1
  }

  let publishedCount = 0
  let concurrentSkips = 0

  for (const entry of toPublish) {
    try {
      deps.publishPackage(entry, registry)
      publishedCount++
    } catch (err) {
      const message = errorMessage(err)
      // The probe ran before the build/pack, so another release can publish
      // this exact immutable version in between. That conflict is not a
      // failure: the version is on the registry, which is all this run wanted.
      // The winner must still match this build, or the release is broken.
      if (deps.isPublished(entry.name, entry.version, registry)) {
        try {
          deps.verifySkipped({ ...entry, decision: "skip", reason: "published concurrently" }, registry)
        } catch (verifyError) {
          deps.logError(`Error: ${errorMessage(verifyError)}`)
          return 1
        }
        concurrentSkips++
        deps.log(`  [skip] ${entry.name}@${entry.version} — published concurrently, taking the idempotent path`)
        continue
      }
      deps.logError(`Error: failed to publish ${entry.name}@${entry.version}: ${message}`)
      if (/E403|E401|403|401|forbidden|unauthorized|ENEEDAUTH/i.test(message)) {
        deps.logError(
          "  the registry rejected the credentials: check the npm publish permission for the @wopal scope " +
            "(NPM_TOKEN), or the trusted-publishing configuration for this repository and workflow",
        )
      }
      return 1
    }
  }

  deps.log(
    `npm publish: published ${publishedCount} package(s) at ${plan.version}` +
      (concurrentSkips > 0 ? `, ${concurrentSkips} already published concurrently.` : "."),
  )
  return 0
}

function main(argv: string[]): number {
  const repoRoot = resolve(import.meta.dir, "..", "..", "..", "..")
  const runtime = createBunRuntime()

  // One scratch dir per run: the skip comparison stages both the downloaded
  // registry tarball and the local build's tarball here, and both are deleted
  // when the run ends — a failed run leaves no .tgz in the package directory.
  const stagingDir = mkdtempSync(join(tmpdir(), "ellamaka-npm-publish-"))

  return runPublishCli(argv, {
    loadTargets: () => loadPublishTargets(repoRoot),
    readSdkVersion: () => readSdkVersion(repoRoot),
    isPublished: (name, version, registry) => createRegistryProbe(registry)(name, version),
    verifySkipped: (entry, registry) => {
      const fetchStaging = mkdtempSync(join(tmpdir(), "ellamaka-npm-verify-"))
      try {
        verifySkippedVersion(entry, {
          registry,
          fetchTarball: createRegistryTarballFetcher({ stagingDir: fetchStaging, runtime }),
          packLocal: (target) =>
            packLocalTarball(target, { repoRoot, stagingDir, runtime, log: (line) => console.log(`  ${line}`) }),
          log: (line) => console.log(line),
        })
      } finally {
        rmSync(fetchStaging, { recursive: true, force: true })
      }
    },
    assertRegistryAuth: createAuthCheck(),
    publishPackage: (entry, registry) => {
      publishPackage(entry, {
        repoRoot,
        stagingDir,
        registry,
        runtime,
        log: (line) => console.log(`  ${line}`),
      })
    },
    log: (line) => console.log(line),
    logError: (line) => console.error(line),
  })
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)))
}
