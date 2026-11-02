import { capabilityKindFromSingular, capabilityKindSingular } from "./capability-kinds"
import { parseCapabilityRefShape, type CapabilityRefShape } from "./assembly"
import { SpaceServiceError, spaceErrorCodes } from "./types"
import type { SpaceAssemblyState } from "./types"

/**
 * Selection references and the tracked assembly snapshot.
 *
 * A selection is a canonical "<kind>:<target>" reference. The three sets are
 * mutually exclusive and never overlap parent/child. Identity fields and the
 * selection sets are the only persisted facts; revision, timestamps and the
 * materialized capability list are recomputed from Git refs and the manifest.
 */

export const selectionCollections = ["include", "exclude", "private"] as const
export type SelectionCollection = (typeof selectionCollections)[number]

function invalidRef(ref: string, reason: string, suggestion?: string): SpaceServiceError {
  return new SpaceServiceError({
    code: spaceErrorCodes.metaSelectionInvalid,
    message: "Invalid capability reference " + JSON.stringify(ref) + ": " + reason,
    suggestion:
      suggestion ?? 'Selection references use the strict "<kind>:<target>" form, e.g. "skill:dev-flow" or "path:dsh".',
  })
}

/** Canonicalize a "<kind>:<target>" selection reference. */
export function canonicalCapabilityRef(ref: string): string {
  const colon = ref.indexOf(":")
  if (colon <= 0) throw invalidRef(ref, 'it lacks the "<kind>:" prefix')
  const kind = ref.slice(0, colon)
  const target = ref.slice(colon + 1)
  if (kind !== "path" && !Object.hasOwn(capabilityKindFromSingular, kind)) {
    throw invalidRef(ref, "unknown kind " + JSON.stringify(kind) + " (expected agent|skill|rule|command|plugin|path)")
  }
  let shape: CapabilityRefShape
  try {
    shape = parseCapabilityRefShape(target)
  } catch (error) {
    if (error instanceof SpaceServiceError) throw invalidRef(ref, error.message, error.suggestion)
    throw error
  }
  return kind + ":" + shape.ref
}

/** The repository path a canonical selection points at. */
export function repositoryPathForCapabilityRef(ref: string): string {
  const canonical = canonicalCapabilityRef(ref)
  const colon = canonical.indexOf(":")
  const kind = canonical.slice(0, colon)
  const shape = parseCapabilityRefShape(canonical.slice(colon + 1))
  if (kind === "path") return shape.target
  const plural = Object.hasOwn(capabilityKindFromSingular, kind) ? capabilityKindFromSingular[kind] : undefined
  if (plural === undefined) throw invalidRef(ref, "unknown kind")
  return plural + "/" + shape.target
}

/** Do two canonical references cover overlapping repository content? */
export function refsOverlap(a: string, b: string): boolean {
  if (a === b) return true
  const pathA = repositoryPathForCapabilityRef(a)
  const pathB = repositoryPathForCapabilityRef(b)
  return pathA.startsWith(pathB + "/") || pathB.startsWith(pathA + "/")
}

/** Is this a canonical repository-relative path? */
export function isRepositoryRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\")) return false
  if (/^[A-Za-z]:[\\/]/.test(path)) return false
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
}

export interface BuildStateInput {
  readonly type: string
  readonly schema: string
  readonly ontology: string
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
  readonly private?: readonly string[]
}

function insertSorted(values: readonly string[], value: string): string[] {
  const index = values.findIndex((entry) => entry > value)
  if (index === -1) return [...values, value]
  return [...values.slice(0, index), value, ...values.slice(index)]
}

export function withSelection(
  state: SpaceAssemblyState,
  collection: SelectionCollection,
  ref: string,
  options: { readonly remove?: boolean } = {},
): SpaceAssemblyState {
  const canonical = canonicalCapabilityRef(ref)
  if (options.remove === true) {
    return { ...state, [collection]: state[collection].filter((entry) => entry !== canonical) }
  }
  for (const other of selectionCollections) {
    for (const entry of state[other]) {
      if (entry === canonical) continue
      if (refsOverlap(entry, canonical)) {
        throw new SpaceServiceError({
          code: spaceErrorCodes.metaSelectionInvalid,
          message: "Selection reference " + JSON.stringify(canonical) + " overlaps " + JSON.stringify(entry),
          suggestion: "Select one complete asset: overlapping or parent/child references are rejected.",
        })
      }
    }
  }
  const next = { ...state, include: [] as string[], exclude: [] as string[], private: [] as string[] }
  for (const other of selectionCollections) {
    next[other] = state[other].filter((entry) => entry !== canonical)
  }
  next[collection] = insertSorted(next[collection], canonical)
  return next
}

