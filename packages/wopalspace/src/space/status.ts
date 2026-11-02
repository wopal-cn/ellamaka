import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { checkSparseConsistency, listSparsePatterns } from "./sparse"
import {
  fileAtRef,
  lastCommitForPath,
  listCommits,
  mergePrediction,
  remoteBranchNames,
  statusPorcelain,
  tryGit,
  type GitRunner,
} from "./git"
import { repositoryPathForCapabilityRef } from "./selection"
import { readAssemblyState, spaceMetaPath } from "./snapshot"
import { SpaceServiceError, spaceErrorCodes } from "./types"
import type { RegisteredSpace, SpacePreparationFacts, SpaceSparseViolation, SpaceStatusResult } from "./types"

/** How many index violations the status view samples. */
const violationSample = 5

const runtimeStatePrefix = ".wopal-space/"
const rootStatePath = ".wopal-space/space-meta.json"

export interface SpaceStatusInput {
  readonly space: RegisteredSpace
  /** Absolute ontology host repository (checked out on main). */
  readonly ontologyPath: string
  readonly ontologyMode: "fork" | "clone" | "unknown"
  /** Injected instance-preparation facts; the Runtime owns the decision. */
  readonly preparation?: SpacePreparationFacts
}

function tracked(git: GitRunner, repo: string, path: string): boolean {
  return tryGit(git, repo, ["ls-files", "--error-unmatch", "--", path]).ok
}

function rootState(spacePath: string, git: GitRunner): SpaceStatusResult["rootState"] {
  if (!tryGit(git, spacePath, ["rev-parse", "--absolute-git-dir"]).ok) return undefined
  const isTracked = tracked(git, spacePath, rootStatePath)
  let current: string | null = null
  try {
    current = readFileText(spaceMetaPath(spacePath))
  } catch {
    current = null
  }
  // The Git runner trims trailing whitespace; normalize the file the same way.
  const committed = fileAtRef(git, spacePath, "HEAD", rootStatePath)
  const currentNormalized = current === null ? null : current.replace(/\n+$/, "")
  const lastCommit = lastCommitForPath(git, spacePath, rootStatePath)
  return {
    tracked: isTracked,
    pendingChanges: currentNormalized !== null && currentNormalized !== committed,
    ...(lastCommit !== undefined ? { lastCommit } : {}),
  }
}

function readFileText(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

function unregisteredFiles(worktree: string, registeredRoots: readonly string[], git: GitRunner): string[] {
  const result = tryGit(git, worktree, ["ls-files", "--others", "--exclude-standard", "-z"])
  if (!result.ok) return []
  return result.stdout
    .split("\0")
    .filter((path) => path.length > 0)
    .filter((path) => !path.startsWith(runtimeStatePrefix))
    .filter((path) => !registeredRoots.some((root) => path === root || path.startsWith(root + "/")))
    .sort()
}

function remoteDelta(
  git: GitRunner,
  ontologyPath: string,
  branch: string,
): { ahead: number; behind: number } | undefined {
  if (!remoteBranchNames(git, ontologyPath, "origin").has(branch)) return undefined
  const result = tryGit(git, ontologyPath, ["rev-list", "--left-right", "--count", branch + "...origin/" + branch])
  if (!result.ok) return undefined
  const [left, right] = result.stdout.split(/\s+/).map((value) => Number.parseInt(value, 10) || 0)
  return { ahead: left ?? 0, behind: right ?? 0 }
}

/**
 * Read-only Space status.
 *
 * Reports the branch-to-main relationship, the tracked assembly identity,
 * sparse health, selections, unregistered content, the root repository's
 * state-commit situation, and injected preparation facts. It never mutates a
 * ref, index, working tree or registry, and never creates a Runtime.
 */
export function readSpaceStatus(input: SpaceStatusInput, git: GitRunner): SpaceStatusResult {
  const { space, ontologyPath, ontologyMode } = input
  const reading = readAssemblyState(space.path)
  if (reading.status !== "ok") {
    throw new SpaceServiceError({
      code: reading.status === "missing" ? spaceErrorCodes.metaMissing : spaceErrorCodes.metaInvalid,
      message:
        reading.status === "missing"
          ? "This space has no assembly state at " + reading.path
          : "This space's assembly state is invalid at " + reading.path + ": " + reading.reason,
      suggestion:
        "Restore the tracked snapshot from the space root repository or a backup; a corrupt snapshot is never migrated or rebuilt automatically.",
    })
  }
  const state = reading.state
  const worktree = join(space.path, ".wopal")

  const contributions = listCommits(git, ontologyPath, "main", space.branch)
  const merge = mergePrediction(git, ontologyPath, "main", space.branch)
  const behindCommits = listCommits(git, ontologyPath, space.branch, "main")

  let sparseConsistent: boolean | null = null
  let sparseViolations: SpaceSparseViolation[] = []
  try {
    const consistency = checkSparseConsistency(git, worktree, listSparsePatterns(git, worktree))
    sparseConsistent = consistency.consistent
    sparseViolations = consistency.violations.slice(0, violationSample)
  } catch {
    sparseConsistent = null
  }

  const registeredRoots = [...state.include, ...state.private].map((ref) => repositoryPathForCapabilityRef(ref))
  const porcelain = statusPorcelain(git, worktree)
  const dirtyCount = porcelain.filter((line) => !line.startsWith("??")).length

  const root = rootState(space.path, git)
  const remote = ontologyMode === "fork" ? remoteDelta(git, ontologyPath, space.branch) : undefined

  return {
    space: { name: space.name, path: space.path, branch: space.branch, type: state.type },
    sync: {
      contributions,
      behindCount: behindCommits.length,
      behindCommits,
      mergePrediction: merge.prediction,
      conflictFiles: merge.conflictFiles,
    },
    assembly: { schema: state.schema, ontology: state.source.ontology, sparseConsistent, sparseViolations },
    selection: { include: [...state.include], exclude: [...state.exclude], private: [...state.private] },
    unregistered: unregisteredFiles(worktree, registeredRoots, git),
    ...(root !== undefined ? { rootState: root } : {}),
    ...(remote !== undefined ? { remote } : {}),
    dirtyCount,
    preparation: input.preparation ?? { status: "unknown" },
  }
}
