import { existsSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  alwaysAssembledPatterns,
  materializationPatterns,
  parseArchetypeDocument,
  parseCapabilityRefShape,
  pluginNamesInSection,
  readArchetype,
  resolveCapabilityRef,
  resolveGenericPathRef,
  type ArchetypeManifest,
  type ResolvedCapabilityRef,
} from "./assembly"
import { capabilityKindFromSingular, type CapabilityKind } from "./capability-kinds"
import { inspectWorktreeAsset, type WorktreeAsset } from "./candidate"
import { treeFallback } from "./assembly-tree"
import { currentBranch, listCommits, revParse, tryGit, type GitRunner } from "./git"
import { alignSpaceConfig, declaredPluginNamesFromSettings, spacePluginSpecs } from "./local-config"
import { editManifestList, editManifestPlugin, onlyFieldChanged, verifyManifestEdit } from "./manifest-edit"
import { applySelectionTransaction } from "./assembly-ops"
import { mountPatternPaths, repositoryPathForCapabilityRef, shadowedPaths, withSelection } from "./selection"
import { canonicalCapabilityRef, serializeAssemblyState } from "./selection"
import { applySparsePatterns, listSparsePatterns } from "./sparse"
import { readAssemblyState, requireWritableState, writeAssemblyStateBytes } from "./snapshot"
import { SpaceServiceError, spaceErrorCodes } from "./types"
import type { RegisteredSpace, SpaceAssemblyState } from "./types"

/**
 * Space capability selection mutation.
 *
 * Three independent facts drive the result:
 *  - the shared capability pool: tracked content in ontology Git;
 *  - the type default: the Space archetype manifest;
 *  - this Space's overrides: `include` (extra mount) and `exclude` (local stop).
 *
 * `add` also adopts a complete new asset that already exists in this Space's
 * worktree: it widens the sparse range, stages exactly that asset's files and
 * commits them on the Space branch, then applies the requested assembly. The
 * ontology content commit and the Space root state commit are separate
 * boundaries and are reported separately; a failure after one of them landed
 * is reported as a partial commit, never as a full rollback.
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
  readonly selection: "include" | "exclude" | "none"
  readonly warnings: readonly string[]
}

export interface CapabilityResult {
  readonly confirm: boolean
  readonly operation: "add" | "remove"
  readonly local: boolean
  readonly type: string
  readonly items: readonly CapabilityItemResult[]
  /** Space root repository commit that recorded the selection change. */
  readonly stateCommit?: string
  /** Space branch commit that adopted new capability content. */
  readonly ontologyCommit?: string
  /** True when this operation left branch content that still needs `space sync`. */
  readonly syncPending: boolean
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
  readonly category: CapabilityKind | null
  readonly resolved: ResolvedCapabilityRef
  readonly section: string | null
  /** Set when the identity only exists as a complete new asset in the worktree. */
  readonly adoption?: WorktreeAsset
}

function resolveKind(input: {
  kind: string
  category: CapabilityKind | null
  resolved: ResolvedCapabilityRef
  section: string | null
  adoption?: WorktreeAsset
}): ResolvedReference {
  return {
    kind: input.kind,
    category: input.category,
    resolved: input.resolved,
    section: input.section,
    ...(input.adoption === undefined ? {} : { adoption: input.adoption }),
  }
}

/**
 * Cached Space-branch tree reader for one capability operation.
 *
 * A batch request can miss the pool several times; read the branch tree once
 * instead of shelling out per reference.
 */
