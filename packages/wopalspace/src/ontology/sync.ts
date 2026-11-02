import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import {
  analyzeFlow,
  commitsAhead,
  createQuarantine,
  currentBranch,
  dirty,
  fetch,
  inProgressOperation,
  isAncestor,
  refExists,
  remoteUrl,
  sanitizeRemoteUrl,
  virtualMerge,
} from "./git"
import {
  OntologyServiceError,
  sanitizeMessage,
  type FileDiff,
  type GitRunner,
  type OntologyMode,
  type SyncStep,
} from "./types"

export interface SyncOutcome {
  readonly steps: readonly SyncStep[]
  readonly pushed: boolean
  readonly pushErrors?: readonly { readonly branch: string; readonly message: string }[]
}

export interface SyncOptions {
  readonly repo: string
  readonly mode: OntologyMode
  readonly confirm: boolean
  readonly git: GitRunner
  readonly scratchRoot: string
  /** Re-read critical facts immediately before the first write. */
  readonly revalidate?: () => void
}

const ORIGIN = "origin/main"
const UPSTREAM = "upstream/main"

function requireRemote(repo: string, remote: string, git: GitRunner): void {
  if (!remoteUrl(repo, remote, git)) {
    throw new OntologyServiceError({
      code: "ONTOLOGY_SYNC_SOURCE_MISSING",
      message: "Cannot resolve " + remote + "/main: the " + remote + " remote is not configured",
      suggestion: "Check `git remote -v` in the ontology repository, then retry.",
    })
  }
}

function requireRef(repo: string, ref: string, git: GitRunner): void {
  if (refExists(repo, ref, git)) return
  const remote = ref.startsWith("upstream/") ? "upstream" : "origin"
  throw new OntologyServiceError({
    code: "ONTOLOGY_SYNC_SOURCE_MISSING",
    message: "Cannot resolve " + ref + ": the remote ref does not exist or the last fetch failed",
    suggestion: "Run `git fetch " + remote + "` in the ontology repository, then retry.",
  })
}

/** An origin that cannot take part in the fork triangle is a broken instance, even in clone mode. */
function assertOriginConsistent(repo: string, git: GitRunner): void {
  const origin = remoteUrl(repo, "origin", git)
  const upstream = remoteUrl(repo, "upstream", git)
  if (!origin || !upstream) return
  const github = (url: string) => /github\.com[:/]/i.test(url)
  if (!github(sanitizeRemoteUrl(origin)) && github(sanitizeRemoteUrl(upstream))) {
    throw new OntologyServiceError({
      code: "ONTOLOGY_ORIGIN_INVALID",
      message: `Ontology origin is not a GitHub URL (${sanitizeRemoteUrl(origin)}).`,
      suggestion: "Fix the origin remote to the fork URL or reinstall the ontology, then retry.",
    })
  }
}

function buildMergeSummary(diffs: readonly FileDiff[]): string {
  if (diffs.length === 0) {
    return "0 content changes — aligns commit topology with upstream (no file changes)"
  }
  const added = diffs.filter((diff) => diff.status === "added").length
  const modified = diffs.filter((diff) => diff.status === "modified").length
  const deleted = diffs.filter((diff) => diff.status === "deleted").length
  return diffs.length + " file(s): " + added + " added, " + modified + " modified, " + deleted + " deleted"
}

function parseDiffs(diff: string): FileDiff[] {
  return diff
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const columns = line.split("\t")
      const letter = columns[0]?.charAt(0) ?? ""
      if (letter === "R" || letter === "C") {
        const result: FileDiff[] = []
        if (letter === "R" && columns[1]) result.push({ path: columns[1], status: "deleted" })
        if (columns[2]) result.push({ path: columns[2], status: "added" })
        return result
      }
      if (!columns[1]) return []
      return [{ path: columns[1], status: letter === "A" ? "added" : letter === "D" ? "deleted" : "modified" }]
    })
}

interface Stage {
  readonly step: string
  readonly source: string
  readonly kind: "merge" | "push"
}

function stages(mode: OntologyMode): Stage[] {
  return mode === "fork"
    ? [
        { step: "origin-merge", source: ORIGIN, kind: "merge" },
        { step: "upstream-merge", source: UPSTREAM, kind: "merge" },
        { step: "origin-push", source: "main", kind: "push" },
      ]
    : [{ step: "main", source: ORIGIN, kind: "merge" }]
}

/**
 * Project the whole chain without writing. Each clean merge is materialized
 * inside the quarantine so the next stage judges the commit the apply run
 * would actually produce; identical trees with disconnected history still
 * merge because commit ancestry, not tree equality, decides the stage.
 */
