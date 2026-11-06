import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { SpaceServiceError, spaceErrorCodes } from "./types"

/**
 * Narrow Git boundary for the Space domain.
 *
 * Callers only reach business operations below; no operation exposes an
 * arbitrary Git command. Tests that need controlled Git behaviour supply
 * their own runner instead of replacing modules process-wide.
 */
export interface RawGitResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
}

export type GitRunner = ((cwd: string, args: readonly string[], env?: Readonly<Record<string, string>>) => string) & {
  /** Optional raw runner that keeps stdout of a failing command. */
  readonly capture?: (cwd: string, args: readonly string[], env?: Readonly<Record<string, string>>) => RawGitResult
}

const BUFFER = 64 * 1024 * 1024

function runSystemGit(cwd: string, args: readonly string[], env?: Readonly<Record<string, string>>): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: BUFFER,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  }).trim()
}

function captureSystemGit(cwd: string, args: readonly string[], env?: Readonly<Record<string, string>>): RawGitResult {
  try {
    return { ok: true, stdout: runSystemGit(cwd, args, env), stderr: "" }
  } catch (error) {
    return {
      ok: false,
      stdout: errorText(error, "stdout"),
      stderr: errorText(error, "stderr") || (error instanceof Error ? error.message : String(error)),
    }
  }
}

export const systemGit: GitRunner = Object.assign(runSystemGit, { capture: captureSystemGit })

export interface GitAttempt {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
}

function errorText(error: unknown, key: "stdout" | "stderr"): string {
  if (error === null || typeof error !== "object") return ""
  const value: unknown = Reflect.get(error, key)
  return typeof value === "string" ? value.trim() : ""
}

/** Run Git without throwing; the caller decides what a failure means. */
export function tryGit(git: GitRunner, cwd: string, args: readonly string[]): GitAttempt {
  try {
    return { ok: true, stdout: git(cwd, args), stderr: "" }
  } catch (error) {
    const stderr = errorText(error, "stderr")
    return {
      ok: false,
      stdout: "",
      stderr: stderr.length > 0 ? stderr : error instanceof Error ? error.message : String(error),
    }
  }
}

/** Like tryGit, but keeps whatever the failing command wrote to stdout. */
export function runGitCaptured(git: GitRunner, cwd: string, args: readonly string[]): GitAttempt {
  const attempt = tryGit(git, cwd, args)
  if (attempt.ok) return attempt
  return { ok: false, stdout: "", stderr: attempt.stderr }
}

export function isGitRepository(git: GitRunner, path: string): boolean {
  if (!existsSync(path)) return false
  return tryGit(git, path, ["rev-parse", "--git-dir"]).ok
}

export function currentBranch(git: GitRunner, path: string): string {
  const result = tryGit(git, path, ["rev-parse", "--abbrev-ref", "HEAD"])
  return result.ok && result.stdout.length > 0 ? result.stdout : "HEAD"
}

export function headSha(git: GitRunner, path: string): string | undefined {
  const result = tryGit(git, path, ["rev-parse", "HEAD"])
  return result.ok ? result.stdout : undefined
}

/** Exact-case branch existence check (for-each-ref, never rev-parse). */
export function branchExists(git: GitRunner, repo: string, branch: string): boolean {
  const result = tryGit(git, repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/" + branch])
  return result.ok && result.stdout.split("\n").includes(branch)
}

export function remoteBranchNames(git: GitRunner, repo: string, remote: string): Set<string> {
  const result = tryGit(git, repo, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/" + remote])
  if (!result.ok) return new Set()
  const prefix = remote + "/"
  return new Set(
    result.stdout
      .split("\n")
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length)),
  )
}

export function remoteUrl(git: GitRunner, repo: string, remote: string): string | undefined {
  const result = tryGit(git, repo, ["remote", "get-url", remote])
  if (!result.ok || result.stdout.length === 0) return undefined
  return sanitizeRemoteUrl(result.stdout)
}

/** Strip embedded credentials from a remote URL before it leaves the domain. */
export function sanitizeRemoteUrl(url: string): string {
  return url.replace(/https?:\/\/[^@]+@/, (match) => (match.startsWith("https") ? "https://" : "http://"))
}

