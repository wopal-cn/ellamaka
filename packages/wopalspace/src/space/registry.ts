import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { SpaceServiceError, spaceErrorCodes } from "./types"
import type { RegisteredOntology, RegisteredSpace, SpaceRegistryReading } from "./types"

/** Registry location inside a Wopal Home. */
export function spaceRegistryPath(wopalHome: string): string {
  return join(wopalHome, "config", "settings.jsonc")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

export function normalizeSpaceName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === "." || value === "..") {
    throw new SpaceServiceError({
      code: spaceErrorCodes.nameInvalid,
      message: "Invalid Space name: " + value,
      suggestion: "Use 1-128 letters, digits, dots, underscores or hyphens; start with a letter or digit.",
    })
  }
  return value
}

/** The branch a Space owns for its assembly content. */
export function spaceBranchName(name: string): string {
  return "space/" + normalizeSpaceName(name)
}

/**
 * Read the Space registry from $WOPAL_HOME/config/settings.jsonc.
 *
 * Read-only: a missing file is an empty registry, and an unparsable document
 * is a stable error rather than a repaired file.
 */
export function readSpaceRegistry(wopalHome: string): SpaceRegistryReading {
  const path = spaceRegistryPath(wopalHome)
  if (!existsSync(path)) return { path, raw: undefined, spaces: {}, ontologies: {} }
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.registryInvalid,
      message: "Space registry is not readable: " + path,
      cause: error,
    })
  }
  const errors: ParseError[] = []
  const parsed = parse(raw, errors, { allowTrailingComma: true, disallowComments: false }) as unknown
  if (errors.length > 0) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.registryInvalid,
      message: "config/settings.jsonc is not valid JSONC",
      suggestion: "Repair the settings file; the registry is never rewritten by a read.",
    })
  }
  const settings = record(parsed)
  return { path, raw, spaces: readSpaces(settings?.spaces), ontologies: readOntologies(settings?.ontologies) }
}

function readSpaces(value: unknown): Record<string, RegisteredSpace> {
  const spaces: Record<string, RegisteredSpace> = Object.create(null)
  for (const [name, entry] of Object.entries(record(value) ?? {})) {
    const space = record(entry)
    if (!space || typeof space.path !== "string" || space.path.length === 0) continue
    spaces[name] = {
      name,
      displayName: typeof space.name === "string" && space.name.length > 0 ? space.name : name,
      path: space.path,
      ...(typeof space.ontology === "string" ? { ontology: space.ontology } : {}),
      branch: typeof space.branch === "string" && space.branch.length > 0 ? space.branch : "space/" + name,
      type: typeof space.type === "string" ? space.type : "",
      ...(typeof space.createdAt === "string" ? { createdAt: space.createdAt } : {}),
    }
  }
  return spaces
}

function readOntologies(value: unknown): Record<string, RegisteredOntology> {
  const ontologies: Record<string, RegisteredOntology> = Object.create(null)
  for (const [name, entry] of Object.entries(record(value) ?? {})) {
    const ontology = record(entry)
    if (!ontology || typeof ontology.path !== "string") continue
    ontologies[name] = {
      name,
      path: ontology.path,
      upstream: typeof ontology.upstream === "string" ? ontology.upstream : "",
      ...(typeof ontology.origin === "string" ? { origin: ontology.origin } : {}),
      fork: ontology.fork === true,
    }
  }
  return ontologies
}

/** Registered Spaces in stable name order. */
export function registeredSpaces(registry: SpaceRegistryReading): readonly RegisteredSpace[] {
  return Object.values(registry.spaces).sort((a, b) => a.name.localeCompare(b.name))
}

/** One registered Space, or a stable not-found failure. */
export function requireRegisteredSpace(registry: SpaceRegistryReading, name: string): RegisteredSpace {
  const validName = normalizeSpaceName(name)
  const space = Object.hasOwn(registry.spaces, validName) ? registry.spaces[validName] : undefined
  if (!space) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.spaceNotFound,
      message: "Space is not registered: " + name,
      suggestion: "List the registered Spaces and pass one of their names.",
    })
  }
  return space
}
