import { createSimpleContext } from "@wopal/ui/context"
import { createEffect, createSignal, onCleanup, untrack } from "solid-js"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { type WopalCliHealth, useCheckServerHealth } from "@/utils/server-health"
import { canUseSpaceControl } from "./cli-health"

export type WorkbenchRuntimeStatus = "online" | "degraded" | "recovering" | "offline"

export function resolveWorkbenchRuntimeStatus(
  healthy: boolean,
  eventStatus: "stopped" | "connecting" | "connected" | "reconnecting",
): WorkbenchRuntimeStatus {
  if (!healthy) return "offline"
  if (eventStatus === "connected") return "online"
  if (eventStatus === "connecting") return "recovering"
  return "degraded"
}

const WorkbenchRuntimeContext = createSimpleContext({
  name: "WorkbenchRuntime",
  init: () => {
    const server = useServer()
    const sdk = useServerSDK()
    const checkHealth = useCheckServerHealth()
    const [status, setStatus] = createSignal<WorkbenchRuntimeStatus>("recovering")
    const [cli, setCli] = createSignal<WopalCliHealth>()
    const [repairingCli, setRepairingCli] = createSignal(false)
    let request = 0
    let lastHealthy = false

    const refresh = async (): Promise<boolean> => {
      const current = server.current
      if (!current) {
        setStatus("offline")
        setCli(undefined)
        lastHealthy = false
        return false
      }
      const id = request + 1
      request = id
      const health = await checkHealth(current.http)
      if (id !== request) return false
      lastHealthy = health.healthy
      setCli(health.cli)
      const next = resolveWorkbenchRuntimeStatus(health.healthy, untrack(() => sdk.eventStatus))
      setStatus(next)
      return next === "online"
    }

    // Re-fetch health only when the server changes. SSE eventStatus transitions
    // (connected -> reconnecting -> connected) recompute `status` from the last
    // known health snapshot instead of hammering /global/health on every blip,
    // which previously caused the whole workbench to feel like a page refresh.
    createEffect(() => {
      server.key
      void refresh()
    })

    // eventStatus-only recompute: updates the status label without refetching
    // health. If the health layer was already offline, keep it offline.
    createEffect(() => {
      const eventStatus = sdk.eventStatus
      if (!lastHealthy) return
      setStatus(resolveWorkbenchRuntimeStatus(true, eventStatus))
    })

    const timer = setInterval(() => void refresh(), 5_000)
    onCleanup(() => clearInterval(timer))

    return {
      get status() {
        return status()
      },
      get cli() {
        return cli()
      },
      get repairingCli() {
        return repairingCli()
      },
      canWrite: () => status() === "online" || status() === "degraded",
      canUseSpaceControl: () => canUseSpaceControl(cli()),
      retry: refresh,
      repairCli: async () => {
        if (repairingCli()) return false
        setRepairingCli(true)
        return sdk.client.global.cli.repair()
          .then(async (result) => {
            if (result.error) return false
            await refresh()
            return result.data?.cli.state === "ok"
          })
          .catch(() => false)
          .finally(() => setRepairingCli(false))
      },
    }
  },
})

export const useWorkbenchRuntime = () => WorkbenchRuntimeContext.use()
export const WorkbenchRuntimeProvider = WorkbenchRuntimeContext.provider
