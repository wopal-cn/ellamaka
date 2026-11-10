import { Schema } from "effect"
import { OntologyServiceError, SetupServiceError, SpaceServiceError, redactSecret } from "@wopal/wopalspace"

const PublicErrorFields = { code: Schema.String, message: Schema.String, suggestion: Schema.optional(Schema.String) }
export class WopalSpaceRequestError extends Schema.ErrorClass<WopalSpaceRequestError>("WopalSpaceRequestError")(
  PublicErrorFields,
  { httpApiStatus: 400 },
) {}
export class WopalSpaceNotFoundError extends Schema.ErrorClass<WopalSpaceNotFoundError>("WopalSpaceNotFoundError")(
  PublicErrorFields,
  { httpApiStatus: 404 },
) {}
export class WopalSpaceForbiddenError extends Schema.ErrorClass<WopalSpaceForbiddenError>("WopalSpaceForbiddenError")(
  PublicErrorFields,
  { httpApiStatus: 403 },
) {}
export class WopalSpaceConflictError extends Schema.ErrorClass<WopalSpaceConflictError>("WopalSpaceConflictError")(
  PublicErrorFields,
  { httpApiStatus: 409 },
) {}
export class WopalSpaceOperationError extends Schema.ErrorClass<WopalSpaceOperationError>("WopalSpaceOperationError")(
  PublicErrorFields,
  { httpApiStatus: 500 },
) {}
export const WopalSpaceErrors = [
  WopalSpaceRequestError,
  WopalSpaceNotFoundError,
  WopalSpaceForbiddenError,
  WopalSpaceConflictError,
  WopalSpaceOperationError,
] as const
export type ApiError =
  | InstanceType<typeof WopalSpaceRequestError>
  | InstanceType<typeof WopalSpaceNotFoundError>
  | InstanceType<typeof WopalSpaceForbiddenError>
  | InstanceType<typeof WopalSpaceConflictError>
  | InstanceType<typeof WopalSpaceOperationError>

const NOT_FOUND = new Set(["SPACE_NOT_FOUND", "SPACE_ONTOLOGY_NOT_FOUND", "ONTOLOGY_NOT_FOUND", "SPACE_META_MISSING"])
const FORBIDDEN = new Set(["SPACE_PATH_ESCAPE", "ONTOLOGY_PATH_ESCAPE", "PATH_TRAVERSAL_DETECTED"])
const CONFLICT = new Set([
  "SPACE_NAME_EXISTS",
  "SPACE_PATH_REGISTERED",
  "SPACE_NESTED",
  "SPACE_INVALID_STATE",
  "SPACE_META_CONCURRENT_MODIFICATION",
  "SPACE_META_LEGACY_PRIVATE",
  "MERGE_IN_PROGRESS",
  "SPACE_SYNC_CONFLICT",
  "SPACE_SYNC_DIRTY",
  "ONTOLOGY_SYNC_DIRTY",
  "ONTOLOGY_SYNC_IN_PROGRESS",
  "ONTOLOGY_TARGET_CONFLICT",
  "ONTOLOGY_HISTORY_CONFLICT",
  "ONTOLOGY_SOURCE_CONFLICT",
  "ONTOLOGY_TOPOLOGY_CONFLICT",
  "ONTOLOGY_REGISTRY_CHANGED",
])
const SETUP_NOT_FOUND = new Set(["SETUP_PLAN_NOT_FOUND", "SETUP_RUN_NOT_FOUND", "SETUP_ACTION_NOT_FOUND"])
const SETUP_CONFLICT = new Set([
  "SETUP_HOME_UNCONFIRMED",
  "SETUP_HOME_LOCKED",
  "SETUP_PLAN_STALE",
  "SETUP_OPERATION_BUSY",
  "SETUP_INCOMPLETE",
  "SETUP_OPERATION_CANCELLED",
  "SETUP_ACTION_DEPENDENCY_PENDING",
])
const SETUP_REQUEST = new Set([
  "SETUP_HOME_INVALID",
  "SETUP_GOAL_INVALID",
  "SETUP_ACTION_INPUT_REQUIRED",
  "SETUP_ACTION_INPUT_INVALID",
  "SETUP_GITHUB_TOKEN_INVALID",
])
const SETUP_HOST_FAILURE = new Set([
  "SETUP_HOME_PERSIST_FAILED",
  "SETUP_STATE_WRITE_FAILED",
  "SETUP_INSPECT_FAILED",
  "SETUP_GITHUB_FAILED",
  "SETUP_PROVIDER_FAILED",
  "SETUP_ONTOLOGY_FAILED",
  "SETUP_SPACE_FAILED",
  "SETUP_PREPARATION_FAILED",
  "SETUP_FOUNDATION_FAILED",
])
const HOST_FAILURE = new Set([
  "SPACE_OPERATION_FAILED",
  "ONTOLOGY_OPERATION_FAILED",
  "ONTOLOGY_UPGRADE_FAILED",
  "ONTOLOGY_REFRESH_FAILED",
  "ONTOLOGY_PR_UNAVAILABLE",
  "ONTOLOGY_REGISTRY_INVALID",
  "SPACE_REGISTRY_INVALID",
  "SPACE_WORKTREE_FAILED",
  "SPACE_SYNC_FAILED",
  "SPACE_ENV_SEED_FAILED",
  "SPACE_META_COMMIT_FAILED",
  "SPACE_PREPARATION_FAILED",
  "SPARSE_APPLY_FAILED",
  "CAPABILITY_FAILED",
  "SPACE_CAPABILITY_PARTIAL_COMMIT",
  "ASSEMBLY_SCHEMA_INVALID",
  "ASSEMBLY_ARCHETYPE_INVALID",
])
const CREDENTIALS = /https?:\/\/[^/\s@]+@/gi
function sanitize(message: string) {
  return redactSecret(message.replace(CREDENTIALS, (match) => (match.startsWith("https") ? "https://" : "http://")))
}
export function toApiError(error: unknown): ApiError {
  if (error instanceof SetupServiceError) {
    const fields = {
      code: error.code,
      message: sanitize(error.message),
      ...(error.suggestion ? { suggestion: sanitize(error.suggestion) } : {}),
    }
    if (SETUP_NOT_FOUND.has(error.code)) return new WopalSpaceNotFoundError(fields)
    if (SETUP_CONFLICT.has(error.code)) return new WopalSpaceConflictError(fields)
    if (SETUP_HOST_FAILURE.has(error.code)) return new WopalSpaceOperationError(fields)
    return new WopalSpaceRequestError(fields)
  }
  const known = error instanceof OntologyServiceError || error instanceof SpaceServiceError
  const code = known ? error.code : "WOPALSPACE_OPERATION_FAILED"
  const message = sanitize(known ? error.message : error instanceof Error ? error.message : String(error))
  const suggestion = known && error.suggestion ? sanitize(error.suggestion) : undefined
  const fields = { code, message, ...(suggestion ? { suggestion } : {}) }
  if (NOT_FOUND.has(code)) return new WopalSpaceNotFoundError(fields)
  if (FORBIDDEN.has(code)) return new WopalSpaceForbiddenError(fields)
  if (CONFLICT.has(code) || SETUP_CONFLICT.has(code)) return new WopalSpaceConflictError(fields)
  if (SETUP_REQUEST.has(code)) return new WopalSpaceRequestError(fields)
  if (HOST_FAILURE.has(code)) return new WopalSpaceOperationError(fields)
  return new WopalSpaceRequestError(fields)
}
export * as WopalSpaceErrorsModule from "./wopal-space-errors"
