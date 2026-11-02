import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tryGit, type GitRunner } from "./git"
import { SpaceServiceError, spaceErrorCodes } from "./types"

/**
 * Sparse materialization mechanics for a Space worktree.
 *
 * A worktree is created with --no-checkout and then narrowed to its assembly
 * range. This module owns only that Git interaction; worktree lifecycle
 * (create/remove) belongs to the Space init transaction.
 */

function sparseFailure(worktreePath: string, step: string, detail: string): SpaceServiceError {
  return new SpaceServiceError({
    code: spaceErrorCodes.sparseApplyFailed,
    message: "Sparse checkout " + step + " failed for worktree " + worktreePath + ": " + detail,
    suggestion: "Ensure the target path is a git worktree with a valid index, then re-run the operation",
  })
}

function run(git: GitRunner, worktree: string, args: readonly string[], step: string): string {
  const result = tryGit(git, worktree, args)
  if (!result.ok) throw sparseFailure(worktree, step, result.stderr)
  return result.stdout
}

function isSparseInitialized(git: GitRunner, worktree: string): boolean {
  return tryGit(git, worktree, ["sparse-checkout", "list"]).ok
}

function isIndexEmpty(git: GitRunner, worktree: string): boolean {
  return run(git, worktree, ["ls-files"], "ls-files").trim().length === 0
}

/** The recorded sparse range, in order. */
export function listSparsePatterns(git: GitRunner, worktree: string): string[] {
  const result = tryGit(git, worktree, ["sparse-checkout", "list"])
  return result.ok ? result.stdout.split("\n").filter((line) => line.length > 0) : []
}

function samePatternSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((pattern) => set.has(pattern))
}

/**
 * Apply a non-cone sparse range to an existing worktree.
 *
 * Idempotent: an unchanged range with a populated index does nothing. A
 * --no-checkout worktree has an empty index, so the range is recorded and
 * the working tree populated. An empty pattern list is refused.
 */
export function applySparsePatterns(git: GitRunner, worktree: string, patterns: readonly string[]): void {
  if (patterns.length === 0) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.sparseApplyFailed,
      message: "Refusing to apply an empty sparse range to " + worktree,
      suggestion: "Pass at least one pattern; an empty list would enable git's default range instead",
    })
  }
  if (!isSparseInitialized(git, worktree)) {
    run(git, worktree, ["sparse-checkout", "init", "--no-cone"], "init")
  } else if (samePatternSet(listSparsePatterns(git, worktree), patterns) && !isIndexEmpty(git, worktree)) {
    return
  }

  run(git, worktree, ["sparse-checkout", "set", "--no-cone", ...patterns], "set")
  if (isIndexEmpty(git, worktree)) run(git, worktree, ["checkout"], "checkout")
}

/** Non-cone sparse pattern covering exactly one repository path. */
export function toSparsePattern(path: string): string {
  return path.startsWith("/") ? path : "/" + path
}

export interface SparseIndexViolation {
  readonly path: string
  readonly form: "stranded" | "drifted"
}

export interface SparseConsistency {
  readonly consistent: boolean
  readonly violations: readonly SparseIndexViolation[]
}

const CE_SKIP_WORKTREE = 0x4000

function patternCovers(pattern: string, path: string): boolean {
  const body = pattern.startsWith("/") ? pattern.slice(1) : pattern
  const directory = body.endsWith("/")
  const bare = directory ? body.slice(0, -1) : body
  if (path === bare) return true
  return directory ? path.startsWith(bare + "/") : false
}

/** One index entry read from git ls-files --debug. */
interface IndexEntry {
  readonly path: string
  readonly flags: number
}

function unquoteIndexPath(line: string): string {
  if (line.length >= 2 && line.startsWith('"') && line.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === "string") return parsed
    } catch {
      return line.slice(1, -1)
    }
  }
  return line
}

function parseIndexEntries(output: string): IndexEntry[] {
  const entries: IndexEntry[] = []
  let path: string | null = null
  let flags: number | null = null
  const flush = () => {
    if (path !== null && flags !== null) entries.push({ path, flags })
    path = null
    flags = null
  }
  for (const line of output.split("\n")) {
    if (line.length === 0) continue
    if (!/^\s/.test(line)) {
      flush()
      path = unquoteIndexPath(line)
      continue
    }
    const match = /(?:^|\s)flags:\s*([0-9a-fA-F]+)\s*$/.exec(line)
    if (match && path !== null) {
      const value = match[1]
      if (value !== undefined) flags = Number.parseInt(value, 16)
    }
  }
  flush()
  return entries
}

/**
 * Compare the worktree index with its recorded sparse range.
 *
 * Two directions disagree: an in-range entry carrying the skip-worktree bit
 * (drifted) and an out-of-range entry without it whose file is gone
 * (stranded, git's unstaged-deletion signal). An out-of-range entry still on
 * disk is the legitimate sparse-add state and is not a violation.
 */
export function checkSparseConsistency(
  git: GitRunner,
  worktree: string,
  patterns: readonly string[],
): SparseConsistency {
  const entries = parseIndexEntries(run(git, worktree, ["ls-files", "--debug"], "ls-files --debug"))
  const violations: SparseIndexViolation[] = []
  for (const entry of entries) {
    const inRange = patterns.some((pattern) => patternCovers(pattern, entry.path))
    const skipped = (entry.flags & CE_SKIP_WORKTREE) !== 0
    if (inRange && skipped) {
      violations.push({ path: entry.path, form: "drifted" })
    } else if (!inRange && !skipped && !existsSync(join(worktree, entry.path))) {
      violations.push({ path: entry.path, form: "stranded" })
    }
  }
  return { consistent: violations.length === 0, violations }
}

/** Abort when the worktree index disagrees with its sparse range. */
export function assertSparseConsistency(git: GitRunner, worktree: string): void {
  let result: SparseConsistency
  try {
    result = checkSparseConsistency(git, worktree, listSparsePatterns(git, worktree))
  } catch {
    return
  }
  if (result.consistent) return
  const sample = result.violations
    .slice(0, 5)
    .map((violation) => violation.path + " (" + violation.form + ")")
    .join(", ")
  throw new SpaceServiceError({
    code: spaceErrorCodes.sparseApplyFailed,
    message:
      "The Space worktree index disagrees with its sparse range (" + result.violations.length + " entries): " + sample,
    suggestion:
      "Run git sparse-checkout reapply inside the Space worktree after reviewing the index, then retry; no automatic repair is performed.",
  })
}

/** Read a sparse range file, or empty when absent. */
export function readSparseRangeFile(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8").split("\n").filter(Boolean)
}

/** Write a sparse range file directly (fixture support). */
export function writeSparseRangeFile(path: string, patterns: readonly string[]): void {
  if (!existsSync(join(path, ".."))) throw new Error("SPARSE_RANGE_PATH_INVALID")
  writeFileSync(path, patterns.join("\n") + "\n")
}
