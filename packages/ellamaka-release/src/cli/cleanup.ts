// packages/ellamaka-release/src/cli/cleanup.ts
//
// Thin CLI entry for release cleanup (protection model, docs/DISTRIBUTION.md
// §7.2). Merges the former scripts/cleanup-ellamaka-releases.mjs and
// scripts/cleanup-desktop-releases.mjs into one entry selected by
// --product. Product differences (channels, R2 roots, alias names, restore
// strategy) come from src/cleanup/products.ts; the product-agnostic kernel
// lives in src/cleanup/core.ts.
//
// Usage:
//   bun packages/ellamaka-release/src/cli/cleanup.ts \
//     --product ellamaka-cli --keep-stable 3 --keep-rc 2 [--dry-run]
//   bun packages/ellamaka-release/src/cli/cleanup.ts \
//     --product ellamaka-desktop --keep-stable 3 --keep-beta 2 [--dry-run]
//   bun packages/ellamaka-release/src/cli/cleanup.ts \
//     --product ellamaka-cli --withdraw 1.16.0 --fallback 1.17.0 [--dry-run]
//
// Environment:
//   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / R2_ENDPOINT — R2 credentials
//   GH_TOKEN (or GITHUB_TOKEN) — GitHub PAT with repo scope
//   GITEE_TOKEN — Gitee API token (optional)

import { execSync } from "child_process"
import fs from "fs"
import {
  applyRetentionWithRecheck,
  buildReferenceGraph,
  planRetention,
  planWithdraw,
} from "../cleanup/core"
import { executeRetention, type RetentionOps } from "../cleanup/execute"
import { parseArgs, parseReleaseTag, type Flags } from "../cleanup/parse"
import { PRODUCTS, type ProductConfig } from "../cleanup/products"

const R2_BUCKET = "wopal-release"

// ---------------------------------------------------------------------------
// Tag parsing (B-01) — delegated to src/cleanup/parse.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// R2 primitives
// ---------------------------------------------------------------------------

function listR2VersionedPaths(config: ProductConfig, r2Url: string, r2Root: string) {
  const cmd = `aws s3api list-objects-v2 \
    --bucket ${R2_BUCKET} \
    --prefix "${r2Root}/" \
    --delimiter "/" \
    --endpoint-url "${r2Url}" \
    --query "CommonPrefixes[].Prefix" \
    --output json`
  const output = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
  const prefixes = JSON.parse(output)
  return prefixes
    .map((p: string) => p.replace(/\/$/, ""))
    .filter((p: string) => {
      const name = p.replace(`${r2Root}/`, "")
      return name.startsWith("v") && /^\d/.test(name.slice(1))
    })
}

function listR2ObjectKeys(r2Url: string, prefix: string) {
  const cmd = `aws s3api list-objects-v2 \
    --bucket ${R2_BUCKET} \
    --prefix "${prefix}" \
    --endpoint-url "${r2Url}" \
    --query "Contents[].Key" \
    --output json`
  try {
    const output = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
    const keys = JSON.parse(output || "[]")
    return Array.isArray(keys) ? keys : []
  } catch {
    return []
  }
}

function headR2Object(r2Url: string, key: string) {
  const cmd = `aws s3api head-object \
    --bucket ${R2_BUCKET} \
    --key "${key}" \
    --endpoint-url "${r2Url}"`
  try {
    execSync(cmd, { stdio: ["pipe", "pipe", "pipe"] })
    return true
  } catch {
    return false
  }
}

function deleteR2Prefix(r2Url: string, versionedPath: string, dryRun: boolean) {
  const s3Key = `s3://${R2_BUCKET}/${versionedPath}/`
  if (dryRun) {
    console.log(`  [DRY RUN] would delete ${s3Key}`)
    return
  }
  execSync(`aws s3 rm "${s3Key}" --recursive --endpoint-url "${r2Url}"`, { stdio: "inherit" })
  console.log(`  deleted ${s3Key}`)
}

