import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs"
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
    if (flow.contentState === "conflict" || flow.contentState === "unknown") {
      return [{ step: "main", action: "conflict", conflictFiles: flow.conflictFiles }]
    }
    if (flow.historyState === "target-ancestor") {
      return [{ step: "main", action: "fast-forwarded" }]
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
      const treeUnchanged = currentTree === merge.tree
      const diffs =
        treeUnchanged ? [] : parseDiffs(git(repo, ["diff", "--name-status", currentTree, merge.tree], quarantine.env))
      steps.push({
        step: stage.step,
        action: treeUnchanged ? "reconciled" : "merged",
        fileDiffs: diffs,
        summary: treeUnchanged
          ? "0 content changes — aligns commit topology (no file changes)"
          : buildMergeSummary(diffs),
      })
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

/** Formal subjects fixed by the design; temporary worktree/branch identity never leaks. */
function mergeSubject(source: string, treePreserving: boolean): string {
  const remote = source.startsWith("upstream/") ? "upstream/main" : "origin/main"
  return treePreserving ? "sync(ontology): reconcile " + remote + " history" : "sync(ontology): integrate " + remote
}

/**
 * Persist every loose object the quarantined commit created. The scratch
 * store uses the standard two-hex-prefix fan-out layout, so a plain file
 * copy into the real store is sufficient and idempotent.
 */
function copyQuarantinedObjects(repo: string, scratch: string, git: GitRunner): void {
  const common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  const real = join(common, "objects")
  for (const prefix of readdirSync(scratch)) {
    if (!/^[0-9a-f]{2}$/.test(prefix)) continue
    mkdirSync(join(real, prefix), { recursive: true })
    for (const name of readdirSync(join(scratch, prefix))) {
      const target = join(real, prefix, name)
      try {
        git(repo, ["cat-file", "-e", prefix + name])
        continue
      } catch {
        // Object absent from the real store; copy the loose file.
      }
      rmSync(target, { force: true })
      copyFileSync(join(scratch, prefix, name), target)
    }
  }
}

/**
 * Build the merge commit directly: the tree from the virtual merge decides
 * whether this is a content integration or a tree-preserving history
 * reconciliation, and the subject follows the outcome, not the guess.
 */
function commitMerge(
  repo: string,
  worktree: string,
  firstParent: string,
  source: string,
  git: GitRunner,
): { ok: boolean; conflicts: string[] } {
  const quarantine = createQuarantine(repo, git)
  try {
    const merge = virtualMerge(repo, firstParent, source, git, quarantine.env)
    if (!merge.clean) {
      try {
        git(worktree, ["merge", "--no-edit", "-m", "conflict-probe", source])
      } catch {
        // Expected: the probe only materializes conflict facts.
      }
      let conflicts: string[] = []
      try {
        conflicts = git(worktree, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean)
      } catch {
        conflicts = []
      }
      try {
        git(worktree, ["merge", "--abort"])
      } catch {
        // The candidate worktree is force-removed regardless.
      }
      return { ok: false, conflicts }
    }
    if (!merge.tree) return { ok: false, conflicts: [] }
    const treeUnchanged = merge.tree === git(repo, ["rev-parse", firstParent + "^{tree}"], quarantine.env)
    const message = mergeSubject(source, treeUnchanged)
    // Build the merge commit inside the quarantine: the commit and any tree
    // objects it references land in the scratch store. commit-tree does not
    // copy referenced objects, so writing "into the real store" via
    // alternates would leave the merge tree stranded in the disposable
    // scratch. Instead the commit is built quarantined and every loose
    // object produced is then copied into the real object store before the
    // scratch is removed.
    const commit = git(
      worktree,
      ["commit-tree", merge.tree, "-p", firstParent, "-p", source, "-m", message],
      quarantine.env,
    )
    copyQuarantinedObjects(repo, quarantine.env.GIT_OBJECT_DIRECTORY ?? "", git)
    git(worktree, ["update-ref", "HEAD", commit])
    return { ok: true, conflicts: [] }
  } finally {
    quarantine.cleanup()
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
    if (flow.contentState === "conflict" || flow.contentState === "unknown") {
      return {
        steps: [{ step: "main", action: "conflict", conflictFiles: flow.conflictFiles }],
        pushed: false,
      }
    }
    const onMain = currentBranch(repo, git) === "main"
    const candidate = onMain ? undefined : createCandidate(repo, git, scratchRoot)
    try {
      const worktree = candidate?.path ?? repo
      const firstParent = git(worktree, ["rev-parse", "main"])
      const firstParentTree = git(worktree, ["rev-parse", firstParent + "^{tree}"])
      if (isAncestor(repo, firstParent, ORIGIN, git)) {
        // target-ancestor: fast-forward only, no merge commit.
        git(worktree, ["merge", "--ff-only", ORIGIN])
        if (candidate) updateLocalMain(repo, git(candidate.path, ["rev-parse", "HEAD"]), git)
        steps.push({ step: "main", action: "fast-forwarded" })
        return { steps, pushed: false }
      }
      const outcome = commitMerge(repo, worktree, firstParent, ORIGIN, git)
      if (!outcome.ok) {
        return { steps: [{ step: "main", action: "conflict", conflictFiles: outcome.conflicts }], pushed: false }
      }
      if (candidate) updateLocalMain(repo, git(candidate.path, ["rev-parse", "HEAD"]), git)
      const newHead = git(worktree, ["rev-parse", "main"])
      const treeUnchanged = git(worktree, ["rev-parse", newHead + "^{tree}"]) === firstParentTree
      steps.push({
        step: "main",
        action: treeUnchanged ? "reconciled" : "merged",
        fileDiffs: treeUnchanged ? [] : flow.fileDiffs,
        summary: treeUnchanged
          ? "0 content changes — aligns commit topology (no file changes)"
          : buildMergeSummary(flow.fileDiffs),
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
      // Judge against the projected history: after the first stage the
      // candidate HEAD, not the original main, is the integration point.
      const targetRef = candidate ? git(candidate.path, ["rev-parse", "HEAD"]) : "main"
      if (isAncestor(repo, stage.source, targetRef, git)) {
        steps.push({ step: stage.step, action: "skipped" })
        continue
      }
      if (isAncestor(repo, targetRef, stage.source, git)) {
        // Fast-forward: the stage cannot run on the host checkout, so the
        // candidate worktree materializes the projected merge commit.
        candidate ??= createCandidate(repo, git, scratchRoot)
        git(candidate.path, ["merge", "--ff-only", stage.source])
        steps.push({ step: stage.step, action: "fast-forwarded" })
        merged = true
        continue
      }
      const flow = analyzeFlow(repo, stage.source, targetRef, stage.step, git, "merge", scratchRoot)
      candidate ??= createCandidate(repo, git, scratchRoot)
      if (flow.contentState === "conflict" || flow.contentState === "unknown") {
        steps.push({
          step: stage.step,
          action: "conflict",
          conflictFiles: flow.conflictFiles,
        })
        return { steps, pushed: false }
      }
      const firstParent = git(candidate.path, ["rev-parse", "HEAD"])
      const firstParentTree = git(candidate.path, ["rev-parse", firstParent + "^{tree}"])
      const outcome = commitMerge(repo, candidate.path, firstParent, stage.source, git)
      if (!outcome.ok) {
        steps.push({
          step: stage.step,
          action: "conflict",
          conflictFiles: outcome.conflicts.length > 0 ? outcome.conflicts : flow.conflictFiles,
        })
        return { steps, pushed: false }
      }
      const newHead = git(candidate.path, ["rev-parse", "HEAD"])
      const newTree = git(candidate.path, ["rev-parse", newHead + "^{tree}"])
      const treeUnchanged = newTree === firstParentTree
      steps.push({
        step: stage.step,
        action: treeUnchanged ? "reconciled" : "merged",
        fileDiffs: treeUnchanged ? [] : flow.fileDiffs,
        summary: treeUnchanged
          ? "0 content changes — aligns commit topology (no file changes)"
          : buildMergeSummary(flow.fileDiffs),
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