export function statusPorcelain(git: GitRunner, path: string): string[] {
  const result = tryGit(git, path, ["status", "--porcelain"])
  return result.ok && result.stdout.length > 0 ? result.stdout.split("\n").filter(Boolean) : []
}

export function revListCount(git: GitRunner, repo: string, from: string, to: string): number {
  const result = tryGit(git, repo, ["rev-list", "--count", from + ".." + to])
  return result.ok ? Number(result.stdout) || 0 : 0
}

export function listCommits(
  git: GitRunner,
  repo: string,
  from: string,
  to: string,
): { sha: string; subject: string }[] {
  const result = tryGit(git, repo, ["log", "--format=%H%x00%s", from + ".." + to])
  if (!result.ok) return []
  return result.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.indexOf("\0")
      return separator >= 0
        ? { sha: line.slice(0, separator), subject: line.slice(separator + 1) }
        : { sha: line, subject: "" }
    })
}

export function lastCommitForPath(
  git: GitRunner,
  repo: string,
  path: string,
): { sha: string; subject: string } | undefined {
  const result = tryGit(git, repo, ["log", "-1", "--format=%H%x00%s", "--", path])
  if (!result.ok || result.stdout.length === 0) return undefined
  const separator = result.stdout.indexOf("\0")
  return separator >= 0
    ? { sha: result.stdout.slice(0, separator), subject: result.stdout.slice(separator + 1) }
    : { sha: result.stdout, subject: "" }
}

export function lsTreeFiles(git: GitRunner, repo: string, ref: string): string[] {
  const result = tryGit(git, repo, ["ls-tree", "-r", "--name-only", ref])
  return result.ok ? result.stdout.split("\n").filter(Boolean) : []
}

export function fileAtRef(git: GitRunner, repo: string, ref: string, path: string): string | null {
  const result = tryGit(git, repo, ["show", ref + ":" + path])
  return result.ok ? result.stdout : null
}

/** Read-only integration feasibility hint; never mutates the repository. */
export function mergePrediction(
  git: GitRunner,
  repo: string,
  from: string,
  to: string,
): { prediction: "clean" | "conflict"; conflictFiles: string[] } {
  if (!tryGit(git, repo, ["rev-parse", "--verify", from]).ok) return { prediction: "clean", conflictFiles: [] }
  if (!tryGit(git, repo, ["rev-parse", "--verify", to]).ok) return { prediction: "clean", conflictFiles: [] }
  const result = tryGit(git, repo, ["merge-tree", "--write-tree", "--name-only", to, from])
  if (result.ok) return { prediction: "clean", conflictFiles: [] }
  // A conflicted merge-tree reports the tree and the conflicting paths on
  // stdout, and exits non-zero; keep those names for the diagnosis.
  const merged = git.capture?.(repo, ["merge-tree", "--write-tree", "--name-only", to, from]).stdout ?? ""
  const diagnostics = merged.length > 0 ? merged : result.stderr
  return {
    prediction: "conflict",
    conflictFiles: diagnostics
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^[0-9a-f]{40,64}$/.test(line))
      .filter((line) => !line.startsWith("CONFLICT") && !line.startsWith("Auto-merging"))
      .slice(0, 5),
  }
}

/** Read a file inside a Git worktree, or null when it does not exist. */
export function readWorktreeFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

/** Path of a worktree-private git info file. */
export function gitPath(git: GitRunner, worktree: string, name: string): string {
  const result = tryGit(git, worktree, ["rev-parse", "--git-path", name])
  return result.ok ? join(worktree, result.stdout) : join(worktree, ".git", name)
}

// ─── Transaction primitives ───────────────────────────────────────────
//
// Narrow, named operations for the sync transaction. None of them is a
// general Git surface: callers reach them only through the business flows
// in ./sync and ./capability.

export function revParse(git: GitRunner, repo: string, ref: string): string {
  const result = tryGit(git, repo, ["rev-parse", ref])
  if (!result.ok) {
    throw new Error("Cannot resolve " + ref + " in " + repo + ": " + result.stderr)
  }
  return result.stdout
}

