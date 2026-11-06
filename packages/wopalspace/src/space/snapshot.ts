import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import { repositoryPathForCapabilityRef, serializeAssemblyState, validateAssemblyState } from "./selection"
import { tryGit, type GitRunner } from "./git"
import { SpaceServiceError, spaceErrorCodes, type SpaceAssemblyState } from "./types"

/** Snapshot filename inside the Space's runtime directory. */
export const spaceMetaFilename = "space-meta.json"
export const spaceMetaVersion = 3
export const spaceMetaCommitMessage = "chore(space): update space assembly state"

const stateRepoPath = ".wopal-space/space-meta.json"

/** Absolute path of a Space's assembly snapshot. */
export function spaceMetaPath(spacePath: string): string {
  return join(spacePath, ".wopal-space", spaceMetaFilename)
}

export type SpaceMetaReading =
  | {
      readonly status: "ok"
      readonly state: SpaceAssemblyState
      readonly raw: string
      /** Retired version 2 `private` selections still on disk; non-empty blocks writes. */
      readonly legacyPrivate: readonly string[]
    }
  | { readonly status: "missing"; readonly path: string }
  | { readonly status: "invalid"; readonly path: string; readonly reason: string }

export type WritableSpaceMetaReading = Extract<SpaceMetaReading, { readonly status: "ok" }>

/** Read and classify the snapshot: ok, missing, or invalid with a reason. */
export function readAssemblyState(spacePath: string): SpaceMetaReading {
  const path = spaceMetaPath(spacePath)
  if (!existsSync(path)) return { status: "missing", path }
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    return {
      status: "invalid",
      path,
      reason: "not readable: " + (error instanceof Error ? error.message : String(error)),
    }
  }
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return { status: "invalid", path, reason: "not valid JSON" }
  }
  const result = validateAssemblyState(doc)
  if (!result.ok) return { status: "invalid", path, reason: result.reason }
  return { status: "ok", state: result.state, raw, legacyPrivate: result.legacyPrivate }
}

/** The snapshot's assembly type, or null when no readable snapshot exists. */
export function readAssemblyType(spacePath: string): string | null {
  const reading = readAssemblyState(spacePath)
  return reading.status === "ok" ? reading.state.type : null
}

/**
 * The optimistic-concurrency / legacy-protection failure for a snapshot a
 * state-changing operation must not write over.
 *
 * A version 2 snapshot that still registers private content is not corrupt:
 * the space simply requires an explicit, human-reviewed migration. The error
 * names the retained selections and their repository paths so the caller can
 * act, and nothing has been written when it is raised.
 */
export function legacyPrivateFailure(spacePath: string, reading: WritableSpaceMetaReading): SpaceServiceError | null {
  if (reading.legacyPrivate.length === 0) return null
  const paths = reading.legacyPrivate.map((ref) => repositoryPathForCapabilityRef(ref))
  return new SpaceServiceError({
    code: spaceErrorCodes.metaLegacyPrivate,
    message:
      "This Space still holds " +
      reading.legacyPrivate.length +
      " retired private selection(s) at " +
      spaceMetaPath(spacePath) +
      ": " +
      reading.legacyPrivate.join(", ") +
      ". Affected repository paths: " +
      paths.join(", ") +
      ". The private selection set is no longer a persistent capability state, so this operation refuses to overwrite it.",
    suggestion:
      "Back up the snapshot and the affected files, review the Space branch commits that touch them, then decide explicitly whether that content stays outside the shared branch or may be published. Only after the content and its commits are handled, clear the retired private entries by hand (or restore a version 3 snapshot) and retry. No refs, sparse range or files were changed.",
  })
}

/** Read a snapshot that a state-changing operation may write over. */
export function requireWritableState(spacePath: string): WritableSpaceMetaReading {
  const reading = readAssemblyState(spacePath)
  if (reading.status === "missing") {
    throw new SpaceServiceError({
      code: spaceErrorCodes.metaMissing,
      message: "This space has no assembly state at " + reading.path,
      suggestion: "Re-run space.init to rebuild the Space assembly state.",
    })
  }
  if (reading.status === "invalid") {
    throw new SpaceServiceError({
      code: spaceErrorCodes.metaInvalid,
      message: "This space's assembly state is invalid at " + reading.path + ": " + reading.reason,
      suggestion:
        "Repair or restore the corrupt snapshot; a corrupt snapshot is never migrated or rebuilt automatically.",
    })
  }
  const legacy = legacyPrivateFailure(spacePath, reading)
  if (legacy !== null) throw legacy
  return reading
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = path + "." + randomBytes(8).toString("hex") + ".tmp"
  try {
    writeFileSync(temporary, content, "utf8")
    renameSync(temporary, path)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The original failure is the one that matters.
    }
    throw error
  }
}

