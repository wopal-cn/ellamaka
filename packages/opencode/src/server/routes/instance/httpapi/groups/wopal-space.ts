import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

// ===========================================================================
// Public errors
// ===========================================================================

const PublicErrorFields = {
  code: Schema.String,
  message: Schema.String,
  suggestion: Schema.optional(Schema.String),
}

/** A caller-correctable request problem (invalid name, path, selection, query). */
export class WopalSpaceRequestError extends Schema.ErrorClass<WopalSpaceRequestError>("WopalSpaceRequestError")(
  PublicErrorFields,
  { httpApiStatus: 400 },
) {}

/** A registered Space or Ontology does not exist. */
export class WopalSpaceNotFoundError extends Schema.ErrorClass<WopalSpaceNotFoundError>("WopalSpaceNotFoundError")(
  PublicErrorFields,
  { httpApiStatus: 404 },
) {}

/** A path escaped its registered root or a Git target failed validation. */
export class WopalSpaceForbiddenError extends Schema.ErrorClass<WopalSpaceForbiddenError>("WopalSpaceForbiddenError")(
  PublicErrorFields,
  { httpApiStatus: 403 },
) {}

/** The requested change conflicts with existing state (dirty tree, conflict, in progress). */
export class WopalSpaceConflictError extends Schema.ErrorClass<WopalSpaceConflictError>("WopalSpaceConflictError")(
  PublicErrorFields,
  { httpApiStatus: 409 },
) {}

/** The operation itself failed inside the host (unexpected Git/FS failure). */
export class WopalSpaceOperationError extends Schema.ErrorClass<WopalSpaceOperationError>("WopalSpaceOperationError")(
  PublicErrorFields,
  { httpApiStatus: 500 },
) {}

const WopalSpaceErrors = [
  WopalSpaceRequestError,
  WopalSpaceNotFoundError,
  WopalSpaceForbiddenError,
  WopalSpaceConflictError,
  WopalSpaceOperationError,
] as const

// ===========================================================================
// Shared domain result schemas
// ===========================================================================

const Mode = Schema.Literals(["fork", "clone"])

const RepositoryFacts = Schema.Struct({
  available: Schema.Boolean,
  readable: Schema.Boolean,
  branch: Schema.optional(Schema.String),
  head: Schema.optional(Schema.String),
  dirty: Schema.Boolean,
  changes: Schema.Array(Schema.String),
  branches: Schema.Array(Schema.String),
  diagnostic: Schema.optional(Schema.String),
})

const FileDiff = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(["added", "modified", "deleted"]),
})

const FlowAnalysis = Schema.Struct({
  label: Schema.String,
  fromBranch: Schema.String,
  toBranch: Schema.String,
  kind: Schema.Literals(["merge", "push", "contribute"]),
  historyState: Schema.Literals([
    "same",
    "source-ancestor",
    "target-ancestor",
    "diverged",
    "no-common-base",
    "unavailable",
  ]),
  sourceAhead: Schema.NullOr(Schema.Number),
  targetAhead: Schema.NullOr(Schema.Number),
  contentState: Schema.Literals(["aligned", "changes", "conflict", "unknown"]),
  fileDiffs: Schema.Array(FileDiff),
  conflictFiles: Schema.Array(Schema.String),
  requiredAction: Schema.Literals([
    "none",
    "fast-forward",
    "merge-content",
    "reconcile-history",
    "push",
    "contribute",
    "sync-first",
    "blocked",
  ]),
})

const OntologySpaceReference = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  branch: Schema.String,
  type: Schema.String,
  ontology: Schema.String,
})

const OntologySummary = Schema.Struct({
  name: Schema.String,
  mode: Mode,
  path: Schema.String,
  remote: Schema.String,
  upstream: Schema.optional(Schema.String),
  available: Schema.Boolean,
  repo: RepositoryFacts,
  spaces: Schema.Array(OntologySpaceReference),
})

const OntologyListResult = Schema.Struct({
  items: Schema.Array(OntologySummary),
  total: Schema.Number,
})

