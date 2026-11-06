import {
  archetypeMissingError,
  capabilitySetSuffixMatches,
  genericPathCollisionFailure,
  manifestCategoryRefs,
  parseArchetypeDocument,
  parseCapabilityRefShape,
  parseArchetypeOrThrow,
  parseReferenceShape,
  parseSpaceSchemaDocument,
  resolveSchemaName,
  type ArchetypeManifest,
  type CapabilityRefShape,
  type ResolvedCapabilityRef,
  type SpaceSchema,
} from "./assembly"
import { capabilityKindFromSingular, capabilityKindSingular, type CapabilityKind } from "./capability-kinds"
import { fileAtRef, lsTreeFiles, type GitRunner } from "./git"
import { SpaceServiceError, spaceErrorCodes, type SpaceAssemblyState } from "./types"
import { canonicalCapabilityRef } from "./selection"

/**
 * Assembly facts read from a commit instead of the ontology working tree.
 *
 * A repeated init reassembles an existing Space from its own branch: the
 * manifest, schema, templates, shared settings and declared references all
 * come from the branch tip. The host checkout may legitimately differ, so
 * reading it would write the wrong facts into the Space.
 */

export interface AssemblyTreeFacts {
  readonly repoPath: string
  readonly ref: string
  readonly files: ReadonlySet<string>
  readonly directories: ReadonlySet<string>
}

/** Directories implied by a committed file list. */
export function impliedDirectories(files: readonly string[]): Set<string> {
  const directories = new Set<string>()
  for (const file of files) {
    let index = file.indexOf("/")
    while (index > 0) {
      directories.add(file.slice(0, index))
      index = file.indexOf("/", index + 1)
    }
  }
  return directories
}

export function readAssemblyTree(repoPath: string, ref: string, git: GitRunner): AssemblyTreeFacts {
  const files = new Set(lsTreeFiles(git, repoPath, ref))
  return { repoPath, ref, files, directories: impliedDirectories([...files]) }
}

export function readTreeFile(facts: AssemblyTreeFacts, path: string, git: GitRunner): string | null {
  return fileAtRef(git, facts.repoPath, facts.ref, path)
}

function typesFromTree(facts: AssemblyTreeFacts, git: GitRunner): string[] {
  const types: string[] = []
  for (const file of facts.files) {
    if (!file.startsWith("assembly/archetypes/") || !file.endsWith(".yaml")) continue
    if (file.slice("assembly/archetypes/".length).includes("/")) continue
    const raw = readTreeFile(facts, file, git)
    if (raw === null) continue
    const outcome = parseArchetypeDocument(raw)
    if (outcome.ok) types.push(outcome.manifest.type)
  }
  return types.sort((a, b) => a.localeCompare(b))
}

export function readArchetypeFromTree(facts: AssemblyTreeFacts, type: string, git: GitRunner): ArchetypeManifest {
  const path = "assembly/archetypes/" + type + ".yaml"
  const raw = readTreeFile(facts, path, git)
  if (raw === null) {
    throw archetypeMissingError(type, 'ref "' + facts.ref + '"', typesFromTree(facts, git))
  }
  return parseArchetypeOrThrow(raw, "git:" + facts.ref + ":" + path)
}

export function readSpaceSchemaFromTree(facts: AssemblyTreeFacts, schemaName: string, git: GitRunner): SpaceSchema {
  const path = "assembly/schemas/" + schemaName
  const raw = readTreeFile(facts, path, git)
  if (raw === null) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.schemaMissing,
      message: 'No space schema "' + schemaName + '" in ref "' + facts.ref + '"',
      suggestion: "Check the archetype schema field, or add the schema under assembly/schemas/",
    })
  }
  return parseSpaceSchemaDocument(raw, "git:" + facts.ref + ":" + path)
}

export function readTemplateFromTree(facts: AssemblyTreeFacts, template: string, git: GitRunner): string | null {
  return readTreeFile(facts, "assembly/templates/" + template, git)
}

/** Schema templates the ref does not provide. */
export function findMissingTemplatesFromTree(facts: AssemblyTreeFacts, schema: SpaceSchema): string[] {
  const missing = new Set<string>()
  for (const entry of [...schema.runtime.files, ...schema.space.files]) {
    if (entry.template === "BOOTSTRAP.md") continue
    if (!facts.files.has("assembly/templates/" + entry.template)) missing.add(entry.template)
  }
  return [...missing].sort()
}

