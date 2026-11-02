import type { HostContext, PublicError } from "../contract"

/** The application goals a setup plan may carry. */
export const SETUP_GOALS = ["foundation", "github", "ontology", "space", "provider"] as const

export type SetupGoal = (typeof SETUP_GOALS)[number]

/** One action per goal; the goal name is the stable action identity. */
export type SetupActionId = SetupGoal

export function isSetupGoal(value: unknown): value is SetupGoal {
  return typeof value === "string" && (SETUP_GOALS as readonly string[]).includes(value)
}

export type SetupStepStatus = "pending" | "in-progress" | "done" | "skipped" | "failed"

export type SetupRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled"

export const SETUP_ERROR = {
  planNotFound: "SETUP_PLAN_NOT_FOUND",
  planStale: "SETUP_PLAN_STALE",
  busy: "SETUP_OPERATION_BUSY",
  incomplete: "SETUP_INCOMPLETE",
  stateWriteFailed: "SETUP_STATE_WRITE_FAILED",
  inspectFailed: "SETUP_INSPECT_FAILED",
  runNotFound: "SETUP_RUN_NOT_FOUND",
  actionNotFound: "SETUP_ACTION_NOT_FOUND",
  dependencyPending: "SETUP_ACTION_DEPENDENCY_PENDING",
  goalInvalid: "SETUP_GOAL_INVALID",
  inputRequired: "SETUP_ACTION_INPUT_REQUIRED",
  inputInvalid: "SETUP_ACTION_INPUT_INVALID",
  operationCancelled: "SETUP_OPERATION_CANCELLED",
  githubInvalid: "SETUP_GITHUB_TOKEN_INVALID",
  githubFailed: "SETUP_GITHUB_FAILED",
  providerFailed: "SETUP_PROVIDER_FAILED",
  ontologyFailed: "SETUP_ONTOLOGY_FAILED",
  spaceFailed: "SETUP_SPACE_FAILED",
  preparationFailed: "SETUP_PREPARATION_FAILED",
  foundationFailed: "SETUP_FOUNDATION_FAILED",
  homeConfigFailed: "SETUP_HOME_CONFIG_FAILED",
  homeUnconfirmed: "SETUP_HOME_UNCONFIRMED",
  homeLocked: "SETUP_HOME_LOCKED",
  homeInvalid: "SETUP_HOME_INVALID",
  homePersistFailed: "SETUP_HOME_PERSIST_FAILED",
} as const

export class SetupServiceError extends Error {
  readonly code: string
  readonly suggestion?: string

  constructor(input: { code: string; message: string; suggestion?: string; cause?: unknown }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "SetupServiceError"
    this.code = input.code
    if (input.suggestion) this.suggestion = input.suggestion
  }
}

export function setupPublicError(error: unknown, redact: (text: string) => string): PublicError {
  if (error instanceof SetupServiceError) {
    return {
      code: error.code,
      message: redact(error.message),
      ...(error.suggestion ? { suggestion: redact(error.suggestion) } : {}),
    }
  }
  return {
    code: "SETUP_OPERATION_FAILED",
    message: redact(error instanceof Error ? error.message : String(error)),
  }
}

// ---------------------------------------------------------------------------
// Persisted application state
// ---------------------------------------------------------------------------

/**
 * The Ellamaka onboarding recovery document under WOPAL_HOME/.setup.
 *
 * Only the setup recovery position, the per-step statuses and "completed" are
 * stored. Machine facts are always re-read; credentials never live here.
 */
export interface SetupState {
  readonly version: 1
  readonly currentStep: string
  readonly steps: Readonly<Record<string, SetupStepStatus>>
  readonly errors: Readonly<Record<string, string>>
  readonly completed: boolean
  readonly startedAt: string | null
  readonly updatedAt: string | null
}

export type SetupStateRead =
  | { readonly status: "absent"; readonly path: string }
  | { readonly status: "ok"; readonly path: string; readonly state: SetupState }
  | { readonly status: "corrupt"; readonly path: string; readonly diagnostic: string }

export interface SetupStateStore {
  read(): Promise<SetupStateRead>
  write(state: SetupState): Promise<{ ok: true } | { ok: false; reason: string }>
  /**
   * Read → change → publish under one exclusive cross-process lock, so a
   * concurrent Server, worker or restart cannot lose another writer's step or
   * completion record. The change receives the freshly read state and returns
   * the document to publish, or an error to abort untouched.
   */
  update(
    change: (current: SetupStateRead) => SetupState | { error: string },
  ): Promise<{ ok: true; state: SetupState } | { ok: false; reason: string }>
}

