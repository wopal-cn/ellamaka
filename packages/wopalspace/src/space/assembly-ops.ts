import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  alwaysAssembledPatterns,
  materializationPatterns,
  parseArchetypeDocument,
  readArchetype,
  type ArchetypeManifest,
} from "./assembly"
import { computeEffectivePatterns, materializationPatternsFromTree, readAssemblyTree } from "./assembly-tree"
import { capabilityKindFromSingular } from "./capability-kinds"
import {
  checkoutFileFrom,
  conflictFiles,
  diffNameStatus,
  diffWorktreeNameOnly,
  diffCachedNameOnly,
  fileAtRef,
  fileExistsAtRef,
  listCommits,
  lsTreeFiles,
  mergeAbort,
  mergeBase,
  mergeNoEdit,
  operationInProgress,
  revParse,
  statusPorcelain,
  tryGit,
  untrackedFiles,
  type GitRunner,
} from "./git"
import { declaredPluginNamesFromSettings, spacePluginSpecs } from "./local-config"
import { parseJsonc } from "./structured-text"
import { mountPatternPaths, shadowedPaths } from "./selection"
import { canonicalCapabilityRef, repositoryPathForCapabilityRef } from "./selection"
import { applySparsePatterns, listSparsePatterns } from "./sparse"
import {
  commitAssemblyState,
  readAssemblyState,
  spaceMetaPath,
  transactAssemblyState,
  writeAssemblyStateBytes,
} from "./snapshot"
import { SpaceServiceError, spaceErrorCodes } from "./types"
import type { SpaceAssemblyState } from "./types"

/**
 * Space assembly operations shared by sync and capability mutation.
 *
 * Everything here is the older owner's single definition of the range,
 * worktree classification, protected removals and selection transaction —
 * ported so there is exactly one implementation of each rule.
 */

/** The paths a Space must never lose to a local deletion or rename. */
export const protectedPaths: readonly { readonly path: string; readonly directory: boolean }[] = [
  { path: "assembly/archetypes", directory: true },
  { path: "assembly/schemas", directory: true },
  { path: "assembly/templates", directory: true },
  { path: ".gitignore", directory: false },
  { path: "AGENTS.md", directory: false },
  { path: "AGENTS.zh-CN.md", directory: false },
]

/** The protected set as non-cone sparse patterns. */
export function protectedPatterns(): string[] {
  return protectedPaths.map((entry) => (entry.directory ? "/" + entry.path + "/" : "/" + entry.path))
}

/** Does a non-cone pattern cover this repository-relative path? */
export function patternCovers(pattern: string, path: string): boolean {
  const body = pattern.startsWith("/") ? pattern.slice(1) : pattern
  const directory = body.endsWith("/")
  const bare = directory ? body.slice(0, -1) : body
  if (path === bare) return true
  return directory ? path.startsWith(bare + "/") : false
}

export function isPathInPatterns(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => patternCovers(pattern, path))
}

