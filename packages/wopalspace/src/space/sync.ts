import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { alwaysAssembledPatterns, readArchetype } from "./assembly"
import { readAssemblyTree, pruneSelections } from "./assembly-tree"
import {
  analyzeWorktree,
  applySelectionTransaction,
  assertNoOperationInProgress,
  commitPendingState,
  computeSparsePatterns,
  detectProtectedRemovals,
  integrateIntoMain,
  isPathInPatterns,
  pluginConfigDrift,
  protectedPatterns,
  syncWorktreeBase,
  validateAssemblyTree,
  type PluginConfigDrift,
} from "./assembly-ops"
import {
  diffNameOnlyExpr,
  diffNoRenamesPaths,
  fileAtRef,
  listCommits,
  lsTreeFiles,
  mergeFfOnly,
  probeMerge,
  resetHardToChecked,
  resetMixedToChecked,
  revListCount,
  revParse,
  statusPorcelain,
  tryGit,
  updateRefChecked,
  type GitRunner,
} from "./git"
import { mountPatternPaths, shadowedPaths } from "./selection"
import { applySparsePatterns, listSparsePatterns } from "./sparse"
import { readAssemblyState, requireWritableState, spaceMetaPath, writeAssemblyStateBytes } from "./snapshot"
import { SpaceServiceError, spaceErrorCodes } from "./types"
import type { RegisteredSpace, SpaceSyncCommit } from "./types"

/**
 * Space sync: publish the Space's unique commits to local main, then align
 * the Space branch and its sparse range.
 *
 * `planSpaceSync` is the single decision function. Its preview performs no
 * repository write at all — the virtual merge runs against a disposable
 * object store — and `applySpaceSync` reruns it immediately before the
 * first mutation, so preview and apply can never disagree.
 */

export interface SpaceSyncConflicts {
  readonly upstream: string[]
  readonly stray: string[]
}

export interface SpaceSyncResult {
  readonly confirm: boolean
  readonly strayFiles: string[]
  readonly contributions: SpaceSyncCommit[]
  readonly mainAhead: number
  readonly mainHead: string
  readonly sparsePatterns: string[]
  readonly shadowedPaths: string[]
  readonly protectedPaths: string[]
  readonly conflicts: SpaceSyncConflicts
  readonly prunedSelections: string[]
  readonly pluginConfigDrift: PluginConfigDrift[]
  readonly uncommittedChanges: string[]
}

export interface SpaceSyncContext {
  readonly wopalHome: string
  readonly git: GitRunner
  readonly space: RegisteredSpace
  readonly ontologyPath: string
}

interface Plan extends SpaceSyncResult {
  /** Candidate tree the downstream will land on, when known. */
  readonly mergeTarget: string | null
  readonly stateRaw: string | null
}

function requireType(spacePath: string): string {
  return requireWritableState(spacePath).state.type
}

function strayConflicts(git: GitRunner, ontologyPath: string, branch: string, stray: readonly string[]): string[] {
  if (stray.length === 0) return []
  const mainFiles = new Set(lsTreeFiles(git, ontologyPath, "main"))
  for (const path of diffNameOnlyExpr(git, ontologyPath, "main..." + branch)) mainFiles.add(path)
  return stray.filter((path) => mainFiles.has(path))
}

/**
 * Compute the sync decision. Zero repository writes: the virtual merge uses
 * a disposable object store that is removed afterwards.
 */
