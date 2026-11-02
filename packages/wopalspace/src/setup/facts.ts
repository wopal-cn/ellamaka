import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { parse } from "jsonc-parser"
import { HOME_CAPABILITY_ROOTS, fileCredentials } from "./home"
import { readSetupState, setupStatePath } from "./state"
import type {
  SetupCredentialStore,
  SetupFactSource,
  SetupFacts,
  SetupGithubPort,
  SetupHomeBindingFacts,
  SetupOntologyPort,
  SetupSpacePort,
  SetupStateStore,
} from "./types"

/** Foundation owns only the WOPAL_HOME root. */
export const FOUNDATION_DIRECTORIES = ["."] as const

export function missingFoundationDirectories(wopalHome: string): string[] {
  try {
    return statSync(wopalHome).isDirectory() ? [] : ["."]
  } catch {
    return ["."]
  }
}

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

function settingsFacts(wopalHome: string): SetupFacts["home"]["settings"] {
  const file = join(wopalHome, "config", "settings.jsonc")
  if (!existsSync(file)) return { present: false, valid: true, ellamaka: { present: false, valid: false } }
  try {
    // A malformed settings file is reported; repairing it belongs to the
    // settings owner, never to setup inspect.
    const errors: { error: number; offset: number; length: number }[] = []
    const parsed: unknown = parse(readFileSync(file, "utf8"), errors, {
      allowTrailingComma: true,
      disallowComments: false,
    })
    if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { present: true, valid: false, ellamaka: { present: false, valid: false } }
    }
    const ellamaka = "ellamaka" in parsed ? parsed.ellamaka : undefined
    return {
      present: true,
      valid: true,
      ellamaka: {
        present: ellamaka !== undefined,
        valid: Boolean(ellamaka && typeof ellamaka === "object" && !Array.isArray(ellamaka)),
      },
    }
  } catch {
    return { present: true, valid: false, ellamaka: { present: false, valid: false } }
  }
}

function capabilityFacts(wopalHome: string): SetupFacts["home"]["capabilities"] {
  const missing = HOME_CAPABILITY_ROOTS.filter((entry) => {
    try {
      return !statSync(join(wopalHome, entry)).isDirectory()
    } catch {
      return true
    }
  })
  return { ready: missing.length === 0, missing }
}

/**
 * Live fact reader. Every call re-reads Home, the domain registries and
 * credential presence; nothing here is cached, written or repaired.
 */
export function createFactSource(input: {
  wopalHome: string
  homeBinding?: () => SetupHomeBindingFacts
  ontology: SetupOntologyPort
  space: SetupSpacePort
  state: SetupStateStore
  credentials?: SetupCredentialStore
  github: SetupGithubPort
}): SetupFactSource {
  const home = input.wopalHome
  return {
    async read(): Promise<SetupFacts> {
      const binding = input.homeBinding?.()
      if (binding && !binding.locked) {
        return {
          home: {
            path: home,
            binding,
            writable: false,
            foundation: { ready: false, missing: ["."] },
            settings: { present: false, valid: true, ellamaka: { present: false, valid: false } },
            capabilities: { ready: false, missing: [...HOME_CAPABILITY_ROOTS] },
          },
          ontology: { status: "missing", items: [] },
          space: { status: "missing", items: [], availableTypes: [] },
          credentials: { github: { configured: false }, providers: [] },
          state: {
            status: "absent",
            path: setupStatePath(home),
            completed: false,
            currentStep: "foundation",
            steps: {},
          },
        }
      }

      const read = await input.state.read()
      const state: SetupFacts["state"] =
        read.status === "ok"
          ? {
              status: "ok",
              path: read.path,
              completed: read.state.completed,
              currentStep: read.state.currentStep,
              steps: read.state.steps,
            }
          : read.status === "absent"
            ? { status: "absent", path: read.path, completed: false, currentStep: "foundation", steps: {} }
            : {
                status: "corrupt",
                path: read.path,
                completed: false,
                currentStep: "foundation",
                steps: {},
                diagnostic: read.diagnostic,
              }

      let ontology: SetupFacts["ontology"]
      try {
        const listed = await input.ontology.list()
        const readable = listed.items.filter((item) => item.available && item.readable)
        ontology =
          readable.length > 0
            ? {
                status: "ready",
                items: readable.map((item) => ({ name: item.name, path: item.path, mode: item.mode })),
              }
            : {
                status: listed.total > 0 ? "broken" : "missing",
                items: listed.items.map((item) => ({ name: item.name, path: item.path, mode: item.mode })),
              }
      } catch (error) {
        ontology = {
          status: "broken",
          items: [],
          diagnostic: error instanceof Error ? error.message : String(error),
        }
      }

      let space: SetupFacts["space"]
      try {
        const listed = await input.space.list()
        const verified = listed.items.filter((item) => item.verified)
        const availableTypes = await input.space.availableTypes()
        space = {
          status: listed.total === 0 ? "missing" : verified.length > 0 ? "ready" : "unprepared",
          items: listed.items.map((item) => ({ name: item.name, path: item.path, verified: item.verified })),
          availableTypes,
        }
      } catch (error) {
        space = {
          status: "missing",
          items: [],
          availableTypes: [],
          diagnostic: error instanceof Error ? error.message : String(error),
        }
      }

      const credentials = input.credentials ?? fileCredentials(home)
      const github = await input.github.inspect()
      const providers = await credentials.providerIds()

      const missing = missingFoundationDirectories(home)
      return {
        home: {
          path: home,
          binding:
            binding ??
            ({
              mode: "normal",
              source: "shell",
              path: home,
              locked: true,
              selectable: false,
              persisted: true,
            } satisfies SetupHomeBindingFacts),
          writable: writable(home),
          foundation: { ready: missing.length === 0, missing },
          settings: settingsFacts(home),
          capabilities: capabilityFacts(home),
        },
        ontology,
        space,
        credentials: { github, providers: [...providers].sort() },
        state,
      }
    },
  }
}

export { readSetupState }
