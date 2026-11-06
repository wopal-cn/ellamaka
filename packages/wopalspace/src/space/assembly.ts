import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { capabilityKindSingular, capabilityKinds, type CapabilityKind } from "./capability-kinds"
import { SpaceServiceError, spaceErrorCodes } from "./types"
import { parseYaml } from "./structured-text"

/**
 * Assembly definitions: the ontology's archetype manifests, space schemas
 * and the strict capability-reference syntax.
 *
 * Every function here is a pure read of an injected ontology root. Nothing
 * writes, fetches, or repairs; callers own persistence and Git.
 */

export interface ArchetypeManifest {
  readonly version: number
  readonly type: string
  readonly description?: string
  readonly schema?: string
  readonly agents: readonly string[]
  readonly skills: readonly string[]
  readonly rules: readonly string[]
  readonly commands: readonly string[]
  /** Settings section to plugin-name list; the section set is open. */
  readonly plugins: Readonly<Record<string, readonly string[]>>
  /** Generic repository-relative paths outside the capability categories. */
  readonly paths: readonly string[]
}

export interface SchemaFileEntry {
  readonly template: string
  readonly target: string
}

export interface SchemaDirEntry {
  readonly path: string
  readonly keep?: readonly string[]
}

export interface SpaceSchema {
  readonly version: number
  readonly runtime: {
    readonly path: string
    readonly files: readonly SchemaFileEntry[]
    readonly dirs: readonly SchemaDirEntry[]
  }
  readonly space: { readonly files: readonly SchemaFileEntry[]; readonly dirs: readonly SchemaDirEntry[] }
}

export interface AvailableAssemblyType {
  readonly type: string
  readonly description: string | null
}

export type CapabilityRefForm = "file" | "noext" | "set" | "directory"

export interface CapabilityRefShape {
  readonly form: CapabilityRefForm
  /** Normalized storage form of the reference. */
  readonly ref: string
  /** Reference-relative target without the category prefix. */
  readonly target: string
  /** Set form only: suffix after the star dot. */
  readonly setSuffix?: string
}

const noextMarker = ".noext"
const noextSetSuffix = "noext"

/** The settings section plugin declarations materialize to by default. */
export const defaultPluginSection = "ellamaka"

/** The strict grammar quoted in unresolved-reference remedies. */
export const refShapeHint =
  'Strict reference forms: file "<name>.<ext>" (explicit extension), ' +
  'no-extension file "<name>.noext", one-level file set "<dir>/*.<ext>", ' +
  'and directory "<name>/".'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function hasExtension(name: string): boolean {
  const dot = name.lastIndexOf(".")
  return dot > 0 && dot < name.length - 1
}

/** Does a file name belong to a one-level wildcard set with this suffix? */
export function capabilitySetSuffixMatches(suffix: string, fileName: string): boolean {
  return suffix === noextSetSuffix ? !hasExtension(fileName) : fileName.endsWith("." + suffix)
}

function lastSegment(target: string): string {
  const segments = target.split("/")
  return segments[segments.length - 1] ?? ""
}

function normalizeDirectoryRef(target: string): string {
  return lastSegment(target).includes(".") ? target + "/" : target
}

function invalidReference(label: string, reason: string): SpaceServiceError {
  return new SpaceServiceError({
    code: spaceErrorCodes.capabilityUnresolved,
    message: label + " is invalid: " + reason,
    suggestion: refShapeHint,
  })
}

/**
 * Parse a reference's mechanical form. The form follows the reference's
 * ending; the path must be repository-relative and a wildcard may only be
 * the final star or star-dot-extension segment.
 */