export function planSpaceSync(context: SpaceSyncContext): Plan {
  const { git, space, ontologyPath } = context
  const worktree = join(space.path, ".wopal")
  const type = requireType(space.path)
  assertNoOperationInProgress(git, worktree)

  const analysis = analyzeWorktree(git, worktree)
  const detection = detectProtectedRemovals(git, ontologyPath, space.branch, analysis.deleted)
  const dirty = analysis.changed.filter((path) => !detection.excusedDeletions.has(path))

  const contributions = listCommits(git, ontologyPath, "main", space.branch)
  const mainAhead = revListCount(git, ontologyPath, space.branch, "main")
  const strayFiles = [...analysis.untracked]

  const scratch = mkdtempSync(join(tmpdir(), "wopalspace-sync-probe-"))
  let probe: ReturnType<typeof probeMerge>
  try {
    probe = probeMerge(git, ontologyPath, "main", space.branch, scratch)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  const conflicts: SpaceSyncConflicts = {
    upstream: [...probe.conflicts],
    stray: strayConflicts(git, ontologyPath, space.branch, strayFiles),
  }

  const reading = requireWritableState(space.path)
  const state = reading.state

  const manifest = readArchetype(ontologyPath, type)
  const plannedPatterns = computeSparsePatterns(
    ontologyPath,
    manifest,
    type,
    [...mountPatternPaths(state), ...strayFiles],
    shadowedPaths(state),
  )

  const mergeTarget = probe.resultTree ?? (contributions.length === 0 && mainAhead > 0 ? "main" : null)
  const currentPatterns = listSparsePatterns(git, worktree)
  const addedPatterns = plannedPatterns.filter((pattern) => !currentPatterns.includes(pattern))
  const removedPatterns = currentPatterns.filter((pattern) => !plannedPatterns.includes(pattern))
  const changedPaths = mergeTarget === null ? [] : diffNoRenamesPaths(git, ontologyPath, space.branch, mergeTarget)
  const touched = (path: string) =>
    changedPaths.includes(path) || isPathInPatterns(path, [...addedPatterns, ...removedPatterns])

  const colliding = dirty.filter((path) => touched(path))
  if (colliding.length > 0) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.syncDirty,
      message:
        "Space worktree has uncommitted changes on " +
        colliding.length +
        " tracked file(s) this sync would update or remove: " +
        colliding.join(", "),
      suggestion: "Commit or discard these changes, then re-run sync. No changes were applied.",
    })
  }

  if (probe.resultTree !== undefined) {
    const problems = validateAssemblyTree(git, ontologyPath, probe.resultTree)
    if (problems.length > 0) {
      throw new SpaceServiceError({
        code: spaceErrorCodes.capabilityUnresolved,
        message: "The merged assembly would leave dangling references: " + problems.join("; "),
        suggestion:
          "Keep every declared capability reachable, or update the manifests in the same change. No changes were applied.",
      })
    }
  }

  const postMergeTreeish = mergeTarget ?? (contributions.length === 0 ? space.branch : null)
  let prunedSelections: string[] = []
  let drift: PluginConfigDrift[] = []
  if (postMergeTreeish !== null) {
    const pruned = pruneSelections(readAssemblyTree(ontologyPath, postMergeTreeish, git), type, state, git)
    prunedSelections = pruned.dropped
    try {
      const facts = readAssemblyTree(ontologyPath, postMergeTreeish, git)
      drift = pluginConfigDrift({
        worktree,
        manifest: readArchetype(ontologyPath, type),
        sharedSettings: fileAtRef(git, ontologyPath, postMergeTreeish, "config/settings.jsonc"),
        excludeRefs: pruned.state.exclude,
      })
      void facts
    } catch {
      drift = []
    }
  }

  return {
    confirm: false,
    strayFiles,
    contributions,
    mainAhead,
    mainHead: revParse(git, ontologyPath, "main"),
    sparsePatterns: plannedPatterns,
    shadowedPaths: [...shadowedPaths(state)],
    protectedPaths: [...detection.protectedPaths],
    conflicts,
    prunedSelections,
    pluginConfigDrift: drift,
    uncommittedChanges: [...dirty],
    mergeTarget,
    stateRaw: reading.status === "ok" ? reading.raw : null,
  }
}

/** Preview: the plan with zero repository writes. */
export function previewSpaceSync(context: SpaceSyncContext): SpaceSyncResult {
  const plan = planSpaceSync(context)
  return toResult(plan, plan.mainHead, plan.sparsePatterns)
}

