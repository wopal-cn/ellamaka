import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { File } from "@/file"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"

const GeneralTarget = Schema.Struct({ type: Schema.Literal("general") })
const SpacePathTarget = Schema.Struct({
  type: Schema.Literal("space"),
  spacePath: Schema.String,
  directory: Schema.optional(Schema.String),
})
const LegacySpaceTarget = Schema.Struct({
  type: Schema.Literal("space"),
  space: Schema.String,
  directory: Schema.optional(Schema.String),
})

export const CreateSessionPayload = Schema.Struct({
  requestID: Schema.String,
  target: Schema.Union([GeneralTarget, SpacePathTarget, LegacySpaceTarget]),
  title: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
})

const DirectoryHealth = Schema.Literals(["healthy", "missing", "unavailable"])
const WorkbenchSessionResponse = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  directory: Schema.String,
  directoryHealth: DirectoryHealth,
  agent: Schema.optional(Schema.String),
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
})

const WorkbenchSessionGroup = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  type: Schema.Literals(["space", "general"]),
  sessionCount: Schema.Number,
  sessions: Schema.Array(WorkbenchSessionResponse),
})
const WorkbenchSessionGroupsResponse = Schema.Struct({ groups: Schema.Array(WorkbenchSessionGroup) })
const WorkbenchSessionStatusResponse = Schema.Struct({
  directory: Schema.String,
  sessionID: SessionID,
  status: SessionStatus.Info,
})
const WorkbenchSessionSummaryResponse = Schema.Struct({
  id: SessionID,
  title: Schema.String,
  directory: Schema.String,
  parentID: Schema.optional(SessionID),
  agent: Schema.optional(Schema.String),
})
const WorkbenchSpaceFilesQuery = Schema.Struct({
  spacePath: Schema.String,
  path: Schema.optional(Schema.String),
})

const WorkbenchTreeSession = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  directory: Schema.String,
  relativePath: Schema.optional(Schema.String),
  marker: Schema.Literals(["", "directory", "worktree"]),
  branch: Schema.optional(Schema.String),
  directoryHealth: DirectoryHealth,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
})
const WorkbenchTreeLocation = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(["general-directory", "general-date", "space-root", "project"]),
  name: Schema.String,
  path: Schema.String,
  sessionCount: Schema.Number,
  sessions: Schema.Array(WorkbenchTreeSession),
})
const WorkbenchSessionTreeResponse = Schema.Struct({
  scopes: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      kind: Schema.Literals(["general", "space"]),
      name: Schema.String,
      path: Schema.String,
      sessionCount: Schema.Number,
      truncated: Schema.Boolean,
      locations: Schema.Array(WorkbenchTreeLocation),
    }),
  ),
})
const WorkbenchLocationsResponse = Schema.Struct({
  scopePath: Schema.String,
  items: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      kind: Schema.Literals(["space-root", "project", "recent", "search"]),
      name: Schema.String,
      path: Schema.String,
      relativeDirectory: Schema.String,
      lastUsedAt: Schema.optional(Schema.Number),
    }),
  ),
})

export class WorkbenchSpaceNotFoundError extends Schema.TaggedErrorClass<WorkbenchSpaceNotFoundError>()(
  "WorkbenchSpaceNotFound",
  { message: Schema.String, spacePath: Schema.String },
  { httpApiStatus: 404 },
) {}
export class InvalidSpaceTargetError extends Schema.TaggedErrorClass<InvalidSpaceTargetError>()(
  "InvalidSpaceTarget",
  { message: Schema.String, detail: Schema.optional(Schema.String) },
  { httpApiStatus: 400 },
) {}
export class SessionDirectoryUnavailableError extends Schema.TaggedErrorClass<SessionDirectoryUnavailableError>()(
  "SessionDirectoryUnavailable",
  { message: Schema.String, directory: Schema.String },
  { httpApiStatus: 409 },
) {}
export class WorkbenchRequestConflictError extends Schema.TaggedErrorClass<WorkbenchRequestConflictError>()(
  "WorkbenchRequestConflict",
  { message: Schema.String, requestID: Schema.String },
  { httpApiStatus: 409 },
) {}
export class WorkbenchSpaceFileAccessDeniedError extends Schema.TaggedErrorClass<WorkbenchSpaceFileAccessDeniedError>()(
  "WorkbenchSpaceFileAccessDenied",
  { message: Schema.String, path: Schema.String },
  { httpApiStatus: 403 },
) {}
export class WorkbenchSpaceFileNotFoundError extends Schema.TaggedErrorClass<WorkbenchSpaceFileNotFoundError>()(
  "WorkbenchSpaceFileNotFound",
  { message: Schema.String, path: Schema.String },
  { httpApiStatus: 404 },
) {}
export class SpaceControlUnavailableError extends Schema.TaggedErrorClass<SpaceControlUnavailableError>()(
  "SpaceControlUnavailable",
  { message: Schema.String, reason: Schema.optional(Schema.String) },
  { httpApiStatus: 503 },
) {}
export class CapabilityContractError extends Schema.TaggedErrorClass<CapabilityContractError>()(
  "CapabilityContractError",
  { message: Schema.String, capability: Schema.optional(Schema.String), detail: Schema.optional(Schema.String) },
  { httpApiStatus: 502 },
) {}

const WorkbenchDshUrlResponse = Schema.Struct({
  url: Schema.Union([Schema.String, Schema.Undefined]),
})

