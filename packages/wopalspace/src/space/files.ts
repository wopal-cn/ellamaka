import { readFileSync, readdirSync, statSync } from "node:fs"
import { extname, join } from "node:path"
import { confineToRoot, relativeToRoot, symlinkStaysInRoot } from "./confinement"
import { GitignoreMatcher } from "./gitignore"
import { SpaceServiceError, spaceErrorCodes } from "./types"
import type { SpaceFileContent, SpaceFileNode, SpaceFilesListResult } from "./types"

/** Entries never surfaced by controlled Space browsing. */
const excluded = new Set([".git", ".DS_Store"])

const mimeTypes: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
}

const binaryExtensions = new Set([
  "exe",
  "dll",
  "pdb",
  "bin",
  "so",
  "dylib",
  "o",
  "a",
  "lib",
  "zip",
  "gz",
  "tar",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "node",
])

/**
 * List one controlled directory inside a registered Space root.
 *
 * Read-only: no Runtime, bootstrap, fetch or repair. Symlinks that resolve
 * outside the root are dropped so the listing cannot leak foreign content.
 */
export function listSpaceFiles(root: string, path?: string): SpaceFilesListResult {
  const confined = confineToRoot(root, path)
  let isDirectory = false
  try {
    isDirectory = statSync(confined.target).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.spaceNotFound,
      message: "Space path is not a directory: " + (path ?? ""),
      suggestion: "Pass a relative directory path, or omit the path to list the Space root.",
    })
  }

  const matcher = new GitignoreMatcher(confined.root)
  let entries
  try {
    entries = readdirSync(confined.target, { withFileTypes: true })
  } catch (error) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.spaceNotFound,
      message: "Space directory not found: " + (path ?? ""),
      cause: error,
    })
  }

  const items: SpaceFileNode[] = []
  for (const entry of entries) {
    if (excluded.has(entry.name)) continue
    const absolute = join(confined.target, entry.name)
    if (entry.isSymbolicLink() && !symlinkStaysInRoot(confined.root, absolute)) continue
    const relative = relativeToRoot(confined.root, absolute)
    if (relative === undefined) continue
    let directory = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      try {
        directory = statSync(absolute).isDirectory()
      } catch {
        directory = false
      }
    }
    items.push({
      name: entry.name,
      path: relative,
      absolute,
      type: directory ? "directory" : "file",
      ignored: matcher.isIgnored(absolute, directory),
    })
  }
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return { items, total: items.length }
}

/**
 * Read one controlled file inside a registered Space root.
 *
 * Text is returned as UTF-8; images come back base64 encoded; other binary
 * formats are reported as binary with no content.
 */
export function readSpaceFile(root: string, path: string): SpaceFileContent {
  const confined = confineToRoot(root, path)
  let isFile = false
  try {
    isFile = statSync(confined.target).isFile()
  } catch {
    isFile = false
  }
  if (!isFile) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.spaceNotFound,
      message: "Space file not found: " + path,
      suggestion: "List the parent directory to see the available files.",
    })
  }

  const extension = extname(confined.target).toLowerCase()
  const mimeType = mimeTypes[extension]
  if (mimeType !== undefined && extension !== ".svg") {
    return {
      type: "text",
      content: readFileSync(confined.target).toString("base64"),
      encoding: "base64",
      mimeType,
    }
  }
  if (binaryExtensions.has(extension.slice(1))) {
    return { type: "binary", content: "" }
  }

  const bytes = readFileSync(confined.target)
  return { type: "text", content: bytes.toString("utf8"), ...(mimeType ? { mimeType } : {}) }
}