function toResult(plan: Plan, mainHead: string, sparsePatterns: readonly string[]): SpaceSyncResult {
  return {
    confirm: plan.confirm,
    strayFiles: plan.strayFiles,
    contributions: plan.contributions,
    mainAhead: plan.mainAhead,
    mainHead,
    sparsePatterns: [...sparsePatterns],
    shadowedPaths: plan.shadowedPaths,
    protectedPaths: plan.protectedPaths,
    conflicts: plan.conflicts,
    prunedSelections: plan.prunedSelections,
    pluginConfigDrift: plan.pluginConfigDrift,
    uncommittedChanges: plan.uncommittedChanges,
  }
}

/**
 * Apply the sync plan.
 *
 * The plan is recomputed immediately before the first mutation, so stale
 * preview facts cannot drive a write. Any failure restores local main, the
 * space branch, both indexes, the sparse range and the snapshot.
 */
export function applySpaceSync(context: SpaceSyncContext): SpaceSyncResult {
  const { git, space, ontologyPath } = context
  const worktree = join(space.path, ".wopal")
  const plan = planSpaceSync(context)

  if (plan.conflicts.upstream.length > 0) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.syncConflict,
      message: "Integrating " + space.branch + " into local main would conflict: " + plan.conflicts.upstream.join(", "),
      suggestion: "Resolve the conflict in the ontology repo, then re-run sync. No changes were applied.",
    })
  }
  if (plan.conflicts.stray.length > 0) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.syncConflict,
      message: "Stray file(s) collide with local main content at the same path: " + plan.conflicts.stray.join(", "),
      suggestion: "Move or rename the stray files, then re-run sync. No changes were applied.",
    })
  }

  const worktreeBranch = tryGit(git, worktree, ["rev-parse", "--abbrev-ref", "HEAD"])
  if (!worktreeBranch.ok || worktreeBranch.stdout !== space.branch) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.syncFailed,
      message: "Space worktree is on '" + worktreeBranch.stdout + "', not '" + space.branch + "'",
      suggestion: "Re-run space.init to repair the worktree, then retry.",
    })
  }
  if (statusPorcelain(git, ontologyPath).length > 0) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.syncFailed,
      message: "The ontology repository has uncommitted changes: " + ontologyPath,
      suggestion: "Commit or discard them in the ontology repo, then re-run sync.",
    })
  }

  const preMain = revParse(git, ontologyPath, "main")
  const preSpace = revParse(git, ontologyPath, space.branch)
  const preRange = listSparsePatterns(git, worktree)
  const preStateRaw = plan.stateRaw
  const type = requireType(space.path)

  try {
    if (plan.contributions.length > 0) {
      integrateIntoMain(git, {
        ontologyPath,
        spaceBranch: space.branch,
        worktreeBase: syncWorktreeBase(context.wopalHome),
        label: space.name.replace(/[^a-zA-Z0-9_-]/g, "-"),
        preservePaths: [...plan.shadowedPaths, ...plan.protectedPaths],
        validate: (head) => {
          const problems = validateAssemblyTree(git, ontologyPath, head)
          if (problems.length > 0) {
            throw new SpaceServiceError({
              code: spaceErrorCodes.capabilityUnresolved,
              message: "The integrated assembly would leave dangling references: " + problems.join("; "),
              suggestion: "Keep every declared capability reachable, or update the manifests in the same change.",
            })
          }
        },
      })
    }

    if (plan.contributions.length > 0 || plan.mainAhead > 0) {
      mergeFfOnly(git, worktree, "main")
    }

    const reading = readAssemblyState(space.path)
    if (reading.status !== "ok") {
      throw new SpaceServiceError({
        code: spaceErrorCodes.metaInvalid,
        message: "Space assembly state became unreadable during sync: " + space.path,
      })
    }
    const pruned = pruneSelections(readAssemblyTree(ontologyPath, "HEAD", git), type, reading.state, git)
    const manifest = readArchetype(ontologyPath, type)
    const nextPatterns = computeSparsePatterns(
      ontologyPath,
      manifest,
      type,
      [...mountPatternPaths(pruned.state), ...plan.strayFiles],
      shadowedPaths(pruned.state),
    )
    void alwaysAssembledPatterns

    if (pruned.dropped.length > 0) {
      applySelectionTransaction(git, {
        ontologyPath,
        worktree,
        spacePath: space.path,
        type,
        nextState: pruned.state,
        expectedRaw: preStateRaw,
        coveragePaths: plan.strayFiles,
        failureCode: spaceErrorCodes.syncFailed,
      })
      commitPendingState(git, space.path, requireRaw(space.path))
    } else if (nextPatterns.length > 0) {
      applySparsePatterns(git, worktree, nextPatterns)
    }

    return {
      confirm: true,
      strayFiles: plan.strayFiles,
      contributions: plan.contributions,
      mainAhead: plan.mainAhead,
      mainHead: revParse(git, ontologyPath, "main"),
      sparsePatterns: listSparsePatterns(git, worktree),
      shadowedPaths: shadowedPaths(pruned.state),
      protectedPaths: plan.protectedPaths,
      conflicts: plan.conflicts,
      prunedSelections: pruned.dropped,
      pluginConfigDrift: plan.pluginConfigDrift,
      uncommittedChanges: plan.uncommittedChanges,
    }
  } catch (error) {
    const recovery = rollback(git, {
      ontologyPath,
      worktree,
      spaceBranch: space.branch,
      preMain,
      preSpace,
      preRange,
      preStateRaw,
    })
    throw syncFailure(error, recovery)
  }
}

