import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  alwaysAssembledPatterns,
  findMissingTemplates,
  materializationPatterns,
  readArchetype,
  readSpaceSchema,
  resolveSchemaName,
  type ArchetypeManifest,
  type SpaceSchema,
} from "./assembly"
import {
  computeEffectivePatterns,
  findMissingTemplatesFromTree,
  materializationPatternsFromTree,
  pruneSelections,
  readArchetypeFromTree,
  readSpaceSchemaFromTree,
  readAssemblyTree,
  readTreeFile,
  readTemplateFromTree,
  type AssemblyTreeFacts,
} from "./assembly-tree"
import {
  branchExists,
  currentBranch,
  isGitRepository,
  remoteBranchNames,
  revListCount,
  tryGit,
  type GitRunner,
} from "./git"
import { filesystemTemplates, materializeSpace, type TemplateSource } from "./materialize"
import {
  applyPluginExclusions,
  alignSpaceConfig,
  declaredPluginNamesFromSettings,
  excludedPluginNames,
  spacePluginSpecs,
} from "./local-config"
import { spaceBranchName, normalizeSpaceName } from "./registry"
import { registerSpace } from "./registry-write"
import { mountPatternPaths, shadowedPaths, buildAssemblyState, type BuildStateInput } from "./selection"
import { applySparsePatterns, assertSparseConsistency, listSparsePatterns } from "./sparse"
import { readAssemblyState, spaceMetaPath, transactAssemblyState } from "./snapshot"
import { SpaceServiceError, spaceErrorCodes } from "./types"
import type {
  RegisteredOntology,
  RegisteredSpace,
  SpaceAssemblyState,
  SpaceCondition,
  SpaceInitInput,
  SpaceMaterialization,
  SpaceReconcileStep,
} from "./types"

/**
 * Space init: create, reuse, relink and repair.
 *
 * The transaction is ordered so a partial Space is never registered:
 *   verify inputs -> read assembly facts -> (re)build the worktree ->
 *   materialize the skeleton -> align the local config -> write and commit the
 *   snapshot -> register -> prepare the instance.
 *
 * Materialization and instance preparation are separate facts. A failed or
 * cancelled preparation keeps the Space as it is; retrying init repairs the
 * missing preparation without recreating the Space.
 */

export interface SpaceInitContext {
  readonly wopalHome: string
  readonly git: GitRunner
  readonly ontology: RegisteredOntology & { readonly remote?: string }
  readonly registered?: RegisteredSpace
  readonly now: () => Date
}

interface Assembly {
  readonly manifest: ArchetypeManifest
  readonly schemaName: string
  readonly schema: SpaceSchema
  readonly patterns: string[]
  readonly settingsLocalPlugins: Record<string, string[]>
  readonly templates: TemplateSource
  readonly envTemplate: { readonly read: () => string | null; readonly label: string }
}

interface Detection {
  readonly condition: SpaceCondition
  readonly hasSnapshot: boolean
  readonly hasWopalDir: boolean
  readonly worktreeValid: boolean
  readonly registered: boolean
  readonly lockedType: string | null
}

function step(
  steps: SpaceReconcileStep[],
  name: SpaceReconcileStep["step"],
  status: SpaceReconcileStep["status"],
  detail: string,
): void {
  steps.push({ step: name, status, detail })
}

/** Expand a leading tilde before any path is derived from it. */
export function expandTildePath(path: string): string {
  return path.replace(/^~(?=$|[/\\])/, homedir())
}

/** On case-insensitive filesystems, report the real casing of an input path. */
export function verifyPathCase(inputPath: string): { ok: boolean; realPath?: string } {
  if (!existsSync(inputPath)) return { ok: true }
  try {
    const real = realpathSync(inputPath)
    return real === inputPath ? { ok: true } : { ok: false, realPath: real }
  } catch {
    return { ok: true }
  }
}

function worktreeValid(git: GitRunner, wopalDir: string, branch: string): boolean {
  if (!existsSync(wopalDir)) return false
  if (!tryGit(git, wopalDir, ["rev-parse", "--git-dir"]).ok) return false
  return currentBranch(git, wopalDir) === branch
}