export function parseReferenceShape(ref: string, label: string): CapabilityRefShape {
  if (ref.length === 0) throw invalidReference(label, "it is empty")
  if (ref.includes("\\")) throw invalidReference(label, "backslashes are not path separators")
  if (ref.startsWith("/")) throw invalidReference(label, 'it is absolute (leading "/")')

  const directoryMarked = ref.endsWith("/")
  const body = directoryMarked ? ref.slice(0, -1) : ref
  const segments = body.split("/")
  if (segments.some((segment) => segment.length === 0)) {
    throw invalidReference(label, 'it contains an empty segment (a doubled "/")')
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw invalidReference(label, 'it contains a "." or ".." segment')
  }

  const lastIndex = segments.length - 1
  const last = segments[lastIndex] ?? ""
  const wildcards = segments.filter((segment) => segment.includes("*"))

  if (wildcards.length > 0) {
    if (directoryMarked) {
      throw invalidReference(label, 'a trailing "/" marks a directory; wildcard forms take no trailing slash')
    }
    if (wildcards.length > 1 || !last.includes("*")) {
      throw invalidReference(label, "wildcards are allowed in the last segment only")
    }
    if (lastIndex === 0) throw invalidReference(label, "the wildcard needs a directory prefix")
    if (last === "*") {
      const target = segments.slice(0, lastIndex).join("/")
      return { form: "directory", ref: normalizeDirectoryRef(target), target }
    }
    if (last.startsWith("*.") && last.length > 2 && !last.slice(2).includes("*")) {
      const setSuffix = last.slice(2)
      const target = segments.slice(0, lastIndex).join("/")
      return { form: "set", ref: target + "/*." + setSuffix, target, setSuffix }
    }
    throw invalidReference(label, "only the star or star-dot-extension form is a valid wildcard")
  }

  if (directoryMarked) return { form: "directory", ref: normalizeDirectoryRef(body), target: body }

  if (last.endsWith(noextMarker)) {
    const stripped = last.slice(0, -noextMarker.length)
    if (stripped.length === 0) throw invalidReference(label, "no file name before the noext marker")
    return { form: "noext", ref, target: [...segments.slice(0, lastIndex), stripped].join("/") }
  }

  if (hasExtension(last)) return { form: "file", ref, target: ref }

  return { form: "directory", ref: normalizeDirectoryRef(ref), target: ref }
}

export function parseCapabilityRefShape(ref: string): CapabilityRefShape {
  return parseReferenceShape(ref, "Capability reference " + JSON.stringify(ref))
}

/** One resolved reference: its shape, repository path and sparse coverage. */
export interface ResolvedCapabilityRef {
  readonly form: CapabilityRefForm
  readonly ref: string
  /** Category-prefixed repository-relative path. */
  readonly path: string
  /** Non-cone sparse patterns covering exactly the target. */
  readonly patterns: readonly string[]
  /** Set form only: matched one-level files. */
  readonly files?: readonly string[]
  readonly setSuffix?: string
}

function missingRemedy(rootAbsolute: string, shape: CapabilityRefShape): string | null {
  if (shape.form === "set") return null
  const segments = shape.target.split("/")
  const parent = segments.slice(0, -1).join("/")
  const parentAbsolute = parent.length > 0 ? join(rootAbsolute, parent) : rootAbsolute
  const base = segments[segments.length - 1] ?? ""
  const rel = (name: string) => (parent.length > 0 ? parent + "/" + name : name)
  const isFile = (name: string) => statSync(join(parentAbsolute, name), { throwIfNoEntry: false })?.isFile() === true

  let entries: string[]
  try {
    entries = readdirSync(parentAbsolute).sort()
  } catch {
    return null
  }
  const named = (names: string[]) =>
    names
      .slice(0, 2)
      .map((name) => JSON.stringify(rel(name)))
      .join(", ")

  if (shape.form === "directory") {
    if (hasExtension(base)) return null
    const candidates = entries.filter((name) => name.startsWith(base + ".") && isFile(name))
    if (candidates.length === 0) return null
    return (
      "no directory matches " +
      JSON.stringify(rel(base)) +
      "; found " +
      named(candidates) +
      ' — write the file explicit extension, or ".noext" when the file has none.'
    )
  }
  if (shape.form === "noext") {
    const candidates = entries.filter((name) => name.startsWith(base + ".") && isFile(name))
    if (candidates.length === 0) return null
    return (
      "no file matches " +
      JSON.stringify(rel(base)) +
      " without an extension; found " +
      named(candidates) +
      " — write the file explicit extension."
    )
  }
  const dot = base.lastIndexOf(".")
  const stripped = base.slice(0, dot)
  if (stripped.length > 0 && isFile(stripped)) {
    return (
      JSON.stringify(rel(stripped)) + " has no extension — write " + JSON.stringify(rel(stripped) + noextMarker) + "."
    )
  }
  const candidates = entries.filter((name) => name.startsWith(stripped + ".") && name !== base && isFile(name))
  if (candidates.length === 0) return null
  return (
    "no file matches " +
    JSON.stringify(rel(base)) +
    "; found " +
    named(candidates) +
    " — write the file full name with its extension."
  )
}

