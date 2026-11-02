import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "jsonc-parser"
import { Schema, SchemaGetter } from "effect"
import { updateSettingsEntry } from "../settings-registry"
import {
  OntologyServiceError,
  type OntologyInstallInput,
  type OntologyMode,
  type OntologyRegistryEntry,
  type OntologySpaceReference,
} from "./types"

export const DEFAULT_UPSTREAM = "https://github.com/wopal-cn/wopal-space-ontology"
export const SETTINGS_PATH = ["config", "settings.jsonc"] as const

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CREDENTIAL_SOURCE = /^[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i

/** Names address one child of the ontology root, never a path. */
export function normalizeOntologyName(value: string): string {
  if (!NAME_PATTERN.test(value) || value === "." || value === ".." || value.endsWith(".lock")) {
    throw new OntologyServiceError({
      code: "ONTOLOGY_NAME_INVALID",
      message: "Invalid ontology name: " + value,
      suggestion: "Use 1-128 letters, digits, dots, underscores, or hyphens; the first character must be alphanumeric.",
    })
  }
  return value
}

function githubSource(value: string): string | undefined {
  const shorthand = value.match(/^github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  if (shorthand) return "https://github.com/" + shorthand[1] + "/" + shorthand[2]
  const https = value.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  if (/^https?:\/\//i.test(value) && !https) return undefined
  if (https) return "https://github.com/" + https[1] + "/" + https[2]
  const ssh = value.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  if (ssh) return "https://github.com/" + ssh[1] + "/" + ssh[2]
  return undefined
}

/**
 * Normalize a supported Git source. Path-shaped input is rejected before it
 * can reach git as a local clone source.
 */
export function normalizeOntologySource(value: string | undefined): string {
  if (!value || value === "default") return DEFAULT_UPSTREAM
  if (CREDENTIAL_SOURCE.test(value)) {
    throw new OntologyServiceError({
      code: "ONTOLOGY_SOURCE_INVALID",
      message: "Ontology sources must not carry credentials",
      suggestion: "Authenticate git separately from the recorded source URL.",
    })
  }
  if (/[?#]/.test(value)) {
    throw new OntologyServiceError({
      code: "ONTOLOGY_SOURCE_INVALID",
      message: "Ontology sources must not carry query strings or fragments",
    })
  }
  const source = githubSource(value)
  if (source) return source
  // Only an absolute file URL is a Git source; file://relative stays path-shaped.
  if (/^file:\/\/\/[^\s?#]+$/i.test(value)) return value
  throw new OntologyServiceError({
    code: "ONTOLOGY_SOURCE_INVALID",
    message: "Invalid ontology source: " + value,
    suggestion:
      "Pass an official GitHub URL, a canonical github.com/owner/repo source, or an absolute file:// Git URL.",
  })
}

export function ontologyMode(input: Pick<OntologyInstallInput, "mode" | "fork">): OntologyMode {
  if (input.mode && input.fork !== undefined && (input.mode === "fork") !== input.fork) {
    throw new OntologyServiceError({
      code: "ONTOLOGY_MODE_INVALID",
      message: "mode and fork describe different installation modes",
    })
  }
  return input.mode ?? (input.fork ? "fork" : "clone")
}

const ontologySource = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value: string) => normalizeOntologySource(value)),
    encode: SchemaGetter.transform((value: string) => value),
  }),
)

export const ontologyInstallInputSchema = Schema.Struct({
  name: Schema.String,
  source: Schema.optional(ontologySource),
  mode: Schema.optional(Schema.Literals(["clone", "fork"])),
  fork: Schema.optional(Schema.Boolean),
})

export const ontologyRegistryEntrySchema = Schema.Struct({
  path: Schema.String,
  upstream: Schema.String,
  origin: Schema.optional(Schema.String),
  fork: Schema.optional(Schema.Boolean),
})

export interface OntologyRegistry {
  readonly path: string
  readonly entries: Readonly<Record<string, OntologyRegistryEntry>>
  readonly spaces: Readonly<Record<string, OntologySpaceReference>>
  readonly raw: string | undefined
}

export function settingsPath(wopalHome: string): string {
  return join(wopalHome, ...SETTINGS_PATH)
}

export function ontologyRoot(wopalHome: string): string {
  return join(wopalHome, "ontologies")
}

export function readRegistry(wopalHome: string): OntologyRegistry {
  const path = settingsPath(wopalHome)
  if (!existsSync(path)) return { path, entries: {}, spaces: {}, raw: undefined }
  const raw = readFileSync(path, "utf8")
  return { path, ...parseOntologySettings(raw), raw }
}

export function registryEntry(name: string, registry: OntologyRegistry): OntologyRegistryEntry {
  const entry = Object.hasOwn(registry.entries, name) ? registry.entries[name] : undefined
  if (!entry) {
    throw new OntologyServiceError({
      code: "ONTOLOGY_NOT_FOUND",
      message: "Ontology is not registered: " + name,
      suggestion: "Run ontology install first, then retry with the registered name.",
    })
  }
  return entry
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) record[key] = entry
  return record
}

export function parseOntologySettings(raw: string): Pick<OntologyRegistry, "entries" | "spaces"> {
  const errors: { error: number; offset: number; length: number }[] = []
  const parsed = parse(raw, errors, { allowTrailingComma: true, disallowComments: false }) as unknown
  if (errors.length > 0) {
    throw new OntologyServiceError({
      code: "ONTOLOGY_REGISTRY_INVALID",
      message: "config/settings.jsonc is not valid JSONC",
    })
  }
  const settings = object(parsed)
  const ontologyValues = object(settings?.ontologies)
  const spaceValues = object(settings?.spaces)
  const entries: Record<string, OntologyRegistryEntry> = Object.create(null)
  const spaces: Record<string, OntologySpaceReference> = Object.create(null)

  for (const [name, value] of Object.entries(ontologyValues ?? {})) {
    const entry = object(value)
    if (!entry || typeof entry.path !== "string" || typeof entry.upstream !== "string") continue
    entries[name] = {
      path: entry.path,
      upstream: entry.upstream,
      ...(typeof entry.origin === "string" ? { origin: entry.origin } : {}),
      ...(typeof entry.fork === "boolean" ? { fork: entry.fork } : {}),
    }
  }
  for (const [name, value] of Object.entries(spaceValues ?? {})) {
    const entry = object(value)
    if (!entry || typeof entry.path !== "string" || typeof entry.ontology !== "string") continue
    spaces[name] = {
      name: typeof entry.name === "string" ? entry.name : name,
      path: entry.path,
      branch: typeof entry.branch === "string" ? entry.branch : "space/" + name,
      type: typeof entry.type === "string" ? entry.type : "",
      ontology: entry.ontology,
    }
  }
  return { entries, spaces }
}

/** Atomically publish one ontology entry while preserving comments and unrelated settings. */
export function writeRegistryEntry(wopalHome: string, name: string, entry: OntologyRegistryEntry): void {
  const validName = normalizeOntologyName(name)
  updateSettingsEntry(settingsPath(wopalHome), ["ontologies", validName], entry, {
    validate: (text) => {
      parseOntologySettings(text)
    },
  })
}

export function spacesForOntology(registry: OntologyRegistry, name: string): readonly OntologySpaceReference[] {
  return Object.values(registry.spaces).filter((space) => space.ontology === name)
}
