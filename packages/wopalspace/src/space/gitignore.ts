import { existsSync, readFileSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative } from "node:path"

/**
 * Gitignore matching used by Space search/scan/file listing.
 *
 * Ported from the previous Wopal CLI owner (fs/gitignore) so the assembly
 * view keeps its exact pattern semantics: exact names, basename matches,
 * trailing wildcards, "*.ext", directory prefixes, and negation.
 */
export interface IgnorePattern {
  readonly raw: string
  readonly negated: boolean
  readonly isDir: boolean
}

export function parseGitignore(content: string): IgnorePattern[] {
  const patterns: IgnorePattern[] = []
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const negated = trimmed.startsWith("!")
    let pattern = negated ? trimmed.substring(1) : trimmed
    const isDir = pattern.endsWith("/")
    if (isDir) pattern = pattern.slice(0, -1)
    patterns.push({ raw: pattern, negated, isDir })
  }
  return patterns
}

export function matchPattern(pattern: string, relPath: string, checkAsDir: boolean): boolean {
  if (relPath === pattern) return true
  if (!pattern.includes("/") && basename(relPath) === pattern) return true
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2)
    if (relPath === prefix || relPath.startsWith(prefix + "/")) return true
  }
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3)
    if (relPath === prefix || relPath.startsWith(prefix + "/")) return true
  }
  if (pattern.startsWith("*.")) {
    const suffix = pattern.substring(1)
    if (relPath.endsWith(suffix) || basename(relPath).endsWith(suffix)) return true
  }
  if (pattern.endsWith("/") && checkAsDir && relPath === pattern.slice(0, -1)) return true
  return relPath === pattern || relPath.startsWith(pattern + "/")
}

export function isIgnoredByPatterns(relPath: string, isDir: boolean, patterns: readonly IgnorePattern[]): boolean {
  let ignored = false
  for (const pattern of patterns) {
    if (matchPattern(pattern.raw, relPath, isDir || pattern.isDir)) ignored = !pattern.negated
  }
  return ignored
}

/** Ignore rules collected from every .gitignore between a root and a path. */
export class GitignoreMatcher {
  private readonly patternsByDir = new Map<string, IgnorePattern[]>()

  constructor(private readonly root: string) {}

  private loadDir(directory: string): void {
    if (this.patternsByDir.has(directory)) return
    const path = join(directory, ".gitignore")
    if (!existsSync(path)) return
    try {
      this.patternsByDir.set(directory, parseGitignore(readFileSync(path, "utf8")))
    } catch {
      // Unreadable ignore files contribute no patterns.
    }
  }

  isIgnored(absPath: string, isDir: boolean): boolean {
    let root = this.root
    let target = absPath
    try {
      root = realpathSync(this.root)
      target = realpathSync(absPath)
    } catch {
      // Keep the unresolved pair; the containment check below still applies.
    }
    if (!isAbsolute(target)) return false
    let current = isDir ? target : dirname(target)
    while (true) {
      if (!isWithin(root, current)) return false
      this.loadDir(current)
      const patterns = this.patternsByDir.get(current)
      if (patterns) {
        const sub = relative(current, target)
        if (sub && sub !== "." && isIgnoredByPatterns(sub, isDir, patterns)) return true
      }
      if (current === root) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    return false
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel))
}