interface ResolutionRequest {
  readonly rootAbsolute: string
  readonly label: string
  readonly prefix: string
  readonly shape: CapabilityRefShape
  readonly source: string
}

function unresolved(request: ResolutionRequest): SpaceServiceError {
  const remedy = missingRemedy(request.rootAbsolute, request.shape)
  const target = request.prefix + request.shape.target
  return new SpaceServiceError({
    code: spaceErrorCodes.capabilityUnresolved,
    message: request.label + " cannot be resolved in " + request.source + ": no asset matches " + target,
    suggestion: remedy !== null ? remedy + " " + refShapeHint : refShapeHint,
  })
}

function resolveAgainstPool(request: ResolutionRequest): ResolvedCapabilityRef {
  const { rootAbsolute, label, prefix, shape, source } = request
  const target = prefix + shape.target
  const absolute = join(rootAbsolute, shape.target)
  const stats = statSync(absolute, { throwIfNoEntry: false })

  if (shape.form === "directory") {
    if (stats?.isDirectory()) {
      return { form: shape.form, ref: shape.ref, path: target, patterns: ["/" + target + "/"] }
    }
    if (stats?.isFile()) {
      const remedy = hasExtension(shape.target)
        ? 'drop the trailing "/": write ' + JSON.stringify(shape.target)
        : "write " +
          JSON.stringify(shape.ref + noextMarker) +
          " for a file without an extension, or the file name with its extension"
      throw new SpaceServiceError({
        code: spaceErrorCodes.capabilityUnresolved,
        message: label + " resolves to a file in " + source + ": " + target + " is a file, not a directory",
        suggestion: JSON.stringify(target) + " is a file — " + remedy + ". " + refShapeHint,
      })
    }
    throw unresolved(request)
  }

  if (shape.form === "set") {
    const suffix = shape.setSuffix ?? noextSetSuffix
    if (!stats?.isDirectory()) {
      if (stats?.isFile()) {
        throw new SpaceServiceError({
          code: spaceErrorCodes.capabilityUnresolved,
          message: label + " cannot be resolved in " + source + ": " + target + " is a file, not a directory",
          suggestion:
            "A file set takes a directory prefix — reference " +
            JSON.stringify(shape.target + "/") +
            " as a directory, or name the file directly. " +
            refShapeHint,
        })
      }
      throw unresolved(request)
    }
    const matches = readdirSync(absolute)
      .filter((name) => capabilitySetSuffixMatches(suffix, name))
      .filter((name) => statSync(join(absolute, name), { throwIfNoEntry: false })?.isFile() === true)
      .sort()
    const files = matches.map((name) => target + "/" + name)
    if (files.length === 0) {
      throw new SpaceServiceError({
        code: spaceErrorCodes.capabilityUnresolved,
        message: label + " cannot be resolved in " + source + ": no files match the set one level under " + target,
        suggestion:
          "No file under " +
          JSON.stringify(target) +
          " matches the set — check the extension, reference the files individually, or use the directory form. " +
          refShapeHint,
      })
    }
    return {
      form: shape.form,
      ref: shape.ref,
      path: target,
      patterns: files.map((file) => "/" + file),
      files,
      setSuffix: suffix,
    }
  }

  if (stats?.isFile()) {
    return { form: shape.form, ref: shape.ref, path: target, patterns: ["/" + target] }
  }
  if (stats?.isDirectory()) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.capabilityUnresolved,
      message: label + " resolves to a directory in " + source + ": " + target + " is a directory, not a file",
      suggestion: 'Append "/" to reference the directory: ' + JSON.stringify(shape.ref + "/") + ".",
    })
  }
  throw unresolved(request)
}

