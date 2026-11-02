import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { Context, Effect, Layer } from "effect"
import { isWopalHomeLockedAtStartup, persistWopalHomeEnv } from "@wopal/ellamaka-core/wopal-home-env"
import {
  createSetupHomeBinding,
  createSetupService,
  SETUP_ERROR,
  SetupServiceError,
  type SetupHomeBinding,
  type SetupHomeBindingFacts,
  type OntologyService,
  type SetupGithubPort,
  type SetupInspectResult,
  type SetupOntologyPort,
  type SetupService,
  type SetupSpacePort,
  type SpaceService,
} from "@wopal/wopalspace"
import { WopalSpaceHostService } from "./wopal-space-host"

/**
 * Server-side composition of the private Setup service.
 *
 * Setup keeps its own host seam so the Workbench/Space composition stays
 * unchanged. Both services are built once at the application boundary from the
 * same Ontology and Space instances, so Setup never carries a second registry,
 * Git path or Space implementation.
 */
export interface SetupHostOverrides {
  /**
   * Test seam for the GitHub token check. Production leaves this unset so the
   * configured verifier (the real GitHub API) is used.
   */
  readonly github?: SetupGithubPort
  /** Test seam for Home policy/persistence; production derives it from the process environment. */
  readonly homeBinding?: (wopal: WopalSpaceHostService.WopalSpaceHost) => SetupHomeBinding
}

export interface SetupHost extends SetupService {
  homeSelect(input: { readonly path: string }): Promise<SetupHomeBindingFacts>
}

export class Service extends Context.Service<Service, SetupHost>()("@opencode/SetupHost") {}

/** Ontology facts and install for Setup, over the shared Ontology service. */
function ontologyPort(ontology: OntologyService): SetupOntologyPort {
  return {
    list: async () => {
      const listed = await ontology.list()
      return {
        items: listed.items.map((item) => ({
          name: item.name,
          path: item.path,
          mode: item.mode,
          available: item.available,
          readable: item.repo.readable,
        })),
        total: listed.total,
      }
    },
    install: async (input) => {
      const installed = await ontology.install({
        name: input.name ?? "wopal-space-ontology",
        ...(input.source ? { source: input.source } : {}),
        mode: input.mode,
      })
      return { name: installed.name, path: installed.path, status: installed.status }
    },
  }
}

/** Space facts and init for Setup, over the shared Space service. */
function spacePort(space: SpaceService): SetupSpacePort {
  return {
    list: async () => {
      const listed = space.list()
      return {
        items: listed.items.map((item) => ({
          name: item.name,
          path: item.path,
          // A Space counts as verified when its registered root, assembly
          // snapshot and .wopal worktree all exist.
          verified: item.facts.present && item.facts.snapshot === "ok" && item.facts.worktree,
        })),
        total: listed.total,
      }
    },
    availableTypes: async () => space.availableTypes(),
    init: async (input, _signal, onProgress) => {
      const result = await space.init({ name: input.name, root: input.root, type: input.type }, onProgress)
      const preparation =
        result.preparation.status === "ready" || result.preparation.status === "skipped"
          ? { status: "ok" as const }
          : result.preparation.status === "failed"
            ? { status: "failed" as const, error: result.preparation.error }
            : { status: "cancelled" as const }
      return {
        name: result.space.name,
        path: result.space.path,
        materialized: result.materialized.finalCondition !== "invalid",
        preparation,
      }
    },
  }
}

function normalizeHomePath(value: string): string {
  let path = value.trim()
  if (path === "~") path = homedir()
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2))
  if (!path || !isAbsolute(path)) throw new Error("WOPAL_HOME must be an absolute path")
  return resolve(path)
}

function productionHomeBinding(wopal: WopalSpaceHostService.WopalSpaceHost): SetupHomeBinding {
  const explicitHome = process.env.WOPAL_HOME?.trim()
  const mode = process.env.WOPAL_DEV === "1" ? "development" : "normal"
  return createSetupHomeBinding({
    mode,
    initialPath: wopal.host.wopalHome,
    source: explicitHome ? "shell" : "default",
    locked: isWopalHomeLockedAtStartup(),
    normalizePath: normalizeHomePath,
    persist: async (path) => {
      const result = persistWopalHomeEnv(path)
      if (!result.success) throw new Error(result.message ?? "failed to persist WOPAL_HOME")
    },
    apply: async (path) => {
      wopal.rebindHome(path)
      process.env.DSH_HOME = join(path, "dsh", "home")
    },
  })
}

const make = (overrides: SetupHostOverrides = {}) =>
  Effect.map(WopalSpaceHostService.Service, (wopal) => {
    const homeBinding = overrides.homeBinding?.(wopal) ?? productionHomeBinding(wopal)
    const build = () =>
      createSetupService({
        host: wopal.host,
        homeBinding: () => homeBinding.inspect(),
        ontology: ontologyPort(wopal.ontology),
        space: spacePort(wopal.space),
        ...(overrides.github ? { github: overrides.github } : {}),
      })
    let setup = build()

    const requireHome = () => {
      if (homeBinding.inspect().locked) return
      throw new SetupServiceError({
        code: SETUP_ERROR.homeUnconfirmed,
        message: "WOPAL_HOME must be confirmed before Setup can modify this host.",
        suggestion: "Select the Home on the first Onboarding step and retry.",
      })
    }

    const host: SetupHost = {
      async inspect(): Promise<SetupInspectResult> {
        return setup.inspect()
      },
      async homeSelect(input) {
        const before = homeBinding.inspect()
        const selected = await homeBinding.select(input.path)
        if (!before.locked) setup = build()
        return selected
      },
      async plan(input) {
        requireHome()
        return setup.plan(input)
      },
      async execute(input) {
        requireHome()
        return setup.execute(input)
      },
      progress(runId) {
        requireHome()
        return setup.progress(runId)
      },
      progressEvents(input) {
        requireHome()
        return setup.progressEvents(input)
      },
      cancel(runId) {
        requireHome()
        return setup.cancel(runId)
      },
      async complete(input) {
        requireHome()
        return setup.complete(input)
      },
    }
    return Service.of(host)
  })

export const layer = Layer.effect(Service, make())

/** Host layer with an injected GitHub verifier; used by tests instead of the network. */
export const layerFor = (overrides: SetupHostOverrides) => Layer.effect(Service, make(overrides))
export * as SetupHostService from "./setup-host"