/**
 * Map one sync failure plus its recovery outcome to the public error.
 *
 * Kept separate so the design-visible contract — the caller must learn that
 * recovery was incomplete, with the failed legs named — is directly testable.
 */
export function syncFailure(error: unknown, recovery: readonly string[]): SpaceServiceError {
  // A caller told that no changes were applied must not be left with a sparse
  // range, ref or snapshot that recovery could not restore.
  const incomplete = recovery.length === 0 ? "" : " Rollback was incomplete (" + recovery.join("; ") + ")."
  if (error instanceof SpaceServiceError) {
    return new SpaceServiceError({
      code: error.code,
      message: error.message + incomplete,
      suggestion:
        recovery.length === 0
          ? error.suggestion
          : "Recovery failed; inspect the Space refs, snapshot and sparse range before re-running sync.",
    })
  }
  return new SpaceServiceError({
    code: spaceErrorCodes.syncFailed,
    message:
      "Space sync failed while aligning the space branch: " +
      (error instanceof Error ? error.message : String(error)) +
      incomplete,
    suggestion:
      recovery.length === 0
        ? "No changes were applied. Inspect the error above, then re-run sync."
        : "Recovery failed; inspect the Space refs, snapshot and sparse range before re-running sync.",
  })
}

function requireRaw(spacePath: string): string | null {
  const reading = readAssemblyState(spacePath)
  return reading.status === "ok" ? reading.raw : null
}

/** Restore every side of a failed sync to its pre-sync state. */
export function rollback(
  git: GitRunner,
  input: {
    readonly ontologyPath: string
    readonly worktree: string
    readonly spaceBranch: string
    readonly preMain: string
    readonly preSpace: string
    readonly preRange: readonly string[]
    readonly preStateRaw: string | null
  },
): string[] {
  const failures: string[] = []
  const attempt = (label: string, run: () => void) => {
    try {
      run()
    } catch (error) {
      failures.push(label + ": " + (error instanceof Error ? error.message : String(error)))
    }
  }
  // Checked variants: the forgiving helpers return normally on Git failure, which
  // would make a half-restored ref look like a successful recovery.
  attempt("ontology main ref", () => updateRefChecked(git, input.ontologyPath, "main", input.preMain))
  attempt("space branch ref", () => updateRefChecked(git, input.ontologyPath, input.spaceBranch, input.preSpace))
  attempt("ontology reset", () => resetHardToChecked(git, input.ontologyPath, input.preMain))
  attempt("worktree reset", () => resetMixedToChecked(git, input.worktree, input.preSpace))
  if (input.preRange.length > 0) {
    attempt("sparse range", () => applySparsePatterns(git, input.worktree, [...input.preRange]))
  }
  attempt("assembly snapshot", () => writeAssemblyStateBytes(join(input.worktree, ".."), input.preStateRaw))
  void spaceMetaPath
  void protectedPatterns
  return failures
}