function detect(context: SpaceInitContext, input: { name: string; path: string }): Detection {
  const wopalDir = join(input.path, ".wopal")
  const branch = spaceBranchName(input.name)
  const hasSnapshot = existsSync(spaceMetaPath(input.path))
  const hasWopalDir = existsSync(wopalDir)
  const valid = hasWopalDir && worktreeValid(context.git, wopalDir, branch)
  const registered = context.registered !== undefined && context.registered.path === input.path
  const reading = readAssemblyState(input.path)
  const lockedType =
    reading.status === "ok"
      ? reading.state.type
      : context.registered?.type !== undefined && context.registered.type.length > 0
        ? context.registered.type
        : null

  let condition: SpaceCondition
  if (!hasSnapshot && !hasWopalDir) condition = "create"
  else if (!hasSnapshot && hasWopalDir) condition = "invalid"
  else if (hasSnapshot && !hasWopalDir) condition = "relink"
  else if (valid && registered) condition = "noop"
  else if (valid && !registered) condition = "repair-registry"
  else if (!valid && registered) condition = "repair-worktree"
  else condition = "repair-both"
  return { condition, hasSnapshot, hasWopalDir, worktreeValid: valid, registered, lockedType }
}

function prepareAssemblyFromOntology(ontologyPath: string, type: string): Assembly {
  const manifest = readArchetype(ontologyPath, type)
  const schemaName = resolveSchemaName(manifest)
  const schema = readSpaceSchema(ontologyPath, schemaName)
  const missing = findMissingTemplates(ontologyPath, schema)
  if (missing.length > 0) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.templateMissing,
      message:
        'Space schema "' +
        schemaName +
        '" references templates missing from ' +
        join(ontologyPath, "assembly", "templates") +
        ": " +
        missing.join(", "),
      suggestion:
        "Add the templates under assembly/templates/ in the ontology repository, or fix the schema template references",
    })
  }
  const settingsContent = readTextOrNull(join(ontologyPath, "config", "settings.jsonc"))
  const envPath = join(ontologyPath, ".env.example")
  return {
    manifest,
    schemaName,
    schema,
    // Manifest references resolve through the shared resolver, so a broken
    // declaration fails before any disk write.
    patterns: materializationPatterns(ontologyPath, manifest),
    settingsLocalPlugins: spacePluginSpecs(declaredPluginNamesFromSettings(settingsContent), manifest),
    templates: filesystemTemplates(join(ontologyPath, "assembly", "templates")),
    envTemplate: {
      read: () => (existsSync(envPath) ? readTextOrNull(envPath) : null),
      label: envPath,
    },
  }
}

function prepareAssemblyFromTree(facts: AssemblyTreeFacts, type: string, git: GitRunner): Assembly {
  const manifest = readArchetypeFromTree(facts, type, git)
  const schemaName = resolveSchemaName(manifest)
  const schema = readSpaceSchemaFromTree(facts, schemaName, git)
  const missing = findMissingTemplatesFromTree(facts, schema)
  if (missing.length > 0) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.templateMissing,
      message:
        'Space schema "' +
        schemaName +
        '" references templates missing from ref "' +
        facts.ref +
        '": ' +
        missing.join(", "),
      suggestion:
        "Add the templates under assembly/templates/ on the space branch, or fix the schema template references",
    })
  }
  const fromTree = materializationPatternsFromTree(facts, manifest, alwaysAssembledPatterns(manifest))
  if (fromTree.problems.length > 0) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.capabilityUnresolved,
      message: "Space branch " + facts.ref + " has an unusable assembly declaration: " + fromTree.problems.join("; "),
      suggestion: "Fix the assembly manifest on the space branch, then retry.",
    })
  }
  const settingsContent = readTreeFile(facts, "config/settings.jsonc", git)
  return {
    manifest,
    schemaName,
    schema,
    patterns: fromTree.patterns,
    settingsLocalPlugins: spacePluginSpecs(declaredPluginNamesFromSettings(settingsContent), manifest),
    templates: {
      read: (template) => readTemplateFromTree(facts, template, git),
      label: (template) => 'ref "' + facts.ref + '" (assembly/templates/' + template + ")",
    },
    envTemplate: {
      read: () => readTreeFile(facts, ".env.example", git),
      label: 'ref "' + facts.ref + '" (.env.example)',
    },
  }
}

