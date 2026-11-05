import type { HostContext, PublicError } from "../contract"

export const CAPABILITY_KINDS = ["agents", "skills", "rules", "commands", "plugins"] as const
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number]
export type OntologyMode = "fork" | "clone"

export class OntologyServiceError extends Error {
  readonly code: string
  readonly suggestion?: string

  constructor(input: { code: string; message: string; suggestion?: string; cause?: unknown }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "OntologyServiceError"
    this.code = input.code
    if (input.suggestion) this.suggestion = input.suggestion
  }
}

const URL_USER_INFO = /\b(https?:\/\/)(?!\[REDACTED\])[^/\s"'<>]*@/gi
const BEARER_TOKEN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi
const LABELED_CREDENTIAL =
  /\b((?:access[_-]?\s*token|refresh[_-]?\s*token|auth[_-]?\s*token|token|api[_-]?\s*key|apikey|client[_-]?\s*secret|secret|password|passwd|pwd|key))(["']?\s*(?:=|:)\s*)(?!\[REDACTED\])("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&)\]}]+)/gi

/** Stable message text; remote credentials never reach callers. */
export function sanitizeMessage(message: string): string {
  return message
    .replace(URL_USER_INFO, "$1")
    .replace(BEARER_TOKEN, "$1[REDACTED]")
    .replace(LABELED_CREDENTIAL, (_match, label: string, separator: string, value: string) => {
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : ""
      const unquoted = quote ? value.slice(1, -1) : value
      if (unquoted === "[REDACTED]") return label + separator + value
      return label + separator + quote + "[REDACTED]" + quote
    })
}

export function toPublicError(error: unknown): PublicError {
  if (error instanceof OntologyServiceError) {
    return {
      code: error.code,
      message: sanitizeMessage(error.message),
      ...(error.suggestion ? { suggestion: sanitizeMessage(error.suggestion) } : {}),
    }
  }
  return {
    code: "ONTOLOGY_OPERATION_FAILED",
    message: sanitizeMessage(error instanceof Error ? error.message : String(error)),
  }
}

export interface OntologyInstallInput {
  readonly name: string
  /** Upstream Git source. "default" selects the official ontology. */
  readonly source?: string
  readonly mode?: OntologyMode
  /** Compatibility spelling of mode: true selects fork, false selects clone. */
  readonly fork?: boolean
}

export interface OntologyRegistryEntry {
  readonly path: string
  readonly upstream: string
  readonly origin?: string
  readonly fork?: boolean
}

export interface OntologySpaceReference {
  readonly name: string
  readonly path: string
  readonly branch: string
  readonly type: string
  readonly ontology: string
}

export interface RepositoryFacts {
  readonly available: boolean
  readonly readable: boolean
  readonly branch?: string
  readonly head?: string
  readonly dirty: boolean
  readonly changes: readonly string[]
  readonly branches: readonly string[]
  readonly diagnostic?: string
}

export interface FileDiff {
  readonly path: string
  readonly status: "added" | "modified" | "deleted"
}

export type OntologyHistoryState =
  | "same"
  | "source-ancestor"
  | "target-ancestor"
  | "diverged"
  | "no-common-base"
  | "unavailable"

export type OntologyContentState = "aligned" | "changes" | "conflict" | "unknown"

export type OntologyFlowAction =
  | "none"
  | "fast-forward"
  | "merge-content"
  | "reconcile-history"
  | "push"
  | "contribute"
  | "sync-first"
  | "blocked"

export interface FlowAnalysis {
  readonly label: string
  readonly fromBranch: string
  readonly toBranch: string
  readonly kind: "merge" | "push" | "contribute"
  readonly historyState: OntologyHistoryState
  readonly sourceAhead: number | null
  readonly targetAhead: number | null
  readonly contentState: OntologyContentState
  readonly fileDiffs: readonly FileDiff[]
  readonly conflictFiles: readonly string[]
  readonly requiredAction: OntologyFlowAction
}

export interface OntologySummary {
  readonly name: string
  readonly mode: OntologyMode
  readonly path: string
  readonly remote: string
  readonly upstream?: string
  readonly available: boolean
  readonly repo: RepositoryFacts
  readonly spaces: readonly OntologySpaceReference[]
}

export interface OntologyListResult {
  readonly items: readonly OntologySummary[]
  readonly total: number
}

