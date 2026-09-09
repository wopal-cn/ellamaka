import { createSimpleContext } from "@wopal/ui/context"
import { createEffect } from "solid-js"
import { useServer } from "./server"
import { useServerHealth } from "@/utils/server-health"
import { resolveAppVersion, setAppVersion } from "./app-version"

export const { use: useServers, provider: ServersProvider } = createSimpleContext({
  name: "Servers",
  init: () => {
    const server = useServer()

    const health = useServerHealth(
      () => server.list,
      () => true,
    )

    // The web UI is embedded in the CLI binary; the real version is only
    // available over HTTP from /global/health. Surface it into the shared
    // app-version signal so platform.version reflects the running CLI.
    // Always sync the active server's value (including undefined) so a server
    // switch with a pending/failed health check falls back to pkg.version
    // instead of retaining the previous server's version.
    createEffect(() => {
      setAppVersion(resolveAppVersion(health, server.key))
    })

    return {
      list: () => server.list,
      health,
    }
  },
})