function readTextOrNull(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

function resolveMainStartRef(git: GitRunner, ontologyPath: string): string {
  for (const ref of ["main", "origin/main"]) {
    if (tryGit(git, ontologyPath, ["rev-parse", "--verify", ref + "^{commit}"]).ok) return ref
  }
  throw new SpaceServiceError({
    code: spaceErrorCodes.mainRefMissing,
    message: "Ontology at " + ontologyPath + " has no main (or origin/main) ref to fork the space branch from",
    suggestion: "Fetch or reinstall the ontology, then retry.",
  })
}

function latestRebuildBackup(backupRoot: string): string | null {
  if (!existsSync(backupRoot)) return null
  const slots = readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("rebuild-"))
    .map((entry) => entry.name)
    .sort()
    .reverse()
  const latest = slots[0]
  return latest === undefined ? null : join(backupRoot, latest)
}

function copyUserFiles(source: string, destination: string): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".git") continue
    cpSync(join(source, entry.name), join(destination, entry.name), { recursive: true, force: true })
  }
}

interface WorktreeResult {
  readonly created: boolean
  readonly repaired: boolean
}

/**
 * Create, repair or relink the Space worktree.
 *
 * A stale .wopal is copied aside before removal and user files are restored
 * over the fresh checkout; the rebuild backup slot is kept so a defective
 * restore can never destroy user content beyond recovery. Any failure after
 * the worktree was created rolls it back to the "not created" state.
 */
export function rebuildWorktree(
  context: SpaceInitContext,
  input: { name: string; path: string; fork: boolean },
  detection: Detection,
  patterns: readonly string[],
  steps: SpaceReconcileStep[],
): WorktreeResult {
  const { git, ontology } = context
  const wopalDir = join(input.path, ".wopal")
  const branch = spaceBranchName(input.name)
  const ontologyPath = ontology.path
  const backupRoot = join(input.path, ".wopal-space", "backup")
  const backupDir = join(backupRoot, "rebuild-" + context.now().getTime())
  const stale = detection.hasWopalDir && !detection.worktreeValid

  if (stale) {
    try {
      if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true })
      mkdirSync(join(input.path, ".wopal-space"), { recursive: true })
      cpSync(wopalDir, backupDir, { recursive: true })
      rmSync(wopalDir, { recursive: true, force: true })
    } catch (error) {
      throw new SpaceServiceError({
        code: spaceErrorCodes.worktreeFailed,
        message: "Failed to back up stale .wopal/: " + (error instanceof Error ? error.message : String(error)),
      })
    }
  }

  tryGit(git, ontologyPath, ["worktree", "prune"])

  const localExists = branchExists(git, ontologyPath, branch)
  const remoteBranches = remoteBranchNames(git, ontologyPath, "origin")
  const recoverFromRemote = !localExists && input.fork && remoteBranches.has(branch)
  let createdBranch = false

  try {
    if (localExists) {
      tryGit(git, ontologyPath, ["worktree", "add", "--force", "--no-checkout", wopalDir, branch])
    } else if (recoverFromRemote) {
      tryGit(git, ontologyPath, ["branch", branch, "origin/" + branch])
      tryGit(git, ontologyPath, ["worktree", "add", "--no-checkout", wopalDir, branch])
    } else {
      createdBranch = true
      const startRef = resolveMainStartRef(git, ontologyPath)
      const args = startRef.includes("/") ? ["branch", "--no-track", branch, startRef] : ["branch", branch, startRef]
      const created = tryGit(git, ontologyPath, args)
      if (!created.ok) throw new Error(created.stderr)
      const added = tryGit(git, ontologyPath, ["worktree", "add", "--no-checkout", wopalDir, branch])
      if (!added.ok) throw new Error(added.stderr)
    }
    applySparsePatterns(git, wopalDir, patterns)
  } catch (error) {
    try {
      if (existsSync(wopalDir)) rmSync(wopalDir, { recursive: true, force: true })
      tryGit(git, ontologyPath, ["worktree", "prune"])
      if (createdBranch) tryGit(git, ontologyPath, ["branch", "-D", branch])
    } catch {
      // Best effort; the failure below is the actionable report.
    }
    if (stale && existsSync(backupDir)) {
      try {
        if (existsSync(wopalDir)) rmSync(wopalDir, { recursive: true, force: true })
        cpSync(backupDir, wopalDir, { recursive: true })
      } catch {
        // The backup slot remains on disk for manual recovery.
      }
    }
    throw new SpaceServiceError({
      code: spaceErrorCodes.worktreeFailed,
      message:
        "Failed to create worktree at " + wopalDir + ": " + (error instanceof Error ? error.message : String(error)),
    })
  }

  if (stale && existsSync(backupDir)) {
    try {
      copyUserFiles(backupDir, wopalDir)
    } catch (error) {
      throw new SpaceServiceError({
        code: spaceErrorCodes.worktreeFailed,
        message:
          "Worktree rebuilt but user files could not be fully restored: " +
          (error instanceof Error ? error.message : String(error)) +
          ". Your files are backed up at " +
          backupDir,
      })
    }
  }

  step(
    steps,
    "worktree",
    stale ? "repaired" : "created",
    "branch=" +
      branch +
      " sparse=true localExisted=" +
      localExists +
      " recoveredFromRemote=" +
      recoverFromRemote +
      " filesRestored=" +
      stale,
  )
  return { created: true, repaired: stale }
}

