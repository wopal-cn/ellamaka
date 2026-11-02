import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import type { FileDiff, FlowAnalysis, GitRunner, RepositoryFacts } from "./types"

const BUFFER = 64 * 1024 * 1024

/** The only process boundary for Git. Callers receive business facts, never shell access. */
export const systemGit: GitRunner = (repo, args, env) =>
  execFileSync("git", [...args], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60_000,
    maxBuffer: BUFFER,
    ...(env ? { env } : {}),
  }).trim()

export function isGitRepository(repo: string, git: GitRunner): boolean {
  if (!existsSync(repo)) return false
  try {
    git(repo, ["rev-parse", "--git-dir"])
    return true
  } catch {
    return false
  }
}

export function sanitizeRemoteUrl(url: string): string {
  return url.replace(/https?:\/\/[^/\s@]+@/gi, (match) => (match.startsWith("https") ? "https://" : "http://"))
}

export function remoteUrl(repo: string, remote: string, git: GitRunner): string | undefined {
  try {
    const url = git(repo, ["remote", "get-url", remote])
    return url ? sanitizeRemoteUrl(url) : undefined
  } catch {
    return undefined
  }
}

/** The configured remote URL, before any url.insteadOf rewrite. */
export function configuredRemoteUrl(repo: string, remote: string, git: GitRunner): string | undefined {
  try {
    const url = git(repo, ["config", "--get", "remote." + remote + ".url"])
    return url ? sanitizeRemoteUrl(url) : undefined
  } catch {
    return undefined
  }
}

export interface RemoteTopology {
  readonly fork: boolean
  readonly origin?: string
  readonly upstream?: string
}

export function topology(repo: string, git: GitRunner): RemoteTopology {
  const origin = configuredRemoteUrl(repo, "origin", git)
  const upstream = configuredRemoteUrl(repo, "upstream", git)
  if (origin && upstream) return { fork: normalizeRemote(origin) !== normalizeRemote(upstream), origin, upstream }
  if (origin) return { fork: false, origin }
  return { fork: false }
}

/** Compare remotes without transport/URL spelling differences. */
export function normalizeRemote(url: string): string {
  return sanitizeRemoteUrl(url)
    .replace(/\.git\/?$/i, "")
    .replace(/\/+$/, "")
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/")
    .toLowerCase()
}

export function dirty(repo: string, git: GitRunner): string[] {
  try {
    return git(repo, ["status", "--porcelain=v1"]).split("\n").filter(Boolean)
  } catch {
    return []
  }
}

export function localBranches(repo: string, git: GitRunner): string[] {
  try {
    return git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean)
  } catch {
    return []
  }
}

export function head(repo: string, git: GitRunner): string | undefined {
  try {
    return git(repo, ["rev-parse", "HEAD"]) || undefined
  } catch {
    return undefined
  }
}

export function currentBranch(repo: string, git: GitRunner): string {
  try {
    return git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || "HEAD"
  } catch {
    return "HEAD"
  }
}

export function refExists(repo: string, ref: string, git: GitRunner): boolean {
  try {
    git(repo, ["rev-parse", "--verify", ref])
    return true
  } catch {
    return false
  }
}

export function commitsAhead(repo: string, exclude: string, ref: string, git: GitRunner): number {
  try {
    return Number(git(repo, ["rev-list", "--count", exclude + ".." + ref])) || 0
  } catch {
    return 0
  }
}

export function isAncestor(
  repo: string,
  ancestor: string,
  descendant: string,
  git: GitRunner,
  env?: NodeJS.ProcessEnv,
): boolean {
  try {
    git(repo, ["merge-base", "--is-ancestor", ancestor, descendant], env)
    return true
  } catch {
    return false
  }
}

export function hasCommonBase(repo: string, left: string, right: string, git: GitRunner): boolean {
  try {
    return git(repo, ["merge-base", left, right]).length > 0
  } catch {
    return false
  }
}

export function fetch(repo: string, remote: string, git: GitRunner): void {
  git(repo, ["fetch", "--no-tags", "--prune", remote])
}

export function repositoryFacts(repo: string, git: GitRunner): RepositoryFacts {
  if (!isGitRepository(repo, git)) {
    return {
      available: false,
      readable: false,
      dirty: false,
      changes: [],
      branches: [],
      diagnostic: "Ontology repository is not readable",
    }
  }
  try {
    const changes = dirty(repo, git)
    const facts: RepositoryFacts = {
      available: true,
      readable: true,
      dirty: changes.length > 0,
      changes,
      branches: localBranches(repo, git),
      ...(currentBranch(repo, git) !== "HEAD" ? { branch: currentBranch(repo, git) } : {}),
      ...(head(repo, git) ? { head: head(repo, git) } : {}),
    }
    return facts
  } catch (error) {
    return {
      available: true,
      readable: false,
      dirty: false,
      changes: [],
      branches: [],
      diagnostic: error instanceof Error ? error.message : String(error),
    }
  }
}

/** A path is inside a root when both real paths agree after resolution. */
export function isPathInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