function branchTree(
  context: CapabilityContext,
): (category: CapabilityKind | null, ref: string) => ResolvedCapabilityRef | null {
  let fallback: ReturnType<typeof treeFallback> | undefined
  return (category, ref) => {
    fallback ??= treeFallback(join(context.space.path, ".wopal"), "HEAD", context.git)
    return fallback(category, ref)
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

/** The repository path a reference names inside an ontology or worktree root. */
function targetPath(category: CapabilityKind | null, target: string): string {
  return category === null ? target : category + "/" + target
}

/**
 * Resolve a reference against the ontology pool, falling back to a complete
 * new asset in the Space worktree. A pool identity always wins: adoption is
 * only for identities the pool does not have.
 */
function resolveReference(context: CapabilityContext, reference: string, section: string | null): ResolvedReference {
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
  const sectionValue = category === "plugins" ? (section ?? "ellamaka") : null
  const worktree = join(context.space.path, ".wopal")
  const shape = parseCapabilityRefShape(name)
  const poolTarget = join(context.ontologyPath, targetPath(category, shape.target))
  if (statSync(poolTarget, { throwIfNoEntry: false }) !== undefined) {
    const resolved =
      category === null
        ? resolveGenericPathRef(context.ontologyPath, name)
        : resolveCapabilityRef(context.ontologyPath, category, name)
    return resolveKind({ kind, category, resolved, section: sectionValue })
  }

  const inspection = inspectWorktreeAsset({ worktree, category, shape })
  if (inspection.ok) {
    return resolveKind({
      kind,
      category,
      resolved: inspection.asset.resolved,
      section: sectionValue,
      adoption: inspection.asset,
    })
  }

  // Third source: content this Space already committed on its own branch.
  // A local `exclude` drops it from the sparse range, so neither the pool nor
  // the disk carries it, but the Space still owns it and must be able to
  // restore the selection without forcing `space sync`.
  const fromBranch = branchTree(context)(category, name)
  if (fromBranch !== null) {
    return resolveKind({ kind, category, resolved: fromBranch, section: sectionValue })
  }

  throw new SpaceServiceError({
    code: spaceErrorCodes.capabilityUnresolved,
    message:
      "Capability reference " +
      JSON.stringify(reference) +
      " does not exist in the ontology pool, on this Space branch, or as a complete new asset in the Space worktree: " +
      inspection.reason,
    suggestion: inspection.suggestion,
  })
}

/** Refuse an edit that would change more than the intended field or drop a comment. */
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
  readonly resolved: ResolvedCapabilityRef
  readonly selection: CapabilityItemResult["selection"]
  readonly warnings: string[]
  readonly nextManifest?: string
  readonly nextState?: SpaceAssemblyState
  readonly alignPlugins?: { section: string }
  readonly removeArtifacts?: string[]
  readonly adoption?: WorktreeAsset
}

interface Plan {
  readonly type: string
  readonly local: boolean
  readonly operation: "add" | "remove"
  readonly items: PlannedItem[]
  readonly finalManifest?: string
  readonly finalState: SpaceAssemblyState
  readonly nextPatterns: readonly string[]
  readonly adoptions: readonly WorktreeAsset[]
}

/** Ignored files inside an asset would silently drop out of the adopted content. */
function ignoredAssetFiles(context: CapabilityContext, worktree: string, asset: WorktreeAsset): string[] {
  const paths = asset.resolved.form === "directory" ? [asset.resolved.path] : [...asset.files]
  const result = tryGit(context.git, worktree, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
    "--",
    ...paths,
  ])
  if (!result.ok) return []
  return result.stdout.split("\0").filter((path) => path.length > 0)
}

/**
 * Is the whole asset already carried by the Space branch tree?
 *
 * The pool is `local main`; an asset can already be committed on this Space's
 * own branch before `space sync` publishes it. That content is shared for this
 * Space and must not be committed a second time.
 */
