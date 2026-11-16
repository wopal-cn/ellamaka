import { existsSync } from "node:fs"
import { resolve } from "node:path"
import {
  createCorePreparationService,
  type CorePreparationContributor,
  type CorePreparationService,
  type CorePreparationStepResult,
} from "@wopal/ellamaka-core/preparation"
import type { InitializeDshOptions } from "./manager.js"
import { checkClosureIntegrity, materializeClosure, validateClosureOnDisk } from "./materializer.js"
import { acquireMaterializeLock, releaseMaterializeLock } from "./lock.js"
import { createDshLogger } from "./log.js"
import { resolveDshLayout, resolveInstallAnchor } from "./status.js"
import { prepareDshHome, readDshHomeState, withDshHomeExclusiveAccess } from "./home-guard.js"
import { createDshRuntimeApi, createPackageDshRuntimeApi } from "./loader.js"
import { inspectDshProfileResources, prepareDshProfileResources, type DshProfileName } from "./profile-resources.js"
import {
  inspectManagedNode,
  prepareManagedNode,
  ManagedNodeError,
  type ManagedNodeOwner,
  type ManagedNodeDeps,
} from "./managed-node.js"

export type DshPreparationOptions = Omit<InitializeDshOptions, "entry"> & {
  readonly closureVersion: number
  readonly profiles?: readonly DshProfileName[]
  /** Operator confirmation for the one-time adoption of an unversioned Home. */
  readonly legacyAdoptionConfirmed?: boolean
  /** Product and version that own this managed runtime resource. */
  readonly nodeOwner?: ManagedNodeOwner
  /** Desktop reuses its bundled Electron Node instead of downloading one. */
  readonly usesElectronNode?: boolean
  /** Dependency seam for isolated managed runtime tests. */
  readonly managedNodeDeps?: ManagedNodeDeps
}

const LOCK_WAIT_MS = 10 * 60 * 1000

function ready(): CorePreparationStepResult {
  return { state: "READY" }
}

function disabled(options: DshPreparationOptions): boolean {
  return options.profiles?.length === 0
}

function profiles(options: DshPreparationOptions): readonly DshProfileName[] {
  return options.profiles ?? ["web", "ellamaka-tools"]
}

function closureAnchor(options: DshPreparationOptions): string | null {
  return validateClosureOnDisk({ home: options.wopalHome, manifest: options.manifest, deps: options.deps })
}

async function inspectClosure(options: DshPreparationOptions): Promise<CorePreparationStepResult> {
  if (disabled(options)) return ready()
  if (!options.manifest.fingerprint) return { state: "DEGRADED", code: "DSH_CLOSURE_INVALID" }
  const anchor = closureAnchor(options)
  if (!anchor) return { state: "NEEDS_PREPARATION" }
  try {
    await checkClosureIntegrity({ home: options.wopalHome, manifest: options.manifest, deps: options.deps })
    return ready()
  } catch {
    return { state: "NEEDS_PREPARATION", code: "DSH_CLOSURE_DAMAGED" }
  }
}

async function prepareClosure(
  options: DshPreparationOptions,
  context: Parameters<CorePreparationContributor["prepare"]>[1],
): Promise<CorePreparationStepResult> {
  if (disabled(options)) return ready()
  context.signal.throwIfAborted()
  const before = await inspectClosure(options)
  if (before.state === "READY") return before
  if (before.state === "DEGRADED") return before

  const layout = resolveDshLayout(options.wopalHome)
  context.report({ phase: "lock" })
  const token = await acquireMaterializeLock(layout.lockFile, LOCK_WAIT_MS)
  if (!token) return { state: "BUSY", code: "DSH_CLOSURE_BUSY" }
  try {
    context.signal.throwIfAborted()
    const afterLock = await inspectClosure(options)
    if (afterLock.state === "READY") return afterLock
    context.report({ phase: "materialize" })
    const log = createDshLogger({ logFile: options.logFile, minLevel: options.logLevel, print: options.print })
    await materializeClosure({
      home: options.wopalHome,
      manifest: options.manifest,
      lock: options.lock,
      deps: options.deps,
      log,
    })
    // A cancellation that arrives during the durable publication is observed
    // only after publication settles; the generic service reports cancellation.
    context.signal.throwIfAborted()
    context.report({ phase: "closure.completed" })
    return ready()
  } finally {
    await releaseMaterializeLock(layout.lockFile, token)
  }
}

async function inspectHome(options: DshPreparationOptions): Promise<CorePreparationStepResult> {
  if (disabled(options)) return ready()
  const state = await readDshHomeState(options.wopalHome)
  if (state.kind === "managed") {
    if (state.closureVersion === options.closureVersion) return ready()
    if (state.closureVersion > options.closureVersion) return { state: "DEGRADED", code: "DSH_HOME_NEWER_THAN_RUNTIME" }
    return { state: "NEEDS_PREPARATION" }
  }
  if (state.kind === "unknown") return { state: "DEGRADED", code: "DSH_HOME_VERSION_UNKNOWN" }
  if (state.kind === "legacy" && !options.legacyAdoptionConfirmed)
    return { state: "DEGRADED", code: "DSH_HOME_LEGACY_ADOPTION_REQUIRED" }
  return { state: "NEEDS_PREPARATION" }
}

