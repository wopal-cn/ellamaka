import { join } from "node:path"
import { worktrees } from "./git"
import { OntologyServiceError, sanitizeMessage } from "./types"
import type {
  ContributionEntry,
  GitRunner,
  OntologyInspectResult,
  PullRequestQuery,
  PullRequestSnapshot,
} from "./types"

const LOCAL_PREFIX = "refs/heads/"
const REMOTE_PREFIX = "refs/remotes/origin/"
const CONTRIBUTE_PREFIX = "contribute/"

interface BranchFacts {
  readonly branch: string
  readonly origins: ("local" | "remote")[]
  worktreePath?: string
  localHead?: string
  remoteHead?: string
}

/**
 * Union the local contribution branches, the origin tracking branches and
 * worktrees that hold a contribution branch. A branch appears once; a
 * remotely deleted branch stays visible while its local ref or worktree
 * still exists.
 */
export function contributionBranches(repo: string, git: GitRunner): BranchFacts[] {
  const found = new Map<string, BranchFacts>()
  const entry = (branch: string): BranchFacts => {
    const existing = found.get(branch)
    if (existing) return existing
    const created: BranchFacts = { branch, origins: [] }
    found.set(branch, created)
    return created
  }
  let refs = ""
  try {
    refs = git(repo, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      LOCAL_PREFIX + CONTRIBUTE_PREFIX,
      REMOTE_PREFIX + CONTRIBUTE_PREFIX,
    ])
  } catch {
    refs = ""
  }
  for (const line of refs.split("\n")) {
    const [ref, sha] = line.split(" ")
    if (!ref || !sha) continue
    const local = ref.startsWith(LOCAL_PREFIX)
    const value = entry(ref.slice((local ? LOCAL_PREFIX : REMOTE_PREFIX).length))
    if (!value.origins.includes(local ? "local" : "remote")) value.origins.push(local ? "local" : "remote")
    if (local) value.localHead = sha
    else value.remoteHead = sha
  }
  for (const record of worktrees(repo, git)) {
    const branch = record.branch?.startsWith(LOCAL_PREFIX + CONTRIBUTE_PREFIX)
      ? record.branch.slice(LOCAL_PREFIX.length)
      : undefined
    if (!branch) continue
    const value = entry(branch)
    value.worktreePath = record.path
    if (!value.origins.includes("local")) value.origins.push("local")
  }
  return [...found.values()].sort((left, right) =>
    left.branch < right.branch ? -1 : left.branch > right.branch ? 1 : 0,
  )
}

function normalizeIdentity(value: string): string {
  return value
    .replace(/^\.?\/?/, "")
    .replace(/\.git\/?$/i, "")
    .toLowerCase()
}

export function githubIdentity(url: string | undefined): string | undefined {
  if (!url) return undefined
  const cleaned = url.replace(/\.git\/?$/, "").replace(/\/+$/, "")
  const match = cleaned.match(/github\.com[:/]([^/]+)\/([^/]+)$/i)
  return match ? match[1] + "/" + match[2] : undefined
}

/** Only a candidate whose target repository, fork, branch and base all agree is this contribution. */
export function matchingPullRequests(
  candidates: readonly PullRequestSnapshot[],
  input: { readonly headFork: string; readonly headBranch: string; readonly baseBranch: string },
): PullRequestSnapshot[] {
  const fork = normalizeIdentity(input.headFork)
  const seen = new Map<number, PullRequestSnapshot>()
  for (const candidate of candidates) {
    if (normalizeIdentity(candidate.headFork ?? "") !== fork) continue
    if ((candidate.headBranch ?? "") !== input.headBranch) continue
    if ((candidate.baseBranch ?? "") !== input.baseBranch) continue
    if (!Number.isInteger(candidate.number) || candidate.number <= 0) continue
    if (!seen.has(candidate.number)) seen.set(candidate.number, candidate)
  }
  return [...seen.values()]
}

export interface ContributionQuery {
  readonly query?: PullRequestQuery
  readonly urlFor: (repo: string, remote: string) => string | undefined
}

export interface ContributionInspection {
  readonly entries: readonly ContributionEntry[]
  readonly status: "ok" | "unavailable" | "failed"
  readonly diagnostic?: string
}

export async function inspectContributions(
  repo: string,
  inspect: OntologyInspectResult,
  git: GitRunner,
  options: ContributionQuery,
): Promise<ContributionInspection> {
  if (inspect.mode !== "fork") return { entries: [], status: "ok" }
  const upstreamRepo = githubIdentity(options.urlFor(repo, "upstream") ?? inspect.upstreamRepo)
  const forkRepo = githubIdentity(options.urlFor(repo, "origin"))
  const branches = contributionBranches(repo, git)
  const entries: ContributionEntry[] = branches.map((branch) => ({ ...branch, prLookup: "missing" }))
  if (!upstreamRepo || !forkRepo) {
    return {
      entries: entries.map((entry) => ({
        ...entry,
        prLookup: "failed",
        diagnostic: "Contribution identity is unavailable: the upstream or origin fork is not a GitHub repository.",
      })),
      status: "failed",
      diagnostic: "Contribution identity is unavailable.",
    }
  }
  if (!options.query) {
    return {
      entries: entries.map((entry) => ({
        ...entry,
        prLookup: "failed",
        diagnostic: "GitHub pull request lookup is not configured.",
      })),
      status: "unavailable",
      diagnostic: "GitHub pull request lookup is not configured.",
    }
  }
  let failures = 0
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    try {
      const candidates = await options.query.query({
        repo,
        upstreamRepo,
        headFork: forkRepo,
        headBranch: entry.branch,
        baseBranch: "main",
      })
      const matches = matchingPullRequests(candidates, {
        headFork: forkRepo,
        headBranch: entry.branch,
        baseBranch: "main",
      })
      if (matches.length > 1) {
        entries[index] = {
          ...entry,
          prLookup: "failed",
          diagnostic: "Ambiguous pull request identity: multiple candidates match this branch.",
        }
        failures += 1
      } else if (matches.length === 1) {
        const pr = matches[0]
        entries[index] = {
          ...entry,
          prLookup: "found",
          pr: {
            number: pr.number,
            url: pr.url,
            state: pr.state,
            ...(pr.headSha ? { headSha: pr.headSha } : {}),
            headMatchesBranch: Boolean(pr.headSha && pr.headSha === (entry.remoteHead ?? entry.localHead)),
          },
        }
      }
    } catch (error) {
      entries[index] = {
        ...entry,
        prLookup: "failed",
        diagnostic:
          "GitHub pull request query failed: " +
          sanitizeMessage(error instanceof Error ? error.message : String(error)),
      }
      failures += 1
    }
  }
  return {
    entries,
    status: failures === 0 ? "ok" : entries.length === failures ? "failed" : "unavailable",
    ...(failures === 0 ? {} : { diagnostic: failures + " contribution lookup(s) did not complete." }),
  }
}

/** Resolve the registered repository root to its real path, refusing a symlinked escape. */
export function assertRegisteredRepository(expected: string, actual: string, realpath: (path: string) => string): void {
  if (realpath(expected) !== realpath(actual)) {
    throw new OntologyServiceError({
      code: "ONTOLOGY_PATH_ESCAPE",
      message: "Ontology registration resolves outside its registered repository: " + join(expected),
    })
  }
}
