import { attachUrl } from "@/utils/attach-url"
import type { ServerConnection } from "@/context/server"

export type TuiAttachAuth = {
  username?: string
  password?: string
}

/**
 * TUI attach credentials come only from the Desktop sidecar connection. Remote
 * HTTP and SSH servers keep their Basic Auth out of the PTY child environment.
 */
export function resolveTuiAttachAuth(server: ServerConnection.Any | undefined): TuiAttachAuth | undefined {
  if (server?.type !== "sidecar") return undefined
  const { username, password } = server.http
  if (!password) return undefined
  return { username, password }
}

export function createTuiAttachRequest(input: {
  serverUrl: string
  sessionID?: string
  directory: string
  panelID: string
  auth?: TuiAttachAuth
}) {
  const args = input.sessionID
    ? ["attach", attachUrl(input.serverUrl), "-s", input.sessionID, "--dir", input.directory]
    : undefined
  const env = input.auth?.password
    ? {
        ELLAMAKA_SERVER_USERNAME: input.auth.username ?? "ellamaka",
        ELLAMAKA_SERVER_PASSWORD: input.auth.password,
      }
    : undefined

  return {
    command: "ellamaka",
    args,
    cwd: input.directory,
    title: `ellamaka tui (${input.panelID})`,
    env,
  }
}