function categorizedLabel(ref: string, category: CapabilityKind): string {
  return "Capability reference " + JSON.stringify(ref) + " (" + category + ")"
}

/** Resolve one capability reference against its category pool. */
export function resolveCapabilityRef(
  ontologyPath: string,
  category: CapabilityKind,
  ref: string,
): ResolvedCapabilityRef {
  const shape = parseReferenceShape(ref, categorizedLabel(ref, category))
  return resolveAgainstPool({
    rootAbsolute: join(ontologyPath, category),
    label: categorizedLabel(ref, category),
    prefix: category + "/",
    shape,
    source: "ontology " + ontologyPath,
  })
}

/** Reserved directories no generic path may overlap. */
export const reservedDirectories = ["assembly", "config", "docs"] as const

export type GenericPathCollision =
  | { readonly kind: "category"; readonly category: CapabilityKind; readonly singular: string }
  | { readonly kind: "reserved"; readonly directory: string }
  | { readonly kind: "root-file" }

/**
 * The collision boundary of a generic path target, decided mechanically:
 * a first segment owning a capability category or a reserved directory
 * collides, and a repository-root file is never selectable.
 */
export function genericPathCollision(target: string, form: CapabilityRefForm): GenericPathCollision | null {
  const first = target.split("/")[0] ?? ""
  const category = capabilityKinds.find((kind) => kind === first)
  if (category) {
    return { kind: "category", category, singular: capabilityKindSingular[category] }
  }
  const directory = reservedDirectories.find((dir) => dir === first)
  if (directory) return { kind: "reserved", directory }
  if (!target.includes("/") && (form === "file" || form === "noext" || first.startsWith("."))) {
    return { kind: "root-file" }
  }
  return null
}

function collisionError(ref: string, target: string, collision: GenericPathCollision): SpaceServiceError {
  const label = "Generic path reference " + JSON.stringify(ref)
  const hint = refShapeHint
  switch (collision.kind) {
    case "category": {
      const rest = target.split("/").slice(1).join("/")
      const example = rest.length > 0 ? collision.singular + ":" + rest : collision.singular + ":<ref>"
      return new SpaceServiceError({
        code: spaceErrorCodes.capabilityUnresolved,
        message: label + " lies inside the capability category " + JSON.stringify(collision.category + "/"),
        suggestion:
          "Use the " +
          JSON.stringify(collision.singular) +
          " category instead (e.g. " +
          JSON.stringify(example) +
          "), or choose a path outside agents/, skills/, rules/, commands/ and plugins/. " +
          hint,
      })
    }
    case "reserved":
      return new SpaceServiceError({
        code: spaceErrorCodes.capabilityUnresolved,
        message: label + " overlaps the reserved directory " + JSON.stringify(collision.directory + "/"),
        suggestion:
          "assembly/, config/ and docs/ are reserved for the assembly system and assembled into every space; choose a path outside them. " +
          hint,
      })
    case "root-file":
      return new SpaceServiceError({
        code: spaceErrorCodes.capabilityUnresolved,
        message: label + " is a repository-root file and is not selectable",
        suggestion:
          "Root files are not selectable content — README.md, README.en.md, LICENSE and the AGENTS pair are already assembled into every space; declare a path under a directory instead. " +
          hint,
      })
  }
  const unreachable: never = collision
  return unreachable
}

