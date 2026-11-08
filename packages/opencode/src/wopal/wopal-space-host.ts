import { Global } from "@wopal/ellamaka-core/global"
import { Context, Effect, Layer } from "effect"
import {
  createOntologyService,
  createSpaceService,
  type ForkProvisioner,
  type HostContext,
  type OntologyService,
  type RegisteredSpace,
  type SpacePreparationFacts,
  type SpacePreparationResult,
  type SpaceService,
  type SpaceServiceOptions,
} from "@wopal/wopalspace"
import {
  getInstancePreparationService,
  getInstancePreparationTarget,
  prepareInstancePluginDependencies,
} from "@/core/instance-preparation"

/**
 * Server-side composition seam for the private WopalSpace application services.
 *
 * The host context is resolved from the trusted process environment once; HTTP
 * callers can never replace it. Both the Public Platform handlers and the
 * Official App BFF use this one seam, so there is no second Space/Ontology
 * implementation and no CLI bridge.
 */
export interface WopalSpaceHost {
  readonly host: HostContext
  readonly ontology: OntologyService
  readonly space: SpaceService
  /** Registered Space facts by stable name; read-only, no Runtime bootstrap. */
  readonly findSpace: (name: string) => RegisteredSpace | undefined
  /** Internal bootstrap seam: rebase this process before any Setup write. */
  readonly rebindHome: (path: string) => void
}

export class Service extends Context.Service<Service, WopalSpaceHost>()("@opencode/WopalSpaceHost") {}

const preparationFacts = async (wopalHome: string, spacePath: string): Promise<SpacePreparationFacts> => {
  try {
    const target = await getInstancePreparationTarget(spacePath)
    const inspected = await getInstancePreparationService(wopalHome).inspect(target)
    switch (inspected.state) {
      case "READY":
        return { status: "ready" }
      case "PREPARING":
        return { status: "preparing" }
      case "DEGRADED":
        return { status: "degraded", diagnostic: inspected.reason ?? "instance preparation is degraded" }
      default:
        return { status: "unknown" }
    }
  } catch (error) {
    return { status: "unknown", diagnostic: error instanceof Error ? error.message : String(error) }
  }
}

const prepare = async (
  wopalHome: string,
  input: { spacePath: string; name: string },
): Promise<SpacePreparationResult> => {
  try {
    const result = await prepareInstancePluginDependencies({
      wopalHome,
      directory: input.spacePath,
      reason: "space-init:" + input.name,
    })
    if (result.state === "READY") return { status: "ready", prepared: true }
    return {
      status: "failed",
      error: { code: "SPACE_PREPARATION_FAILED", message: "Instance preparation is " + result.state },
    }
  } catch (error) {
    return {
      status: "failed",
      error: {
        code: "SPACE_PREPARATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

export interface WopalSpaceHostOverrides {
  /** Test seam for fork mode; production uses the authenticated gh adapter. */
  readonly fork?: ForkProvisioner
  /** Test-only trusted host context; production still resolves Global.Path.wopalHome. */
  readonly host?: HostContext
  /** Test-only Git runner for isolated Space operations without host gitconfig dependency. */
  readonly spaceGit?: SpaceServiceOptions["git"]
}

const make = (overrides: WopalSpaceHostOverrides = {}) =>
  Effect.sync(() => {
    const build = (host: HostContext) => {
      const ontology = createOntologyService({ host, ...(overrides.fork ? { fork: overrides.fork } : {}) })
      const space = createSpaceService({
        host,
        ...(overrides.spaceGit ? { git: overrides.spaceGit } : {}),
        prepareInstance: (input) => prepare(host.wopalHome, input),
        inspectPreparation: (input) => preparationFacts(host.wopalHome, input.spacePath),
      })
      return { host, ontology, space }
    }
    let current = build(overrides.host ?? { wopalHome: Global.Path.wopalHome })
    return Service.of({
      get host() {
        return current.host
      },
      get ontology() {
        return current.ontology
      },
      get space() {
        return current.space
      },
      findSpace: (name: string) => current.space.list().items.find((item) => item.name === name),
      rebindHome(path: string) {
        const wopalHome = overrides.host ? path : Global.bindWopalHome(path)
        current = build({
          wopalHome,
          ...(current.host.directory !== undefined ? { directory: current.host.directory } : {}),
        })
      },
    })
  })

export const layer = Layer.effect(Service, make())

/** Host layer with an injected fork provisioner; used by tests instead of real GitHub. */
export const layerFor = (overrides: WopalSpaceHostOverrides) => Layer.effect(Service, make(overrides))
export * as WopalSpaceHostService from "./wopal-space-host"