function rollbackWorktree(context: SpaceInitContext, input: { path: string }, detection: Detection): void {
  if (detection.worktreeValid) return
  const wopalDir = join(input.path, ".wopal")
  try {
    if (existsSync(wopalDir)) rmSync(wopalDir, { recursive: true, force: true })
    const slot = detection.hasWopalDir ? latestRebuildBackup(join(input.path, ".wopal-space", "backup")) : null
    if (slot !== null) cpSync(slot, wopalDir, { recursive: true })
    tryGit(context.git, context.ontology.path, ["worktree", "prune"])
  } catch {
    // Best effort.
  }
}

function ensureSpaceGitRepo(git: GitRunner, spacePath: string, steps: SpaceReconcileStep[]): void {
  if (existsSync(join(spacePath, ".git"))) {
    step(steps, "git", "reused", "space root already a git repo")
    return
  }
  mkdirSync(spacePath, { recursive: true })
  const init = tryGit(git, spacePath, ["init"])
  if (!init.ok) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.worktreeFailed,
      message: "Failed to init space root git repo: " + init.stderr,
    })
  }
  const head = tryGit(git, spacePath, ["symbolic-ref", "HEAD"])
  if (head.ok && !head.stdout.endsWith("/main")) {
    tryGit(git, spacePath, ["symbolic-ref", "HEAD", "refs/heads/main"])
  }
  step(steps, "git", "created", "initialized space root git repo")
}

function materializeSkeleton(
  input: { name: string; path: string },
  ontology: { readonly path: string; readonly remote: string | undefined },
  assembly: Assembly,
  bootstrap: boolean,
  steps: SpaceReconcileStep[],
): void {
  const wopalDir = join(input.path, ".wopal")
  const repoSlug =
    ontology.remote === undefined
      ? "wopal-space-ontology"
      : ontology.remote.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "")
  const ontologyName = repoSlug.split("/").pop() || "wopal-space-ontology"

  mkdirSync(input.path, { recursive: true })
  const result = materializeSpace(
    input.path,
    assembly.schema,
    assembly.templates,
    { spaceName: input.name, spaceRoot: input.path, ontologyRepo: repoSlug, ontologyName },
    { bootstrap },
  )
  if (!result.success) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.templateMissing,
      message: "Materialization failed: " + result.missing.join(", "),
    })
  }

  const envDestination = join(wopalDir, ".env")
  if (!existsSync(envDestination)) {
    const content = assembly.envTemplate.read()
    if (content === null) {
      throw new SpaceServiceError({
        code: spaceErrorCodes.envSeedFailed,
        message: "Ontology env template is missing: " + assembly.envTemplate.label,
        suggestion: "Add .env.example to the ontology, or create the Space .env yourself.",
      })
    }
    try {
      writeFileSync(envDestination, content, "utf8")
    } catch (error) {
      throw new SpaceServiceError({
        code: spaceErrorCodes.envSeedFailed,
        message:
          "Failed to seed " +
          envDestination +
          " from " +
          assembly.envTemplate.label +
          ": " +
          (error instanceof Error ? error.message : String(error)),
      })
    }
  }

  step(steps, "materialize", "reused", "created=" + result.created.length + " skipped=" + result.skipped.length)
}

export interface InitRequest {
  readonly input: SpaceInitInput
  readonly hostDirectory?: string
}

