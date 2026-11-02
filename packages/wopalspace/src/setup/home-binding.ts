import { SETUP_ERROR, SetupServiceError } from "./types"
import type { SetupHomeBinding, SetupHomeBindingFacts, SetupHomeBindingOptions } from "./types"

function publicFacts(input: {
  mode: SetupHomeBindingFacts["mode"]
  source: SetupHomeBindingFacts["source"]
  path: string
  locked: boolean
  persisted: boolean
}): SetupHomeBindingFacts {
  return {
    ...input,
    selectable: !input.locked,
  }
}

function invalidHome(error: unknown): SetupServiceError {
  return new SetupServiceError({
    code: SETUP_ERROR.homeInvalid,
    message: "WOPAL_HOME path is invalid: " + (error instanceof Error ? error.message : String(error)),
    suggestion: "Choose an absolute host-local directory and retry.",
    cause: error,
  })
}

/**
 * One-host-lifecycle Home confirmation state machine.
 *
 * Persistence and runtime application are host ports. The WopalSpace domain
 * owns ordering and lock semantics without knowing shell/profile details.
 */
export function createSetupHomeBinding(options: SetupHomeBindingOptions): SetupHomeBinding {
  let state = publicFacts({
    mode: options.mode,
    source: options.source,
    path: options.initialPath,
    locked: options.locked,
    persisted: options.mode === "normal" && options.source === "shell",
  })

  const normalize = (value: string): string => {
    try {
      const normalized = options.normalizePath(value)
      if (!normalized.trim()) throw new Error("path is empty")
      return normalized
    } catch (error) {
      throw invalidHome(error)
    }
  }

  return {
    inspect() {
      return state
    },

    async select(value: string) {
      const path = normalize(value)
      if (state.locked) {
        if (path === state.path) return state
        throw new SetupServiceError({
          code: SETUP_ERROR.homeLocked,
          message: "WOPAL_HOME is already locked for this Host lifecycle: " + state.path,
          suggestion: "Restart Ellamaka before selecting a different Home.",
        })
      }

      if (state.mode === "normal") {
        try {
          await options.persist(path)
        } catch (error) {
          throw new SetupServiceError({
            code: SETUP_ERROR.homePersistFailed,
            message:
              "Failed to persist WOPAL_HOME for the current user: " +
              (error instanceof Error ? error.message : String(error)),
            suggestion: "Fix the user shell/environment permissions and retry.",
            cause: error,
          })
        }
      }

      await options.apply(path)
      state = publicFacts({
        mode: state.mode,
        source: "selected",
        path,
        locked: true,
        persisted: state.mode === "normal",
      })
      return state
    },
  }
}