export function mergeBase(git: GitRunner, repo: string, a: string, b: string): string | undefined {
  const result = tryGit(git, repo, ["merge-base", a, b])
  return result.ok ? result.stdout : undefined
}

export function diffNameOnly(git: GitRunner, repo: string, from: string, to: string): string[] {
  const result = tryGit(git, repo, ["diff", "--name-only", from, to])
  return result.ok ? result.stdout.split("\n").filter(Boolean) : []
}

export function diffCachedNameOnly(git: GitRunner, repo: string): string[] {
  const result = tryGit(git, repo, ["diff", "--cached", "--name-only"])
  return result.ok ? result.stdout.split("\n").filter(Boolean) : []
}

export function diffWorktreeNameOnly(git: GitRunner, repo: string): string[] {
  const result = tryGit(git, repo, ["diff", "--name-only"])
  return result.ok ? result.stdout.split("\n").filter(Boolean) : []
}

/** Rename-detection-free change paths (a rename source must stay visible). */
export function diffNoRenamesPaths(git: GitRunner, repo: string, from: string, to: string): string[] {
  const result = tryGit(git, repo, ["diff", "--no-renames", "--name-only", from, to])
  return result.ok ? result.stdout.split("\n").filter(Boolean) : []
}

export function deletedPaths(git: GitRunner, repo: string, from: string, to: string): string[] {
  const result = tryGit(git, repo, ["diff", "--name-status", "--no-renames", from, to])
  if (!result.ok) return []
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("D\t"))
    .map((line) => line.slice(2))
}

export function diffNameStatus(
  git: GitRunner,
  repo: string,
  from: string,
  to: string,
): { status: string; path: string }[] {
  const result = tryGit(git, repo, ["diff", "--name-status", from, to])
  if (!result.ok) return []
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const columns = line.split("\t")
      const status = columns[0] ?? ""
      if ((status.startsWith("R") || status.startsWith("C")) && columns[2] !== undefined) {
        return [
          { status: "D", path: columns[1] ?? "" },
          { status: "A", path: columns[2] },
        ]
      }
      return columns[1] === undefined ? [] : [{ status: status.charAt(0), path: columns[1] }]
    })
}

export function untrackedFiles(git: GitRunner, repo: string): string[] {
  const result = tryGit(git, repo, ["ls-files", "--others", "--exclude-standard"])
  return result.ok ? result.stdout.split("\n").filter(Boolean) : []
}

export function fileExistsAtRef(git: GitRunner, repo: string, ref: string, path: string): boolean {
  return tryGit(git, repo, ["cat-file", "-e", ref + ":" + path]).ok
}

export function worktreeAddDetached(git: GitRunner, repo: string, path: string, ref: string): void {
  const result = tryGit(git, repo, ["worktree", "add", "--detach", path, ref])
  if (!result.ok) throw new Error("Cannot create integration worktree at " + path + ": " + result.stderr)
}

export function worktreeRemove(git: GitRunner, repo: string, path: string): void {
  tryGit(git, repo, ["worktree", "remove", "--force", path])
}

export function pruneWorktrees(git: GitRunner, repo: string): void {
  tryGit(git, repo, ["worktree", "prune"])
}

export function mergeNoEdit(git: GitRunner, worktree: string, ref: string): boolean {
  return tryGit(git, worktree, ["merge", "--no-edit", ref]).ok
}

export function mergeAbort(git: GitRunner, worktree: string): void {
  tryGit(git, worktree, ["merge", "--abort"])
}

export function mergeFfOnly(git: GitRunner, repo: string, ref: string): void {
  const result = tryGit(git, repo, ["merge", "--ff-only", ref])
  if (!result.ok) throw new Error("Fast-forward to " + ref + " failed: " + result.stderr)
}

export function conflictFiles(git: GitRunner, worktree: string): string[] {
  const result = tryGit(git, worktree, ["diff", "--name-only", "--diff-filter=U"])
  return result.ok ? result.stdout.split("\n").filter(Boolean) : []
}

export function checkoutFileFrom(git: GitRunner, worktree: string, ref: string, path: string): boolean {
  return tryGit(git, worktree, ["checkout", ref, "--", path]).ok
}