/**
 * Resolve the Space path a request targets.
 *
 * The path comes from the request or from the trusted host directory; the
 * domain module never falls back to an ambient process directory.
 */
export function spaceInitPath(input: SpaceInitInput, hostDirectory: string | undefined): string {
  const name = normalizeSpaceName(input.name)
  if (input.root !== undefined && input.root.length > 0) return expandTildePath(input.root)
  if (hostDirectory === undefined || hostDirectory.length === 0) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.pathInvalid,
      message: "A Space path is required when the host supplies no trusted directory",
      suggestion: "Pass the Space root path, or call from a trusted host directory.",
    })
  }
  return expandTildePath(join(hostDirectory, name))
}

/**
 * Run the infrastructure part of init: everything before instance preparation.
 */
export function materializeSpaceInit(
  context: SpaceInitContext,
  request: InitRequest,
  fork: boolean,
): SpaceMaterialization & { readonly state: SpaceAssemblyState } {
  const { git, ontology } = context
  const name = normalizeSpaceName(request.input.name)
  const spacePath = spaceInitPath(request.input, request.hostDirectory)
  const steps: SpaceReconcileStep[] = []
  const branch = spaceBranchName(name)
  const detection = detect(context, { name, path: spacePath })

  if (detection.condition === "invalid") {
    throw new SpaceServiceError({
      code: spaceErrorCodes.invalidState,
      message:
        "Invalid state: .wopal/ exists but the assembly snapshot .wopal-space/space-meta.json is missing. " +
        "Restore the snapshot from the space root repository, or remove .wopal/ manually before retrying.",
    })
  }

  const requestedType =
    request.input.type !== undefined && request.input.type.length > 0
      ? request.input.type
      : (detection.lockedType ?? undefined)
  if (detection.condition === "create" && (requestedType === undefined || requestedType === "common")) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.typeRequired,
      message: "A space type is required to create a space.",
      suggestion: "Pass a type declared by the ontology assembly/archetypes/.",
    })
  }

  let previous: { raw: string | null; state: SpaceAssemblyState | null } = { raw: null, state: null }
  if (detection.condition !== "create") {
    const reading = readAssemblyState(spacePath)
    if (reading.status !== "ok") {
      throw new SpaceServiceError({
        code: reading.status === "missing" ? spaceErrorCodes.metaMissing : spaceErrorCodes.metaInvalid,
        message:
          reading.status === "missing"
            ? "This space has no assembly state at " + reading.path
            : "This space's assembly state is invalid at " + reading.path + ": " + reading.reason,
        suggestion:
          reading.status === "missing"
            ? "Restore .wopal-space/space-meta.json (tracked in the space root repository) or a backup, then retry."
            : "Repair or restore the corrupt snapshot; a corrupt snapshot is never migrated or rebuilt automatically.",
      })
    }
    previous = { raw: reading.raw, state: reading.state }
  }

  const effectiveType = requestedType ?? ""
  if (detection.lockedType !== null && detection.lockedType !== effectiveType) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.typeMismatch,
      message:
        "This space was created with type " +
        JSON.stringify(detection.lockedType) +
        ", cannot change to " +
        JSON.stringify(effectiveType) +
        ". Changing types would discard work on the existing branch.",
      suggestion: "Remove the space first if you really need a different type.",
    })
  }

  if (!isGitRepository(git, ontology.path)) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.ontologyNotFound,
      message: "Registered ontology is not a readable Git repository: " + ontology.path,
      suggestion: "Install or repair the ontology first, then retry.",
    })
  }
  step(steps, "ontology", "reused", ontology.path)

  const existing = detection.condition !== "create"
  const branchPresent = existing && branchExists(git, ontology.path, branch)
  let facts: AssemblyTreeFacts | undefined
  if (branchPresent) {
    if (detection.worktreeValid) {
      const unreceived = revListCount(git, ontology.path, branch, "main")
      if (unreceived > 0) {
        throw new SpaceServiceError({
          code: spaceErrorCodes.behindMain,
          message:
            "Local ontology main carries " + unreceived + " commit(s) the space branch " + branch + " has not received",
          suggestion:
            "Run space.sync to bring the space branch up to local main, then retry init. No changes were applied.",
        })
      }
      assertSparseConsistency(git, join(spacePath, ".wopal"))
    }
    facts = readAssemblyTree(ontology.path, branch, git)
  }

  const assembly =
    facts === undefined
      ? prepareAssemblyFromOntology(ontology.path, effectiveType)
      : prepareAssemblyFromTree(facts, effectiveType, git)
  step(
    steps,
    "assembly",
    "reused",
    "type=" +
      effectiveType +
      " schema=" +
      assembly.schemaName +
      " capabilities=" +
      assembly.patterns.length +
      (facts ? " ref=" + branch : ""),
  )

  let selectionState = previous.state
  let dropped: string[] = []
  if (facts !== undefined && selectionState !== null) {
    const pruned = pruneSelections(facts, effectiveType, selectionState, git)
    selectionState = pruned.state
    dropped = pruned.dropped
  }
  const effectivePatterns =
    selectionState === null
      ? assembly.patterns
      : computeEffectivePatterns(
          assembly.patterns,
          alwaysAssembledPatterns(assembly.manifest),
          mountPatternPaths(selectionState),
          shadowedPaths(selectionState),
        )

  const needsWorktree =
    detection.condition === "create" ||
    detection.condition === "relink" ||
    detection.condition === "repair-worktree" ||
    detection.condition === "repair-both"
  try {
    if (needsWorktree) {
      rebuildWorktree(context, { name, path: spacePath, fork }, detection, effectivePatterns, steps)
    } else {
      step(steps, "worktree", "reused", "already valid")
    }

    materializeSkeleton(
      { name, path: spacePath },
      { path: ontology.path, remote: ontology.remote },
      assembly,
      detection.condition === "create",
      steps,
    )

    const excluded = excludedPluginNames(selectionState?.exclude ?? [])
    const pluginPlan = applyPluginExclusions(assembly.settingsLocalPlugins, assembly.manifest, excluded)
    const aligned = alignSpaceConfig(join(spacePath, ".wopal"), pluginPlan.desired, pluginPlan.extraManaged)
    if (!aligned.ok) {
      throw new SpaceServiceError({
        code: spaceErrorCodes.worktreeFailed,
        message: aligned.error ?? "Space config alignment failed",
      })
    }
    step(
      steps,
      "config",
      aligned.changed ? "created" : "reused",
      "settings.local.jsonc added=" + aligned.added.length + " removed=" + aligned.removed.length,
    )

    if (!needsWorktree) {
      const current = listSparsePatterns(git, join(spacePath, ".wopal"))
      const changed = !sameSet(current, effectivePatterns)
      if (changed) applySparsePatterns(git, join(spacePath, ".wopal"), effectivePatterns)
      step(steps, "range", changed ? "updated" : "reused", "patterns=" + effectivePatterns.length)
    }

    ensureSpaceGitRepo(git, spacePath, steps)

    const nextState = buildAssemblyState({
      type: effectiveType,
      schema: assembly.schemaName,
      ontology: ontology.name,
      include: selectionState?.include ?? [],
      exclude: selectionState?.exclude ?? [],
      private: selectionState?.private ?? [],
    } satisfies BuildStateInput)
    const transaction = transactAssemblyState({ spacePath, expectedRaw: previous.raw, state: nextState }, git)
    step(
      steps,
      "snapshot",
      transaction.changed ? (previous.raw === null ? "created" : "updated") : "reused",
      "type=" +
        effectiveType +
        " schema=" +
        assembly.schemaName +
        " changed=" +
        transaction.changed +
        " committed=" +
        transaction.committed +
        " pruned=" +
        dropped.length,
    )

    const registration = registerSpace(context.wopalHome, {
      name,
      path: spacePath,
      ontology: ontology.name,
      branch,
      type: effectiveType,
      ...(request.input.displayName !== undefined ? { displayName: request.input.displayName } : {}),
      createdAt: context.now().toISOString(),
    })
    step(
      steps,
      "register",
      registration === "created" ? "created" : registration === "renamed" ? "updated" : "reused",
      "name=" + name,
    )

    return {
      condition: detection.condition,
      finalCondition: "noop",
      type: effectiveType,
      branch,
      steps,
      prunedSelections: dropped,
      state: nextState,
    }
  } catch (error) {
    rollbackWorktree(context, { path: spacePath }, detection)
    throw error
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((value) => set.has(value))
}