/** Does one selection entry cover a repository-relative path? */
export function selectionEntryCoversPath(entryPath: string, candidatePath: string): boolean {
  const base = entryPath.replace(/^\//, "").replace(/\/$/, "")
  const candidate = candidatePath.replace(/^\//, "").replace(/\/$/, "")
  return candidate === base || candidate.startsWith(base + "/")
}

export interface WorktreeAnalysis {
  readonly changed: string[]
  readonly deleted: string[]
  readonly untracked: string[]
}

/**
 * Classify a Space worktree: tracked changes (staged plus unstaged) with
 * their deletions separately, and untracked non-ignored strays.
 */
export function analyzeWorktree(git: GitRunner, worktree: string): WorktreeAnalysis {
  const porcelain = statusPorcelain(git, worktree)
  const changed: string[] = []
  const deleted: string[] = []
  if (porcelain.some((line) => !line.startsWith("??"))) {
    changed.push(...new Set([...diffWorktreeNameOnly(git, worktree), ...diffCachedNameOnly(git, worktree)]))
    for (const entry of [...diffNameStatus(git, worktree, "HEAD", ""), ...stagedDeletions(git, worktree)]) {
      if (entry.status === "D") deleted.push(entry.path)
    }
  }
  return { changed, deleted: [...new Set(deleted)], untracked: untrackedFiles(git, worktree) }
}

function stagedDeletions(git: GitRunner, worktree: string): { status: string; path: string }[] {
  const result = tryGit(git, worktree, ["diff", "--cached", "--name-status", "--no-renames"])
  if (!result.ok) return []
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("D\t"))
    .map((line) => ({ status: "D", path: line.slice(2) }))
}

export interface ProtectedRemoval {
  readonly protectedPaths: string[]
  readonly excusedDeletions: ReadonlySet<string>
}

/**
 * Protected definition paths removed in the Space (D-04). Their deletion is
 * never carried upstream and never recorded as a shadow.
 */
export function detectProtectedRemovals(
  git: GitRunner,
  ontologyPath: string,
  spaceBranch: string,
  deletedInWorktree: readonly string[],
): ProtectedRemoval {
  const patterns = protectedPatterns()
  const branchFiles = new Set(lsTreeFiles(git, ontologyPath, spaceBranch))
  const base = mergeBase(git, ontologyPath, "main", spaceBranch)
  const baseFiles = base === undefined ? [] : lsTreeFiles(git, ontologyPath, base)
  const protectedRemoved = [
    ...new Set([
      ...deletedInWorktree.filter((path) => isPathInPatterns(path, patterns)),
      ...baseFiles.filter((path) => isPathInPatterns(path, patterns) && !branchFiles.has(path)),
    ]),
  ].sort()
  const excused = new Set(deletedInWorktree.filter((path) => isPathInPatterns(path, patterns)))
  return { protectedPaths: protectedRemoved, excusedDeletions: excused }
}

/** Sparse range from the ontology working tree manifest. */
export function computeSparsePatterns(
  ontologyPath: string,
  manifest: ArchetypeManifest,
  type: string,
  addedPaths: readonly string[],
  shadowed: readonly string[],
): string[] {
  void type
  return computeEffectivePatterns(
    materializationPatterns(ontologyPath, manifest),
    alwaysAssembledPatterns(manifest),
    addedPaths,
    shadowed,
  )
}

/** Sparse range from a committed assembly tree. */
export function computeSparsePatternsFromTree(
  git: GitRunner,
  ontologyPath: string,
  type: string,
  addedPaths: readonly string[],
  shadowed: readonly string[],
): string[] {
  const facts = readAssemblyTree(ontologyPath, "main", git)
  const manifest = readArchetype(ontologyPath, type)
  const fromTree = materializationPatternsFromTree(facts, manifest, alwaysAssembledPatterns(manifest))
  if (fromTree.problems.length > 0) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.capabilityUnresolved,
      message: "Assembly tree is not usable: " + fromTree.problems.join("; "),
    })
  }
  return computeEffectivePatterns(fromTree.patterns, alwaysAssembledPatterns(manifest), addedPaths, shadowed)
}

/** The canonical selection reference for a repository-relative path. */
export function selectionRefForPath(worktree: string, path: string): string {
  const stats = statSync(join(worktree, path), { throwIfNoEntry: false })
  const isDirectory = stats?.isDirectory() ?? true
  const segments = path.split("/")
  const plural = segments[0] ?? ""
  const category = Object.hasOwn(capabilityKindFromSingular, plural.slice(0, -1)) ? plural.slice(0, -1) : undefined
  if (category !== undefined && segments.length > 1) {
    return canonicalCapabilityRef(category + ":" + segments.slice(1).join("/") + (isDirectory ? "" : ""))
  }
  return canonicalCapabilityRef("path:" + path)
}

/** Is the path carried by the branch tree (shared) rather than disk-only? */
export function trackedInWorktree(git: GitRunner, worktree: string, path: string): boolean {
  return fileExistsAtRef(git, worktree, "HEAD", path)
}

/** Drop include/private selections equal to or nested under a path. */
export function dropSelectionsUnder(state: SpaceAssemblyState, path: string): SpaceAssemblyState {
  const covers = (ref: string) => {
    const refPath = repositoryPathForCapabilityRef(ref)
    return refPath === path || refPath.startsWith(path + "/")
  }
  return {
    ...state,
    include: state.include.filter((ref) => !covers(ref)),
    private: state.private.filter((ref) => !covers(ref)),
  }
}

export interface SelectionTransactionInput {
  readonly ontologyPath: string
  readonly worktree: string
  readonly spacePath: string
  readonly type: string
  readonly nextState: SpaceAssemblyState
  readonly expectedRaw: string | null
  readonly coveragePaths?: readonly string[]
  readonly failureCode?: string
}