export function previewSync(options: Omit<SyncOptions, "confirm">): SyncStep[] {
  const { repo, mode, git, scratchRoot } = options
  const plan = stages(mode)
  if (mode === "clone") {
    const flow = analyzeFlow(repo, ORIGIN, "main", "origin/main → local/main", git, "merge", scratchRoot)
    if (commitsAhead(repo, "main", ORIGIN, git) === 0) return [{ step: "main", action: "skipped" }]
    if (flow.mergePrediction !== "clean") {
      return [{ step: "main", action: "conflict", conflictFiles: flow.conflictFiles }]
    }
    return [{ step: "main", action: "merged", fileDiffs: flow.fileDiffs, summary: buildMergeSummary(flow.fileDiffs) }]
  }
  const quarantine = createQuarantine(repo, git, scratchRoot)
  try {
    const steps: SyncStep[] = []
    let head = "main"
    const aheadInQuarantine = (exclude: string, ref: string): number =>
      Number(git(repo, ["rev-list", "--count", exclude + ".." + ref], quarantine.env)) || 0
    for (const stage of plan.slice(0, 2)) {
      if (aheadInQuarantine(head, stage.source) === 0) {
        steps.push({ step: stage.step, action: "skipped" })
        continue
      }
      const merge = virtualMerge(repo, head, stage.source, git, quarantine.env)
      if (!merge.clean) {
        steps.push({ step: stage.step, action: "conflict", conflictFiles: merge.conflictFiles })
        return steps
      }
      if (!merge.tree) return steps
      const currentTree = git(repo, ["rev-parse", head + "^{tree}"], quarantine.env)
      const diffs =
        currentTree === merge.tree
          ? []
          : parseDiffs(git(repo, ["diff", "--name-status", currentTree, merge.tree], quarantine.env))
      steps.push({ step: stage.step, action: "merged", fileDiffs: diffs, summary: buildMergeSummary(diffs) })
      head = isAncestor(repo, head, stage.source, git, quarantine.env)
        ? stage.source
        : git(
            repo,
            ["commit-tree", merge.tree, "-p", head, "-p", stage.source, "-m", "wopalspace ontology sync preview merge"],
            quarantine.env,
          )
    }
    const toPush = aheadInQuarantine(ORIGIN, head)
    steps.push(
      toPush > 0
        ? { step: "origin-push", action: "pushed", summary: "push local main to origin (" + toPush + " commit(s))" }
        : { step: "origin-push", action: "skipped" },
    )
    return steps
  } finally {
    quarantine.cleanup()
  }
}

interface Candidate {
  readonly path: string
  readonly branch: string
}

function createCandidate(repo: string, git: GitRunner, scratchRoot: string): Candidate {
  const base = join(scratchRoot, ".worktrees")
  mkdirSync(base, { recursive: true })
  const path = join(base, "ontology-sync-" + process.pid + "-" + crypto.randomUUID())
  const branch = "ontology-sync-" + crypto.randomUUID()
  try {
    git(repo, ["worktree", "add", "-b", branch, path, "main"])
  } catch (error) {
    rmSync(path, { recursive: true, force: true })
    throw error
  }
  return { path, branch }
}

function removeCandidate(repo: string, git: GitRunner, candidate: Candidate): void {
  try {
    git(repo, ["worktree", "remove", "--force", candidate.path])
  } catch {
    rmSync(candidate.path, { recursive: true, force: true })
    try {
      git(repo, ["worktree", "prune"])
    } catch {
      // best effort hygiene; the candidate branch removal below still matters
    }
  }
  try {
    git(repo, ["branch", "-D", candidate.branch])
  } catch {
    // branch already absent
  }
  rmSync(candidate.path, { recursive: true, force: true })
}

function mergeInto(repo: string, target: string, source: string, git: GitRunner): { ok: boolean; conflicts: string[] } {
  try {
    git(repo, ["merge", "--no-edit", source])
    return { ok: true, conflicts: [] }
  } catch {
    let conflicts: string[] = []
    try {
      conflicts = git(repo, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean)
    } catch {
      conflicts = []
    }
    try {
      git(repo, ["merge", "--abort"])
    } catch {
      // The candidate worktree is force-removed regardless.
    }
    return { ok: false, conflicts }
  }
}

function updateLocalMain(repo: string, commit: string, git: GitRunner): void {
  if (currentBranch(repo, git) === "main") {
    git(repo, ["merge", "--ff-only", commit])
    return
  }
  git(repo, ["branch", "-f", "main", commit])
}

/**
 * Preview is a projection over cached refs; apply refetches, re-projects and
 * then executes that same chain. Only the local transaction advances main,
 * and only after every merge succeeded. Push failures are reported, never
 * rolled back, so a retry performs the remote half alone.
 */
