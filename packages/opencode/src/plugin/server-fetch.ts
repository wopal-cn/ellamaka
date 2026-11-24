/** Transport delivered to plugins that create their own API clients. */
export function createPluginServerFetch(
  serverUrl: URL | undefined,
  inProcessFetch: (request: Request) => Response | Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request && !init ? input : new Request(input, init)
      if (!serverUrl) return inProcessFetch(request)
      // Preserve the SDK's no-idle-timeout behavior for long requests and SSE.
      ;(request as Request & { timeout?: boolean }).timeout = false
      return globalThis.fetch(request)
    },
    { preconnect: globalThis.fetch.preconnect },
  )
}