/** Does a committed tree satisfy one strictly shaped reference? */
export function treeReferenceProblem(
  files: ReadonlySet<string>,
  directories: ReadonlySet<string>,
  prefix: string,
  shape: CapabilityRefShape,
): string | null {
  const target = prefix + shape.target
  if (shape.form === "directory") {
    if (directories.has(target)) return null
    if (files.has(target)) return '"' + target + '" is a file, not a directory'
    return 'no directory matches "' + target + '"'
  }
  if (shape.form === "set") {
    const suffix = shape.setSuffix ?? ""
    const matched = [...files].some((file) => {
      if (!file.startsWith(target + "/")) return false
      const rest = file.slice(target.length + 1)
      return !rest.includes("/") && capabilitySetSuffixMatches(suffix, rest)
    })
    if (matched) return null
    if (files.has(target)) return '"' + target + '" is a file, not a directory'
    return 'no files match the set one level under "' + target + '"'
  }
  if (files.has(target)) return null
  if (directories.has(target)) return '"' + target + '" is a directory, not a file'
  return 'no file matches "' + target + '"'
}

/** Sparse coverage of one tree reference, or a failure reason. */
function treePatterns(
  facts: AssemblyTreeFacts,
  prefix: string,
  shape: CapabilityRefShape,
): { patterns: string[] } | { problem: string } {
  const problem = treeReferenceProblem(facts.files, facts.directories, prefix, shape)
  if (problem !== null) return { problem }
  const target = prefix + shape.target
  if (shape.form === "directory") return { patterns: ["/" + target + "/"] }
  if (shape.form === "set") {
    const suffix = shape.setSuffix ?? ""
    const matched = [...facts.files].filter((file) => {
      if (!file.startsWith(target + "/")) return false
      const rest = file.slice(target.length + 1)
      return !rest.includes("/") && capabilitySetSuffixMatches(suffix, rest)
    })
    return { patterns: matched.sort().map((file) => "/" + file) }
  }
  return { patterns: ["/" + target] }
}

/**
 * Resolve one reference against a committed tree.
 *
 * The pool is `local main` and the worktree disk only holds what the current
 * sparse range materializes. Content this Space already committed on its own
 * branch is shared for this Space even before `space sync` publishes it, and
 * it stays the only copy once a local `exclude` drops the disk materialization.
 * Returns null when the tree does not carry the reference.
 */
export function resolveCapabilityRefFromTree(
  facts: AssemblyTreeFacts,
  category: CapabilityKind | null,
  ref: string,
): ResolvedCapabilityRef | null {
  const label =
    category === null
      ? "Generic path reference " + JSON.stringify(ref)
      : "Capability reference " + JSON.stringify(ref) + " (" + category + ")"
  const shape = parseReferenceShape(ref, label)
  const prefix = category === null ? "" : category + "/"
  const resolved = treePatterns(facts, prefix, shape)
  if ("problem" in resolved) return null
  const path = prefix + shape.target
  const base = { form: shape.form, ref: shape.ref, path, patterns: resolved.patterns }
  if (shape.form !== "set") return base
  const suffix = shape.setSuffix ?? ""
  const files = [...facts.files]
    .filter((file) => file.startsWith(path + "/"))
    .filter((file) => {
      const rest = file.slice(path.length + 1)
      return !rest.includes("/") && capabilitySetSuffixMatches(suffix, rest)
    })
    .sort()
  return { ...base, files, setSuffix: suffix }
}

/**
 * A `materializationPatterns` fallback that resolves against a committed tree.
 *
 * Reads the tree once per call site so a multi-reference manifest does not
 * shell out to Git for every entry.
 */
export function treeFallback(
  repoPath: string,
  ref: string,
  git: GitRunner,
): (category: CapabilityKind | null, ref: string) => ResolvedCapabilityRef | null {
  let facts: AssemblyTreeFacts | undefined
  return (category, reference) => {
    if (facts === undefined) facts = readAssemblyTree(repoPath, ref, git)
    return resolveCapabilityRefFromTree(facts, category, reference)
  }
}

/** Sparse patterns of a manifest's default assembly, read from the ref. */
export function materializationPatternsFromTree(
  facts: AssemblyTreeFacts,
  manifest: ArchetypeManifest,
  alwaysAssembled: readonly string[],
): { patterns: string[]; problems: string[] } {
  const patterns = new Set<string>(alwaysAssembled)
  const problems: string[] = []
  for (const { category, ref } of manifestCategoryRefs(manifest)) {
    const shape = parseReferenceShape(ref, "Capability reference " + JSON.stringify(ref) + " (" + category + ")")
    const resolved = treePatterns(facts, category + "/", shape)
    if ("problem" in resolved) {
      problems.push(category + ":" + ref + ": " + resolved.problem)
      continue
    }
    for (const pattern of resolved.patterns) patterns.add(pattern)
  }
  for (const ref of manifest.paths) {
    const shape = parseReferenceShape(ref, "Generic path reference " + JSON.stringify(ref))
    const collision = genericPathCollisionFailure(ref, shape)
    if (collision !== null) {
      problems.push("path:" + ref + ": " + collision.message)
      continue
    }
    const resolved = treePatterns(facts, "", shape)
    if ("problem" in resolved) {
      problems.push("path:" + ref + ": " + resolved.problem)
      continue
    }
    for (const pattern of resolved.patterns) patterns.add(pattern)
  }
  return { patterns: [...patterns].sort(), problems }
}