export interface OntologyInspectResult {
  readonly name: string
  readonly mode: OntologyMode
  readonly path: string
  readonly remote: string
  readonly available: boolean
  readonly spaces: readonly OntologySpaceReference[]
  readonly repo: RepositoryFacts
  readonly localRepo: string
  readonly remoteRepo: string
  readonly upstreamRepo?: string
  readonly repository: RepositoryFacts
  readonly downstream: readonly FlowAnalysis[]
  readonly upstream: readonly FlowAnalysis[]
}

export interface InstallResult {
  readonly name: string
  readonly mode: OntologyMode
  readonly path: string
  readonly remote: string
  readonly upstream: string
  readonly status: "created" | "reused" | "upgraded"
}

export interface PullRequestSnapshot {
  readonly number: number
  readonly url: string
  readonly state: "open" | "merged" | "closed"
  readonly baseBranch: string
  readonly headBranch: string
  readonly headFork: string
  readonly headSha?: string
}

export interface PullRequestQueryInput {
  readonly repo: string
  readonly upstreamRepo: string
  readonly headFork: string
  readonly headBranch: string
  readonly baseBranch: string
}

/** Explicit external boundary: GitHub PR lookup, never a local read. */
export interface PullRequestQuery {
  readonly query: (input: PullRequestQueryInput) => Promise<readonly PullRequestSnapshot[]>
}

export interface ContributionPullRequest {
  readonly number: number
  readonly url: string
  readonly state: "open" | "merged" | "closed"
  readonly headSha?: string
  readonly headMatchesBranch: boolean
}

export interface ContributionEntry {
  readonly branch: string
  readonly origins: readonly ("local" | "remote")[]
  readonly worktreePath?: string
  readonly localHead?: string
  readonly remoteHead?: string
  readonly pr?: ContributionPullRequest
  readonly prLookup: "found" | "missing" | "failed"
  readonly diagnostic?: string
}

export interface RefreshPhase {
  readonly status: "ok" | "failed" | "unavailable"
  readonly ok: boolean
  /** Readable per-remote or per-lookup explanations, separate from the error summary. */
  readonly diagnostics: readonly string[]
  readonly error?: PublicError
}

export interface RefreshResult {
  readonly git: RefreshPhase & {
    readonly remotes: Readonly<Record<string, { readonly status: "ok" | "failed"; readonly error?: string }>>
  }
  readonly pr: RefreshPhase
  readonly contributions: readonly ContributionEntry[]
  readonly inspection: OntologyInspectResult
}

export type OntologySyncAction =
  | "skipped"
  | "fast-forwarded"
  | "merged"
  | "reconciled"
  | "pushed"
  | "conflict"
  | "failed"

export interface SyncStep {
  readonly step: string
  readonly action: OntologySyncAction
  readonly fileDiffs?: readonly FileDiff[]
  readonly conflictFiles?: readonly string[]
  readonly summary?: string
}

export interface OntologySyncResult {
  readonly steps: readonly SyncStep[]
  readonly pushed: boolean
  readonly pushErrors?: readonly { readonly branch: string; readonly message: string }[]
}

export interface OntologyCapabilityItem {
  readonly kind: CapabilityKind
  readonly name: string
  readonly description: string
}

export interface OntologyCapabilityResult {
  readonly items: readonly OntologyCapabilityItem[]
  readonly total: number
}

export type GitRunner = (cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv) => string

/** GitHub fork creation/verification boundary. Returns an owner/repo slug or Git URL. */
export interface ForkProvisioner {
  readonly ensure: (source: string) => Promise<string>
}

export interface OntologyServiceOptions {
  readonly host: HostContext
  readonly git?: GitRunner
  readonly fork?: ForkProvisioner
  readonly pr?: PullRequestQuery
  /** Scratch root for read-only merge projections. Defaults to the OS temp directory. */
  readonly tempRoot?: string
}

export interface OntologyService {
  readonly install: (input: OntologyInstallInput) => Promise<InstallResult>
  readonly list: () => Promise<OntologyListResult>
  readonly inspect: (name: string) => Promise<OntologyInspectResult>
  readonly refresh: (name: string) => Promise<RefreshResult>
  readonly sync: (name: string, options: { readonly confirm: boolean }) => Promise<OntologySyncResult>
  readonly capabilityList: (name: string, options?: { readonly kind?: string }) => Promise<OntologyCapabilityResult>
  /** The resolved read repository for internal composition; not a public operation. */
  readonly repositoryPath: (name: string) => Promise<string>
}