function assetTracked(context: CapabilityContext, worktree: string, resolved: ResolvedCapabilityRef): boolean {
  const paths = resolved.form === "set" ? (resolved.files ?? []) : [resolved.path]
  if (paths.length === 0) return false
  return paths.every((path) => tryGit(context.git, worktree, ["cat-file", "-e", "HEAD:" + path]).ok)
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
  const needsAdoption = reference.adoption !== undefined && !assetTracked(context, worktree, reference.resolved)
  if (needsAdoption && reference.adoption !== undefined) {
    const ignored = ignoredAssetFiles(context, worktree, reference.adoption)
    if (ignored.length > 0) {
      throw new SpaceServiceError({
        code: spaceErrorCodes.capabilityUnresolved,
        message:
          'The new capability "' +
          reference.resolved.ref +
          '" contains ignored or sensitive files that would not enter Git: ' +
          ignored.join(", "),
        suggestion:
          "Move or delete these files (or commit them through the normal ontology flow), then retry. No changes were applied.",
      })
    }
  }

  const isDeclared = declaredNames(manifest, reference.category, reference.section).some(
    (entry) => entry === reference.resolved.ref,
  )
  const shadowed = coveringEntries(state.exclude, reference.resolved)
  const alreadyLocal = coveringEntries(state.include, reference.resolved)
  const adoption = needsAdoption && reference.adoption !== undefined ? { adoption: reference.adoption } : {}

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
      nextState = withSelection(nextState, "include", selectionRefFor(reference))
      selection = "include"
    }
    return {
      reference: selectionRefFor(reference),
      capabilityPath: reference.resolved.path,
      resolved: reference.resolved,
      selection,
      warnings: [],
      nextState,
      ...adoption,
    }
  }

  if (isDeclared && shadowed.length === 0) {
    return {
      reference: selectionRefFor(reference),
      capabilityPath: reference.resolved.path,
      resolved: reference.resolved,
      selection: "none",
      warnings: [],
      ...adoption,
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
  return {
    reference: selectionRefFor(reference),
    capabilityPath: reference.resolved.path,
    resolved: reference.resolved,
    selection: "none",
    warnings: [],
    nextManifest,
    nextState,
    ...adoption,
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
        resolved: reference.resolved,
        selection: "exclude",
        warnings: [],
        nextState,
      }
    }
    let nextState = state
    for (const entry of coveringEntries(state.include, reference.resolved)) {
      nextState = withSelection(nextState, "include", entry, { remove: true })
    }
    return {
      reference: selectionRefFor(reference),
      capabilityPath: reference.resolved.path,
      resolved: reference.resolved,
      selection: "none",
      warnings: [],
      nextState,
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

  const dirty = uncommittedAt(context, worktree, reference.resolved)
  const warnings = dirty
    ? ["Kept the materialized files of " + reference.resolved.ref + " because they carry uncommitted changes"]
    : []
  return {
    reference: selectionRefFor(reference),
    capabilityPath: reference.resolved.path,
    resolved: reference.resolved,
    selection: "none",
    warnings,
    nextManifest,
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
  const state = requireWritableState(context.space.path).state
  const type = state.type
  const raw = manifestRaw(worktree, type)
  const manifest = readArchetype(worktree, type)
  const local = input.local === true
  // Content this Space already committed on its branch is shared for this
  // Space even before `space sync`, and it is the only copy once a local
  // exclude drops it from disk. Resolve through all three sources.
  const fallbacks = { fallbackRoot: worktree, fallbackTree: treeFallback(worktree, "HEAD", context.git) }
  const baseline = operation === "add" ? materializationPatterns(context.ontologyPath, manifest, fallbacks) : []
  let manifestWork = raw
  let stateWork: SpaceAssemblyState = state
  const items: PlannedItem[] = []
  for (const reference of input.references) {
    const resolved = resolveReference(context, reference, input.section ?? null)
    const workingManifest = parseArchetypeDocument(manifestWork)
    const manifestForItem = workingManifest.ok ? workingManifest.manifest : manifest
    const item =
      operation === "add"
        ? planAdd(context, resolved, local, stateWork, manifestForItem, manifestWork)
        : planRemove(context, resolved, local, stateWork, manifestForItem, manifestWork)
    if (item.nextManifest !== undefined) manifestWork = item.nextManifest
    if (item.nextState !== undefined) stateWork = item.nextState
    items.push(item)
  }

  const finalManifest = manifestWork === raw ? undefined : manifestWork
  const effectiveManifest = finalManifest === undefined ? manifest : parseManifestOr(finalManifest, manifest)
  const additions =
    operation === "add"
      ? [...mountPatternPaths(stateWork), ...items.flatMap((item) => patternInputs(item.resolved))]
      : [...mountPatternPaths(stateWork)]
  const nextPatterns =
    operation === "add"
      ? computeEffective(baseline, manifest, additions, shadowedPaths(stateWork))
      : computeEffective(
          materializationPatterns(context.ontologyPath, effectiveManifest, fallbacks),
          effectiveManifest,
          additions,
          shadowedPaths(stateWork),
        )

  return {
    type,
    local,
    operation,
    items,
    ...(finalManifest === undefined ? {} : { finalManifest }),
    finalState: stateWork,
    nextPatterns,
    adoptions: items.flatMap((item) => (item.adoption === undefined ? [] : [item.adoption])),
  }
}

function parseManifestOr(raw: string, fallback: ArchetypeManifest): ArchetypeManifest {
  const outcome = parseArchetypeDocument(raw)
  return outcome.ok ? outcome.manifest : fallback
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
    syncPending: plan.adoptions.length > 0 || syncPending(context),
    capabilities: capabilityLists(join(context.space.path, ".wopal"), plan.type),
  }
}

/** Does the Space branch carry commits that `space sync` has not published yet? */
function syncPending(context: CapabilityContext): boolean {
  return listCommits(context.git, context.ontologyPath, "main", context.space.branch).length > 0
}

function unionPatterns(current: readonly string[], next: readonly string[]): string[] {
  return [...new Set([...current, ...next])].sort()
}

interface AdoptedContentInput {
  readonly git: GitRunner
  readonly worktree: string
  readonly files: readonly string[]
  readonly manifestPath?: string
  readonly message: string
}

/**
 * Stage exactly the adopted asset files (plus the manifest edit this same
 * operation made) and commit them on the Space branch. Never stages anything
 * else: `git add -A` would sweep unrelated worktree changes into the commit.
 */
function commitAdoptedContent(input: AdoptedContentInput): string {
  const paths = [...new Set([...input.files, ...(input.manifestPath === undefined ? [] : [input.manifestPath])])].sort()
  const staged = tryGit(input.git, input.worktree, ["add", "--", ...paths])
  if (!staged.ok) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.capabilityFailed,
      message: "Failed to stage the adopted capability content: " + staged.stderr,
      suggestion: "Check the Space worktree Git state, then retry. No commit was created.",
    })
  }
  const commit = tryGit(input.git, input.worktree, ["commit", "-q", "-m", input.message, "--", ...paths])
  if (!commit.ok) {
    tryGit(input.git, input.worktree, ["restore", "--staged", "--", ...paths])
    throw new SpaceServiceError({
      code: spaceErrorCodes.capabilityFailed,
      message: "Failed to commit the adopted capability content: " + commit.stderr,
      suggestion:
        "Check the Space worktree Git state and the repository user identity, then retry. No commit was created.",
    })
  }
  return revParse(input.git, input.worktree, "HEAD")
}

