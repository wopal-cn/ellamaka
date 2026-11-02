import { existsSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  alwaysAssembledPatterns,
  materializationPatterns,
  parseArchetypeDocument,
  pluginNamesInSection,
  readArchetype,
  resolveCapabilityRef,
  resolveGenericPathRef,
  type ArchetypeManifest,
  type ResolvedCapabilityRef,
} from "./assembly"
import { capabilityKindFromSingular, type CapabilityKind } from "./capability-kinds"
import { computeSparsePatterns, trackedInWorktree } from "./assembly-ops"
import { tryGit, type GitRunner } from "./git"
import { alignSpaceConfig, declaredPluginNamesFromSettings, spacePluginSpecs } from "./local-config"
import { editManifestList, editManifestPlugin, onlyFieldChanged, verifyManifestEdit } from "./manifest-edit"
import { applySelectionTransaction, commitPendingState } from "./assembly-ops"
import { mountPatternPaths, repositoryPathForCapabilityRef, shadowedPaths, withSelection } from "./selection"
import { canonicalCapabilityRef, serializeAssemblyState } from "./selection"
import { readAssemblyState, writeAssemblyStateBytes } from "./snapshot"
import { applySparsePatterns, listSparsePatterns } from "./sparse"
import { SpaceServiceError, spaceErrorCodes } from "./types"
import type { RegisteredSpace, SpaceAssemblyState } from "./types"

/**
 * Space capability selection mutation.
 *
 * Two channels, two commit boundaries:
 *  - shared: edit the Space's archetype manifest (and, for plugins, the
 *    local settings file) so the capability materializes from the branch
 *    tree and uploads with the next sync;
 *  - local: record an include/exclude/private selection in the tracked
 *    snapshot and commit only that file in the Space root repository. The
 *    archetype manifest is never edited.
 *
 * Preview performs zero writes; apply recomputes the same plan immediately
 * before its first mutation.
 */

export interface CapabilityInput {
  readonly references: readonly string[]
  readonly local?: boolean
  readonly section?: string
  readonly confirm: boolean
}

export interface CapabilityItemResult {
  readonly reference: string
  readonly capabilityPath: string
  readonly selection: "include" | "exclude" | "private" | "none"
  readonly warnings: readonly string[]
}

export interface CapabilityResult {
  readonly confirm: boolean
  readonly operation: "add" | "remove"
  readonly local: boolean
  readonly type: string
  readonly items: readonly CapabilityItemResult[]
  readonly stateCommit?: string
  readonly capabilities: {
    readonly agents: readonly string[]
    readonly skills: readonly string[]
    readonly rules: readonly string[]
    readonly commands: readonly string[]
    readonly plugins: readonly string[]
    readonly paths: readonly string[]
  }
}

export interface CapabilityContext {
  readonly git: GitRunner
  readonly space: RegisteredSpace
  readonly ontologyPath: string
}

interface ResolvedReference {
  readonly kind: string
  readonly category: string | null
  readonly resolved: ResolvedCapabilityRef
  readonly section: string | null
}

function resolveKind(input: {
  kind: string
  category: string | null
  resolved: ResolvedCapabilityRef
  section: string | null
}): ResolvedReference {
  return {
    kind: input.kind,
    category: input.category,
    resolved: input.resolved,
    section: input.section,
  }
}

/** Split "kind:target" into a resolvable reference. */
function parseReference(reference: string): { kind: string; name: string } {
  const colon = reference.indexOf(":")
  if (colon <= 0) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.capabilitySpecInvalid,
      message: "Capability reference " + JSON.stringify(reference) + ' must use the "<kind>:<target>" form',
      suggestion: 'Use e.g. "skill:dev-flow", "rule:typescript.md" or "path:dsh".',
    })
  }
  return { kind: reference.slice(0, colon), name: reference.slice(colon + 1) }
}

function categoryFor(kind: string): CapabilityKind | null | undefined {
  if (kind === "path") return null
  return Object.hasOwn(capabilityKindFromSingular, kind) ? capabilityKindFromSingular[kind] : undefined
}

