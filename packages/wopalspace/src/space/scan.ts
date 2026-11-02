import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { basename, isAbsolute, join, relative } from "node:path"
import { describeDirectory } from "./description"
import { parseGitignore, isIgnoredByPatterns, type IgnorePattern } from "./gitignore"
import type { GitRunner } from "./git"
import type { SpaceAgentRuleEntry, SpaceRepositoryEntry, SpaceScanResult } from "./types"

const alwaysSkip = new Set(["node_modules", "__pycache__", ".next", "dist", "build", ".DS_Store", ".git"])

function realOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

function gitType(path: string): "dir" | "file" | null {
  try {
    const stats = statSync(join(path, ".git"))
    return stats.isDirectory() ? "dir" : stats.isFile() ? "file" : null
  } catch {
    return null
  }
}

function remoteAndRef(git: GitRunner, path: string): { remote?: string; ref?: string } {
  let remote: string | undefined
  let ref: string | undefined
  try {
    const value = git(path, ["remote", "get-url", "origin"])
    if (value.length > 0) remote = value
  } catch {
    // A repository without an origin contributes no remote.
  }
  try {
    const value = git(path, ["rev-parse", "--abbrev-ref", "HEAD"])
    if (value.length > 0) ref = value
  } catch {
    // An unborn HEAD contributes no ref.
  }
  return { remote, ref }
}

function readIgnoreFile(path: string): IgnorePattern[] {
  try {
    return parseGitignore(readFileSync(path, "utf8"))
  } catch {
    return []
  }
}

function scanDirectory(input: {
  directory: string
  relativeDirectory: string
  root: string
  repoRoots: Set<string>
  repoIgnores: Map<string, IgnorePattern[]>
  repositories: SpaceRepositoryEntry[]
  agentRules: SpaceAgentRuleEntry[]
  git: GitRunner
}): void {
  const { directory, relativeDirectory, repoRoots, repoIgnores, repositories, agentRules, git } = input
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }

  let parentRepo = ""
  for (const repoRoot of repoRoots) {
    if (relativeDirectory === repoRoot || relativeDirectory.startsWith(repoRoot + "/")) {
      if (parentRepo.length === 0 || repoRoot.length > parentRepo.length) parentRepo = repoRoot
    }
  }
  const ignorePatterns = repoIgnores.get(parentRepo) ?? []

  for (const entry of entries) {
    const name = entry.name
    if (alwaysSkip.has(name)) continue
    const entryRelative = relativeDirectory.length > 0 ? relativeDirectory + "/" + name : name
    const absolute = join(directory, name)

    if (parentRepo.length > 0 && isIgnoredByPatterns(entryRelative, entry.isDirectory(), ignorePatterns)) continue

    const type = entry.isDirectory() ? gitType(absolute) : null
    if (type !== null) {
      const agentsFile = existsSync(join(absolute, "AGENTS.md")) ? entryRelative + "/AGENTS.md" : undefined
      const description = describeDirectory(
        absolute,
        agentsFile !== undefined ? join(absolute, "AGENTS.md") : undefined,
        agentsFile,
        entryRelative,
      )
      repositories.push({
        path: entryRelative,
        level: "repo",
        type: type === "file" ? "worktree" : "repo",
        ...remoteAndRef(git, absolute),
        description,
        ...(agentsFile !== undefined ? { agentsFile } : {}),
      })
      repoRoots.add(entryRelative)
      repoIgnores.set(entryRelative, readIgnoreFile(join(absolute, ".gitignore")))
      scanDirectory({ ...input, directory: absolute, relativeDirectory: entryRelative })
      continue
    }

    if (name === "AGENTS.md" && entry.isFile()) {
      if (relativeDirectory.length === 0 || repoRoots.has(relativeDirectory)) continue
      agentRules.push({
        path: relativeDirectory,
        role: "module-rules",
        repo: parentRepo,
        description: describeDirectory(directory, absolute, entryRelative, relativeDirectory),
        agentsFile: entryRelative,
      })
      continue
    }

    if (entry.isDirectory()) {
      const real = realOrUndefined(absolute)
      if (real === undefined) continue
      const rel = relative(input.root, real)
      if (rel.startsWith("..") || isAbsolute(rel)) continue
      scanDirectory({ ...input, directory: absolute, relativeDirectory: entryRelative })
    }
  }
}

/**
 * Scan a registered Space root for repository/worktree and AGENTS.md facts.
 *
 * Read-only: the space root is an asset container, so its own ignore file
 * does not hide entries; each repository boundary applies its own
 * .gitignore. Symbolic links that leave the root are never followed.
 */
export function scanSpace(root: string, name: string, git: GitRunner): SpaceScanResult {
  const resolvedRoot = realOrUndefined(root) ?? root
  const repositories: SpaceRepositoryEntry[] = []
  const agentRules: SpaceAgentRuleEntry[] = []
  scanDirectory({
    directory: resolvedRoot,
    relativeDirectory: "",
    root: resolvedRoot,
    repoRoots: new Set(),
    repoIgnores: new Map(),
    repositories,
    agentRules,
    git,
  })
  repositories.sort((a, b) => a.path.localeCompare(b.path))
  agentRules.sort((a, b) => a.path.localeCompare(b.path))
  return { space: { name, path: resolvedRoot }, repositories, agentRules }
}

/** Directory basename, used by callers that derive a Space name from a path. */
export function nameForPath(path: string): string {
  return basename(path)
}
