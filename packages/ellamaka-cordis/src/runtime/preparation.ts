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
import { isDshEnabled, resolveDshLayout, resolveInstallAnchor } from "./status.js"
import { prepareDshHome, readDshHomeState, withDshHomeExclusiveAccess } from "./home-guard.js"
import { createDshRuntimeApi, createPackageDshRuntimeApi } from "./loader.js"
import { inspectDshProfileResources, prepareDshProfileResources } from "./profile-resources.js"

export type DshPreparationOptions = Omit<InitializeDshOptions, "entry"> & { readonly closureVersion: number }

const LOCK_WAIT_MS = 10 * 60 * 1000

function ready(): CorePreparationStepResult {
  return { state: "READY" }
}

function disabled(options: DshPreparationOptions): boolean {
  return !isDshEnabled(options.env ?? process.env)
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
  return { state: "NEEDS_PREPARATION" }
}

async function prepareHome(
  options: DshPreparationOptions,
  context: Parameters<CorePreparationContributor["prepare"]>[1],
): Promise<CorePreparationStepResult> {
  if (disabled(options)) return ready()
  context.report({ phase: "home.prepare" })
  const result = await prepareDshHome({ wopalHome: options.wopalHome, closureVersion: options.closureVersion })
  if (result.ok) {
    context.report({ phase: "home.completed" })
    return ready()
  }
  return {
    state: result.reason === "DSH_HOME_BUSY" ? "BUSY" : "DEGRADED",
    code: result.reason,
  }
}

function profileRuntime(options: DshPreparationOptions) {
  const anchor = resolveInstallAnchor(options.wopalHome, options.manifest).path
  if (!existsSync(anchor)) return createPackageDshRuntimeApi()
  return (options.deps?.resolveRuntime ?? createDshRuntimeApi)(anchor)
}

async function inspectProfiles(options: DshPreparationOptions): Promise<CorePreparationStepResult> {
  if (disabled(options)) return ready()
  const inspection = inspectDshProfileResources(options.wopalHome)
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
    () => prepareDshProfileResources(options.wopalHome, profileRuntime(options)),
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
  return [
    {
      step: "dsh.closure",
      target: "host",
      inspect: () => inspectClosure(options),
      prepare: (_target, context) => prepareClosure(options, context),
    },
    {
      step: "dsh.home",
      target: "host",
      inspect: () => inspectHome(options),
      prepare: (_target, context) => prepareHome(options, context),
    },
    {
      step: "dsh.profiles",
      target: "host",
      inspect: () => inspectProfiles(options),
      prepare: (_target, context) => prepareProfiles(options, context),
    },
  ]
}

/** Internal generic factory wiring; product entry orchestration remains Task 6. */
export function createDshPreparationService(options: DshPreparationOptions): CorePreparationService {
  const identity = options.manifest.fingerprint ?? `closure-${options.closureVersion}`
  return createCorePreparationService({
    hostKey: `${resolve(options.wopalHome)}::${identity}`,
    contributors: createDshPreparationContributors(options),
  })
}