/** The ownership-boundary failure of a generic path, or null when selectable. */
export function genericPathCollisionFailure(ref: string, shape: CapabilityRefShape): SpaceServiceError | null {
  const collision = genericPathCollision(shape.target, shape.form)
  return collision === null ? null : collisionError(ref, shape.target, collision)
}

/** Resolve a generic path reference against the repository root. */
export function resolveGenericPathRef(ontologyPath: string, ref: string): ResolvedCapabilityRef {
  const label = "Generic path reference " + JSON.stringify(ref)
  const shape = parseReferenceShape(ref, label)
  const collision = genericPathCollision(shape.target, shape.form)
  if (collision !== null) throw collisionError(ref, shape.target, collision)
  return resolveAgainstPool({
    rootAbsolute: ontologyPath,
    label,
    prefix: "",
    shape,
    source: "ontology " + ontologyPath,
  })
}

/** The first pair of overlapping paths entries, or null when disjoint. */
export function findGenericPathsOverlap(entries: readonly string[]): [string, string] | null {
  const targets = entries.map((entry) => {
    try {
      return parseCapabilityRefShape(entry).target
    } catch {
      return entry
    }
  })
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = targets[i] ?? ""
      const b = targets[j] ?? ""
      if (a === b || a.startsWith(b + "/") || b.startsWith(a + "/")) return [entries[i] ?? "", entries[j] ?? ""]
    }
  }
  return null
}

/** Parse a plugins value: section to non-empty-name list, null when malformed. */
export function parsePluginSections(value: unknown): Record<string, string[]> | null {
  if (!isRecord(value)) return null
  const sections: Record<string, string[]> = Object.create(null)
  for (const [section, names] of Object.entries(value)) {
    if (section.length === 0) return null
    if (!isStringArray(names) || !names.every((name) => name.length > 0)) return null
    sections[section] = names
  }
  return sections
}

/** The first plugin name two sections both declare. */
export function findPluginSectionConflict(
  sections: Readonly<Record<string, readonly string[]>>,
): { name: string; sections: [string, string] } | null {
  const owner = new Map<string, string>()
  for (const [section, names] of Object.entries(sections)) {
    for (const name of names) {
      const first = owner.get(name)
      if (first !== undefined) return { name, sections: [first, section] }
      owner.set(name, section)
    }
  }
  return null
}

export function pluginNamesFromManifest(manifest: ArchetypeManifest): string[] {
  return Object.values(manifest.plugins).flat()
}

export function pluginNamesInSection(
  manifest: ArchetypeManifest,
  section: string = defaultPluginSection,
): readonly string[] {
  return Object.hasOwn(manifest.plugins, section) ? (manifest.plugins[section] ?? []) : []
}

export type ArchetypeParseOutcome =
  | { readonly ok: true; readonly manifest: ArchetypeManifest }
  | { readonly ok: false; readonly conflict?: { name: string; sections: [string, string] }; readonly reason?: string }