export function syncOntology(options: SyncOptions): SyncOutcome {
  const { repo, mode, confirm, git, scratchRoot } = options
  assertOriginConsistent(repo, git)
  const remoteNames = mode === "fork" ? ["upstream", "origin"] : ["origin"]
  for (const remote of remoteNames) requireRemote(repo, remote, git)

  if (!confirm) {
    for (const ref of mode === "fork" ? [UPSTREAM, ORIGIN] : [ORIGIN]) requireRef(repo, ref, git)
    return { steps: previewSync({ repo, mode, git, scratchRoot }), pushed: false }
  }

  options.revalidate?.()
  const changes = dirty(repo, git)
  if (changes.length > 0) {
    throw new OntologyServiceError({
      code: "ONTOLOGY_SYNC_DIRTY",
      message: "The ontology host repository has " + changes.length + " uncommitted change(s)",
      suggestion: "Commit or stash the host repository changes, then retry the sync.",
    })
  }
  const inProgress = inProgressOperation(repo, git)
  if (inProgress) {
    throw new OntologyServiceError({
      code: "ONTOLOGY_SYNC_IN_PROGRESS",
      message: "An incomplete Git operation is in progress: " + inProgress,
      suggestion: "Finish or abort the in-progress Git operation before syncing.",
    })
  }
  for (const remote of remoteNames) {
    try {
      fetch(repo, remote, git)
    } catch (error) {
      throw new OntologyServiceError({
        code: "ONTOLOGY_SYNC_REFRESH_FAILED",
        message: "Could not refresh " + remote + " before ontology sync",
        suggestion: sanitizeMessage(error instanceof Error ? error.message : String(error)),
        cause: error,
      })
    }
  }
  for (const ref of mode === "fork" ? [UPSTREAM, ORIGIN] : [ORIGIN]) requireRef(repo, ref, git)

  const steps: SyncStep[] = []
  if (mode === "clone") {
    if (commitsAhead(repo, "main", ORIGIN, git) === 0) {
      return { steps: [{ step: "main", action: "skipped" }], pushed: false }
    }
    const flow = analyzeFlow(repo, ORIGIN, "main", "origin/main → local/main", git, "merge", scratchRoot)
    if (flow.mergePrediction !== "clean") {
      return {
        steps: [{ step: "main", action: "conflict", conflictFiles: flow.conflictFiles }],
        pushed: false,
      }
    }
    const onMain = currentBranch(repo, git) === "main"
    const candidate = onMain ? undefined : createCandidate(repo, git, scratchRoot)
    try {
      const outcome = mergeInto(candidate?.path ?? repo, "main", ORIGIN, git)
      if (!outcome.ok) {
        return { steps: [{ step: "main", action: "conflict", conflictFiles: outcome.conflicts }], pushed: false }
      }
      if (candidate) updateLocalMain(repo, git(candidate.path, ["rev-parse", "HEAD"]), git)
      steps.push({
        step: "main",
        action: "merged",
        fileDiffs: flow.fileDiffs,
        summary: buildMergeSummary(flow.fileDiffs),
      })
    } finally {
      if (candidate) removeCandidate(repo, git, candidate)
    }
    return { steps, pushed: false }
  }

  const plan = stages("fork").slice(0, 2)
  let merged = false
  let candidate: Candidate | undefined
  try {
    for (const stage of plan) {
      const target = candidate?.path ?? repo
      const targetRef = candidate ? "HEAD" : "main"
      if (commitsAhead(target, targetRef, stage.source, git) === 0) {
        steps.push({ step: stage.step, action: "skipped" })
        continue
      }
      const flow = analyzeFlow(target, stage.source, targetRef, stage.step, git, "merge", scratchRoot)
      candidate ??= createCandidate(repo, git, scratchRoot)
      const outcome = mergeInto(candidate.path, "HEAD", stage.source, git)
      if (!outcome.ok) {
        steps.push({
          step: stage.step,
          action: "conflict",
          conflictFiles: outcome.conflicts.length > 0 ? outcome.conflicts : flow.conflictFiles,
        })
        return { steps, pushed: false }
      }
      steps.push({
        step: stage.step,
        action: "merged",
        fileDiffs: flow.fileDiffs,
        summary: buildMergeSummary(flow.fileDiffs),
      })
      merged = true
    }
    if (candidate && merged) updateLocalMain(repo, git(candidate.path, ["rev-parse", "HEAD"]), git)
  } finally {
    if (candidate) removeCandidate(repo, git, candidate)
  }

  const toPush = commitsAhead(repo, ORIGIN, "main", git)
  if (toPush === 0) {
    steps.push({ step: "origin-push", action: "skipped" })
    return { steps, pushed: false }
  }
  try {
    git(repo, ["push", "origin", "main"])
    steps.push({
      step: "origin-push",
      action: "pushed",
      summary: "push local main to origin (" + toPush + " commit(s))",
    })
    return { steps, pushed: true }
  } catch (error) {
    steps.push({ step: "origin-push", action: "failed", summary: "push failed — see push errors" })
    return {
      steps,
      pushed: false,
      pushErrors: [
        { branch: "main", message: sanitizeMessage(error instanceof Error ? error.message : String(error)) },
      ],
    }
  }
}