/**
 * Persist a selection change and the range together.
 *
 * The snapshot write and the range apply form one unit: a failed range
 * apply restores the previous bytes and the previous range, so the durable
 * state never claims a selection the disk does not honour.
 */
export function applySelectionTransaction(
  git: GitRunner,
  input: SelectionTransactionInput,
): { changed: boolean; committed: boolean; commit?: string } {
  const manifest = readArchetype(input.ontologyPath, input.type)
  const patterns = computeSparsePatterns(
    input.ontologyPath,
    manifest,
    input.type,
    [...mountPatternPaths(input.nextState), ...(input.coveragePaths ?? [])],
    shadowedPaths(input.nextState),
  )
  const reading = readAssemblyState(input.spacePath)
  const metaBefore = reading.status === "ok" ? reading.raw : null
  const rangeBefore = listSparsePatterns(git, input.worktree)

  try {
    const transaction = transactAssemblyState(
      { spacePath: input.spacePath, expectedRaw: input.expectedRaw, state: input.nextState },
      git,
    )
    applySparsePatterns(git, input.worktree, patterns)
    return {
      changed: transaction.changed,
      committed: transaction.committed,
      ...(transaction.commit ? { commit: transaction.commit } : {}),
    }
  } catch (error) {
    writeAssemblyStateBytes(input.spacePath, metaBefore)
    try {
      if (rangeBefore.length > 0) applySparsePatterns(git, input.worktree, rangeBefore)
    } catch {
      // The original failure is the primary signal.
    }
    if (error instanceof SpaceServiceError) throw error
    throw new SpaceServiceError({
      code: input.failureCode ?? spaceErrorCodes.metaCommitFailed,
      message: "Failed to register the selections: " + (error instanceof Error ? error.message : String(error)),
      suggestion: "Check that the Space snapshot is writable, then retry.",
    })
  }
}

/** Commit the snapshot file when its bytes differ from HEAD. */
export function commitPendingState(
  git: GitRunner,
  spacePath: string,
  expectedRaw: string | null,
): { committed: boolean; commit: string } {
  const reading = readAssemblyState(spacePath)
  const current = reading.status === "ok" ? reading.raw : null
  if (current === null) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.metaMissing,
      message: "Space assembly state is missing: " + spaceMetaPath(spacePath),
      suggestion: "Run space.init to rebuild the Space.",
    })
  }
  if (current !== expectedRaw) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.metaConcurrentModification,
      message: "Space assembly state changed on disk while the operation was running: " + spacePath,
      suggestion: "Re-run the operation; the concurrent content was left untouched.",
    })
  }
  const result = commitAssemblyState(spacePath, git)
  return { committed: result.committed, commit: result.commit ?? "" }
}

export interface MergeProbe {
  readonly ok: boolean
  readonly conflicts: readonly string[]
  readonly resultTree?: string
}

export interface UpstreamIntegration {
  readonly head: string
}

/**
 * Integrate the Space's unique commits into local main through an isolated
 * detached worktree. Nothing moves until the merged tree is validated and
 * local main is fast-forwarded as the last step.
 */
export function integrateIntoMain(
  git: GitRunner,
  input: {
    readonly ontologyPath: string
    readonly spaceBranch: string
    readonly worktreeBase: string
    readonly label: string
    readonly preservePaths: readonly string[]
    readonly validate: (head: string) => void
  },
): UpstreamIntegration {
  const path = join(input.worktreeBase, "sync-" + input.label + "-" + Date.now())
  mkdirSync(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true })
  try {
    const added = tryGit(git, input.ontologyPath, ["worktree", "add", "--detach", path, "main"])
    if (!added.ok) throw new Error(added.stderr)
    if (!mergeNoEdit(git, path, input.spaceBranch)) {
      const conflicts = conflictFiles(git, path)
      mergeAbort(git, path)
      throw new SpaceServiceError({
        code: spaceErrorCodes.syncConflict,
        message:
          "Integrating " +
          input.spaceBranch +
          " into local main conflicted" +
          (conflicts.length > 0 ? ": " + conflicts.join(", ") : " (no conflict files listed)"),
        suggestion: "Resolve the conflict in the ontology repo, then re-run sync. No changes were applied.",
      })
    }

    for (const preserve of input.preservePaths) {
      if (existsSync(join(path, preserve))) continue
      checkoutFileFrom(git, path, "main", preserve)
    }
    const staged = tryGit(git, path, ["diff", "--cached", "--name-only"])
    if (staged.ok && staged.stdout.length > 0) {
      tryGit(git, path, ["commit", "-q", "-m", "chore(space): preserve shadowed capability paths"])
    }

    const head = revParse(git, path, "HEAD")
    input.validate(head)
    tryGit(git, input.ontologyPath, ["merge", "--ff-only", head])
    return { head }
  } finally {
    tryGit(git, input.ontologyPath, ["worktree", "remove", "--force", path])
    tryGit(git, input.ontologyPath, ["worktree", "prune"])
  }
}