/** Build a validated snapshot from identity inputs and selections. */
export function buildAssemblyState(input: BuildStateInput): SpaceAssemblyState {
  for (const [field, value] of [
    ["type", input.type],
    ["schema", input.schema],
    ["ontology", input.ontology],
  ] as const) {
    if (value.length === 0) {
      throw new SpaceServiceError({
        code: spaceErrorCodes.metaInvalid,
        message: "Space assembly state requires a non-empty " + field,
        suggestion: "Recreate the space with space.init.",
      })
    }
  }
  let state: SpaceAssemblyState = {
    version: 2,
    type: input.type,
    schema: input.schema,
    source: { ontology: input.ontology },
    include: [],
    exclude: [],
    private: [],
  }
  for (const collection of selectionCollections) {
    for (const ref of input[collection] ?? []) {
      state = withSelection(state, collection, ref)
    }
  }
  return state
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/** Validate a raw snapshot document, reporting the first violation. */
export function validateAssemblyState(
  raw: unknown,
): { readonly ok: true; readonly state: SpaceAssemblyState } | { readonly ok: false; readonly reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "not a JSON object" }
  if (raw.version !== 2) {
    return {
      ok: false,
      reason:
        "unsupported space-meta version " +
        JSON.stringify(raw.version) +
        " (expected 2); older snapshots are handled manually, never migrated",
    }
  }
  if (!nonEmptyString(raw.type)) return { ok: false, reason: "missing type" }
  if (!nonEmptyString(raw.schema)) return { ok: false, reason: "missing schema" }
  const source = raw.source
  if (!isRecord(source) || !nonEmptyString(source.ontology)) return { ok: false, reason: "missing source.ontology" }

  const parsed: {
    version: 2
    type: string
    schema: string
    source: { ontology: string }
    include: string[]
    exclude: string[]
    private: string[]
  } = {
    version: 2,
    type: raw.type,
    schema: raw.schema,
    source: { ontology: source.ontology },
    include: [],
    exclude: [],
    private: [],
  }

  const seen = new Map<string, SelectionCollection>()
  for (const collection of selectionCollections) {
    const value = raw[collection]
    if (!Array.isArray(value)) return { ok: false, reason: 'missing selection set "' + collection + '"' }
    for (const entry of value) {
      if (typeof entry !== "string") {
        return { ok: false, reason: 'selection "' + collection + '" contains a non-string entry' }
      }
      let canonical: string
      try {
        canonical = canonicalCapabilityRef(entry)
      } catch (error) {
        return {
          ok: false,
          reason:
            'selection "' +
            collection +
            '" entry ' +
            JSON.stringify(entry) +
            " is invalid: " +
            (error instanceof Error ? error.message : "unknown"),
        }
      }
      if (canonical !== entry) {
        return {
          ok: false,
          reason:
            'selection "' +
            collection +
            '" entry ' +
            JSON.stringify(entry) +
            " is not canonical (use " +
            JSON.stringify(canonical) +
            ")",
        }
      }
      const previous = seen.get(canonical)
      if (previous !== undefined) {
        return {
          ok: false,
          reason:
            previous === collection
              ? 'selection "' + canonical + '" appears twice in "' + collection + '"'
              : 'selection "' + canonical + '" appears in both "' + previous + '" and "' + collection + '"',
        }
      }
      seen.set(canonical, collection)
      parsed[collection].push(canonical)
    }
  }

  for (const [ref, collection] of seen) {
    for (const [other, otherCollection] of seen) {
      if (other === ref) continue
      if (refsOverlap(ref, other)) {
        return {
          ok: false,
          reason: 'selection "' + ref + '" (' + collection + ') overlaps "' + other + '" (' + otherCollection + ")",
        }
      }
    }
  }

  return { ok: true, state: parsed }
}

/** Canonical, byte-stable serialization (fixed key order, sorted sets). */
export function serializeAssemblyState(state: SpaceAssemblyState): string {
  const document = {
    version: state.version,
    type: state.type,
    schema: state.schema,
    source: { ontology: state.source.ontology },
    include: [...state.include].sort(),
    exclude: [...state.exclude].sort(),
    private: [...state.private].sort(),
  }
  return JSON.stringify(document, null, 2) + "\n"
}

/** The sparse-range input form of the mount selections. */
export function mountPatternPaths(state: SpaceAssemblyState): string[] {
  return [...state.include, ...state.private].map((ref) => {
    const path = repositoryPathForCapabilityRef(ref)
    const shape = parseCapabilityRefShape(ref.slice(ref.indexOf(":") + 1))
    return shape.form === "directory" ? path + "/" : path
  })
}

/** The shadowed repository paths of the exclude selections. */
export function shadowedPaths(state: SpaceAssemblyState): string[] {
  return state.exclude.map((ref) => repositoryPathForCapabilityRef(ref))
}

/** The singular kind of a canonical reference. */
export function selectionKind(ref: string): string {
  return canonicalCapabilityRef(ref).slice(0, canonicalCapabilityRef(ref).indexOf(":"))
}

export { capabilityKindSingular }