function resolveAgainstPool(ontologyPath: string, reference: string, section: string | null): ResolvedReference {
  const { kind, name } = parseReference(reference)
  const category = categoryFor(kind)
  if (category === undefined) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.capabilityInvalid,
      message: "Unknown capability kind " + JSON.stringify(kind),
      suggestion: "Valid kinds: agent, skill, rule, command, plugin, path",
    })
  }
  if (category !== "plugins" && section !== null) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.capabilitySpecInvalid,
      message: "A settings section only applies to plugin selections",
      suggestion: "Drop the section for non-plugin references.",
    })
  }
  const resolved =
    category === null ? resolveGenericPathRef(ontologyPath, name) : resolveCapabilityRef(ontologyPath, category, name)
  return resolveKind({ kind, category, resolved, section: category === "plugins" ? (section ?? "ellamaka") : null })
}

/**
 * Refuse an edit that would change more than the intended field or drop a
 * comment: the manifest editor is narrow, so an unfamiliar document shape is
 * rejected instead of being rewritten.
 */
function checkedEdit(before: string, after: string, key: string): string {
  const problem = verifyManifestEdit(before, after, (previous, next) => onlyFieldChanged(previous, next, key))
  if (problem !== null) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.capabilitySpecInvalid,
      message: "The Space manifest cannot be edited safely: " + problem,
      suggestion:
        "Edit the archetype manifest by hand, or restore the standard block-list shape, then retry. No changes were applied.",
    })
  }
  return after
}

/** The canonical selection identity of a resolved reference. */
function selectionRefFor(reference: ResolvedReference): string {
  return canonicalCapabilityRef(reference.kind + ":" + reference.resolved.ref)
}

function spaceType(spacePath: string): string {
  const reading = readAssemblyState(spacePath)
  if (reading.status !== "ok") {
    throw new SpaceServiceError({
      code: reading.status === "missing" ? spaceErrorCodes.metaMissing : spaceErrorCodes.metaInvalid,
      message:
        reading.status === "missing"
          ? "This space has no assembly state at " + reading.path
          : "This space's assembly state is invalid at " + reading.path + ": " + reading.reason,
      suggestion: "Re-run space.init to rebuild the Space assembly state.",
    })
  }
  return reading.state.type
}

function declaredNames(
  manifest: ArchetypeManifest,
  category: string | null,
  section: string | null,
): readonly string[] {
  if (category === null) return manifest.paths
  switch (category) {
    case "plugins":
      return pluginNamesInSection(manifest, section ?? "ellamaka")
    case "agents":
      return manifest.agents
    case "skills":
      return manifest.skills
    case "rules":
      return manifest.rules
    case "commands":
      return manifest.commands
    default:
      return []
  }
}

function manifestRaw(worktree: string, type: string): string {
  const path = join(worktree, "assembly", "archetypes", type + ".yaml")
  try {
    return readFileSync(path, "utf8")
  } catch {
    throw new SpaceServiceError({
      code: spaceErrorCodes.archetypeMissing,
      message: "No archetype manifest for type " + JSON.stringify(type) + " in the Space worktree",
      suggestion: "Re-run space.init to materialize the archetype manifest.",
    })
  }
}

/** Capability lists reported after the operation. */
function capabilityLists(worktree: string, type: string): CapabilityResult["capabilities"] {
  let manifest: ArchetypeManifest
  try {
    const outcome = parseArchetypeDocument(
      readFileSync(join(worktree, "assembly", "archetypes", type + ".yaml"), "utf8"),
    )
    if (!outcome.ok) throw new Error(outcome.reason ?? "invalid manifest")
    manifest = outcome.manifest
  } catch {
    return { agents: [], skills: [], rules: [], commands: [], plugins: [], paths: [] }
  }
  return {
    agents: [...manifest.agents],
    skills: [...manifest.skills],
    rules: [...manifest.rules],
    commands: [...manifest.commands],
    plugins: Object.values(manifest.plugins).flat(),
    paths: [...manifest.paths],
  }
}

/** Selection entries covering a resolved reference, by repository path. */
function coveringEntries(entries: readonly string[], resolved: ResolvedCapabilityRef): string[] {
  return entries.filter((ref) => {
    const path = repositoryPathForCapabilityRef(ref)
    return path === resolved.path || path.startsWith(resolved.path + "/")
  })
}

interface PlannedItem {
  readonly reference: string
  readonly capabilityPath: string
  readonly selection: CapabilityItemResult["selection"]
  readonly warnings: string[]
  readonly nextManifest?: string
  readonly nextState?: SpaceAssemblyState
  readonly nextPatterns?: string[]
  readonly alignPlugins?: { section: string }
  readonly removeArtifacts?: string[]
}

