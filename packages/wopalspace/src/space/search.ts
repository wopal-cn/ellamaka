import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import { GitignoreMatcher } from "./gitignore"
import { SpaceServiceError, spaceErrorCodes } from "./types"
import type { SpaceSearchInput, SpaceSearchItem, SpaceSearchResult, SpaceSearchType } from "./types"

/** Directories a Space search never enters. */
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

const maxDepth = 6
const maxLimit = 50

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

function walk(
  root: string,
  directory: string,
  relPath: string,
  type: SpaceSearchType,
  matcher: GitignoreMatcher,
  onMatch: (item: SpaceSearchItem) => void,
  depth: number,
): void {
  if (depth > maxDepth) return
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return
  }
  for (const name of names) {
    if (skipDirectories.has(name)) continue
    const absolute = join(directory, name)
    let stats
    try {
      stats = statSync(absolute)
    } catch {
      continue
    }
    if (!staysInRoot(root, absolute)) continue
    const rel = relPath.length > 0 ? relPath + "/" + name : name
    const isDirectory = stats.isDirectory()
    if (matcher.isIgnored(absolute, isDirectory)) continue

    if (isDirectory) {
      const isRepo = existsSync(join(absolute, ".git"))
      if (type === "repo") {
        if (isRepo) {
          onMatch({ name, path: rel, type })
          continue
        }
      } else if (type === "dir") {
        onMatch({ name, path: rel, type })
      }
      walk(root, absolute, rel, type, matcher, onMatch, depth + 1)
      continue
    }
    if (type === "file") onMatch({ name, path: rel, type })
  }
}

/**
 * Search inside one registered Space root.
 *
 * Confined, read-only discovery: the query is a plain substring matched
 * against entry names, never a path. Absolute queries and parent traversal
 * are refused before any walk begins.
 */
export function searchSpace(root: string, input: SpaceSearchInput = {}): SpaceSearchResult {
  const resolvedRoot = realOrUndefined(root)
  if (resolvedRoot === undefined) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.spaceNotFound,
      message: "Space path does not exist: " + root,
      suggestion: "Verify the Space is registered and its path is valid.",
    })
  }

  const type: SpaceSearchType = input.type ?? "dir"
  if (type !== "repo" && type !== "dir" && type !== "file") {
    throw new SpaceServiceError({
      code: spaceErrorCodes.invalidSearchType,
      message: "Invalid search type: " + String(type),
      suggestion: "Search type must be repo, dir, or file.",
    })
  }

  const query = input.query
  if (type !== "repo" && (query === undefined || query.trim().length === 0)) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.queryRequired,
      message: "Query is required for type " + type,
      suggestion: "Provide a query string to search directories or files.",
    })
  }
  if (query !== undefined && (query.includes("..") || isAbsolute(query))) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.pathTraversalDetected,
      message: "Query contains traversal or absolute path: " + query,
      suggestion: "Use a simple query string; search never addresses a path.",
    })
  }

  const limit = Math.min(Math.max(input.limit ?? maxLimit, 1), maxLimit)
  const offset = Math.max(input.offset ?? 0, 0)
  const lowerQuery = query === undefined ? "" : query.toLowerCase()
  const matches: SpaceSearchItem[] = []
  walk(
    resolvedRoot,
    resolvedRoot,
    "",
    type,
    new GitignoreMatcher(resolvedRoot),
    (item) => {
      if (lowerQuery.length > 0 && !item.name.toLowerCase().includes(lowerQuery)) return
      matches.push(item)
    },
    0,
  )
  matches.sort((a, b) => a.path.localeCompare(b.path))
  const items = matches.slice(offset, offset + limit)
  return {
    items,
    total: matches.length,
    offset,
    limit,
    hasMore: offset + items.length < matches.length,
  }
}