/** Parse and structurally validate an archetype manifest document. */
export function parseArchetypeDocument(raw: string): ArchetypeParseOutcome {
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch {
    return { ok: false, reason: "it is not readable YAML" }
  }
  if (!isRecord(parsed)) return { ok: false, reason: "it is not a YAML map" }
  if (typeof parsed.version !== "number") return { ok: false, reason: "missing or invalid version" }
  if (typeof parsed.type !== "string" || parsed.type.length === 0) return { ok: false, reason: "missing type" }
  if (parsed.description !== undefined && typeof parsed.description !== "string") {
    return { ok: false, reason: "description must be a string" }
  }
  if (parsed.schema !== undefined && typeof parsed.schema !== "string") {
    return { ok: false, reason: "schema must be a string" }
  }

  const manifest: {
    version: number
    type: string
    description?: string
    schema?: string
    agents: string[]
    skills: string[]
    rules: string[]
    commands: string[]
    plugins: Record<string, string[]>
    paths: string[]
  } = {
    version: parsed.version,
    type: parsed.type,
    agents: [],
    skills: [],
    rules: [],
    commands: [],
    plugins: Object.create(null),
    paths: [],
  }
  if (typeof parsed.description === "string") manifest.description = parsed.description
  if (typeof parsed.schema === "string") manifest.schema = parsed.schema

  for (const category of capabilityKinds) {
    const value = parsed[category]
    if (value === undefined) continue
    if (category === "plugins") {
      const sections = parsePluginSections(value)
      if (sections === null) {
        return { ok: false, reason: "plugins must be a section to plugin-name-list map (e.g. ellamaka: [my-plugin])" }
      }
      const conflict = findPluginSectionConflict(sections)
      if (conflict !== null) return { ok: false, conflict }
      manifest.plugins = sections
      continue
    }
    if (!isStringArray(value) || !value.every((item) => item.length > 0)) {
      return { ok: false, reason: "the " + category + " category must be an array of non-empty strings" }
    }
    manifest[category] = value
  }

  const pathsValue = parsed.paths
  if (pathsValue !== undefined) {
    if (!isStringArray(pathsValue) || !pathsValue.every((item) => item.length > 0)) {
      return { ok: false, reason: "the paths segment must be an array of non-empty strings" }
    }
    const overlap = findGenericPathsOverlap(pathsValue)
    if (overlap !== null) {
      return {
        ok: false,
        reason:
          "paths entries " +
          JSON.stringify(overlap[0]) +
          " and " +
          JSON.stringify(overlap[1]) +
          " overlap — each declared path must be a complete asset",
      }
    }
    manifest.paths = pathsValue
  }

  return { ok: true, manifest }
}

export function parseArchetypeOrThrow(raw: string, source: string): ArchetypeManifest {
  const outcome = parseArchetypeDocument(raw)
  if (!outcome.ok) {
    const conflict = outcome.conflict
    throw new SpaceServiceError({
      code: spaceErrorCodes.archetypeInvalid,
      message: conflict
        ? "Archetype manifest " +
          source +
          " assembles plugin " +
          JSON.stringify(conflict.name) +
          " to two types (" +
          JSON.stringify(conflict.sections[0]) +
          " and " +
          JSON.stringify(conflict.sections[1]) +
          ")"
        : "Archetype manifest " +
          source +
          " is not a valid assembly definition" +
          (outcome.reason ? ": " + outcome.reason : ""),
      suggestion: conflict
        ? "A plugin belongs to exactly one assembly type — keep " +
          JSON.stringify(conflict.name) +
          " in one section only"
        : "Manifests declare version, type, the capability name arrays (agents, skills, rules, commands), a plugins section to plugin-name-list map and a paths array of non-overlapping generic path references",
    })
  }
  return outcome.manifest
}

/** Every declared capability reference with its category, in manifest order. */
export function manifestCategoryRefs(manifest: ArchetypeManifest): { category: CapabilityKind; ref: string }[] {
  const entries: { category: CapabilityKind; ref: string }[] = []
  for (const category of capabilityKinds) {
    const refs = category === "plugins" ? pluginNamesFromManifest(manifest) : manifest[category]
    for (const ref of refs) entries.push({ category, ref })
  }
  return entries
}