interface Plan {
  readonly type: string
  readonly local: boolean
  readonly items: PlannedItem[]
  /**
   * Manifest accumulated across every reference in the request. Present only when at
   * least one reference changed it, so apply persists the whole request in a single
   * write instead of the first item's intermediate edit.
   */
  readonly finalManifest?: string
}

function planAdd(
  context: CapabilityContext,
  reference: ResolvedReference,
  local: boolean,
  state: SpaceAssemblyState,
  manifest: ArchetypeManifest,
  raw: string,
): PlannedItem {
  const worktree = join(context.space.path, ".wopal")
  const isDeclared = declaredNames(manifest, reference.category, reference.section).some(
    (entry) => entry === reference.resolved.ref,
  )
  const shadowed = coveringEntries(state.exclude, reference.resolved)
  const alreadyLocal = coveringEntries([...state.include, ...state.private], reference.resolved)

  if (local) {
    if (isDeclared && shadowed.length === 0) {
      throw new SpaceServiceError({
        code: spaceErrorCodes.capabilitySpecInvalid,
        message: 'Capability "' + reference.resolved.ref + '" is already declared in this Space archetype manifest',
        suggestion: "It is shared-held; remove it locally to shadow it, or use the shared channel.",
      })
    }
    let nextState = state
    for (const entry of shadowed) nextState = withSelection(nextState, "exclude", entry, { remove: true })
    let selection: CapabilityItemResult["selection"] = "none"
    if (!isDeclared && alreadyLocal.length === 0) {
      const shared = trackedInWorktree(context.git, worktree, reference.resolved.path)
      nextState = withSelection(nextState, shared ? "include" : "private", selectionRefFor(reference))
      selection = shared ? "include" : "private"
    }
    const patterns = changedPatterns(context, nextState, manifest)
    return {
      reference: selectionRefFor(reference),
      capabilityPath: reference.resolved.path,
      selection,
      warnings: [],
      nextState,
      nextPatterns: patterns,
    }
  }

  if (isDeclared && shadowed.length === 0) {
    return {
      reference: selectionRefFor(reference),
      capabilityPath: reference.resolved.path,
      selection: "none",
      warnings: [],
    }
  }

  if (reference.category === "plugins") {
    const owner = Object.entries(manifest.plugins).find(
      ([section, names]) => section !== (reference.section ?? "ellamaka") && names.includes(reference.resolved.ref),
    )
    if (owner !== undefined) {
      throw new SpaceServiceError({
        code: spaceErrorCodes.capabilitySpecInvalid,
        message: 'Plugin "' + reference.resolved.ref + '" is already assembled to type "' + owner[0] + '"',
        suggestion: "A plugin belongs to exactly one assembly type; remove it there first.",
      })
    }
  }

  const baseline = materializationPatterns(context.ontologyPath, manifest)
  const nextManifest = isDeclared
    ? raw
    : checkedEdit(
        raw,
        reference.category === "plugins"
          ? editManifestPlugin(raw, reference.section ?? "ellamaka", reference.resolved.ref, "add")
          : editManifestList(raw, reference.category ?? "paths", reference.resolved.ref, "add"),
        reference.category ?? "paths",
      )
  let nextState = state
  for (const entry of shadowed) nextState = withSelection(nextState, "exclude", entry, { remove: true })
  const patterns = computeEffective(
    baseline,
    manifest,
    [...mountPatternPaths(nextState), ...patternInputs(reference.resolved)],
    shadowedPaths(nextState),
  )
  return {
    reference: selectionRefFor(reference),
    capabilityPath: reference.resolved.path,
    selection: "none",
    warnings: [],
    nextManifest,
    nextState,
    nextPatterns: patterns,
    ...(reference.category === "plugins" && !isDeclared
      ? { alignPlugins: { section: reference.section ?? "ellamaka" } }
      : {}),
  }
}