// ---------------------------------------------------------------------------
// Live facts
// ---------------------------------------------------------------------------

export interface SetupOntologyItem {
  readonly name: string
  readonly path: string
  readonly mode: "fork" | "clone"
}

export interface SetupSpaceItem {
  readonly name: string
  readonly path: string
  /** The Space has a verifiable assembly snapshot/worktree. */
  readonly verified: boolean
}

export interface SetupFacts {
  readonly home: {
    readonly path: string
    readonly binding: SetupHomeBindingFacts
    readonly writable: boolean
    readonly foundation: { readonly ready: boolean; readonly missing: readonly string[] }
    readonly settings: {
      readonly present: boolean
      readonly valid: boolean
      readonly ellamaka: { readonly present: boolean; readonly valid: boolean }
    }
    readonly capabilities: { readonly ready: boolean; readonly missing: readonly string[] }
  }
  readonly ontology: {
    readonly status: "ready" | "missing" | "broken"
    readonly items: readonly SetupOntologyItem[]
    readonly diagnostic?: string
  }
  readonly space: {
    readonly status: "ready" | "missing" | "unprepared"
    readonly items: readonly SetupSpaceItem[]
    readonly availableTypes: readonly { readonly type: string; readonly description: string | null }[]
    readonly diagnostic?: string
  }
  readonly credentials: {
    readonly github: { readonly configured: boolean; readonly source?: string; readonly account?: string }
    readonly providers: readonly string[]
  }
  readonly state: {
    readonly status: "absent" | "ok" | "corrupt"
    readonly path: string
    readonly completed: boolean
    readonly currentStep: string
    readonly steps: Readonly<Record<string, SetupStepStatus>>
    readonly diagnostic?: string
  }
}

export type SetupHomeMode = "normal" | "development"

export type SetupHomeSource = "shell" | "default" | "selected"

export interface SetupHomeBindingFacts {
  readonly mode: SetupHomeMode
  readonly source: SetupHomeSource
  readonly path: string
  readonly locked: boolean
  readonly selectable: boolean
  readonly persisted: boolean
}

export interface SetupHomeBinding {
  inspect(): SetupHomeBindingFacts
  select(path: string): Promise<SetupHomeBindingFacts>
}

export interface SetupHomeBindingOptions {
  readonly mode: SetupHomeMode
  readonly initialPath: string
  readonly source: Exclude<SetupHomeSource, "selected">
  readonly locked: boolean
  readonly normalizePath: (path: string) => string
  readonly persist: (path: string) => Promise<void>
  readonly apply: (path: string) => Promise<void>
}

export interface SetupInspectResult extends SetupFacts {
  /** Goals whose live facts already meet them. */
  readonly goals: readonly SetupGoal[]
  readonly fingerprint: string
}