function readTextIfExists(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

export function archetypeMissingError(
  type: string,
  source: string,
  availableTypes: readonly string[],
): SpaceServiceError {
  return new SpaceServiceError({
    code: spaceErrorCodes.archetypeMissing,
    message: "No archetype manifest for type " + JSON.stringify(type) + " in " + source,
    suggestion:
      availableTypes.length > 0
        ? "Available types: " + availableTypes.join(", ")
        : "No assembly types are available in " + source,
  })
}

/** Read and validate assembly/archetypes/<type>.yaml from an ontology root. */
export function readArchetype(ontologyPath: string, type: string): ArchetypeManifest {
  const path = join(ontologyPath, "assembly", "archetypes", type + ".yaml")
  const raw = readTextIfExists(path)
  if (raw === null) {
    throw archetypeMissingError(
      type,
      "ontology " + ontologyPath,
      listAssemblyTypes(ontologyPath).map((entry) => entry.type),
    )
  }
  return parseArchetypeOrThrow(raw, path)
}

/** Selectable types declared under assembly/archetypes/, invalid ones skipped. */
export function listAssemblyTypes(ontologyPath: string): AvailableAssemblyType[] {
  const directory = join(ontologyPath, "assembly", "archetypes")
  if (!existsSync(directory)) return []
  const types: AvailableAssemblyType[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue
    const raw = readTextIfExists(join(directory, entry.name))
    if (raw === null) continue
    const outcome = parseArchetypeDocument(raw)
    if (!outcome.ok) continue
    types.push({ type: outcome.manifest.type, description: outcome.manifest.description ?? null })
  }
  return types.sort((a, b) => a.type.localeCompare(b.type))
}

/** Resolve a manifest's schema name: the explicit field or the type convention. */
export function resolveSchemaName(manifest: ArchetypeManifest): string {
  return manifest.schema ?? manifest.type + "-space-schema.yaml"
}

function isFileEntry(value: unknown): value is SchemaFileEntry {
  return isRecord(value) && typeof value.template === "string" && typeof value.target === "string"
}

function isDirEntry(value: unknown): value is SchemaDirEntry {
  return isRecord(value) && typeof value.path === "string" && (value.keep === undefined || isStringArray(value.keep))
}

function invalidSchema(source: string, message: string): SpaceServiceError {
  return new SpaceServiceError({
    code: spaceErrorCodes.schemaInvalid,
    message: message + " (" + source + ")",
    suggestion: "Schemas declare version, runtime.path, and files/dirs arrays for runtime and space",
  })
}

/** Parse and validate a space schema document. */
export function parseSpaceSchemaDocument(raw: string, source: string): SpaceSchema {
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch {
    throw invalidSchema(source, "Space schema could not be read as YAML")
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.version !== "number" ||
    !isRecord(parsed.runtime) ||
    typeof parsed.runtime.path !== "string" ||
    !isRecord(parsed.space)
  ) {
    throw invalidSchema(source, "Space schema is missing the runtime/space structure")
  }
  const runtimePath = parsed.runtime.path
  const runtimeFiles = parsed.runtime.files
  const runtimeDirs = parsed.runtime.dirs
  const spaceFiles = parsed.space.files
  const spaceDirs = parsed.space.dirs
  if (
    !Array.isArray(runtimeFiles) ||
    !Array.isArray(runtimeDirs) ||
    !Array.isArray(spaceFiles) ||
    !Array.isArray(spaceDirs)
  ) {
    throw invalidSchema(source, "Space schema is missing the runtime/space structure")
  }
  if (![...runtimeFiles, ...spaceFiles].every(isFileEntry)) {
    throw invalidSchema(source, "Space schema has a file entry without template/target")
  }
  if (![...runtimeDirs, ...spaceDirs].every(isDirEntry)) {
    throw invalidSchema(source, "Space schema has a directory entry without a path")
  }
  const files = (value: unknown[]): SchemaFileEntry[] => value.filter(isFileEntry).map((entry) => ({ ...entry }))
  const dirs = (value: unknown[]): SchemaDirEntry[] =>
    value.filter(isDirEntry).map((entry) => ({ path: entry.path, ...(entry.keep ? { keep: [...entry.keep] } : {}) }))
  return {
    version: parsed.version,
    runtime: { path: runtimePath, files: files(runtimeFiles), dirs: dirs(runtimeDirs) },
    space: { files: files(spaceFiles), dirs: dirs(spaceDirs) },
  }
}

export function readSpaceSchema(ontologyPath: string, schemaName: string): SpaceSchema {
  const path = join(ontologyPath, "assembly", "schemas", schemaName)
  if (!existsSync(path)) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.schemaMissing,
      message: "No space schema " + JSON.stringify(schemaName) + " in ontology " + ontologyPath,
      suggestion: "Check the archetype schema field, or add the schema under assembly/schemas/",
    })
  }
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    throw invalidSchema(path, "Space schema could not be read as YAML")
  }
  return parseSpaceSchemaDocument(raw, path)
}