function readLatestAlias(config: ProductConfig, r2Url: string, latestPrefix: string) {
  const cmd = `aws s3api get-object \
    --bucket ${R2_BUCKET} \
    --key "${latestPrefix}/manifest.json" \
    --endpoint-url "${r2Url}" \
    /dev/stdout 2>/dev/null`
  try {
    const output = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
    const manifest = JSON.parse(output)
    return manifest.version
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// GitHub primitives
// ---------------------------------------------------------------------------

function listGithubReleases(config: ProductConfig, repo: string) {
  const cmd = `gh api repos/${repo}/releases --paginate --jq '[.[] | select(.tag_name | test("^${config.githubTagPrefix}"))] | .[].tag_name'`
  const output = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((t) => t.startsWith(config.githubTagPrefix))
}

function listGithubOntologyReleases(config: ProductConfig, repo: string) {
  // Ontology repo historically mirrored CLI releases with a bare
  // ellamaka-v* prefix (e.g. ellamaka-v2.0.0). Since the naming switch to
  // ellamaka-cli-v*, both prefixes can appear. Desktop only uses the
  // ellamaka-desktop-v* prefix. Product-aware via config (W-01).
  const cmd = `gh api repos/${repo}/releases --paginate --jq '[.[] | select(.tag_name | ${config.githubOntologySelect})] | .[].tag_name'`
  const output = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
  return output.trim().split("\n").filter(Boolean).filter((t) => config.isOntologyTag(t))
}

function deleteGithubRelease(repo: string, tag: string, dryRun: boolean) {
  if (dryRun) {
    console.log(`  [DRY RUN] would delete GitHub release + tag ${repo}:${tag}`)
    return
  }
  const idCmd = `gh api repos/${repo}/releases/tags/${tag} --jq '.id'`
  let releaseId: string
  try {
    releaseId = execSync(idCmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim()
  } catch {
    console.log(`  skip ${repo}:${tag} (release not found)`)
    return
  }
  execSync(`gh api -X DELETE repos/${repo}/releases/${releaseId}`, { stdio: "inherit" })
  try {
    execSync(`gh api -X DELETE repos/${repo}/git/refs/tags/${tag}`, { stdio: ["pipe", "pipe", "pipe"] })
    console.log(`  deleted GitHub release + tag ${repo}:${tag}`)
  } catch {
    console.log(`  deleted GitHub release ${repo}:${tag} (tag deletion skipped — not found)`)
  }
}

// ---------------------------------------------------------------------------
// Gitee primitives
// ---------------------------------------------------------------------------

const GITEE_BASE = "https://gitee.com/api/v5"

function listGiteeReleases(config: ProductConfig, token: string, repo: string): Array<{ id: number; tag_name: string }> {
  const [owner, repoName] = repo.split("/")
  const url = `${GITEE_BASE}/repos/${owner}/${repoName}/releases?access_token=${encodeURIComponent(token)}&per_page=100`
  const output = execSync(`curl -fsSL "${url}"`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
  const releases = JSON.parse(output)
  return releases
    .filter((r: { tag_name?: string }) => r.tag_name && r.tag_name.startsWith(config.githubTagPrefix))
    .map((r: { id: number; tag_name: string }) => ({ id: r.id, tag_name: r.tag_name }))
}

function listGiteeOntologyReleases(config: ProductConfig, token: string, repo: string): Array<{ id: number; tag_name: string }> {
  const [owner, repoName] = repo.split("/")
  const url = `${GITEE_BASE}/repos/${owner}/${repoName}/releases?access_token=${encodeURIComponent(token)}&per_page=100`
  const output = execSync(`curl -fsSL "${url}"`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })
  const releases = JSON.parse(output)
  return releases
    .filter((r: { tag_name?: string }) => r.tag_name && config.isOntologyTag(r.tag_name))
    .map((r: { id: number; tag_name: string }) => ({ id: r.id, tag_name: r.tag_name }))
}

function deleteGiteeRelease(token: string, repo: string, release: { id: number; tag_name: string }, dryRun: boolean) {
  const [owner, repoName] = repo.split("/")
  if (dryRun) {
    console.log(`  [DRY RUN] would delete Gitee release + tag ${repo}:${release.tag_name} (id=${release.id})`)
    return
  }
  const url = `${GITEE_BASE}/repos/${owner}/${repoName}/releases/${release.id}?access_token=${encodeURIComponent(token)}`
  execSync(`curl -fsSL -X DELETE "${url}"`, { stdio: "inherit" })
  const tagUrl = `${GITEE_BASE}/repos/${owner}/${repoName}/git/refs/tags/${release.tag_name}?access_token=${encodeURIComponent(token)}`
  try {
    execSync(`curl -fsSL -X DELETE "${tagUrl}"`, { stdio: ["pipe", "pipe", "pipe"] })
    console.log(`  deleted Gitee release + tag ${repo}:${release.tag_name} (id=${release.id})`)
  } catch {
    console.log(`  deleted Gitee release ${repo}:${release.tag_name} (id=${release.id}) (tag deletion skipped)`)
  }
}

// ---------------------------------------------------------------------------
// Args — fail-closed parsing lives in src/cleanup/parse.ts (B-02)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

function buildSnapshot(config: ProductConfig, r2Url: string) {
  const versionedPaths: string[] = []
  const roots = new Set(config.channels.map((c) => config.rootForChannel(c)))
  for (const root of roots) {
    if (!root) continue
    try {
      const paths = listR2VersionedPaths(config, r2Url, root)
      versionedPaths.push(...paths)
    } catch (err) {
      console.error(`  R2 list failed (${root}): ${(err as Error).message}`)
    }
  }
  return { versionedPaths, tags: [] }
}

function buildAliases(config: ProductConfig, r2Url: string) {
  const aliases: Record<string, string> = {}
  for (const channel of config.channels) {
    const prefix = config.latestPrefixForChannel(channel)
    const version = readLatestAlias(config, r2Url, prefix)
    if (version) aliases[config.aliasKeyForChannel(channel)] = version
  }
  return aliases
}

function runRetention({
  flags,
  config,
  r2Url,
  giteeToken,
  mode,
}: {
  flags: Flags
  config: ProductConfig
  r2Url: string
  giteeToken?: string
  mode: string
}) {
  const keepSummary =
    `keep ${flags.keepStable} stable` +
    (config.channels.includes("beta") ? ` + ${flags.keepBeta} beta` : "") +
    (config.product === "ellamaka-cli" ? ` + ${flags.keepRc} rc` : "")
  console.log(`\n${mode}Cleaning up old ${config.product} releases (protection model, ${keepSummary})\n`)

  const snapshot = buildSnapshot(config, r2Url)
  const aliases = buildAliases(config, r2Url)
  console.log(`  aliases → ${JSON.stringify(aliases)}`)

  // Plan retention per channel.
  const allDeleteCandidates = []
  const allLegacyRetained = new Set<string>()
  for (const channel of config.channels) {
    const keep = channel === "stable" ? flags.keepStable : flags.keepBeta
    const plan = planRetention({
      config,
      channel,
      snapshot,
      aliases,
      keepStable: keep,
      // CLI rc releases form an independent retention bucket within the
      // stable channel; Desktop has no rc shape, so keepRc is inert there.
      keepRc: config.product === "ellamaka-cli" ? flags.keepRc : 0,
      dryRun: flags.dryRun,
    })
    allDeleteCandidates.push(...plan.deleteCandidates)
    for (const v of plan.legacyRetained) allLegacyRetained.add(v)
  }

  if (allLegacyRetained.size > 0) {
    console.log(`  legacy/unknown retained (fail-closed): ${[...allLegacyRetained].join(", ")}`)
  }

  // W-06: re-read aliases and rebuild reference graph right before apply.
  const freshAliases = buildAliases(config, r2Url)
  const freshGraph = buildReferenceGraph(snapshot, freshAliases, config)
  const provisionalPlan = { deleteCandidates: allDeleteCandidates }
  const { kept, skipped } = applyRetentionWithRecheck(provisionalPlan, freshGraph)
  if (skipped.length > 0) {
    console.log(`  ${skipped.length} candidate(s) skipped (became protected since plan):`)
    for (const s of skipped) {
      console.log(`    skip ${s.path} — ${s.reason}`)
    }
  }

  const ghRepo = "wopal-cn/ellamaka"
  const ghOntRepo = "wopal-cn/wopal-space-ontology"

  const ops: RetentionOps = {
    deleteR2: (path, dry) => deleteR2Prefix(r2Url, path, dry),
    listGithub: (repo) => listGithubReleases(config, repo),
    deleteGithub: (repo, tag, dry) => deleteGithubRelease(repo, tag, dry),
    listGithubOntology: (repo) => listGithubOntologyReleases(config, repo),
    listGitee: giteeToken ? (token, repo) => listGiteeReleases(config, token, repo) : undefined,
    listGiteeOntology: giteeToken ? (token, repo) => listGiteeOntologyReleases(config, token, repo) : undefined,
    deleteGitee: giteeToken ? (token, repo, release, dry) => deleteGiteeRelease(token, repo, release, dry) : undefined,
  }

  // B-03 + W-02: only versions whose R2 delete actually SUCCEEDED may have
  // their GitHub/Gitee/ontology Release and tag deleted. A failed R2 delete
  // must never leave an orphaned CDN asset behind. In dry-run the R2 "delete"
  // is a no-op that always succeeds, so every kept candidate is planned for
  // registry/tag deletion too. Failures exit non-zero on apply.
  const { deletedVersions, failures } = executeRetention({
    config,
    kept,
    dryRun: flags.dryRun,
    giteeToken,
    ghRepo,
    ghOntRepo,
    ops,
  })

  if (failures.length > 0 && !flags.dryRun) {
    console.error(`\n${failures.length} R2 delete(s) failed; registry/tag cleanup aborted for those versions.`)
    process.exit(1)
  }

  console.log(`\n${mode}Cleanup complete.\n`)
}

// ---------------------------------------------------------------------------
// Withdraw
// ---------------------------------------------------------------------------

function runWithdraw({
  flags,
  config,
  r2Url,
  giteeToken,
}: {
  flags: Flags
  config: ProductConfig
  r2Url: string
  giteeToken?: string
}) {
  if (!flags.withdrawVersion) {
    console.error("Error: --withdraw requires a version argument")
    process.exit(2)
  }
  if (!flags.fallback) {
    console.error("Error: --withdraw requires --fallback <version>")
    process.exit(2)
  }

  console.log(`\nWithdrawing ${config.product} v${flags.withdrawVersion} (fallback: ${flags.fallback})\n`)

  const withdrawn = JSON.parse(fs.readFileSync("release/withdrawn-versions.json", "utf8"))

  const snapshot = buildSnapshot(config, r2Url)
  const aliases = buildAliases(config, r2Url)

  const plan = planWithdraw({
    config,
    version: flags.withdrawVersion,
    snapshot,
    aliases,
    withdrawn,
    fallbackVersion: flags.fallback,
  })

  if (!plan.allowed) {
    console.error(`Error: withdrawal denied: ${plan.reason}`)
    process.exit(1)
  }

  console.log(`Plan: ${plan.steps.length} steps`)
  for (const step of plan.steps) {
    console.log(`  ${step.action}: ${step.target}`)
  }

  if (flags.dryRun) {
    console.log("\n[DRY RUN] no mutations performed.")
    return
  }

  const channel = flags.withdrawVersion.includes("-beta.") ? "beta" : "stable"
  const root = config.rootForChannel(channel)
  const ghRepo = "wopal-cn/ellamaka"
  const ghOntRepo = "wopal-cn/wopal-space-ontology"

  for (const step of plan.steps) {
    if (step.action === "restore-latest-channel") {
      const latestPrefix = step.target
      const fallbackPrefix = `${root}/v${flags.fallback}`
      const latestKeys = listR2ObjectKeys(r2Url, `${latestPrefix}/`)
      if (latestKeys.length === 0) {
        console.error(`  ERROR: no objects found under ${latestPrefix}/ — cannot restore latest channel`)
        process.exit(1)
      }
      for (const key of latestKeys) {
        const name = key.split("/").pop()
        const src = `${fallbackPrefix}/${name}`
        if (!headR2Object(r2Url, src)) {
          console.warn(`  WARN: cannot restore ${key} — ${src} missing (fallback predates feed/asset versioning); the next release of this channel self-heals`)
          continue
        }
        console.log(`  restoring ${key} ← ${src}`)
        execSync(
          `aws s3 cp "s3://${R2_BUCKET}/${src}" "s3://${R2_BUCKET}/${key}" --endpoint-url "${r2Url}"`,
          { stdio: "inherit" },
        )
      }
    } else if (step.action === "restore-alias") {
      console.log(`  restoring alias ${step.target} → ${flags.fallback}`)
      const fallbackManifestKey = `${config.r2Root}/v${flags.fallback}/manifest.json`
      execSync(
        `aws s3 cp "s3://${R2_BUCKET}/${fallbackManifestKey}" "s3://${R2_BUCKET}/${step.target}" --endpoint-url "${r2Url}"`,
        { stdio: "inherit" },
      )
    } else if (step.action === "delete-versioned-path") {
      deleteR2Prefix(r2Url, step.target, false)
    } else if (step.action === "delete-tag") {
      try {
        deleteGithubRelease(ghRepo, step.target, false)
      } catch (err) {
        console.error(`  failed to delete tag on GitHub: ${(err as Error).message}`)
      }
      if (giteeToken) {
        try {
          const giteeReleases = listGiteeReleases(config, giteeToken, ghRepo)
          const match = giteeReleases.find((r) => r.tag_name === step.target)
          if (match) deleteGiteeRelease(giteeToken, ghRepo, match, false)
        } catch (err) {
          console.error(`  Gitee tag delete failed: ${(err as Error).message}`)
        }
      }
      // Sync-delete the same version from the ontology mirror.
      const version = config.ontologyVersion(step.target)
      try {
        const ghOntTags = listGithubOntologyReleases(config, ghOntRepo)
        for (const tag of ghOntTags) {
          if (config.ontologyVersion(tag) === version) deleteGithubRelease(ghOntRepo, tag, false)
        }
      } catch (err) {
        console.error(`  GitHub ontology tag delete failed: ${(err as Error).message}`)
      }
      if (giteeToken) {
        try {
          const giteeOntReleases = listGiteeOntologyReleases(config, giteeToken, ghOntRepo)
          for (const release of giteeOntReleases) {
            if (config.ontologyVersion(release.tag_name) === version) {
              deleteGiteeRelease(giteeToken, ghOntRepo, release, false)
            }
          }
        } catch (err) {
          console.error(`  Gitee ontology tag delete failed: ${(err as Error).message}`)
        }
      }
    }
  }

  console.log("  CDN purge of restored alias is operator's responsibility (run purge separately).")
  console.log(`\nWithdrawal of v${flags.withdrawVersion} complete.\n`)
}

function main() {
  // Fail-closed arg parsing (B-02): exits with code 2 on invalid args before
  // any remote access (R2_ENDPOINT / GH_TOKEN are only touched after parse).
  const parsed = parseArgs(process.argv)
  if (parsed.error) {
    console.error(parsed.error)
    process.exit(parsed.exitCode)
  }
  const flags = parsed.flags!
  const r2Endpoint = process.env.R2_ENDPOINT
  const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const giteeToken = process.env.GITEE_TOKEN

  if (!r2Endpoint) {
    console.error("Error: R2_ENDPOINT is required")
    process.exit(1)
  }
  if (!ghToken) {
    console.error("Error: GH_TOKEN or GITHUB_TOKEN is required")
    process.exit(1)
  }

  const config = PRODUCTS[flags.product]
  if (!config) {
    console.error(`Error: unknown product ${flags.product}`)
    process.exit(2)
  }

  const r2Url = `https://${r2Endpoint}`
  const mode = flags.dryRun ? "[DRY RUN] " : ""

  if (flags.mode === "withdraw") {
    runWithdraw({ flags, config, r2Url, giteeToken })
    return
  }

  runRetention({ flags, config, r2Url, giteeToken, mode })
}

if (import.meta.main) {
  try {
    main()
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`)
    process.exit(1)
  }
}