const OntologyInspectResult = Schema.Struct({
  name: Schema.String,
  mode: Mode,
  path: Schema.String,
  remote: Schema.String,
  available: Schema.Boolean,
  spaces: Schema.Array(OntologySpaceReference),
  repo: RepositoryFacts,
  localRepo: Schema.String,
  remoteRepo: Schema.String,
  upstreamRepo: Schema.optional(Schema.String),
  repository: RepositoryFacts,
  downstream: Schema.Array(FlowAnalysis),
  upstream: Schema.Array(FlowAnalysis),
})

const ContributionPullRequest = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  state: Schema.Literals(["open", "merged", "closed"]),
  headSha: Schema.optional(Schema.String),
  headMatchesBranch: Schema.Boolean,
})

const ContributionEntry = Schema.Struct({
  branch: Schema.String,
  origins: Schema.Array(Schema.Literals(["local", "remote"])),
  worktreePath: Schema.optional(Schema.String),
  localHead: Schema.optional(Schema.String),
  remoteHead: Schema.optional(Schema.String),
  pr: Schema.optional(ContributionPullRequest),
  prLookup: Schema.Literals(["found", "missing", "failed"]),
  diagnostic: Schema.optional(Schema.String),
})

const RefreshPhase = Schema.Struct({
  status: Schema.Literals(["ok", "failed", "unavailable"]),
  ok: Schema.Boolean,
  diagnostics: Schema.Array(Schema.String),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      suggestion: Schema.optional(Schema.String),
    }),
  ),
})

const RefreshResult = Schema.Struct({
  git: Schema.Struct({
    status: Schema.Literals(["ok", "failed", "unavailable"]),
    ok: Schema.Boolean,
    diagnostics: Schema.Array(Schema.String),
    error: Schema.optional(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        suggestion: Schema.optional(Schema.String),
      }),
    ),
    remotes: Schema.Record(
      Schema.String,
      Schema.Struct({ status: Schema.Literals(["ok", "failed"]), error: Schema.optional(Schema.String) }),
    ),
  }),
  pr: RefreshPhase,
  contributions: Schema.Array(ContributionEntry),
  inspection: OntologyInspectResult,
})

const InstallResult = Schema.Struct({
  name: Schema.String,
  mode: Mode,
  path: Schema.String,
  remote: Schema.String,
  upstream: Schema.String,
  status: Schema.Literals(["created", "reused", "upgraded"]),
})

const SyncStep = Schema.Struct({
  step: Schema.String,
  action: Schema.Literals([
    "skipped",
    "fast-forwarded",
    "merged",
    "reconciled",
    "pushed",
    "conflict",
    "failed",
  ]),
  fileDiffs: Schema.optional(Schema.Array(FileDiff)),
  conflictFiles: Schema.optional(Schema.Array(Schema.String)),
  summary: Schema.optional(Schema.String),
})

const OntologySyncResult = Schema.Struct({
  steps: Schema.Array(SyncStep),
  pushed: Schema.Boolean,
  pushErrors: Schema.optional(Schema.Array(Schema.Struct({ branch: Schema.String, message: Schema.String }))),
})

const OntologyCapabilityResult = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["agents", "skills", "rules", "commands", "plugins"]),
      name: Schema.String,
      description: Schema.String,
    }),
  ),
  total: Schema.Number,
})

const RegisteredSpace = Schema.Struct({
  name: Schema.String,
  displayName: Schema.String,
  path: Schema.String,
  ontology: Schema.optional(Schema.String),
  branch: Schema.String,
  type: Schema.String,
  createdAt: Schema.optional(Schema.String),
})

const SpaceFacts = Schema.Struct({
  present: Schema.Boolean,
  snapshot: Schema.Literals(["ok", "missing", "invalid"]),
  worktree: Schema.Boolean,
  mismatch: Schema.Array(Schema.String),
})

const SpaceListResult = Schema.Struct({
  items: Schema.Array(Schema.Struct({ ...RegisteredSpace.fields, facts: SpaceFacts })),
  total: Schema.Number,
})

const SpaceResolveResult = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  space: RegisteredSpace,
  source: Schema.Literals(["name", "directory"]),
})