export const WorkbenchPaths = {
  sessions: "/workbench/sessions",
  sessionGroups: "/workbench/session-groups",
  sessionStatuses: "/workbench/session-statuses",
  sessionSummary: "/workbench/session-summaries/:sessionID",
  files: "/workbench/files",
  fileContent: "/workbench/file-content",
  sessionTree: "/workbench/session-tree",
  locations: "/workbench/locations",
  dshUrl: "/workbench/dsh-url",
} as const

const WorkbenchErrors = [
  WorkbenchSpaceNotFoundError,
  InvalidSpaceTargetError,
  SessionDirectoryUnavailableError,
  WorkbenchRequestConflictError,
  SpaceControlUnavailableError,
  CapabilityContractError,
] as const

export const WorkbenchApi = HttpApi.make("workbench").add(
  HttpApiGroup.make("workbench")
    .add(
      HttpApiEndpoint.get("sessionGroups", WorkbenchPaths.sessionGroups, {
        success: described(WorkbenchSessionGroupsResponse, "Legacy Workbench session groups"),
        error: [SpaceControlUnavailableError, CapabilityContractError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "workbench.sessionGroups",
          summary: "List legacy Workbench session groups",
          description: "Compatibility projection for existing consumers. New Workbench clients use session-tree.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("sessionStatuses", WorkbenchPaths.sessionStatuses, {
        success: described(Schema.Array(WorkbenchSessionStatusResponse), "Running Workbench session statuses"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "workbench.sessionStatuses",
          summary: "List status snapshots for initialized sessions",
          description:
            "Returns non-idle busy or retry status snapshots from already initialized instances without loading a directory.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("sessionSummary", WorkbenchPaths.sessionSummary, {
        params: { sessionID: SessionID },
        // Separate same-status schemas retain top-level null in generated
        // OpenAPI/SDK output; a root Schema.NullOr is flattened by the
        // current OpenAPI encoder.
        success: [described(WorkbenchSessionSummaryResponse, "Workbench session notification metadata"), Schema.Null],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "workbench.sessionSummary",
          summary: "Read Workbench session notification metadata",
          description:
            "Reads canonical session metadata without loading a directory. Returns null when the session does not exist.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("files", WorkbenchPaths.files, {
        query: WorkbenchSpaceFilesQuery,
        success: described(Schema.Array(File.Node), "Files and directories in a registered Space"),
        error: [
          WorkbenchSpaceNotFoundError,
          WorkbenchSpaceFileAccessDeniedError,
          WorkbenchSpaceFileNotFoundError,
          SpaceControlUnavailableError,
          CapabilityContractError,
        ],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "workbench.files",
          summary: "List files in a registered Space",
          description:
            "Lists a registered Space root or relative child directory without loading an instance. Traversal and symlink escapes are rejected.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("fileContent", WorkbenchPaths.fileContent, {
        query: Schema.Struct({ spacePath: Schema.String, path: Schema.String }),
        success: described(File.Content, "File content in a registered Space"),
        error: [
          WorkbenchSpaceNotFoundError,
          WorkbenchSpaceFileAccessDeniedError,
          WorkbenchSpaceFileNotFoundError,
          SpaceControlUnavailableError,
          CapabilityContractError,
        ],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "workbench.fileContent",
          summary: "Read a file in a registered Space",
          description:
            "Reads a relative file from a registered Space without loading an instance. Traversal and symlink escapes are rejected.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("dshUrl", WorkbenchPaths.dshUrl, {
        success: described(WorkbenchDshUrlResponse, "Authenticated DSH iframe entry URL"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "workbench.dshUrl",
          summary: "Resolve the authenticated DSH iframe entry",
          description:
            "Returns the launch-token iframe URL for the mounted dsh web engine, or url: undefined when the engine is disabled or not yet mounted.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "workbench", description: "Workbench compatibility routes." }))
    .middleware(Authorization),
)
export const WorkbenchInstanceApi = HttpApi.make("workbench-instance").add(
  HttpApiGroup.make("workbench-instance")
    .add(
      HttpApiEndpoint.post("createSession", WorkbenchPaths.sessions, {
        payload: CreateSessionPayload,
        success: described(WorkbenchSessionResponse, "Created Workbench session"),
        error: WorkbenchErrors,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "workbench.createSession",
          summary: "Create an idempotent Workbench session",
          description:
            "Creates a General or registered-Space session. New clients use target.spacePath; legacy target.space remains supported for one release.",
        }),
      ),
      HttpApiEndpoint.get("sessionTree", WorkbenchPaths.sessionTree, {
        query: Schema.Struct({
          limitPerScope: Schema.optional(
            Schema.NumberFromString.check(
              Schema.isInt(),
              Schema.isGreaterThanOrEqualTo(1),
              Schema.isLessThanOrEqualTo(500),
            ),
          ),
        }),
        success: described(WorkbenchSessionTreeResponse, "Workbench session tree"),
        error: [SpaceControlUnavailableError, CapabilityContractError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "workbench.sessionTree",
          summary: "List sessions as Scope, location, session",
          description: "Returns General first, registered Spaces even when empty, and only active root sessions.",
        }),
      ),
      HttpApiEndpoint.get("locations", WorkbenchPaths.locations, {
        query: Schema.Struct({ spacePath: Schema.String, query: Schema.optional(Schema.String) }),
        success: described(WorkbenchLocationsResponse, "Controlled Workbench creation locations"),
        error: [WorkbenchSpaceNotFoundError, SpaceControlUnavailableError, CapabilityContractError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "workbench.locations",
          summary: "List controlled locations inside a Space",
          description:
            "Candidates are Space root, registered projects, recent session directories, and the directory-search capability; arbitrary filesystem browsing is not exposed.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "workbench-instance", description: "Workbench instance routes." }))
    .middleware(Authorization),
)