function planRemove(
  context: CapabilityContext,
  reference: ResolvedReference,
  local: boolean,
  state: SpaceAssemblyState,
  manifest: ArchetypeManifest,
  raw: string,
): PlannedItem {
  const worktree = join(context.space.path, ".wopal")
  const isDeclared = declaredNames(manifest, reference.category, reference.section).some(
    (entry) => entry === reference.resolved.ref,
  )

  if (local) {
    if (isDeclared) {
      let nextState = state
      for (const entry of coveringEntries(state.exclude, reference.resolved))
        nextState = withSelection(nextState, "exclude", entry, { remove: true })
      nextState = withSelection(nextState, "exclude", selectionRefFor(reference))
      return {
        reference: selectionRefFor(reference),
        capabilityPath: reference.resolved.path,
        selection: "exclude",
        warnings: [],
        nextState,
        nextPatterns: changedPatterns(context, nextState, manifest),
      }
    }
    let nextState = state
    for (const entry of coveringEntries([...state.include, ...state.private], reference.resolved)) {
      const collection = state.include.includes(entry) ? "include" : "private"
      nextState = withSelection(nextState, collection, entry, { remove: true })
    }
    return {
      reference: selectionRefFor(reference),
      capabilityPath: reference.resolved.path,
      selection: "none",
      warnings: [],
      nextState,
      nextPatterns: changedPatterns(context, nextState, manifest),
    }
  }

  if (!isDeclared) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.capabilitySpecInvalid,
      message: 'Capability "' + reference.resolved.ref + '" is not declared in this Space archetype manifest',
      suggestion: "Only declared capabilities can be removed through the shared channel.",
    })
  }

  const nextManifest = checkedEdit(
    raw,
    reference.category === "plugins"
      ? editManifestPlugin(raw, reference.section ?? "ellamaka", reference.resolved.ref, "remove")
      : editManifestList(raw, reference.category ?? "paths", reference.resolved.ref, "remove"),
    reference.category ?? "paths",
  )

  const outcome = parseArchetypeDocument(nextManifest)
  const nextManifestParsed = outcome.ok ? outcome.manifest : manifest
  const baseline = materializationPatterns(context.ontologyPath, nextManifestParsed)
  const patterns = computeEffective(
    baseline,
    nextManifestParsed,
    [...mountPatternPaths(state), ...state.private.map((ref) => repositoryPathForCapabilityRef(ref))],
    shadowedPaths(state),
  )

  const dirty = uncommittedAt(context, worktree, reference.resolved)
  const warnings = dirty
    ? ["Kept the materialized files of " + reference.resolved.ref + " because they carry uncommitted changes"]
    : []
  return {
    reference: selectionRefFor(reference),
    capabilityPath: reference.resolved.path,
    selection: "none",
    warnings,
    nextManifest,
    nextPatterns: patterns,
    ...(dirty ? {} : { removeArtifacts: materializedPaths(reference.resolved) }),
    ...(reference.category === "plugins" ? { alignPlugins: { section: reference.section ?? "ellamaka" } } : {}),
  }
}

