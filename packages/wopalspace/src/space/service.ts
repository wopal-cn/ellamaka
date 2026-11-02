import { join } from "node:path"
import type { HostContext } from "../contract"
import { listSpaceProjects } from "./projects"
import { listSpaceFiles, readSpaceFile } from "./files"
import { readSpaceStatus } from "./status"
import { scanSpace } from "./scan"
import { searchSpace } from "./search"
import { listSpaces, ontologyPathForSpace, resolveSpace, spaceByName } from "./lookup"
import { readSpaceRegistry } from "./registry"
import { materializeSpaceInit } from "./init"
import { readAssemblyState } from "./snapshot"
import { applySpaceSync, previewSpaceSync } from "./sync"
import { applyCapability, previewCapability, type CapabilityInput, type CapabilityResult } from "./capability"
import { listAssemblyTypes, type AvailableAssemblyType } from "./assembly"
import { isPathWithin, realPathOf } from "./confinement"
import type { SpaceSyncResult } from "./sync"
import { systemGit, type GitRunner } from "./git"
import { SpaceServiceError, spaceErrorCodes, toPublicError } from "./types"
import type {
  RegisteredOntology,
  RegisteredSpace,
  SpaceFileContent,
  SpaceFilesListResult,
  SpaceInitInput,
  SpaceInitResult,
  SpaceListResult,
  SpacePreparationFacts,
  SpacePreparationResult,
  SpaceProjectsResult,
  SpaceResolveResult,
  SpaceScanResult,
  SpaceSearchInput,
  SpaceSearchResult,
  SpaceStatusResult,
} from "./types"

/**
 * The Space domain service.
 *
 * Every operation is a business operation; the host supplies trusted context
 * and the Runtime supplies instance preparation. Nothing here depends on
 * HTTP, CLI or UI types, and importing this module has no side effects.
 */
export interface SpaceServiceOptions {
  readonly host: HostContext
  readonly git?: GitRunner
  /** Instance preparation owner; Core Preparation is injected, never spawned. */
  readonly prepareInstance?: (input: {
    readonly spacePath: string
    readonly name: string
  }) => Promise<SpacePreparationResult>
  /** Read-only preparation facts for status; omitted means "unknown". */
  readonly inspectPreparation?: (input: {
    readonly spacePath: string
    readonly name: string
  }) => Promise<SpacePreparationFacts>
  readonly now?: () => Date
  /** Fork mode for worktree recovery from origin. */
  readonly fork?: boolean
}

export interface SpaceService {
  readonly resolve: (input: { readonly name?: string; readonly directory?: string }) => SpaceResolveResult
  readonly list: () => SpaceListResult
  /** Selectable Space archetypes from the registered Ontology. Read-only. */
  readonly availableTypes: () => AvailableAssemblyType[]
  readonly init: (input: SpaceInitInput, onProgress?: (message: string) => void) => Promise<SpaceInitResult>
  readonly projectsList: (name: string) => SpaceProjectsResult
  readonly filesList: (name: string, path?: string) => SpaceFilesListResult
  readonly filesRead: (name: string, path: string) => SpaceFileContent
  readonly search: (name: string, input?: SpaceSearchInput) => SpaceSearchResult
  readonly scan: (name: string) => SpaceScanResult
  readonly status: (name: string) => Promise<SpaceStatusResult>
  /** confirm:false previews with zero writes; confirm:true applies. */
  readonly sync: (name: string, input: { readonly confirm: boolean }) => Promise<SpaceSyncResult>
  readonly capabilityAdd: (name: string, input: CapabilityInput) => Promise<CapabilityResult>
  readonly capabilityRemove: (name: string, input: CapabilityInput) => Promise<CapabilityResult>
}

function confinedOntologyPath(wopalHome: string, ontology: RegisteredOntology): string {
  const root = realPathOf(join(wopalHome, "ontologies"))
  const target = realPathOf(ontology.path)
  if (root === undefined || target === undefined) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.ontologyNotFound,
      message: "Registered Ontology path is unavailable: " + ontology.path,
    })
  }
  if (!isPathWithin(root, target)) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.registryInvalid,
      message: "Registered Ontology path escapes WOPAL_HOME/ontologies: " + ontology.path,
    })
  }
  return target
}

function ontologyFor(
  wopalHome: string,
  space: RegisteredSpace | undefined,
  registry: ReturnType<typeof readSpaceRegistry>,
  requested?: string,
): RegisteredOntology {
  const snapshotOntology = space === undefined ? undefined : readAssemblyState(space.path)
  const registeredNames = Object.keys(registry.ontologies)
  const name =
    requested ??
    space?.ontology ??
    (snapshotOntology !== undefined && snapshotOntology.status === "ok"
      ? snapshotOntology.state.source.ontology
      : undefined) ??
    (registeredNames.length === 1 ? registeredNames[0] : undefined) ??
    "wopal-space-ontology"
  if (!Object.hasOwn(registry.ontologies, name)) {
    throw new SpaceServiceError({
      code: spaceErrorCodes.ontologyNotFound,
      message: "Ontology is not registered: " + name,
      suggestion:
        registeredNames.length > 0
          ? "Pass ontology: one of " + registeredNames.join(", ")
          : "Install or register an ontology first, then retry.",
    })
  }
  return registry.ontologies[name]
}

