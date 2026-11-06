/**
 * Space domain entry surface.
 *
 * The package root exports this module; the Server composes
 * `createSpaceService` with a trusted HostContext and an injected instance
 * preparation contributor. Nothing here depends on HTTP, CLI or UI types,
 * and importing it performs no I/O.
 */
export { createSpaceService, type SpaceService, type SpaceServiceOptions } from "./service"
export {
  SpaceServiceError,
  spaceErrorCodes,
  toPublicError,
  type RegisteredOntology,
  type RegisteredSpace,
  type SpaceAgentRuleEntry,
  type SpaceAssemblyState,
  type SpaceCondition,
  type SpaceErrorCode,
  type SpaceFacts,
  type SpaceFileContent,
  type SpaceFileNode,
  type SpaceFilesListResult,
  type SpaceInitInput,
  type SpaceInitResult,
  type SpaceListItem,
  type SpaceListResult,
  type SpaceMaterialization,
  type SpacePreparationFacts,
  type SpacePreparationResult,
  type SpaceProject,
  type SpaceProjectsResult,
  type SpaceReconcileStep,
  type SpaceCapabilityCandidate,
  type SpaceRepositoryEntry,
  type SpaceResolveResult,
  type SpaceScanResult,
  type SpaceSearchInput,
  type SpaceSearchItem,
  type SpaceSearchResult,
  type SpaceSearchType,
  type SpaceSparseViolation,
  type SpaceStatusResult,
  type SpaceSyncCommit,
} from "./types"
export { systemGit, type GitRunner } from "./git"
export { readSpaceRegistry, registeredSpaces, requireRegisteredSpace, spaceRegistryPath } from "./registry"
export { resolveRegisteredSpace } from "./resolve"
export { spaceByName, listSpaces, ontologyPathForSpace } from "./lookup"
export { listSpaceFiles, readSpaceFile } from "./files"
export { listSpaceProjects } from "./projects"
export { searchSpace } from "./search"
export { scanSpace } from "./scan"
export { readSpaceStatus } from "./status"
export { readAssemblyState, spaceMetaPath } from "./snapshot"
export { buildAssemblyState, canonicalCapabilityRef, serializeAssemblyState, validateAssemblyState } from "./selection"
export { materializeSpaceInit, spaceInitPath, expandTildePath } from "./init"
export { normalizeRelativePath, isPathWithin, confineToRoot } from "./confinement"
export { applySpaceSync, previewSpaceSync, planSpaceSync, type SpaceSyncResult, type SpaceSyncConflicts } from "./sync"
export {
  applyCapability,
  previewCapability,
  planCapability,
  type CapabilityInput,
  type CapabilityItemResult,
  type CapabilityResult,
} from "./capability"
