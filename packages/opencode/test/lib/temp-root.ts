// Picks the temp root every fixture must use.
//
// `os.tmpdir()` honours TMPDIR, and a TMPDIR pointing inside a checkout is not
// hypothetical: this workspace tells agents to write scratch files under
// `<space>/.wopal-space/.tmp`, which sits inside the space's own git repository.
// A test directory created there is still "inside a repo" to every upward
// `git rev-parse` (see Git.find in @wopal/ellamaka-core), so a fixture that
// creates a git worktree registers it in THAT repository's .git/worktrees —
// outside the temp directory the fixture later deletes. The registration then
// outlives the test forever and `git worktree list` in the real checkout grows
// phantom entries.
//
// Keep this module import-free apart from Node built-ins: test/preload.ts loads
// it before anything from src/, because global/index.ts reads WOPAL_HOME at
// import time.
import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/** True when `directory` resolves to a working tree of any git repository. */
export function insideGitRepository(directory: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: directory,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  })
  return result.status === 0 && result.stdout.trim().length > 0
}

/**
 * A directory the fixtures can safely create throwaway repositories in: the
 * ambient temp directory when it is outside every checkout, otherwise the
 * platform temp directory.
 */
export function resolveTempRoot(candidates: string[] = [os.tmpdir(), "/tmp", "/var/tmp"]): string {
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate)
    try {
      mkdirSync(resolved, { recursive: true })
    } catch {
      continue
    }
    if (!insideGitRepository(resolved)) return resolved
  }
  throw new Error(
    "no temp directory outside a git repository: refusing to run tests, because fixtures would " +
      "register worktrees in a real checkout (candidates: " +
      candidates.join(", ") +
      ")",
  )
}

/**
 * Worktrees registered in a repository whose checkout directory no longer
 * exists. These are pure leak: git keeps the entry until `worktree prune`, and
 * nothing in the temp tree can remove it.
 */
export function orphanedWorktrees(repository: string = process.cwd()): string[] {
  const listed = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repository,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  })
  if (listed.status !== 0) return []

  const orphaned: string[] = []
  let current: string | undefined
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = line.slice("worktree ".length)
      continue
    }
    // `prunable` marks an entry whose directory is gone; `locked` keeps it on
    // purpose, so only report real orphans.
    if (line.startsWith("prunable") && current) orphaned.push(current)
  }
  return orphaned
}

/** The top level of the repository containing `directory`, if any. */
export function repositoryOf(directory: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: directory,
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  })
  return result.status === 0 ? result.stdout.trim() || undefined : undefined
}

/** Drop undefined entries without an assertion. */
export function defined<T>(values: Array<T | undefined>): T[] {
  return values.filter((value): value is T => value !== undefined)
}