async function prepareHome(
  options: DshPreparationOptions,
  context: Parameters<CorePreparationContributor["prepare"]>[1],
): Promise<CorePreparationStepResult> {
  if (disabled(options)) return ready()
  context.report({ phase: "home.prepare" })
  const result = await prepareDshHome({
    wopalHome: options.wopalHome,
    closureVersion: options.closureVersion,
    ...(options.legacyAdoptionConfirmed ? { legacyAdoptionConfirmed: true } : {}),
  })
  if (result.ok) {
    context.report({ phase: "home.completed" })
    return ready()
  }
  return {
    state: result.reason === "DSH_HOME_BUSY" ? "BUSY" : "DEGRADED",
    code: result.reason,
  }
}

function requiresManagedNode(options: DshPreparationOptions): boolean {
  // Do not infer Web from the legacy default-all profile list: preparation
  // must never download Node for a Native-only or unrequested profile.
  return options.profiles?.includes("web") === true && !options.usesElectronNode
}

function managedNodeOptions(options: DshPreparationOptions) {
  return {
    wopalHome: options.wopalHome,
    owner: options.nodeOwner ?? { product: "ellamaka-cli" as const, version: "local", channel: "dev" },
  }
}

async function inspectNode(options: DshPreparationOptions): Promise<CorePreparationStepResult> {
  if (!requiresManagedNode(options)) return ready()
  const inspection = await inspectManagedNode(managedNodeOptions(options), options.managedNodeDeps)
  if (inspection === "READY") return ready()
  if (inspection === "NEEDS_PREPARATION") return { state: "NEEDS_PREPARATION" }
  return { state: "DEGRADED", code: inspection.code }
}

async function prepareNode(
  options: DshPreparationOptions,
  context: Parameters<CorePreparationContributor["prepare"]>[1],
): Promise<CorePreparationStepResult> {
  if (!requiresManagedNode(options)) return ready()
  try {
    await prepareManagedNode(
      managedNodeOptions(options),
      context.signal,
      (phase) => context.report({ phase }),
      options.managedNodeDeps,
    )
    return ready()
  } catch (error) {
    return {
      state: error instanceof ManagedNodeError && error.code === "DSH_WEB_PTC_NODE_BUSY" ? "BUSY" : "DEGRADED",
      code: error instanceof ManagedNodeError ? error.code : "DSH_WEB_PTC_NODE_PREPARATION_FAILED",
    }
  }
}

// Node belongs to the existing closure preparation step. Consumers must see
// its download, verification, and installation as closure phases, not a new
// CorePreparation step (DESIGN-dsh-base: Preparation Progress Semantics).
async function inspectClosureResources(options: DshPreparationOptions): Promise<CorePreparationStepResult> {
  const closure = await inspectClosure(options)
  return closure.state === "READY" ? inspectNode(options) : closure
}

async function prepareClosureResources(
  options: DshPreparationOptions,
  context: Parameters<CorePreparationContributor["prepare"]>[1],
): Promise<CorePreparationStepResult> {
  const closure = await prepareClosure(options, context)
  return closure.state === "READY" ? prepareNode(options, context) : closure
}

function profileRuntime(options: DshPreparationOptions) {
  const anchor = resolveInstallAnchor(options.wopalHome, options.manifest).path
  if (!existsSync(anchor)) return createPackageDshRuntimeApi()
  return (options.deps?.resolveRuntime ?? createDshRuntimeApi)(anchor)
}

async function inspectProfiles(options: DshPreparationOptions): Promise<CorePreparationStepResult> {
  if (disabled(options)) return ready()
  const inspection = inspectDshProfileResources(options.wopalHome, profiles(options))
  return inspection.ready ? ready() : { state: "NEEDS_PREPARATION" }
}

async function prepareProfiles(
  options: DshPreparationOptions,
  context: Parameters<CorePreparationContributor["prepare"]>[1],
): Promise<CorePreparationStepResult> {
  if (disabled(options)) return ready()
  context.report({ phase: "profiles.prepare" })
  const result = await withDshHomeExclusiveAccess(
    { wopalHome: options.wopalHome, closureVersion: options.closureVersion },
    () => prepareDshProfileResources(options.wopalHome, profileRuntime(options), profiles(options)),
  )
  if (result.ok) {
    context.report({ phase: "profiles.completed" })
    return ready()
  }
  return {
    state: result.reason === "DSH_HOME_BUSY" ? "BUSY" : "DEGRADED",
    code: result.reason,
  }
}

/** The Plan-owned DSH resources exposed through the unified CorePreparation protocol. */
export function createDshPreparationContributors(
  options: DshPreparationOptions,
): readonly CorePreparationContributor[] {
  if (options.closureVersion !== options.manifest.closureVersion)
    throw new Error("DSH preparation closureVersion must match the embedded manifest")
  const shared: CorePreparationContributor[] = [
    {
      step: "dsh.closure",
      target: "host",
      inspect: () => inspectClosureResources(options),
      prepare: (_target, context) => prepareClosureResources(options, context),
    },
    {
      step: "dsh.home",
      target: "host",
      inspect: () => inspectHome(options),
      prepare: (_target, context) => prepareHome(options, context),
    },
  ]
  shared.push({
    step: "dsh.profiles",
    target: "host",
    inspect: () => inspectProfiles(options),
    prepare: (_target, context) => prepareProfiles(options, context),
  })
  return shared
}

/** Internal generic factory wiring; product entry orchestration remains Task 6. */
export function createDshPreparationService(options: DshPreparationOptions): CorePreparationService {
  const identity = options.manifest.fingerprint ?? `closure-${options.closureVersion}`
  return createCorePreparationService({
    hostKey: `${resolve(options.wopalHome)}::${identity}`,
    contributors: createDshPreparationContributors(options),
  })
}
