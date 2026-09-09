import type { SidecarRuntimeState } from "../preload/types"
import type { ServerConnection } from "@wopal/ellamaka-app"

export type SidecarAdapterAction =
  | { action: "wait" }
  | { action: "connect"; server: ServerConnection.Sidecar }
  | { action: "reconnect"; server: ServerConnection.Sidecar }
  | { action: "preserve" }
  | { action: "offline" }
  | { action: "exit" }

/**
 * Maps a SidecarRuntimeState to a renderer action.
 * Pure function — no side effects.
 *
 * @param state - Current sidecar state from Main process
 * @param previousGeneration - The last known generation number (0 if none)
 */
export function mapSidecarStateToAction(
  state: SidecarRuntimeState,
  previousGeneration: number,
): SidecarAdapterAction {
  switch (state.status) {
    case "starting":
      return { action: "wait" }

    case "ready": {
      if (!state.connection) return { action: "preserve" }
      if (state.generation === previousGeneration) return { action: "preserve" }
      const server: ServerConnection.Sidecar = {
        displayName: "Local Server",
        type: "sidecar",
        variant: "base",
        generation: state.generation,
        http: {
          url: state.connection.url,
          username: state.connection.username,
          password: state.connection.password,
        },
      }
      if (previousGeneration === 0) return { action: "connect", server }
      return { action: "reconnect", server }
    }

    case "lost":
    case "restarting":
      return { action: "preserve" }

    case "failed":
      return { action: "offline" }

    case "stopped":
      return { action: "exit" }

    default:
      return { action: "preserve" }
  }
}

export function resolveSidecarServer(
  action: SidecarAdapterAction,
  previous: ServerConnection.Sidecar | undefined,
  fallback: ServerConnection.Sidecar | undefined,
) {
  if (action.action === "connect" || action.action === "reconnect") return action.server
  if (action.action === "wait" || action.action === "preserve") return previous ?? fallback
  return undefined
}