const SpaceFilesListResult = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      path: Schema.String,
      absolute: Schema.String,
      type: Schema.Literals(["file", "directory"]),
      ignored: Schema.Boolean,
    }),
  ),
  total: Schema.Number,
})

const SpaceFileContent = Schema.Struct({
  type: Schema.Literals(["text", "binary"]),
  content: Schema.String,
  encoding: Schema.optional(Schema.Literal("base64")),
  mimeType: Schema.optional(Schema.String),
})

const SpaceProjectsResult = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      path: Schema.String,
      worktrees: Schema.Array(Schema.Struct({ path: Schema.String, branch: Schema.optional(Schema.String) })),
    }),
  ),
  total: Schema.Number,
})

const SpaceSearchResult = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      path: Schema.String,
      type: Schema.Literals(["dir", "repo", "file"]),
    }),
  ),
  total: Schema.Number,
  offset: Schema.Number,
  limit: Schema.Number,
  hasMore: Schema.Boolean,
})

const Description = Schema.Struct({
  text: Schema.String,
  source: Schema.Literals([
    "agents.frontmatter.description",
    "agents.first_paragraph",
    "readme.first_paragraph",
    "package.metadata.description",
  ]),
  confidence: Schema.Literals(["high", "medium"]),
  truncated: Schema.optional(Schema.Boolean),
  sourcePath: Schema.optional(Schema.String),
})

const SpaceScanResult = Schema.Struct({
  space: Schema.Struct({ name: Schema.String, path: Schema.String }),
  repositories: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      level: Schema.Literal("repo"),
      type: Schema.Literals(["repo", "worktree"]),
      remote: Schema.optional(Schema.String),
      ref: Schema.optional(Schema.String),
      description: Schema.optional(Schema.NullOr(Description)),
      agentsFile: Schema.optional(Schema.String),
    }),
  ),
  agentRules: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      role: Schema.Literal("module-rules"),
      repo: Schema.String,
      description: Schema.optional(Schema.NullOr(Description)),
      agentsFile: Schema.optional(Schema.String),
    }),
  ),
})

const SpaceSyncCommit = Schema.Struct({ sha: Schema.String, subject: Schema.String })

const PreparationFacts = Schema.Struct({
  status: Schema.Literals(["ready", "needs-preparation", "preparing", "busy", "degraded", "unknown"]),
  diagnostic: Schema.optional(Schema.String),
})

const SpaceStatusResult = Schema.Struct({
  space: Schema.Struct({
    name: Schema.String,
    path: Schema.String,
    branch: Schema.String,
    type: Schema.String,
  }),
  sync: Schema.Struct({
    contributions: Schema.Array(SpaceSyncCommit),
    behindCount: Schema.Number,
    behindCommits: Schema.Array(SpaceSyncCommit),
    mergePrediction: Schema.Literals(["clean", "conflict"]),
    conflictFiles: Schema.Array(Schema.String),
  }),
  assembly: Schema.Struct({
    schema: Schema.String,
    ontology: Schema.String,
    sparseConsistent: Schema.NullOr(Schema.Boolean),
    sparseViolations: Schema.Array(
      Schema.Struct({ path: Schema.String, form: Schema.Literals(["stranded", "drifted"]) }),
    ),
  }),
  selection: Schema.Struct({
    include: Schema.Array(Schema.String),
    exclude: Schema.Array(Schema.String),
    private: Schema.Array(Schema.String),
  }),
  unregistered: Schema.Array(Schema.String),
  rootState: Schema.optional(
    Schema.Struct({
      tracked: Schema.Boolean,
      pendingChanges: Schema.Boolean,
      lastCommit: Schema.optional(SpaceSyncCommit),
    }),
  ),
  remote: Schema.optional(Schema.Struct({ ahead: Schema.Number, behind: Schema.Number })),
  dirtyCount: Schema.Number,
  preparation: PreparationFacts,
})

