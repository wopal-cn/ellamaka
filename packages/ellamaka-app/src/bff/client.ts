import { createClient } from "./gen/client"
import { EllamakaAppBffClient } from "./gen/sdk.gen"
import { authTokenFromCredentials } from "@/utils/server"

export type AppBffClientConfig = {
  server: { url: string; username?: string; password?: string }
  fetch?: typeof fetch
  headers?: Record<string, string>
  throwOnError?: boolean
  signal?: AbortSignal
}

/**
 * Create the Official App BFF client.
 *
 * The client is generated from the private BFF contract only. Platform
 * capabilities (Runtime + WopalSpace) use the published @wopal/ellamaka-sdk;
 * app-specific projections (Session Tree, creation locations, Session
 * provision, DSH embed) use this client.
 */
export function createAppBffClient(config: AppBffClientConfig) {
  const { server, ...rest } = config
  const headers: Record<string, string> = { ...rest.headers }
  if (server.password) {
    headers.Authorization = `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`
  }
  const $client = createClient({ ...rest, headers, baseUrl: server.url })
  return new EllamakaAppBffClient({ client: $client })
}

export type AppBffClient = ReturnType<typeof createAppBffClient>