function concurrentModification(path: string): SpaceServiceError {
  return new SpaceServiceError({
    code: spaceErrorCodes.metaConcurrentModification,
    message: "Space assembly state changed on disk while the operation was running: " + path,
    suggestion: "Re-run the operation; the state file was not written and the concurrent content was left untouched.",
  })
}

/**
 * Preflight the Space root repository for a state commit: a real repository,
 * a checked-out branch, and no unfinished Git operation.
 */
export function assertRootRepoCommitReady(spacePath: string, git: GitRunner): void {
  const gitDir = tryGit(git, spacePath, ["rev-parse", "--absolute-git-dir"])
  if (!gitDir.ok) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.metaGitStateInvalid,
      message: "The space root is not a Git repository: " + spacePath,
      suggestion: "Re-run space.init to initialize the space root repository, then retry.",
    })
  }
  const branch = tryGit(git, spacePath, ["symbolic-ref", "-q", "HEAD"])
  if (!branch.ok || branch.stdout.length === 0) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.metaGitStateInvalid,
      message: "The space root repo has no checked-out branch (detached HEAD): " + spacePath,
      suggestion: "Check out the repository branch, then retry.",
    })
  }
  const root = gitDir.stdout
  const markers: readonly [string, string][] = [
    ["MERGE_HEAD", "a merge"],
    ["CHERRY_PICK_HEAD", "a cherry-pick"],
    ["REVERT_HEAD", "a revert"],
    ["rebase-merge", "a rebase"],
    ["rebase-apply", "a rebase"],
    ["sequencer", "a sequencer operation"],
  ]
  for (const [marker, activity] of markers) {
    if (existsSync(join(root, marker))) {
      throw new SpaceServiceError({
        code: spaceErrorCodes.metaGitStateInvalid,
        message: "The space root repo has an unfinished Git operation (" + activity + " in progress): " + spacePath,
        suggestion: "Finish or abort the Git operation in the space root repo, then retry.",
      })
    }
  }
}

/** Commit only the snapshot file; a no-op when it is already clean. */
export function commitAssemblyState(
  spacePath: string,
  git: GitRunner,
  options: { readonly message?: string } = {},
): { committed: boolean; commit?: string } {
  const path = spaceMetaPath(spacePath)
  if (!existsSync(path)) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.metaMissing,
      message: "Space assembly state is missing: " + path,
      suggestion: "Write the state file before committing it.",
    })
  }
  assertRootRepoCommitReady(spacePath, git)

  const tracked = tryGit(git, spacePath, ["ls-files", "--error-unmatch", "--", stateRepoPath]).ok
  if (tracked) {
    const status = tryGit(git, spacePath, ["status", "--porcelain", "--", stateRepoPath])
    if (status.ok && status.stdout.length === 0) return { committed: false }
  } else {
    const intent = tryGit(git, spacePath, ["add", "-N", "--", stateRepoPath])
    if (!intent.ok) {
      throw new SpaceServiceError({
        code: spaceErrorCodes.metaCommitFailed,
        message: "Failed to stage the space assembly state (intent-to-add): " + intent.stderr,
        suggestion: "Check the space root repository state, then re-run the operation.",
      })
    }
  }

  const message = options.message ?? spaceMetaCommitMessage
  const commit = tryGit(git, spacePath, ["commit", "-q", "-m", message, "--", stateRepoPath])
  if (!commit.ok) {
    if (/nothing to commit/i.test(commit.stderr)) return { committed: false }
    if (!tracked) {
      tryGit(git, spacePath, ["rm", "-q", "--cached", "--ignore-unmatch", "--", stateRepoPath])
    }
    throw new SpaceServiceError({
      code: spaceErrorCodes.metaCommitFailed,
      message: "Failed to commit the space assembly state: " + commit.stderr,
      suggestion:
        "Fix the space root repository (or configure git user.name/user.email), then re-run; the state file itself is preserved.",
    })
  }
  const sha = tryGit(git, spacePath, ["rev-parse", "HEAD"])
  return { committed: true, ...(sha.ok ? { commit: sha.stdout } : {}) }
}