export function removeWorktreeFile(git: GitRunner, worktree: string, path: string): boolean {
  return tryGit(git, worktree, ["rm", "-q", "--force", "--", path]).ok
}

export function commitStaged(git: GitRunner, worktree: string, message: string): boolean {
  return tryGit(git, worktree, ["commit", "-q", "-m", message]).ok
}

export function resetHardTo(git: GitRunner, repo: string, ref: string): void {
  tryGit(git, repo, ["reset", "--hard", ref])
}

export function resetMixedTo(git: GitRunner, repo: string, ref: string): void {
  tryGit(git, repo, ["reset", "--mixed", ref])
}

export function updateRef(git: GitRunner, repo: string, ref: string, value: string): void {
  tryGit(git, repo, ["update-ref", "refs/heads/" + ref, value])
}

/**
 * Rollback variants that THROW on Git failure.
 *
 * The forgiving versions above return normally so callers can decide what a
 * failure means; a recovery path cannot use them, because a swallowed failure is
 * indistinguishable from a successful restore and the caller would then report
 * "nothing was kept" over a half-restored ref.
 */
export function updateRefChecked(git: GitRunner, repo: string, ref: string, value: string): void {
  const attempt = tryGit(git, repo, ["update-ref", "refs/heads/" + ref, value])
  if (!attempt.ok)
    throw new SpaceServiceError({
      code: spaceErrorCodes.syncFailed,
      message: "git update-ref " + ref + " failed: " + attempt.stderr,
    })
}

export function resetHardToChecked(git: GitRunner, repo: string, ref: string): void {
  const attempt = tryGit(git, repo, ["reset", "--hard", ref])
  if (!attempt.ok)
    throw new SpaceServiceError({
      code: spaceErrorCodes.syncFailed,
      message: "git reset --hard failed: " + attempt.stderr,
    })
}

export function resetMixedToChecked(git: GitRunner, repo: string, ref: string): void {
  const attempt = tryGit(git, repo, ["reset", "--mixed", ref])
  if (!attempt.ok)
    throw new SpaceServiceError({
      code: spaceErrorCodes.syncFailed,
      message: "git reset --mixed failed: " + attempt.stderr,
    })
}

/** Read-only virtual merge: writes only into a disposable object store. */
export function probeMerge(
  git: GitRunner,
  repo: string,
  into: string,
  from: string,
  scratch: string,
): { ok: boolean; conflicts: string[]; resultTree?: string } {
  const commonResult = tryGit(git, repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  if (!commonResult.ok) return { ok: false, conflicts: [] }
  const objects = join(commonResult.stdout, "objects")
  const env = { GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects }
  const raw = git.capture?.(repo, ["merge-tree", "--write-tree", "--name-only", into, from], env)
  const stdout = raw?.stdout ?? ""
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const tree = lines[0]
  if (raw?.ok === true && tree !== undefined && /^[0-9a-f]{40,64}$/.test(tree)) {
    return { ok: true, conflicts: [], resultTree: tree }
  }
  return {
    ok: false,
    conflicts: lines
      .slice(1)
      .filter((line) => !line.startsWith("CONFLICT") && !line.startsWith("Auto-merging"))
      .slice(0, 10),
  }
}

/** Is a merge, rebase, cherry-pick, revert or sequencer in progress? */
export function operationInProgress(git: GitRunner, worktree: string): string | undefined {
  const gitDir = tryGit(git, worktree, ["rev-parse", "--absolute-git-dir"])
  if (!gitDir.ok) return undefined
  const markers: readonly [string, string][] = [
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["sequencer", "sequencer"],
  ]
  for (const [marker, label] of markers) {
    if (existsSync(join(gitDir.stdout, marker))) return label
  }
  return undefined
}

/** Changed paths of one diff expression (e.g. "main...space/x"). */
export function diffNameOnlyExpr(git: GitRunner, repo: string, expression: string): string[] {
  const result = tryGit(git, repo, ["diff", "--name-only", expression])
  return result.ok ? result.stdout.split("\n").filter(Boolean) : []
}