const SpaceSyncResult = Schema.Struct({
  confirm: Schema.Boolean,
  strayFiles: Schema.Array(Schema.String),
  contributions: Schema.Array(SpaceSyncCommit),
  mainAhead: Schema.Number,
  mainHead: Schema.String,
  sparsePatterns: Schema.Array(Schema.String),
  shadowedPaths: Schema.Array(Schema.String),
  protectedPaths: Schema.Array(Schema.String),
  conflicts: Schema.Struct({ upstream: Schema.Array(Schema.String), stray: Schema.Array(Schema.String) }),
  prunedSelections: Schema.Array(Schema.String),
  pluginConfigDrift: Schema.Array(
    Schema.Struct({ section: Schema.String, added: Schema.Array(Schema.String), removed: Schema.Array(Schema.String) }),
  ),
  uncommittedChanges: Schema.Array(Schema.String),
})

const SpaceReconcileStep = Schema.Struct({
  step: Schema.Literals([
    "ontology",
    "assembly",
    "worktree",
    "materialize",
    "config",
    "range",
    "snapshot",
    "git",
    "register",
  ]),
  status: Schema.Literals(["created", "repaired", "reused", "skipped", "updated"]),
  detail: Schema.String,
})

const SpaceInitResult = Schema.Struct({
  space: RegisteredSpace,
  materialized: Schema.Struct({
    condition: Schema.Literals([
      "create",
      "noop",
      "repair-worktree",
      "repair-registry",
      "repair-both",
      "relink",
      "invalid",
    ]),
    finalCondition: Schema.Literals([
      "create",
      "noop",
      "repair-worktree",
      "repair-registry",
      "repair-both",
      "relink",
      "invalid",
    ]),
    type: Schema.String,
    branch: Schema.String,
    steps: Schema.Array(SpaceReconcileStep),
    prunedSelections: Schema.Array(Schema.String),
  }),
  preparation: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("ready"),
      prepared: Schema.Boolean,
      detail: Schema.optional(Schema.String),
    }),
    Schema.Struct({
      status: Schema.Literal("failed"),
      error: Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        suggestion: Schema.optional(Schema.String),
      }),
    }),
    Schema.Struct({ status: Schema.Literal("cancelled") }),
    Schema.Struct({ status: Schema.Literal("skipped"), reason: Schema.String }),
  ]),
})

const CapabilityResult = Schema.Struct({
  confirm: Schema.Boolean,
  operation: Schema.Literals(["add", "remove"]),
  local: Schema.Boolean,
  type: Schema.String,
  items: Schema.Array(
    Schema.Struct({
      reference: Schema.String,
      capabilityPath: Schema.String,
      selection: Schema.Literals(["include", "exclude", "private", "none"]),
      warnings: Schema.Array(Schema.String),
    }),
  ),
  stateCommit: Schema.optional(Schema.String),
  capabilities: Schema.Struct({
    agents: Schema.Array(Schema.String),
    skills: Schema.Array(Schema.String),
    rules: Schema.Array(Schema.String),
    commands: Schema.Array(Schema.String),
    plugins: Schema.Array(Schema.String),
    paths: Schema.Array(Schema.String),
  }),
})

// ===========================================================================
// Setup domain result schemas
// ===========================================================================

const SetupGoal = Schema.Literals(["foundation", "github", "ontology", "space", "provider"])

const SetupRunStatus = Schema.Literals(["queued", "running", "completed", "failed", "cancelled"])

const SetupError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  suggestion: Schema.optional(Schema.String),
})

const SetupStateFacts = Schema.Struct({
  status: Schema.Literals(["absent", "ok", "corrupt"]),
  path: Schema.String,
  completed: Schema.Boolean,
  currentStep: Schema.String,
  steps: Schema.Record(Schema.String, Schema.String),
  diagnostic: Schema.optional(Schema.String),
})

const SetupHomeBinding = Schema.Struct({
  mode: Schema.Literals(["normal", "development"]),
  source: Schema.Literals(["shell", "default", "selected"]),
  path: Schema.String,
  locked: Schema.Boolean,
  selectable: Schema.Boolean,
  persisted: Schema.Boolean,
})

