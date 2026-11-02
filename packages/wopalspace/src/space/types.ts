import type { PublicError } from "../contract"

/** Stable error codes for Space operations; older owners' codes are kept verbatim. */
export const spaceErrorCodes = {
  spaceNotFound: "SPACE_NOT_FOUND",
  nameInvalid: "SPACE_NAME_INVALID",
  registryInvalid: "SPACE_REGISTRY_INVALID",
  nameExists: "SPACE_NAME_EXISTS",
  pathRegistered: "SPACE_PATH_REGISTERED",
  nested: "SPACE_NESTED",
  pathEscape: "SPACE_PATH_ESCAPE",
  pathInvalid: "SPACE_PATH_REQUIRED",
  ontologyNotFound: "SPACE_ONTOLOGY_NOT_FOUND",
  typeRequired: "SPACE_TYPE_REQUIRED",
  typeMismatch: "SPACE_TYPE_MISMATCH",
  invalidState: "SPACE_INVALID_STATE",
  metaMissing: "SPACE_META_MISSING",
  metaInvalid: "SPACE_META_INVALID",
  metaSelectionInvalid: "SPACE_META_SELECTION_INVALID",
  metaConcurrentModification: "SPACE_META_CONCURRENT_MODIFICATION",
  metaGitStateInvalid: "SPACE_META_GIT_STATE_INVALID",
  metaCommitFailed: "SPACE_META_COMMIT_FAILED",
  behindMain: "SPACE_INIT_BEHIND_MAIN",
  mainRefMissing: "SPACE_ONTOLOGY_MAIN_REF_MISSING",
  worktreeFailed: "SPACE_WORKTREE_FAILED",
  envSeedFailed: "SPACE_ENV_SEED_FAILED",
  archetypeMissing: "ASSEMBLY_ARCHETYPE_MISSING",
  archetypeInvalid: "ASSEMBLY_ARCHETYPE_INVALID",
  schemaMissing: "ASSEMBLY_SCHEMA_MISSING",
  schemaInvalid: "ASSEMBLY_SCHEMA_INVALID",
  capabilityUnresolved: "ASSEMBLY_CAPABILITY_UNRESOLVED",
  templateMissing: "ASSEMBLY_TEMPLATE_MISSING",
  sparseApplyFailed: "SPARSE_APPLY_FAILED",
  queryRequired: "QUERY_REQUIRED",
  invalidSearchType: "INVALID_SEARCH_TYPE",
  pathTraversalDetected: "PATH_TRAVERSAL_DETECTED",
  preparationFailed: "SPACE_PREPARATION_FAILED",
  syncConflict: "SPACE_SYNC_CONFLICT",
  syncDirty: "SPACE_SYNC_DIRTY",
  syncUploadGate: "SPACE_SYNC_UPLOAD_GATE",
  syncFailed: "SPACE_SYNC_FAILED",
  syncOperationInProgress: "MERGE_IN_PROGRESS",
  capabilityInvalid: "CAPABILITY_KIND_INVALID",
  capabilitySpecInvalid: "SPACE_CAPABILITY_SPEC_INVALID",
  capabilityFailed: "SPACE_CAPABILITY_FAILED",
} as const

export type SpaceErrorCode = (typeof spaceErrorCodes)[keyof typeof spaceErrorCodes]

/** One Space domain failure with a stable code and an actionable suggestion. */
export class SpaceServiceError extends Error {
  readonly code: string
  readonly suggestion?: string

  constructor(input: { code: string; message: string; suggestion?: string; cause?: unknown }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "SpaceServiceError"
    this.code = input.code
    if (input.suggestion) this.suggestion = input.suggestion
  }
}

export function toPublicError(error: unknown): PublicError {
  if (error instanceof SpaceServiceError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.suggestion ? { suggestion: error.suggestion } : {}),
    }
  }
  return {
    code: "SPACE_OPERATION_FAILED",
    message: error instanceof Error ? error.message : String(error),
  }
}

/** One registered Space: the stable key plus its persisted identity. */
export interface RegisteredSpace {
  /** Stable registry key, the contract's :name. */
  readonly name: string
  /** Display label; never an identity. */
  readonly displayName: string
  readonly path: string
  readonly ontology?: string
  readonly branch: string
  readonly type: string
  readonly createdAt?: string
}

export interface SpaceRegistryReading {
  readonly path: string
  readonly raw: string | undefined
  readonly spaces: Readonly<Record<string, RegisteredSpace>>
  readonly ontologies: Readonly<Record<string, RegisteredOntology>>
}

/** The ontology identity a Space init verifies before materializing. */
export interface RegisteredOntology {
  readonly name: string
  readonly path: string
  readonly upstream: string
  readonly origin?: string
  readonly fork: boolean
}

/** Assembly snapshot stored at .wopal-space/space-meta.json, format version 2. */
export interface SpaceAssemblyState {
  readonly version: 2
  readonly type: string
  readonly schema: string
  readonly source: { readonly ontology: string }
  readonly include: readonly string[]
  readonly exclude: readonly string[]
  readonly private: readonly string[]
}

export type SpaceCondition =
  | "create"
  | "noop"
  | "repair-worktree"
  | "repair-registry"
  | "repair-both"
  | "relink"
  | "invalid"

export interface SpaceResolveResult {
  /** Stable registry name of the resolved Space. */
  readonly name: string
  readonly path: string
  readonly space: RegisteredSpace
  readonly source: "name" | "directory"
}

