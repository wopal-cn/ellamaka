import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import { SpaceServiceError, spaceErrorCodes } from "./types"
import type { SpaceProject, SpaceProjectWorktree, SpaceProjectsResult } from "./types"
import type { GitRunner } from "./git"

/** Directory names never entered while discovering projects or search entries. */
const skipDirectories = new Set([
  "node_modules",
  "__pycache__",
  ".git",
  ".DS_Store",
  "dist",
  "build",
  ".next",
  ".wopal",
  ".wopal-space",
  ".worktrees",
])

function realOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

function staysInRoot(root: string, candidate: string): boolean {
  const real = realOrUndefined(candidate)
  if (real === undefined) return false
  const rel = relative(root, real)
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** Parse `git worktree list --porcelain` output into entries. */
export function parseWorktreePorcelain(output: string): SpaceProjectWorktree[] {
  const result: SpaceProjectWorktree[] = []
  let path: string | undefined
  let branch: string | undefined
  const flush = () => {
    if (path !== undefined) result.push({ path, ...(branch ? { branch } : {}) })
    path = undefined
    branch = undefined
  }
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      flush()
      continue
    }
    const separator = trimmed.indexOf(" ")
    if (separator === -1) continue
    const key = trimmed.slice(0, separator)
    const value = trimmed.slice(separator + 1).trim()
    if (key === "worktree") {
      flush()
      path = value
    } else if (key === "branch") {
      branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value
    }
  }
  flush()
  return result
}

function worktreesOf(projectPath: string, root: string, git: GitRunner): SpaceProjectWorktree[] {
  let output: string
  try {
    output = git(projectPath, ["worktree", "list", "--porcelain"])
  } catch {
    return []
  }
  const resolvedRoot = realOrUndefined(root) ?? root
  const resolvedProject = realOrUndefined(projectPath) ?? projectPath
  const worktreesRoot = join(resolvedRoot, ".worktrees")
  const entries: SpaceProjectWorktree[] = []
  for (const entry of parseWorktreePorcelain(output)) {
    const resolved = realOrUndefined(entry.path) ?? entry.path
    if (resolved === resolvedProject) continue
    const relToWorktrees = relative(worktreesRoot, resolved)
    if (relToWorktrees.startsWith("..") || isAbsolute(relToWorktrees)) continue
    const rel = relative(resolvedRoot, resolved)
    entries.push({ path: rel.split(/[\\/]/).join("/"), ...(entry.branch ? { branch: entry.branch } : {}) })
  }
  return entries
}

function collectProjects(
  root: string,
  directory: string,
  relPath: string,
  result: SpaceProject[],
  depth: number,
): void {
  if (depth > 5) return
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return
  }
  for (const name of names) {
    if (skipDirectories.has(name)) continue
    const absolute = join(directory, name)
    let directoryEntry = false
    try {
      directoryEntry = statSync(absolute).isDirectory()
    } catch {
      continue
    }
    if (!directoryEntry) continue
    if (!staysInRoot(root, absolute)) continue
    const rel = relPath.length > 0 ? relPath + "/" + name : name
    if (existsSync(join(absolute, ".git"))) {
      result.push({ id: rel, name, path: rel, worktrees: [] })
      continue
    }
    collectProjects(root, absolute, rel, result, depth + 1)
  }
}

/**
 * Registered projects: Git repositories under the Space root's `projects/`
 * directory, each with the linked worktrees that live under
 * `.worktrees/`. Read-only; nothing outside the root is followed.
 */
export function listSpaceProjects(root: string, git: GitRunner): SpaceProjectsResult {
  const resolvedRoot = realOrUndefined(root)
  if (resolvedRoot === undefined) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.spaceNotFound,
      message: "Space path does not exist: " + root,
      suggestion: "Verify the Space is registered and its path is valid.",
    })
  }
  const found: SpaceProject[] = []
  const projectsRoot = join(resolvedRoot, "projects")
  if (existsSync(projectsRoot)) collectProjects(resolvedRoot, projectsRoot, "projects", found, 0)
  const items = found
    .map((project) => ({
      ...project,
      worktrees: worktreesOf(join(resolvedRoot, project.path), resolvedRoot, git),
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
  return { items, total: items.length }
}