/** Templates a schema references that assembly/templates/ does not provide. */
export function findMissingTemplates(ontologyPath: string, schema: SpaceSchema): string[] {
  const directory = join(ontologyPath, "assembly", "templates")
  const missing = new Set<string>()
  for (const entry of [...schema.runtime.files, ...schema.space.files]) {
    if (entry.template === "BOOTSTRAP.md") continue
    if (!existsSync(join(directory, entry.template))) missing.add(entry.template)
  }
  return [...missing].sort()
}

/** Every pattern a space of this type always keeps in its sparse range. */
export function alwaysAssembledPatterns(manifest: ArchetypeManifest): string[] {
  return [
    "/.gitignore",
    "/AGENTS.md",
    "/AGENTS.zh-CN.md",
    "/README.md",
    "/README.en.md",
    "/LICENSE",
    "/docs/",
    "/assembly/archetypes/" + manifest.type + ".yaml",
    "/assembly/schemas/" + resolveSchemaName(manifest),
    "/assembly/templates/",
    "/config/",
  ]
}

/**
 * Sparse-checkout patterns for a type's default assembly.
 *
 * A manifest may declare content the pool (`local main`) does not carry yet
 * but this Space already committed on its own branch. `fallbacks` supplies the
 * extra read order before a declaration is reported unresolved: the worktree
 * first (content still on disk before `space sync`), then a tree resolver
 * (content a local `exclude` removed from disk but never stopped owning).
 */
export function materializationPatterns(
  ontologyPath: string,
  manifest: ArchetypeManifest,
  fallbacks: MaterializationFallbacks = {},
): string[] {
  const patterns = new Set<string>(alwaysAssembledPatterns(manifest))
  const { fallbackRoot, fallbackTree } = fallbacks
  const resolveOne = (
    category: CapabilityKind | null,
    ref: string,
    fromRoot: (root: string) => ResolvedCapabilityRef,
  ): readonly string[] | undefined => {
    try {
      return fromRoot(ontologyPath).patterns
    } catch (poolError) {
      if (fallbackRoot !== undefined) {
        try {
          return fromRoot(fallbackRoot).patterns
        } catch {
          // fall through to the branch tree
        }
      }
      const fromTree = fallbackTree?.(category, ref)
      if (fromTree !== undefined && fromTree !== null) return fromTree.patterns
      throw poolError
    }
  }
  for (const { category, ref } of manifestCategoryRefs(manifest)) {
    const found = resolveOne(category, ref, (root) => resolveCapabilityRef(root, category, ref))
    if (found !== undefined) for (const pattern of found) patterns.add(pattern)
  }
  for (const ref of manifest.paths) {
    const found = resolveOne(null, ref, (root) => resolveGenericPathRef(root, ref))
    if (found !== undefined) for (const pattern of found) patterns.add(pattern)
  }
  return [...patterns].sort()
}

/** Extra read sources for a manifest declaration the pool does not carry yet. */
export interface MaterializationFallbacks {
  /** Space worktree: content still materialized before `space sync`. */
  readonly fallbackRoot?: string
  /** Space branch tree: content a local exclude dropped from disk. */
  readonly fallbackTree?: (category: CapabilityKind | null, ref: string) => ResolvedCapabilityRef | null
}