function computeEffective(
  baseline: readonly string[],
  manifest: ArchetypeManifest,
  added: readonly string[],
  shadowed: readonly string[],
): string[] {
  const always = new Set(alwaysAssembledPatterns(manifest))
  const patterns = new Set(baseline)
  for (const path of added) patterns.add(path.startsWith("/") ? path : "/" + path)
  const kept = [...patterns].filter((pattern) => {
    if (always.has(pattern)) return true
    return !shadowed.some((entry) => {
      const base = entry.replace(/^\//, "").replace(/\/$/, "")
      const body = pattern.replace(/^\//, "").replace(/\/$/, "")
      return body === base || body.startsWith(base + "/")
    })
  })
  return kept.sort()
}

function changedPatterns(context: CapabilityContext, state: SpaceAssemblyState, manifest: ArchetypeManifest): string[] {
  return computeSparsePatterns(
    context.ontologyPath,
    manifest,
    manifest.type,
    mountPatternPaths(state),
    shadowedPaths(state),
  )
}

/** Sparse-range inputs for a resolved reference (directories keep the slash). */
function patternInputs(resolved: ResolvedCapabilityRef): string[] {
  if (resolved.form === "directory") return [resolved.path + "/"]
  if (resolved.form === "set") return [...(resolved.files ?? [])]
  return [resolved.path]
}

/** Materialized repository paths a resolved reference owns. */
function materializedPaths(resolved: ResolvedCapabilityRef): string[] {
  if (resolved.form === "set") return [...(resolved.files ?? [])]
  return [resolved.path]
}

function uncommittedAt(context: CapabilityContext, worktree: string, resolved: ResolvedCapabilityRef): boolean {
  const paths = materializedPaths(resolved)
  const result = tryGit(context.git, worktree, ["status", "--porcelain", "--", ...paths])
  return result.ok && result.stdout.length > 0
}

/** Build the preview plan. Performs no write. */
export function planCapability(context: CapabilityContext, operation: "add" | "remove", input: CapabilityInput): Plan {
  if (input.references.length === 0) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.capabilitySpecInvalid,
      message: "At least one capability reference is required",
      suggestion: 'Pass references like "skill:dev-flow".',
    })
  }
  const worktree = join(context.space.path, ".wopal")
  const type = spaceType(context.space.path)
  const raw = manifestRaw(worktree, type)
  const manifest = readArchetype(worktree, type)
  const reading = readAssemblyState(context.space.path)
  if (reading.status !== "ok") {
    throw new SpaceServiceError({
      code: spaceErrorCodes.metaInvalid,
      message: "Space assembly state is unreadable: " + context.space.path,
    })
  }
  const local = input.local === true
  let manifestWork = raw
  let state: SpaceAssemblyState = reading.state
  const items: PlannedItem[] = []
  for (const reference of input.references) {
    const resolved = resolveAgainstPool(context.ontologyPath, reference, input.section ?? null)
    const workingManifest = parseArchetypeDocument(manifestWork)
    const manifestForItem = workingManifest.ok ? workingManifest.manifest : manifest
    const item =
      operation === "add"
        ? planAdd(context, resolved, local, state, manifestForItem, manifestWork)
        : planRemove(context, resolved, local, state, manifestForItem, manifestWork)
    if (item.nextManifest !== undefined) manifestWork = item.nextManifest
    if (item.nextState !== undefined) state = item.nextState
    items.push(item)
  }
  return { type, local, items, ...(manifestWork !== raw ? { finalManifest: manifestWork } : {}) }
}

/** Preview a capability mutation with zero writes. */
export function previewCapability(
  context: CapabilityContext,
  operation: "add" | "remove",
  input: CapabilityInput,
): CapabilityResult {
  const plan = planCapability(context, operation, input)
  return {
    confirm: false,
    operation,
    local: plan.local,
    type: plan.type,
    items: plan.items.map((item) => ({
      reference: item.reference,
      capabilityPath: item.capabilityPath,
      selection: item.selection,
      warnings: item.warnings,
    })),
    capabilities: capabilityLists(join(context.space.path, ".wopal"), plan.type),
  }
}