export interface SpaceFacts {
  /** The registered root is present on disk. */
  readonly present: boolean
  /** Assembly snapshot reading. */
  readonly snapshot: "ok" | "missing" | "invalid"
  /** .wopal is an attached worktree for this Space's branch. */
  readonly worktree: boolean
  /** Registry-versus-disk findings; diagnostics only, never repaired here. */
  readonly mismatch: readonly string[]
}

export interface SpaceListItem extends RegisteredSpace {
  readonly facts: SpaceFacts
}

export interface SpaceListResult {
  readonly items: readonly SpaceListItem[]
  readonly total: number
}

export interface SpaceProjectWorktree {
  readonly path: string
  readonly branch?: string
}

export interface SpaceProject {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly worktrees: readonly SpaceProjectWorktree[]
}

export interface SpaceProjectsResult {
  readonly items: readonly SpaceProject[]
  readonly total: number
}

export interface SpaceFileNode {
  readonly name: string
  /** Registered-root-relative POSIX path. */
  readonly path: string
  readonly absolute: string
  readonly type: "file" | "directory"
  readonly ignored: boolean
}

export interface SpaceFilesListResult {
  readonly items: readonly SpaceFileNode[]
  readonly total: number
}

export interface SpaceFileContent {
  readonly type: "text" | "binary"
  readonly content: string
  readonly encoding?: "base64"
  readonly mimeType?: string
}

export type SpaceSearchType = "dir" | "repo" | "file"

export interface SpaceSearchItem {
  readonly name: string
  readonly path: string
  readonly type: SpaceSearchType
}

export interface SpaceSearchInput {
  readonly query?: string
  readonly type?: SpaceSearchType
  readonly limit?: number
  readonly offset?: number
}

export interface SpaceSearchResult {
  readonly items: readonly SpaceSearchItem[]
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly hasMore: boolean
}

export interface Description {
  readonly text: string
  readonly source:
    | "agents.frontmatter.description"
    | "agents.first_paragraph"
    | "readme.first_paragraph"
    | "package.metadata.description"
  readonly confidence: "high" | "medium"
  readonly truncated?: boolean
  readonly sourcePath?: string
}

export interface SpaceRepositoryEntry {
  readonly path: string
  readonly level: "repo"
  readonly type: "repo" | "worktree"
  readonly remote?: string
  readonly ref?: string
  readonly description?: Description | null
  readonly agentsFile?: string
}

export interface SpaceAgentRuleEntry {
  readonly path: string
  readonly role: "module-rules"
  readonly repo: string
  readonly description?: Description | null
  readonly agentsFile?: string
}

export interface SpaceScanResult {
  readonly space: { readonly name: string; readonly path: string }
  readonly repositories: readonly SpaceRepositoryEntry[]
  readonly agentRules: readonly SpaceAgentRuleEntry[]
}

export interface SpaceSyncCommit {
  readonly sha: string
  readonly subject: string
}

export interface SpaceSparseViolation {
  readonly path: string
  readonly form: "stranded" | "drifted"
}

/** Injected instance-preparation facts; the Runtime owns the real decision. */
export interface SpacePreparationFacts {
  readonly status: "ready" | "needs-preparation" | "preparing" | "busy" | "degraded" | "unknown"
  readonly diagnostic?: string
}

export interface SpaceStatusResult {
  readonly space: {
    readonly name: string
    readonly path: string
    readonly branch: string
    readonly type: string
  }
  readonly sync: {
    readonly contributions: readonly SpaceSyncCommit[]
    readonly behindCount: number
    readonly behindCommits: readonly SpaceSyncCommit[]
    readonly mergePrediction: "clean" | "conflict"
    readonly conflictFiles: readonly string[]
  }
  readonly assembly: {
    readonly schema: string
    readonly ontology: string
    readonly sparseConsistent: boolean | null
    readonly sparseViolations: readonly SpaceSparseViolation[]
  }
  readonly selection: {
    readonly include: readonly string[]
    readonly exclude: readonly string[]
    readonly private: readonly string[]
  }
  readonly unregistered: readonly string[]
  readonly rootState?: {
    readonly tracked: boolean
    readonly pendingChanges: boolean
    readonly lastCommit?: SpaceSyncCommit
  }
  readonly remote?: { readonly ahead: number; readonly behind: number }
  readonly dirtyCount: number
  readonly preparation: SpacePreparationFacts
}

export interface SpaceReconcileStep {
  readonly step:
    | "ontology"
    | "assembly"
    | "worktree"
    | "materialize"
    | "config"
    | "range"
    | "snapshot"
    | "git"
    | "register"
  readonly status: "created" | "repaired" | "reused" | "skipped" | "updated"
  readonly detail: string
}

/** Materialization outcome: the Space exists on disk and is registered. */
export interface SpaceMaterialization {
  readonly condition: SpaceCondition
  readonly finalCondition: SpaceCondition
  readonly type: string
  readonly branch: string
  readonly steps: readonly SpaceReconcileStep[]
  readonly prunedSelections: readonly string[]
}

export type SpacePreparationResult =
  | { readonly status: "ready"; readonly prepared: boolean; readonly detail?: string }
  | { readonly status: "failed"; readonly error: PublicError }
  | { readonly status: "cancelled" }

export interface SpaceInitInput {
  readonly name: string
  /** Absolute Space root to create or reconcile. */
  readonly root?: string
  readonly ontology?: string
  readonly type?: string
  readonly displayName?: string
}

export interface SpaceInitResult {
  readonly space: RegisteredSpace
  readonly materialized: SpaceMaterialization
  readonly preparation: SpacePreparationResult | { readonly status: "skipped"; readonly reason: string }
}