/** The worktree base for sync integrations. */
export function syncWorktreeBase(wopalHome: string): string {
  return join(wopalHome, ".worktrees")
}

/** Is the Space worktree free of an unfinished Git operation? */
export function assertNoOperationInProgress(git: GitRunner, worktree: string): void {
  const operation = operationInProgress(git, worktree)
  if (operation === undefined) return
  throw new SpaceServiceError({
    code: spaceErrorCodes.syncOperationInProgress,
    message: "Space worktree has an uncompleted " + operation,
    suggestion: "Resolve it (commit, or abort), then re-run the operation.",
  })
}

export interface PluginConfigDrift {
  readonly section: string
  readonly added: string[]
  readonly removed: string[]
}

/**
 * Read-only plugin config drift: the managed references a rerun of init
 * would add or remove. The shared settings and the local file are only read.
 */
export function pluginConfigDrift(input: {
  readonly worktree: string
  readonly manifest: ArchetypeManifest
  readonly sharedSettings: string | null
  readonly excludeRefs: readonly string[]
}): PluginConfigDrift[] {
  const declaredFor = declaredPluginNamesFromSettings(input.sharedSettings)
  const desired = spacePluginSpecs(declaredFor, input.manifest)
  const excluded = new Set<string>()
  for (const ref of input.excludeRefs) {
    const colon = ref.indexOf(":")
    if (colon <= 0 || ref.slice(0, colon) !== "plugin") continue
    const target = ref.slice(colon + 1).replace(/\/$/, "")
    const name = target.split("/").pop()
    if (name !== undefined) excluded.add(name)
  }
  const existing = parseLocalSections(readText(join(input.worktree, "config", "settings.local.jsonc")))
  const drift: PluginConfigDrift[] = []
  for (const section of new Set([...Object.keys(desired), ...Object.keys(existing)])) {
    const want = (desired[section] ?? []).filter((spec) => {
      const name = spec.split("/").pop()
      return name === undefined || !excluded.has(name)
    })
    const have = existing[section] ?? []
    const added = want.filter((spec) => !have.includes(spec))
    const removed = have.filter((spec) => spec.startsWith("../plugins/") && !want.includes(spec))
    if (added.length > 0 || removed.length > 0) drift.push({ section, added, removed })
  }
  return drift.sort((a, b) => a.section.localeCompare(b.section))
}

function parseLocalSections(text: string | null): Record<string, string[]> {
  if (text === null) return {}
  let parsed: unknown
  try {
    parsed = parseJsonc(text)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const sections: Record<string, string[]> = {}
  for (const [section, value] of Object.entries(parsed)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue
    const plugins: unknown = Reflect.get(value, "plugin")
    if (!Array.isArray(plugins)) continue
    sections[section] = plugins.filter((spec): spec is string => typeof spec === "string")
  }
  return sections
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

void listCommits

/**
 * Validate every archetype manifest a candidate tree carries: each declared
 * reference must resolve inside that same tree. A whole-asset deletion or
 * rename that leaves a manifest dangling is refused before anything moves.
 */
export function validateAssemblyTree(git: GitRunner, ontologyPath: string, treeish: string): string[] {
  const facts = readAssemblyTree(ontologyPath, treeish, git)
  const problems: string[] = []
  for (const file of facts.files) {
    if (!file.startsWith("assembly/archetypes/") || !file.endsWith(".yaml")) continue
    if (file.slice("assembly/archetypes/".length).includes("/")) continue
    const raw = fileAtRef(git, ontologyPath, treeish, file)
    if (raw === null) continue
    const outcome = parseArchetypeDocument(raw)
    if (!outcome.ok) {
      problems.push(file + ": " + (outcome.reason ?? "invalid manifest"))
      continue
    }
    const resolved = materializationPatternsFromTree(facts, outcome.manifest, alwaysAssembledPatterns(outcome.manifest))
    for (const problem of resolved.problems) problems.push(file + ": " + problem)
  }
  return problems
}