export interface SpaceMetaTransaction {
  readonly spacePath: string
  /** The raw bytes the caller read before computing the state (null = absent). */
  readonly expectedRaw: string | null
  readonly state: SpaceAssemblyState
  readonly message?: string
}

export interface SpaceMetaTransactionResult {
  readonly changed: boolean
  readonly committed: boolean
  readonly commit?: string
  readonly path: string
}

/**
 * The full snapshot transaction: verify the caller's read is current, preflight
 * the root repository, write only when the bytes change, then commit only the
 * snapshot. A commit failure restores the previous bytes so a retry is clean.
 * An unchanged state performs no file write and no Git call.
 */
/** Top-level keys the state model defines; anything else is preserved on upgrade. */
const stateFields = new Set(["version", "type", "schema", "source", "include", "exclude", "private"])

/**
 * Serialize the next snapshot, preserving fields a previous version carried
 * that this model does not own. A version 2 snapshot is upgraded to version 3
 * by the same step that persists the requested change.
 */
function nextStateRaw(currentRaw: string | null, state: SpaceAssemblyState): string {
  const base = serializeAssemblyState(state)
  if (currentRaw === null) return base
  let previous: unknown
  try {
    previous = JSON.parse(currentRaw)
  } catch {
    return base
  }
  if (previous === null || typeof previous !== "object" || Array.isArray(previous)) return base
  const extras = Object.entries(previous).filter(([key]) => !stateFields.has(key))
  if (extras.length === 0) return base
  const parsed: unknown = JSON.parse(base)
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return base
  const document: Record<string, unknown> = { ...parsed }
  for (const [key, value] of extras) document[key] = value
  return JSON.stringify(document, null, 2) + "\n"
}

function legacyGuard(spacePath: string, currentRaw: string | null): void {
  if (currentRaw === null) return
  let doc: unknown
  try {
    doc = JSON.parse(currentRaw)
  } catch {
    return
  }
  const result = validateAssemblyState(doc)
  if (!result.ok || result.legacyPrivate.length === 0) return
  const reading: WritableSpaceMetaReading = {
    status: "ok",
    state: result.state,
    raw: currentRaw,
    legacyPrivate: result.legacyPrivate,
  }
  const failure = legacyPrivateFailure(spacePath, reading)
  if (failure !== null) throw failure
}

export function transactAssemblyState(input: SpaceMetaTransaction, git: GitRunner): SpaceMetaTransactionResult {
  const path = spaceMetaPath(input.spacePath)
  const currentRaw = existsSync(path) ? readFileSync(path, "utf8") : null

  if (currentRaw !== input.expectedRaw) throw concurrentModification(path)
  legacyGuard(input.spacePath, currentRaw)
  const nextRaw = nextStateRaw(currentRaw, input.state)
  if (currentRaw === nextRaw) return { changed: false, committed: false, path }

  assertRootRepoCommitReady(input.spacePath, git)

  atomicWrite(path, nextRaw)
  try {
    const result = commitAssemblyState(
      input.spacePath,
      git,
      input.message === undefined ? {} : { message: input.message },
    )
    return { changed: true, committed: result.committed, ...(result.commit ? { commit: result.commit } : {}), path }
  } catch (error) {
    try {
      if (input.expectedRaw === null) {
        rmSync(path, { force: true })
      } else {
        atomicWrite(path, input.expectedRaw)
      }
    } catch {
      // Best effort; the commit failure below is the actionable report.
    }
    throw error
  }
}

/** Write the snapshot bytes without committing (used by rollback/restore). */
export function writeAssemblyStateBytes(spacePath: string, raw: string | null): void {
  const path = spaceMetaPath(spacePath)
  if (raw === null) {
    rmSync(path, { force: true })
    return
  }
  atomicWrite(path, raw)
}