/** Build the Space service for one trusted host context. */
export function createSpaceService(options: SpaceServiceOptions): SpaceService {
  const git = options.git ?? systemGit
  const now = options.now ?? (() => new Date())
  const wopalHome = options.host.wopalHome

  const resolve = (input: { readonly name?: string; readonly directory?: string }) => resolveSpace(wopalHome, input)
  const list = () => listSpaces(wopalHome, git)
  const availableTypes = () => {
    const registry = readSpaceRegistry(wopalHome)
    const ontology = ontologyFor(wopalHome, undefined, registry)
    return listAssemblyTypes(confinedOntologyPath(wopalHome, ontology))
  }
  const named = (name: string) => spaceByName(wopalHome, name)

  const syncContext = (name: string) => {
    const space = named(name)
    return { wopalHome, git, space, ontologyPath: ontologyPathForSpace(wopalHome, space) }
  }

  const capabilityContext = (name: string) => {
    const space = named(name)
    return { git, space, ontologyPath: ontologyPathForSpace(wopalHome, space) }
  }

  const init = async (input: SpaceInitInput, onProgress?: (message: string) => void): Promise<SpaceInitResult> => {
    const registry = readSpaceRegistry(wopalHome)
    const name = input.name
    const registered = Object.hasOwn(registry.spaces, name) ? registry.spaces[name] : undefined
    const ontology = ontologyFor(wopalHome, registered, registry, input.ontology)

    // Materialization and registration happen first; preparation only follows
    // a Space that exists on disk and in the registry.
    onProgress?.("正在创建空间并装配本体能力。")
    const materialization = materializeSpaceInit(
      {
        wopalHome,
        git,
        ontology: { ...ontology, remote: ontology.origin ?? ontology.upstream },
        ...(registered !== undefined ? { registered } : {}),
        now,
      },
      { input, ...(options.host.directory !== undefined ? { hostDirectory: options.host.directory } : {}) },
      options.fork === true,
    )

    const space = Object.hasOwn(readSpaceRegistry(wopalHome).spaces, name) ? spaceByName(wopalHome, name) : undefined
    if (space === undefined) {
      throw new SpaceServiceError({
        code: spaceErrorCodes.registryInvalid,
        message: "Space registration did not persist: " + name,
      })
    }

    let preparation: SpaceInitResult["preparation"]
    if (options.prepareInstance === undefined) {
      preparation = { status: "skipped", reason: "no instance preparation contributor is wired" }
    } else {
      try {
        onProgress?.("空间已创建，正在安装空间插件依赖。")
        preparation = await options.prepareInstance({ spacePath: space.path, name: space.name })
      } catch (error) {
        preparation = { status: "failed", error: toPublicError(error) }
      }
    }

    return {
      space,
      materialized: {
        condition: materialization.condition,
        finalCondition: materialization.finalCondition,
        type: materialization.type,
        branch: materialization.branch,
        steps: materialization.steps,
        prunedSelections: materialization.prunedSelections,
      },
      preparation,
    }
  }

  return {
    resolve,
    list,
    availableTypes,
    init,
    projectsList: (name) => listSpaceProjects(named(name).path, git),
    filesList: (name, path) => listSpaceFiles(named(name).path, path),
    filesRead: (name, path) => readSpaceFile(named(name).path, path),
    search: (name, input) => searchSpace(named(name).path, input),
    scan: (name) => {
      const space = named(name)
      return scanSpace(space.path, space.name, git)
    },
    sync: async (name, input) => {
      const context = syncContext(name)
      return input.confirm ? applySpaceSync(context) : previewSpaceSync(context)
    },
    capabilityAdd: async (name, input) => {
      const context = capabilityContext(name)
      return input.confirm ? applyCapability(context, "add", input) : previewCapability(context, "add", input)
    },
    capabilityRemove: async (name, input) => {
      const context = capabilityContext(name)
      return input.confirm ? applyCapability(context, "remove", input) : previewCapability(context, "remove", input)
    },
    status: async (name) => {
      const space = named(name)
      const registry = readSpaceRegistry(wopalHome)
      const ontologyPath = ontologyPathForSpace(wopalHome, space)
      const ontologyName = space.ontology
      const ontology =
        ontologyName !== undefined && Object.hasOwn(registry.ontologies, ontologyName)
          ? registry.ontologies[ontologyName]
          : undefined
      const mode: "fork" | "clone" | "unknown" = ontology === undefined ? "unknown" : ontology.fork ? "fork" : "clone"
      const preparation =
        options.inspectPreparation === undefined
          ? undefined
          : await options.inspectPreparation({ spacePath: space.path, name: space.name })
      return readSpaceStatus(
        {
          space,
          ontologyPath,
          ontologyMode: mode,
          ...(preparation !== undefined ? { preparation } : {}),
        },
        git,
      )
    },
  }
}
