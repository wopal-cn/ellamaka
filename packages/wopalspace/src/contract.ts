import { Schema } from "effect"

export const applicationDomains = ["setup", "ontology", "space", "product-settings"] as const

export type ApplicationDomain = (typeof applicationDomains)[number]

const setupOperations = [
  "setup.inspect",
  "setup.plan",
  "setup.execute",
  "setup.progress",
  "setup.progress.events",
  "setup.cancel",
  "setup.complete",
] as const

const ontologyOperations = [
  "ontology.list",
  "ontology.install",
  "ontology.inspect",
  "ontology.refresh",
  "ontology.sync",
  "ontology.capability.list",
] as const

const spaceOperations = [
  "space.resolve",
  "space.list",
  "space.init",
  "space.projects.list",
  "space.files.list",
  "space.files.read",
  "space.search",
  "space.scan",
  "space.status",
  "space.sync",
  "space.capability.add",
  "space.capability.remove",
] as const

/**
 * The canonical public operation catalog. Product Settings has a narrow
 * internal writer and no public operation of its own.
 */
export const publicOperationCatalog = {
  setup: setupOperations,
  ontology: ontologyOperations,
  space: spaceOperations,
  "product-settings": [],
} as const satisfies Record<ApplicationDomain, readonly string[]>

export type PublicOperation =
  | (typeof setupOperations)[number]
  | (typeof ontologyOperations)[number]
  | (typeof spaceOperations)[number]

export const publicOperationNames = [
  ...setupOperations,
  ...ontologyOperations,
  ...spaceOperations,
] as const satisfies readonly PublicOperation[]

export const publicOperationSchema = Schema.Literals(publicOperationNames)

/** Trusted host input. Callers never supply another value for these fields. */
export const hostContextSchema = Schema.Struct({
  wopalHome: Schema.String,
  directory: Schema.optional(Schema.String),
})

export type HostContext = Readonly<Schema.Schema.Type<typeof hostContextSchema>>

/** Stable public error shape shared by every transport. */
export const publicErrorSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  suggestion: Schema.optional(Schema.String),
})

export type PublicError = Schema.Schema.Type<typeof publicErrorSchema>
