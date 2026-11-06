import { lstatSync, readdirSync, statSync, type Dirent } from "node:fs"
import { join } from "node:path"
import {
  parseCapabilityRefShape,
  resolveCapabilityRef,
  resolveGenericPathRef,
  type CapabilityRefShape,
  type ResolvedCapabilityRef,
} from "./assembly"
import { capabilityKindSingular, capabilityKinds, type CapabilityKind } from "./capability-kinds"
import { tryGit, type GitRunner } from "./git"
import { SpaceServiceError } from "./types"

/**
 * Whole-asset inspection for capabilities that exist only in a Space worktree.
 *
 * A new asset becomes shared content before it can be assembled. The checks
 * here are the write-side gate: the reference must resolve to the requested
 * shape, the asset must be complete for its kind, and every file it would
 * carry must be committable — no ignored files, no symbolic links, no
 * repository metadata and no obvious credential files.
 */

/** One worktree asset that can enter the Space branch. */
export interface WorktreeAsset {
  readonly resolved: ResolvedCapabilityRef
  /** Repository-relative regular files this asset owns, sorted. */
  readonly files: readonly string[]
}

export type AssetInspection =
  | { readonly ok: true; readonly asset: WorktreeAsset }
  | { readonly ok: false; readonly reason: string; readonly suggestion: string }

/** Files that mark a directory as a complete capability of its kind. */
const identityFiles: Readonly<Partial<Record<CapabilityKind, string>>> = {
  skills: "SKILL.md",
  plugins: "package.json",
}

/** Credential-shaped basenames that never belong in a shared asset. */
const credentialNames: readonly RegExp[] = [
  /^\.env$/,
  /^\.env\.(?!example$).+$/,
  /\.pem$/,
  /\.key$/,
  /^id_(rsa|dsa|ecdsa|ed25519)$/,
  /^\.npmrc$/,
  /^\.netrc$/,
  /^credentials\.json$/,
  /^\.DS_Store$/,
]

function isCredentialName(name: string): boolean {
  return credentialNames.some((pattern) => pattern.test(name))
}

interface Collected {
  readonly files: string[]
  readonly problems: string[]
}

function inspectFileEntry(worktree: string, path: string, problems: string[]): void {
  const stats = lstatSync(join(worktree, path), { throwIfNoEntry: false })
  if (stats === undefined) {
    problems.push(path + " disappeared while it was being inspected")
    return
  }
  if (stats.isSymbolicLink()) {
    problems.push(path + " is a symbolic link; adopt resolved content only")
    return
  }
  if (!stats.isFile()) {
    problems.push(path + " is not a regular file")
    return
  }
  if (isCredentialName(path.split("/").pop() ?? path)) problems.push(path + " looks like a credential file")
}

function collectFiles(worktree: string, resolved: ResolvedCapabilityRef): Collected {
  if (resolved.form === "set") {
    const files = [...(resolved.files ?? [])]
    const problems: string[] = []
    for (const file of files) inspectFileEntry(worktree, file, problems)
    return { files, problems }
  }
  if (resolved.form !== "directory") {
    const problems: string[] = []
    inspectFileEntry(worktree, resolved.path, problems)
    return { files: [resolved.path], problems }
  }

  const files: string[] = []
  const problems: string[] = []
  const walk = (relative: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(join(worktree, relative), { withFileTypes: true })
    } catch (error) {
      problems.push(relative + " cannot be read: " + (error instanceof Error ? error.message : String(error)))
      return
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const child = relative + "/" + entry.name
      if (entry.name === ".git") {
        problems.push(child + " is Git metadata and cannot be adopted")
        continue
      }
      const stats = lstatSync(join(worktree, child), { throwIfNoEntry: false })
      if (stats === undefined) continue
      if (stats.isSymbolicLink()) {
        problems.push(child + " is a symbolic link; adopt resolved content only")
        continue
      }
      if (stats.isDirectory()) {
        walk(child)
        continue
      }
      if (!stats.isFile()) {
        problems.push(child + " is not a regular file")
        continue
      }
      if (isCredentialName(entry.name)) problems.push(child + " looks like a credential file")
      files.push(child)
    }
  }
  walk(resolved.path)
  return { files: files.sort(), problems }
}

/**
 * Inspect one reference against the Space worktree.
 *
 * Returns the resolved asset and its exact file set when it is a complete,
 * committable new asset; otherwise a reason the caller can act on. It reads
 * only; nothing is staged or written.
 */