export interface SetupFactSource {
  read(): Promise<SetupFacts>
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface SetupAction {
  readonly actionId: SetupActionId
  readonly goal: SetupGoal
  readonly requiresInput: boolean
  readonly dependsOn: readonly SetupActionId[]
}

export interface SetupPlan {
  readonly planId: string
  readonly goals: readonly SetupGoal[]
  readonly actions: readonly SetupAction[]
  readonly fingerprint: string
  readonly createdAt: string
}

// ---------------------------------------------------------------------------
// Run and progress
// ---------------------------------------------------------------------------

export type SetupEventPhase = "started" | "progress" | "completed" | "failed" | "cancelled"

export interface SetupEvent {
  readonly sequence: number
  readonly runId: string
  readonly actionId: SetupActionId
  readonly type: "progress" | "error"
  readonly phase: SetupEventPhase
  readonly message: string
  readonly at: string
  readonly error?: PublicError
}

export interface SetupRunSnapshot {
  readonly runId: string
  readonly planId: string
  readonly actionId: SetupActionId
  readonly goal: SetupGoal
  readonly status: SetupRunStatus
  /** Sequence of the last emitted event. */
  readonly sequence: number
  readonly startedAt: string
  readonly updatedAt: string
  readonly result?: Readonly<Record<string, unknown>>
  readonly error?: PublicError
}

export interface SetupCompleteResult {
  readonly completed: true
  readonly planId: string
  readonly completedAt: string
}

// ---------------------------------------------------------------------------
// Cross-domain and host boundaries
// ---------------------------------------------------------------------------

/**
 * Read/install boundary owned by the Ontology domain. The concrete ontology
 * service is composed by the Server; Setup never imports its internals.
 */
export interface SetupOntologyPort {
  list(): Promise<{
    readonly items: readonly (SetupOntologyItem & { available: boolean; readable: boolean })[]
    readonly total: number
  }>
  install(
    input: { readonly name?: string; readonly source?: string; readonly mode: "fork" | "clone" },
    signal?: AbortSignal,
  ): Promise<{ readonly name: string; readonly path: string; readonly status: "created" | "reused" | "upgraded" }>
}

/** The Space init result, including the separate preparation fact. */
export interface SetupSpaceInitResult {
  readonly name: string
  readonly path: string
  readonly materialized: boolean
  readonly preparation: {
    readonly status: "ok" | "failed" | "cancelled"
    readonly error?: PublicError
  }
}

/** Read/init boundary owned by the Space domain. */
export interface SetupSpacePort {
  list(): Promise<{ readonly items: readonly SetupSpaceItem[]; readonly total: number }>
  availableTypes(): Promise<readonly { readonly type: string; readonly description: string | null }[]>
  init(
    input: { readonly name: string; readonly root: string; readonly type: string },
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<SetupSpaceInitResult>
}

/** Credential presence/write boundary. Secrets only pass through this call. */
export interface SetupCredentialStore {
  setGithubToken(token: string): Promise<{ ok: true; created: boolean; path: string } | { ok: false; reason: string }>
  providerIds(): Promise<readonly string[]>
  setProviderKey(input: {
    providerId: string
    apiKey: string
  }): Promise<{ ok: true; created: boolean; path: string } | { ok: false; reason: string }>
}

/** Verified GitHub identity used by Setup facts and fork-mode decisions. */
export interface SetupGithubPort {
  inspect(): Promise<{ readonly configured: boolean; readonly source?: string; readonly account?: string }>
  verify(token: string): Promise<{ readonly valid: boolean; readonly account: string | null }>
}

/** Controlled Home foundation: the WOPAL_HOME root only, never child resources. */
export interface SetupFoundationPort {
  ensure(): Promise<{ readonly path: string; readonly created: readonly string[] }>
}

export interface SetupHomeSeedResult {
  readonly settings: { readonly path: string; readonly changed: boolean }
  readonly capabilities: { readonly created: readonly string[] }
}

/** Post-Ontology Home initialization owned by Setup, not by foundation. */
export interface SetupHomeSeedPort {
  seed(ontologyPath: string): Promise<SetupHomeSeedResult>
}

export interface SetupServiceOptions {
  readonly host: HostContext
  /** Host-lifecycle Home binding facts. Non-Onboarding consumers default to a locked Home. */
  readonly homeBinding?: () => SetupHomeBindingFacts
  readonly ontology: SetupOntologyPort
  readonly space: SetupSpacePort
  readonly state?: SetupStateStore
  readonly credentials?: SetupCredentialStore
  readonly github?: SetupGithubPort
  readonly foundation?: SetupFoundationPort
  readonly homeSeed?: SetupHomeSeedPort
  /** Test/composition seam; defaults to reading real Home/domain facts. */
  readonly facts?: SetupFactSource
  readonly now?: () => Date
  readonly newId?: () => string
}

export interface SetupService {
  inspect(): Promise<SetupInspectResult>
  plan(input: { readonly goals: readonly SetupGoal[] }): Promise<SetupPlan>
  execute(input: {
    readonly planId: string
    readonly actionId: SetupActionId
    readonly input?: unknown
    /** Transport-level cancellation for the revalidation window. */
    readonly signal?: AbortSignal
  }): Promise<SetupRunSnapshot>
  progress(runId: string): Promise<SetupRunSnapshot>
  progressEvents(input: {
    readonly runId: string
    readonly after?: number
    readonly signal?: AbortSignal
  }): AsyncIterable<SetupEvent>
  cancel(runId: string): Promise<SetupRunSnapshot>
  complete(input: { readonly planId: string }): Promise<SetupCompleteResult>
}