const SetupInspectResult = Schema.Struct({
  home: Schema.Struct({
    path: Schema.String,
    binding: SetupHomeBinding,
    writable: Schema.Boolean,
    foundation: Schema.Struct({ ready: Schema.Boolean, missing: Schema.Array(Schema.String) }),
    settings: Schema.Struct({
      present: Schema.Boolean,
      valid: Schema.Boolean,
      ellamaka: Schema.Struct({ present: Schema.Boolean, valid: Schema.Boolean }),
    }),
    capabilities: Schema.Struct({ ready: Schema.Boolean, missing: Schema.Array(Schema.String) }),
  }),
  ontology: Schema.Struct({
    status: Schema.Literals(["ready", "missing", "broken"]),
    items: Schema.Array(
      Schema.Struct({ name: Schema.String, path: Schema.String, mode: Schema.Literals(["fork", "clone"]) }),
    ),
    diagnostic: Schema.optional(Schema.String),
  }),
  space: Schema.Struct({
    status: Schema.Literals(["ready", "missing", "unprepared"]),
    items: Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String, verified: Schema.Boolean })),
    availableTypes: Schema.Array(Schema.Struct({ type: Schema.String, description: Schema.NullOr(Schema.String) })),
    diagnostic: Schema.optional(Schema.String),
  }),
  credentials: Schema.Struct({
    github: Schema.Struct({
      configured: Schema.Boolean,
      source: Schema.optional(Schema.String),
      account: Schema.optional(Schema.String),
    }),
    providers: Schema.Array(Schema.String),
  }),
  state: SetupStateFacts,
  goals: Schema.Array(SetupGoal),
  fingerprint: Schema.String,
})

const SetupHomeSelectResult = SetupHomeBinding

const SetupAction = Schema.Struct({
  actionId: SetupGoal,
  goal: SetupGoal,
  requiresInput: Schema.Boolean,
  dependsOn: Schema.Array(SetupGoal),
})

const SetupPlanResult = Schema.Struct({
  planId: Schema.String,
  goals: Schema.Array(SetupGoal),
  actions: Schema.Array(SetupAction),
  fingerprint: Schema.String,
  createdAt: Schema.String,
})

const SetupRunSnapshot = Schema.Struct({
  runId: Schema.String,
  planId: Schema.String,
  actionId: SetupGoal,
  goal: SetupGoal,
  status: SetupRunStatus,
  sequence: Schema.Number,
  startedAt: Schema.String,
  updatedAt: Schema.String,
  result: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  error: Schema.optional(SetupError),
})

const SetupCompleteResult = Schema.Struct({
  completed: Schema.Literal(true),
  planId: Schema.String,
  completedAt: Schema.String,
})

// ===========================================================================
// Paths
// ===========================================================================

const Paths = {
  ontologies: "/wopal-space/ontologies",
  ontologyStatus: "/wopal-space/ontologies/:name/status",
  ontologyRefresh: "/wopal-space/ontologies/:name/refresh",
  ontologySync: "/wopal-space/ontologies/:name/sync",
  ontologyCapabilities: "/wopal-space/ontologies/:name/capabilities",
  spaces: "/wopal-space/spaces",
  spaceResolve: "/wopal-space/spaces/resolve",
  spaceProjects: "/wopal-space/spaces/:name/projects",
  spaceFiles: "/wopal-space/spaces/:name/files",
  spaceFileContent: "/wopal-space/spaces/:name/files/content",
  spaceSearch: "/wopal-space/spaces/:name/search",
  spaceScan: "/wopal-space/spaces/:name/scan",
  spaceStatus: "/wopal-space/spaces/:name/status",
  spaceSync: "/wopal-space/spaces/:name/sync",
  spaceCapabilities: "/wopal-space/spaces/:name/capabilities",
  setupInspect: "/wopal-space/setup/inspect",
  setupHome: "/wopal-space/setup/home",
  setupPlan: "/wopal-space/setup/plan",
  setupRuns: "/wopal-space/setup/runs",
  setupRun: "/wopal-space/setup/runs/:runId",
  setupRunEvents: "/wopal-space/setup/runs/:runId/events",
  setupRunCancel: "/wopal-space/setup/runs/:runId/cancel",
  setupComplete: "/wopal-space/setup/complete",
} as const