function adoptionMessage(plan: Plan): string {
  const refs = [...new Set(plan.adoptions.map((asset) => asset.resolved.ref.replace(/\/$/, "")))]
  return "feat(capability): adopt " + refs.join(", ")
}

/** Post-commit failure: report what already landed instead of claiming a rollback. */
function partialCommitFailure(
  error: unknown,
  input: { readonly commit: string; readonly branch: string },
): SpaceServiceError {
  const detail =
    error instanceof SpaceServiceError
      ? error.code + ": " + error.message
      : error instanceof Error
        ? error.message
        : String(error)
  return new SpaceServiceError({
    code: spaceErrorCodes.capabilityPartialCommit,
    message:
      "The capability content was already committed on " +
      input.branch +
      " as " +
      input.commit +
      ", but a later step of this operation failed (" +
      detail +
      "). The Space snapshot and its selections may still be missing that update.",
    suggestion:
      "Re-run the same capability request: it compares the branch refs, the snapshot and this run's touch-set, and performs only what is still missing. Run space sync afterwards to publish the branch content; the existing commit is never rewritten.",
  })
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
  if (beforeState.status !== "ok") {
    throw new SpaceServiceError({
      code: beforeState.status === "missing" ? spaceErrorCodes.metaMissing : spaceErrorCodes.metaInvalid,
      message: "Space assembly state is unreadable: " + context.space.path,
      suggestion: "Re-run space.init to rebuild the Space assembly state.",
    })
  }
  const beforeRange = listSparsePatterns(context.git, worktree)
  let stateCommit: string | undefined
  let ontologyCommit: string | undefined

  try {
    if (plan.finalManifest !== undefined) writeFileSync(manifestPath, plan.finalManifest, "utf8")

    if (plan.adoptions.length > 0) {
      applySparsePatterns(context.git, worktree, unionPatterns(beforeRange, plan.nextPatterns))
      ontologyCommit = commitAdoptedContent({
        git: context.git,
        worktree,
        files: plan.adoptions.flatMap((asset) => asset.files),
        ...(plan.finalManifest === undefined ? {} : { manifestPath: "assembly/archetypes/" + plan.type + ".yaml" }),
        message: adoptionMessage(plan),
      })
    }

    const stateChanged = serializeAssemblyState(plan.finalState) !== serializeAssemblyState(beforeState.state)
    if (stateChanged) {
      const transaction = applySelectionTransaction(context.git, {
        ontologyPath: context.ontologyPath,
        worktree,
        spacePath: context.space.path,
        type: plan.type,
        nextState: plan.finalState,
        expectedRaw: beforeState.raw,
        failureCode: spaceErrorCodes.capabilityFailed,
      })
      if (transaction.committed && transaction.commit !== undefined) stateCommit = transaction.commit
    } else if (plan.nextPatterns.length > 0) {
      applySparsePatterns(context.git, worktree, plan.nextPatterns)
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
      ...(ontologyCommit !== undefined ? { ontologyCommit } : {}),
      syncPending: syncPending(context),
      capabilities: capabilityLists(worktree, plan.type),
    }
  } catch (error) {
    // A commit that already landed is a durable fact: never claim it was rolled
    // back, and leave the remaining steps to an idempotent retry.
    if (ontologyCommit !== undefined) {
      throw partialCommitFailure(error, {
        commit: ontologyCommit,
        branch: currentBranch(context.git, worktree),
      })
    }
    const recovery = recoverCapability({
      context,
      manifestPath,
      beforeRaw,
      beforeState,
      beforeRange,
      worktree,
    })
    const incomplete = recovery.length === 0 ? "" : " Rollback was incomplete (" + recovery.join("; ") + ")."
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

function writeSnapshotBytes(spacePath: string, raw: string): void {
  writeAssemblyStateBytes(spacePath, raw)
}