function quoteAlternatePath(path: string): string {
  const separator = process.platform === "win32" ? ";" : ":"
  if (!path.includes(separator) && !path.includes('"') && !path.includes("\\")) return path
  return '"' + path.replace(/(["\\])/g, "\\$1") + '"'
}

function parseDiff(output: string): FileDiff[] {
  if (!output) return []
  return output.split("\n").flatMap((line) => {
    const columns = line.split("\t")
    const letter = columns[0]?.charAt(0) ?? ""
    if (letter === "R" || letter === "C") {
      const result: FileDiff[] = []
      if (letter === "R" && columns[1]) result.push({ path: columns[1], status: "deleted" })
      if (columns[2]) result.push({ path: columns[2], status: "added" })
      return result
    }
    if (!columns[1]) return []
    return [{ path: columns[1], status: letter === "A" ? "added" : letter === "D" ? "deleted" : "modified" }]
  })
}

export interface Quarantine {
  readonly env: NodeJS.ProcessEnv
  readonly cleanup: () => void
}

/**
 * New objects go to a scratch object store while the repository's own
 * store stays readable through alternates. A virtual merge therefore leaves
 * refs, index, FETCH_HEAD, worktree files and the real object database
 * byte-identical.
 */
export function createQuarantine(repo: string, git: GitRunner, tempRoot?: string): Quarantine {
  let common = join(repo, ".git")
  try {
    common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  } catch {
    // Keep the conventional location when the repo cannot answer.
  }
  const scratch = mkdtempSync(join(tempRoot ?? tmpdir(), "wopalspace-ontology-merge-"))
  return {
    env: {
      ...process.env,
      GIT_OBJECT_DIRECTORY: scratch,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: quoteAlternatePath(join(common, "objects")),
    },
    cleanup: () => rmSync(scratch, { recursive: true, force: true }),
  }
}

export interface VirtualMerge {
  readonly clean: boolean
  readonly tree?: string
  readonly conflictFiles: readonly string[]
}

/** Merge-tree against the real objects but writing only to the scratch store. */
export function virtualMerge(
  repo: string,
  ours: string,
  theirs: string,
  git: GitRunner,
  env: NodeJS.ProcessEnv,
): VirtualMerge {
  let output: string
  let clean = true
  try {
    output = git(repo, ["merge-tree", "--write-tree", "--name-only", ours, theirs], env)
  } catch (error) {
    clean = false
    const stdout = error && typeof error === "object" && "stdout" in error ? error.stdout : undefined
    const stderr = error && typeof error === "object" && "stderr" in error ? error.stderr : undefined
    output = typeof stdout === "string" ? stdout : typeof stderr === "string" ? stderr : ""
  }
  const lines = output.split("\n").map((line) => line.trim())
  const tree = /^[0-9a-f]{40,64}$/.test(lines[0] ?? "") ? lines[0] : undefined
  const conflictFiles = clean
    ? []
    : lines.slice(1).filter((line) => line && !line.startsWith("CONFLICT") && !line.startsWith("Auto-merging"))
  return { clean, tree, conflictFiles }
}

export function analyzeFlow(
  repo: string,
  from: string,
  to: string,
  label: string,
  git: GitRunner,
  kind: "merge" | "push",
  tempRoot?: string,
): FlowAnalysis {
  const base: FlowAnalysis = {
    label,
    fromBranch: from,
    toBranch: to,
    upToDate: false,
    fileDiffs: [],
    mergePrediction: "no-common-base",
    conflictFiles: [],
    kind,
  }
  if (!refExists(repo, from, git) || !refExists(repo, to, git)) return base
  if (!hasCommonBase(repo, from, to, git)) return base
  if (commitsAhead(repo, to, from, git) === 0) return { ...base, upToDate: true, mergePrediction: "clean" }

  const quarantine = createQuarantine(repo, git, tempRoot)
  try {
    const merge = virtualMerge(repo, to, from, git, quarantine.env)
    if (!merge.clean) {
      return {
        ...base,
        mergePrediction: merge.tree ? "conflict" : "no-common-base",
        conflictFiles: merge.conflictFiles,
      }
    }
    if (!merge.tree) return base
    const targetTree = git(repo, ["rev-parse", to + "^{tree}"], quarantine.env)
    const fileDiffs =
      targetTree === merge.tree
        ? []
        : parseDiff(git(repo, ["diff", "--name-status", targetTree, merge.tree], quarantine.env))
    return {
      ...base,
      upToDate: targetTree === merge.tree,
      mergePrediction: "clean",
      fileDiffs,
      conflictFiles: [],
    }
  } catch {
    return base
  } finally {
    quarantine.cleanup()
  }
}

export interface WorktreeRecord {
  readonly path: string
  readonly branch?: string
}

export function worktrees(repo: string, git: GitRunner): WorktreeRecord[] {
  try {
    const output = git(repo, ["worktree", "list", "--porcelain"])
    const records: WorktreeRecord[] = []
    let path: string | undefined
    let branch: string | undefined
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length)
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length)
      else if (line === "" && path) {
        records.push({ path, ...(branch ? { branch } : {}) })
        path = undefined
        branch = undefined
      }
    }
    if (path) records.push({ path, ...(branch ? { branch } : {}) })
    return records
  } catch {
    return []
  }
}

/** Merge/rebase/cherry-pick/revert state that must block a write operation. */
export function inProgressOperation(repo: string, git: GitRunner): string | undefined {
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    try {
      const path = git(repo, ["rev-parse", "--git-path", marker])
      if (existsSync(resolve(repo, path))) return marker
    } catch {
      // A repository that cannot report its own state cannot be written to safely.
      return "unknown"
    }
  }
  return undefined
}

/** The real repository root must be exactly the registered directory. */
export function assertRepositoryRoot(repo: string, git: GitRunner, realpath: (path: string) => string): void {
  let top: string
  try {
    top = git(repo, ["rev-parse", "--show-toplevel"])
  } catch {
    throw new Error("ONTOLOGY_REPOSITORY_INVALID")
  }
  if (realpath(top) !== realpath(repo)) throw new Error("ONTOLOGY_REPOSITORY_INVALID")
}
