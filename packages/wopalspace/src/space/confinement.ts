import { realpathSync } from "node:fs"
import { isAbsolute, relative, sep } from "node:path"
import { SpaceServiceError, spaceErrorCodes } from "./types"

/**
 * Caller-supplied relative path confinement.
 *
 * A path-bearing Space operation accepts only a repository-style relative
 * path below the registered root. Absolute paths, backslashes and any
 * parent segment are refused before touching the filesystem, so
 * normalization can never lift a caller outside the root.
 */
export function normalizeRelativePath(value: string | undefined): string {
  const original = value ?? ""
  const normalized = original.replaceAll("\\", "/")
  if (isAbsolute(original) || /^[A-Za-z]:[\\/]/.test(original) || normalized.startsWith("/")) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.pathEscape,
      message: "Path must be relative to the registered Space root",
      suggestion: "Pass a path below the Space root, for example projects/app.",
    })
  }
  const segments = normalized.split("/")
  if (segments.some((segment) => segment === "..")) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.pathEscape,
      message: "Path must be relative to the registered Space root without parent traversal",
      suggestion: "Remove the parent segments; Space operations never address content above the registered root.",
    })
  }
  return segments.filter((segment) => segment.length > 0 && segment !== ".").join("/")
}

/** Is inner the root itself, or a path below it? Separator-boundary aware. */
export function isPathWithin(root: string, inner: string): boolean {
  if (inner === root) return true
  const rel = relative(root, inner)
  return rel.length > 0 && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel)
}

/** Resolve symlinks for an existing path; undefined when it cannot be resolved. */
export function realPathOf(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

export interface ConfinedPath {
  /** Canonical registered root. */
  readonly root: string
  /** Canonical target inside the root. */
  readonly target: string
  /** Registered-root-relative POSIX path of the target. */
  readonly relative: string
}

/**
 * Confine one caller path to the registered root: lexical containment first,
 * then the real path of both ends so a symlink cannot escape the root.
 */
export function confineToRoot(root: string, relativePath: string | undefined): ConfinedPath {
  const relativeInput = normalizeRelativePath(relativePath)
  const realRoot = realPathOf(root)
  if (realRoot === undefined) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.spaceNotFound,
      message: "Registered Space root is unavailable: " + root,
      suggestion: "Check that the Space directory still exists, then retry.",
    })
  }
  const lexical = relativeInput.length === 0 ? realRoot : realRoot + "/" + relativeInput
  if (!isPathWithin(realRoot, lexical)) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.pathEscape,
      message: "Path escapes the registered Space root",
    })
  }
  const realTarget = realPathOf(lexical)
  if (realTarget === undefined) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.spaceNotFound,
      message: "Space path not found: " + relativeInput,
      suggestion: "List the parent directory to see the available entries.",
    })
  }
  if (!isPathWithin(realRoot, realTarget)) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.pathEscape,
      message: "Resolved path escapes the registered Space root",
      suggestion: "Symlinks that leave the Space root are not readable through this operation.",
    })
  }
  return { root: realRoot, target: realTarget, relative: relativeInput }
}

/** Resolve a path to a registered-root-relative POSIX path, or undefined when outside. */
export function relativeToRoot(root: string, target: string): string | undefined {
  if (!isPathWithin(root, target)) return undefined
  const rel = relative(root, target)
  return rel.split(sep).join("/")
}

/** Is the resolved target safely inside the root (dangling links allowed)? */
export function symlinkStaysInRoot(root: string, target: string): boolean {
  const resolved = realPathOf(target)
  if (resolved === undefined) return true
  return isPathWithin(root, resolved)
}