/** Apply a capability mutation; the plan is recomputed before any write. */
export function applyCapability(
  context: CapabilityContext,
  operation: "add" | "remove",
  input: CapabilityInput,
): CapabilityResult {
  const plan = planCapability(context, operation, input)
  const worktree = join(context.space.path, ".wopal")
  const manifestPath = join(worktree, "assembly", "archetypes", plan.type + ".yaml")
  const beforeRaw = readFileSync(manifestPath, "utf8")
  const beforeState = readAssemblyState(context.space.path)
  const beforeRange = listSparsePatterns(context.git, worktree)
  const nextManifest = plan.finalManifest
  const nextState = [...plan.items].reverse().find((item) => item.nextState !== undefined)?.nextState
  const nextPatterns = [...plan.items].reverse().find((item) => item.nextPatterns !== undefined)?.nextPatterns
  let stateCommit: string | undefined

  try {
    if (nextManifest !== undefined) {
      writeFileSync(manifestPath, nextManifest, "utf8")
    }

    const stateChanged =
      nextState !== undefined &&
      beforeState.status === "ok" &&
      serializeAssemblyState(nextState) !== serializeAssemblyState(beforeState.state)

    if (stateChanged && nextState !== undefined) {
      const transaction = applySelectionTransaction(context.git, {
        ontologyPath: context.ontologyPath,
        worktree,
        spacePath: context.space.path,
        type: plan.type,
        nextState,
        expectedRaw: beforeState.status === "ok" ? beforeState.raw : null,
        failureCode: spaceErrorCodes.capabilityFailed,
      })
      if (transaction.changed) {
        stateCommit = commitPendingState(
          context.git,
          context.space.path,
          readAssemblyState(context.space.path).status === "ok" ? currentRaw(context.space.path) : null,
        ).commit
      }
    } else if (nextPatterns !== undefined && nextPatterns.length > 0) {
      applySparsePatterns(context.git, worktree, nextPatterns)
    }

    for (const item of plan.items) {
      for (const path of item.removeArtifacts ?? []) {
        removeMaterialized(worktree, path)
      }
      if (item.alignPlugins !== undefined) {
        const manifest = readArchetype(worktree, plan.type)
        const desired = spacePluginSpecs(
          declaredPluginNamesFromSettings(readText(join(worktree, "config", "settings.jsonc"))),
          manifest,
        )
        const aligned = alignSpaceConfig(worktree, desired)
        if (!aligned.ok) {
          throw new SpaceServiceError({
            code: spaceErrorCodes.capabilityFailed,
            message: aligned.error ?? "Local plugin configuration could not be aligned",
          })
        }
      }
    }

    return {
      confirm: true,
      operation,
      local: plan.local,
      type: plan.type,
      items: plan.items.map((item) => ({
        reference: item.reference,
        capabilityPath: item.capabilityPath,
        selection: item.selection,
        warnings: [...item.warnings],
      })),
      ...(stateCommit !== undefined ? { stateCommit } : {}),
      capabilities: capabilityLists(worktree, plan.type),
    }
  } catch (error) {
    // Recovery is reported, never swallowed: a caller told that no changes were
    // kept must not be left with a sparse range that disagrees with the restored
    // manifest and snapshot.
    const recovery = recoverCapability({
      context,
      manifestPath,
      beforeRaw,
      beforeState,
      beforeRange,
      worktree,
    })
    const incomplete =
      recovery.length === 0 ? "" : " Rollback was incomplete (" + recovery.join("; ") + ")."
    if (error instanceof SpaceServiceError) {
      throw new SpaceServiceError({
        code: error.code,
        message: error.message + incomplete,
        suggestion:
          recovery.length === 0
            ? error.suggestion
            : "Recovery failed; inspect the Space manifest, snapshot and sparse range before retrying.",
      })
    }
    throw new SpaceServiceError({
      code: spaceErrorCodes.capabilityFailed,
      message: "Capability operation failed: " + (error instanceof Error ? error.message : String(error)) + incomplete,
      suggestion:
        recovery.length === 0
          ? "No changes were kept. Inspect the error above, then retry."
          : "Recovery failed; inspect the Space manifest, snapshot and sparse range before retrying.",
    })
  }
}

/** Restore the pre-operation manifest/snapshot/sparse range, reporting every leg that failed. */
export function recoverCapability(input: {
  readonly context: Pick<CapabilityContext, "git"> & { readonly space: Pick<RegisteredSpace, "path"> }
  readonly manifestPath: string
  readonly beforeRaw: string
  readonly beforeState: ReturnType<typeof readAssemblyState>
  readonly beforeRange: readonly string[]
  readonly worktree: string
}): string[] {
  const failures: string[] = []
  const attempt = (label: string, run: () => void) => {
    try {
      run()
    } catch (failure) {
      failures.push(label + ": " + (failure instanceof Error ? failure.message : String(failure)))
    }
  }
  attempt("manifest", () => writeFileSync(input.manifestPath, input.beforeRaw, "utf8"))
  const snapshotRaw = input.beforeState.status === "ok" ? input.beforeState.raw : undefined
  if (snapshotRaw !== undefined) {
    attempt("assembly snapshot", () => writeSnapshotBytes(input.context.space.path, snapshotRaw))
  }
  if (input.beforeRange.length > 0) {
    attempt("sparse range", () => applySparsePatterns(input.context.git, input.worktree, [...input.beforeRange]))
  }
  return failures
}

function removeMaterialized(worktree: string, path: string): void {
  const absolute = join(worktree, path)
  if (!existsSync(absolute)) return
  const stats = statSync(absolute, { throwIfNoEntry: false })
  if (stats === undefined) return
  if (stats.isDirectory()) {
    rmSync(absolute, { recursive: true, force: true })
    return
  }
  unlinkSync(absolute)
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

function currentRaw(spacePath: string): string | null {
  const reading = readAssemblyState(spacePath)
  return reading.status === "ok" ? reading.raw : null
}

function writeSnapshotBytes(spacePath: string, raw: string): void {
  writeAssemblyStateBytes(spacePath, raw)
}