export function inspectWorktreeAsset(input: {
  readonly worktree: string
  readonly category: CapabilityKind | null
  readonly shape: CapabilityRefShape
}): AssetInspection {
  let resolved: ResolvedCapabilityRef
  try {
    resolved =
      input.category === null
        ? resolveGenericPathRef(input.worktree, input.shape.ref)
        : resolveCapabilityRef(input.worktree, input.category, input.shape.ref)
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof SpaceServiceError ? error.message : String(error),
      suggestion:
        error instanceof SpaceServiceError && error.suggestion !== undefined
          ? error.suggestion
          : "Create the complete asset inside the Space .wopal worktree first.",
    }
  }

  const collected = collectFiles(input.worktree, resolved)
  const problems = [...collected.problems]
  if (collected.files.length === 0) problems.push(resolved.path + " contains no file")
  const identity = input.category === null ? undefined : identityFiles[input.category]
  if (
    identity !== undefined &&
    resolved.form === "directory" &&
    !collected.files.includes(resolved.path + "/" + identity)
  ) {
    problems.push(resolved.path + " is not a complete " + input.category + " asset: it has no " + identity)
  }
  if (problems.length > 0) {
    return {
      ok: false,
      reason: problems.join("; "),
      suggestion:
        "Keep only the complete asset's regular files under the reference path, remove ignored, credential or linked entries, then retry.",
    }
  }
  return { ok: true, asset: { resolved, files: collected.files } }
}

export interface AssetCandidate {
  readonly reference: string
  readonly path: string
  readonly kind: string
  readonly source: "worktree"
}

function candidateShape(name: string, directory: boolean): CapabilityRefShape {
  if (directory) return parseCapabilityRefShape(name.endsWith("/") ? name : name + "/")
  const last = name.split("/").pop() ?? name
  const dotted = last.lastIndexOf(".")
  const hasExtension = dotted > 0 && dotted < last.length - 1
  return parseCapabilityRefShape(hasExtension ? name : name + ".noext")
}

function hasIgnoredFiles(git: GitRunner, worktree: string, path: string): boolean {
  const result = tryGit(git, worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", path])
  return result.ok && result.stdout.split("\0").some((entry) => entry.length > 0)
}

/**
 * List complete assets that live only in the Space worktree: untracked by the
 * Space branch, absent from the ontology pool, and safe to adopt. Incomplete
 * assets, ignored entries, symbolic links and out-of-category files never
 * become candidates. Read-only.
 */
export function listWorktreeCandidates(input: {
  readonly git: GitRunner
  readonly worktree: string
  readonly ontologyPath: string
}): AssetCandidate[] {
  const listed = tryGit(input.git, input.worktree, ["ls-files", "--others", "--exclude-standard", "-z"])
  if (!listed.ok) return []
  const assets = new Map<string, { readonly category: CapabilityKind; readonly name: string }>()
  for (const file of listed.stdout.split("\0")) {
    if (file.length === 0 || file.startsWith(".wopal-space/")) continue
    const segments = file.split("/")
    const first = segments[0]
    const second = segments[1]
    if (first === undefined || second === undefined) continue
    const category = capabilityKinds.find((kind) => kind === first)
    if (category === undefined) continue
    const path = first + "/" + second
    if (!assets.has(path)) assets.set(path, { category, name: second })
  }

  const candidates: AssetCandidate[] = []
  for (const [path, asset] of assets) {
    if (tryGit(input.git, input.worktree, ["cat-file", "-e", "HEAD:" + path]).ok) continue
    if (statSync(join(input.ontologyPath, path), { throwIfNoEntry: false }) !== undefined) continue
    const stats = statSync(join(input.worktree, path), { throwIfNoEntry: false })
    if (stats === undefined) continue
    let shape: CapabilityRefShape
    try {
      shape = candidateShape(asset.name, stats.isDirectory())
    } catch {
      continue
    }
    const inspection = inspectWorktreeAsset({ worktree: input.worktree, category: asset.category, shape })
    if (!inspection.ok) continue
    if (hasIgnoredFiles(input.git, input.worktree, path)) continue
    const singular = capabilityKindSingular[asset.category]
    candidates.push({
      reference: singular + ":" + inspection.asset.resolved.ref,
      path,
      kind: singular,
      source: "worktree",
    })
  }
  return candidates.sort((a, b) => a.reference.localeCompare(b.reference))
}