// ===========================================================================
// Public Platform WopalSpace group
//
// One HttpApi group so every operation shares one tag (and therefore one
// generated client namespace), one OpenAPI surface and one auth middleware.
// ===========================================================================

export const WopalSpaceApi = HttpApi.make("wopal-space").add(
  HttpApiGroup.make("wopal-space")
    .add(
      HttpApiEndpoint.get("listOntologies", Paths.ontologies, {
        success: described(OntologyListResult, "Registered ontologies"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.ontology.list",
          summary: "List registered ontologies",
          description: "Reads the local ontology registry and repository facts. No network access.",
        }),
      ),
      HttpApiEndpoint.post("installOntology", Paths.ontologies, {
        payload: Schema.Struct({
          name: Schema.String,
          source: Schema.optional(Schema.String),
          mode: Schema.optional(Mode),
          fork: Schema.optional(Schema.Boolean),
        }),
        success: described(InstallResult, "Installed or reused ontology"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.ontology.install",
          summary: "Install or reuse an ontology",
          description: "Clones or forks the requested ontology into this host and registers it.",
        }),
      ),
      HttpApiEndpoint.get("inspectOntology", Paths.ontologyStatus, {
        params: { name: Schema.String },
        success: described(OntologyInspectResult, "Local ontology facts"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.ontology.inspect",
          summary: "Inspect an ontology",
          description: "Read-only local inspection of repository, remote topology and divergence. Does not fetch.",
        }),
      ),
      HttpApiEndpoint.post("refreshOntology", Paths.ontologyRefresh, {
        params: { name: Schema.String },
        success: described(RefreshResult, "Refresh result"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.ontology.refresh",
          summary: "Refresh an ontology",
          description:
            "Fetches remote refs and queries contribution PR status, reporting Git and PR results separately.",
        }),
      ),
      HttpApiEndpoint.post("syncOntology", Paths.ontologySync, {
        params: { name: Schema.String },
        payload: Schema.Struct({ confirm: Schema.Boolean }),
        success: described(OntologySyncResult, "Ontology sync result"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.ontology.sync",
          summary: "Sync an ontology",
          description: "confirm=false previews with zero writes; confirm=true re-validates and applies.",
        }),
      ),
      HttpApiEndpoint.get("ontologyCapabilities", Paths.ontologyCapabilities, {
        params: { name: Schema.String },
        query: Schema.Struct({ kind: Schema.optional(Schema.String) }),
        success: described(OntologyCapabilityResult, "Ontology capability pool"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.ontology.capability.list",
          summary: "List ontology capabilities",
          description: "Returns the ontology's full capability pool without Runtime permission filtering.",
        }),
      ),
      HttpApiEndpoint.post("resolveSpace", Paths.spaceResolve, {
        payload: Schema.Struct({ name: Schema.optional(Schema.String), directory: Schema.optional(Schema.String) }),
        success: described(SpaceResolveResult, "Resolved Space"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.space.resolve",
          summary: "Resolve a registered Space",
          description: "Resolves by stable name or by a server-side directory inside a registered root.",
        }),
      ),
      HttpApiEndpoint.get("listSpaces", Paths.spaces, {
        success: described(SpaceListResult, "Registered Spaces"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.space.list",
          summary: "List registered Spaces",
          description: "Reads the local Space registry with read-only disk facts. No Runtime bootstrap.",
        }),
      ),
      HttpApiEndpoint.post("initSpace", Paths.spaces, {
        payload: Schema.Struct({
          name: Schema.String,
          root: Schema.optional(Schema.String),
          ontology: Schema.optional(Schema.String),
          type: Schema.optional(Schema.String),
          displayName: Schema.optional(Schema.String),
        }),
        success: described(SpaceInitResult, "Initialized Space"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.space.init",
          summary: "Initialize or reconcile a Space",
          description:
            "Materializes and registers the Space, preserving user content, then reports instance preparation separately.",
        }),
      ),
      HttpApiEndpoint.get("spaceProjects", Paths.spaceProjects, {
        params: { name: Schema.String },
        success: described(SpaceProjectsResult, "Registered projects"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.space.projects.list",
          summary: "List Space projects",
          description: "Read-only project and worktree facts under the registered root.",
        }),
      ),
      HttpApiEndpoint.get("spaceFiles", Paths.spaceFiles, {
        params: { name: Schema.String },
        query: Schema.Struct({ path: Schema.optional(Schema.String) }),
        success: described(SpaceFilesListResult, "Controlled Space directory listing"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.space.files.list",
          summary: "List Space files",
          description:
            "Lists a relative directory inside the registered root. Traversal and symlink escapes are rejected.",
        }),
      ),
      HttpApiEndpoint.get("spaceFileContent", Paths.spaceFileContent, {
        params: { name: Schema.String },
        query: Schema.Struct({ path: Schema.String }),
        success: described(SpaceFileContent, "Controlled Space file content"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.space.files.read",
          summary: "Read a Space file",
          description: "Reads a relative file inside the registered root. Traversal and symlink escapes are rejected.",
        }),
      ),
      HttpApiEndpoint.get("searchSpace", Paths.spaceSearch, {
        params: { name: Schema.String },
        query: Schema.Struct({
          query: Schema.optional(Schema.String),
          type: Schema.optional(Schema.Literals(["dir", "repo", "file"])),
          limit: Schema.optional(Schema.NumberFromString),
          offset: Schema.optional(Schema.NumberFromString),
        }),
        success: described(SpaceSearchResult, "Space search results"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.space.search",
          summary: "Search a Space",
          description: "Search controlled repo/dir/file candidates inside the registered root.",
        }),
      ),
      HttpApiEndpoint.post("scanSpace", Paths.spaceScan, {
        params: { name: Schema.String },
        success: described(SpaceScanResult, "Space scan facts"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.space.scan",
          summary: "Scan a Space",
          description: "Read-only scan of repositories and AGENTS rules. Does not start a Runtime.",
        }),
      ),
      HttpApiEndpoint.get("spaceStatus", Paths.spaceStatus, {
        params: { name: Schema.String },
        success: described(SpaceStatusResult, "Space status"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.space.status",
          summary: "Read Space status",
          description: "Git, assembly, selection, sparse and preparation facts for the registered Space.",
        }),
      ),
      HttpApiEndpoint.post("syncSpace", Paths.spaceSync, {
        params: { name: Schema.String },
        payload: Schema.Struct({ confirm: Schema.Boolean }),
        success: described(SpaceSyncResult, "Space sync result"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.space.sync",
          summary: "Sync a Space",
          description: "confirm=false previews with zero writes; confirm=true re-validates and applies.",
        }),
      ),
      HttpApiEndpoint.post("addSpaceCapabilities", Paths.spaceCapabilities, {
        params: { name: Schema.String },
        payload: Schema.Struct({
          references: Schema.Array(Schema.String),
          local: Schema.optional(Schema.Boolean),
          section: Schema.optional(Schema.String),
          confirm: Schema.Boolean,
        }),
        success: described(CapabilityResult, "Space capability selection result"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.space.capability.add",
          summary: "Add Space capabilities",
          description: "Adds shared or local capability selections with the same preview/apply decision.",
        }),
      ),
      HttpApiEndpoint.delete("removeSpaceCapabilities", Paths.spaceCapabilities, {
        params: { name: Schema.String },
        payload: Schema.Struct({
          references: Schema.Array(Schema.String),
          local: Schema.optional(Schema.Boolean),
          section: Schema.optional(Schema.String),
          confirm: Schema.Boolean,
        }),
        success: described(CapabilityResult, "Space capability selection result"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.space.capability.remove",
          summary: "Remove Space capabilities",
          description: "Removes capability selections with the same preview/apply decision.",
        }),
      ),
      HttpApiEndpoint.get("setupInspect", Paths.setupInspect, {
        success: described(SetupInspectResult, "Live setup facts"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.setup.inspect",
          summary: "Inspect setup facts",
          description:
            "Reads Home, ontology, Space and credential facts with the persisted recovery position. Performs no writes; a corrupt state file is reported as-is.",
        }),
      ),
      HttpApiEndpoint.post("setupHomeSelect", Paths.setupHome, {
        payload: Schema.Struct({ path: Schema.String }),
        success: described(SetupHomeSelectResult, "Locked Host Home"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.setup.home.select",
          summary: "Confirm the Host Home",
          description:
            "Selects WOPAL_HOME only while the Onboarding host is unlocked. Normal mode persists the user environment; development mode is process-only.",
        }),
      ),
      HttpApiEndpoint.post("setupPlan", Paths.setupPlan, {
        payload: Schema.Struct({ goals: Schema.Array(SetupGoal) }),
        success: described(SetupPlanResult, "Pending setup actions"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.setup.plan",
          summary: "Plan setup actions",
          description:
            "Compares the requested goals with live facts and returns the actions still needed. Writes no business resource and copies no credential.",
        }),
      ),
      HttpApiEndpoint.post("setupExecute", Paths.setupRuns, {
        payload: Schema.Struct({
          planId: Schema.String,
          actionId: SetupGoal,
          input: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        }),
        success: described(SetupRunSnapshot, "Started setup run"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.setup.execute",
          summary: "Execute one setup action",
          description:
            "Revalidates the plan facts, then runs the single pending action on this host. Secrets are accepted only here and never echoed back.",
        }),
      ),
      HttpApiEndpoint.get("setupProgress", Paths.setupRun, {
        params: { runId: Schema.String },
        success: described(SetupRunSnapshot, "Setup run snapshot"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.setup.progress",
          summary: "Read setup progress",
          description: "Returns the current snapshot of one run, including its last emitted sequence.",
        }),
      ),
      HttpApiEndpoint.get("setupProgressEvents", Paths.setupRunEvents, {
        params: { runId: Schema.String },
        query: Schema.Struct({ after: Schema.optional(Schema.NumberFromString) }),
        success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.setup.progress.events",
          summary: "Stream setup progress",
          description:
            "Server-sent events with a monotonic sequence. Reconnecting with after=N replays only newer events; missing events are never reported as success.",
        }),
      ),
      HttpApiEndpoint.post("setupCancel", Paths.setupRunCancel, {
        params: { runId: Schema.String },
        success: described(SetupRunSnapshot, "Setup run after cancellation"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.setup.cancel",
          summary: "Cancel a setup run",
          description:
            "Requests cancellation and waits for the action's safe commit or cleanup boundary before returning the real run state.",
        }),
      ),
      HttpApiEndpoint.post("setupComplete", Paths.setupComplete, {
        payload: Schema.Struct({ planId: Schema.String }),
        success: described(SetupCompleteResult, "Setup completed"),
        error: WopalSpaceErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "wopalSpace.setup.complete",
          summary: "Complete setup",
          description:
            "Re-reads application facts, verifies the goals the user requested, then persists completed. Runtime, DSH and product inventory are not completion gates.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "wopal-space",
        description: "WopalSpace ontology and Space operations (Public Platform contract).",
      }),
    )
    .middleware(Authorization),
)

// ===========================================================================
// Instance mode (Runtime view of the current directory)
// ===========================================================================

export const WopalSpaceInstanceApi = HttpApi.make("wopal-space-mode")
  .add(
    HttpApiGroup.make("wopal-space-mode")
      .add(
        HttpApiEndpoint.get("mode", "/wopal-space/mode", {
          query: WorkspaceRoutingQuery,
          success: described(
            Schema.Struct({ isWopalSpace: Schema.Boolean }),
            "WopalSpace mode for the current directory instance",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "wopalSpace.mode",
            summary: "Get WopalSpace mode",
            description: "Check if the current directory instance is running in WopalSpace mode.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "wopal-space",
          description: "WopalSpace instance routes (ellamaka customization).",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "wopalspace instance api",
      version: "0.0.1",
      description: "Instance-scoped WopalSpace API.",
    }),
  )

export type PublicErrorBody = { readonly code: string; readonly message: string; readonly suggestion?: string }