/** Selected additions minus shadows, keeping always-assembled members. */
export function computeEffectivePatterns(
  baseline: readonly string[],
  alwaysAssembled: readonly string[],
  addedPaths: readonly string[],
  shadowedPaths: readonly string[],
): string[] {
  const always = new Set(alwaysAssembled)
  const patterns = new Set<string>(baseline)
  for (const path of addedPaths) {
    patterns.add(path.startsWith("/") ? path : "/" + path)
  }
  const kept = [...patterns].filter((pattern) => {
    if (always.has(pattern)) return true
    return !shadowedPaths.some((shadow) => {
      const base = shadow.endsWith("/") ? shadow.slice(0, -1) : shadow
      const body = pattern.startsWith("/") ? pattern.slice(1) : pattern
      const bare = body.endsWith("/") ? body.slice(0, -1) : body
      return bare === base || bare.startsWith(base + "/")
    })
  })
  return kept.sort()
}

export interface SelectionPrune {
  readonly state: SpaceAssemblyState
  readonly dropped: string[]
}

/**
 * Drop selections a candidate tree invalidated: an exclude whose declaration
 * disappeared from the manifest, and an include whose target no longer
 * resolves. Private content is local and never pruned here. A manifest that
 * cannot be read leaves excludes untouched.
 */
export function pruneSelections(
  facts: AssemblyTreeFacts,
  type: string,
  state: SpaceAssemblyState,
  git: GitRunner,
): SelectionPrune {
  const dropped: string[] = []
  const manifestRaw = readTreeFile(facts, "assembly/archetypes/" + type + ".yaml", git)
  const manifestRefs = new Set<string>()
  let manifestReadable = false
  if (manifestRaw !== null) {
    const outcome = parseArchetypeDocument(manifestRaw)
    if (outcome.ok) {
      manifestReadable = true
      for (const { category, ref } of manifestCategoryRefs(outcome.manifest)) {
        try {
          const shape = parseReferenceShape(ref, "Capability reference " + JSON.stringify(ref))
          manifestRefs.add(canonicalCapabilityRef(capabilityKindSingular[category] + ":" + shape.ref))
        } catch {
          // An unparsable manifest entry fails tree validation elsewhere.
        }
      }
      for (const ref of outcome.manifest.paths) {
        try {
          const shape = parseReferenceShape(ref, "Generic path reference " + JSON.stringify(ref))
          manifestRefs.add(canonicalCapabilityRef("path:" + shape.ref))
        } catch {
          // same
        }
      }
    }
  }

  let next: SpaceAssemblyState = state
  for (const ref of state.exclude) {
    if (!manifestReadable) break
    let canonical: string
    try {
      canonical = canonicalCapabilityRef(ref)
    } catch {
      canonical = ref
    }
    if (!manifestRefs.has(canonical)) {
      next = { ...next, exclude: next.exclude.filter((entry) => entry !== ref) }
      dropped.push(ref)
    }
  }

  for (const ref of state.include) {
    let canonical: string
    try {
      canonical = canonicalCapabilityRef(ref)
    } catch {
      continue
    }
    const colon = canonical.indexOf(":")
    const kind = canonical.slice(0, colon)
    const shape = parseCapabilityRefShape(canonical.slice(colon + 1))
    const category = Object.hasOwn(capabilityKindFromSingular, kind) ? capabilityKindFromSingular[kind] : undefined
    const prefix = category === undefined ? "" : category + "/"
    if (treeReferenceProblem(facts.files, facts.directories, prefix, shape) !== null) {
      next = { ...next, include: next.include.filter((entry) => entry !== ref) }
      dropped.push(ref)
    }
  }

  return { state: next, dropped }
}

/** Category of a singular selection kind, or undefined. */
export function categoryOfSingular(kind: string): CapabilityKind | undefined {
  return Object.hasOwn(capabilityKindFromSingular, kind) ? capabilityKindFromSingular[kind] : undefined
}

export { resolveSchemaName }
