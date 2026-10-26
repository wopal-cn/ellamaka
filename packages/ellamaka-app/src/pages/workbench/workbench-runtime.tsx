import { createSimpleContext } from "@wopal/ui/context"
import { createEffect, createSignal, onCleanup, untrack } from "solid-js"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import {
  type DshRuntimeStatus,
  type WopalCliHealth,
  resolveServerHealthKey,
  useCheckServerHealth,
} from "@/utils/server-health"
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
    const [unauthorized, setUnauthorized] = createSignal(false)
    const [repairingCli, setRepairingCli] = createSignal(false)
    const [dshWeb, setDshWeb] = createSignal<DshRuntimeStatus>()
    const [dshTools, setDshTools] = createSignal<DshRuntimeStatus>()
    const [dshWebReady, setDshWebReady] = createSignal(false)
    const [dshToolsReady, setDshToolsReady] = createSignal(false)
    let request = 0
    let lastHealthy = false
    let generationAbort: AbortController | undefined
    let refreshing = false
    let rerun = false

    const refresh = async (): Promise<boolean> => {
      const current = server.current
      if (!current) {
        setStatus("offline")
        setUnauthorized(false)
        setCli(undefined)
        setDshWebReady(false)
        setDshToolsReady(false)
        lastHealthy = false
        return false
      }
      if (refreshing) {
        rerun = true
        return false
      }
      refreshing = true
      const id = request + 1
      request = id
      try {
        const health = await checkHealth(current.http, { signal: generationAbort?.signal, retryCount: 0 })
        if (id !== request || generationAbort?.signal.aborted) return false
        lastHealthy = health.healthy
        setCli(health.cli)
        setUnauthorized(health.unauthorized === true)
        if (health.healthy && health.dsh) {
          setDshWeb(health.dsh.web)
          setDshTools(health.dsh.tools)
          setDshWebReady(health.dsh.web === "ready")
          setDshToolsReady(health.dsh.tools === "ready")
        }
        const next = resolveWorkbenchRuntimeStatus(
          health.healthy,
          untrack(() => sdk.eventStatus),
        )
        setStatus(next)
        return next === "online"
      } finally {
        refreshing = false
        if (rerun && !generationAbort?.signal.aborted) {
          rerun = false
          queueMicrotask(() => void refresh())
        }
      }
    }

    createEffect(() => {
      resolveServerHealthKey(server.key, server.current)
      request += 1
      generationAbort?.abort()
      generationAbort = new AbortController()
      setDshWebReady(false)
      setDshToolsReady(false)
      void refresh()
    })

    createEffect(() => {
      const eventStatus = sdk.eventStatus
      if (!lastHealthy) return
      setStatus(resolveWorkbenchRuntimeStatus(true, eventStatus))
    })

    const offPreparation = sdk.event.on("global", (event) => {
      if (event.type !== "core.preparation") return
      const target = (event.properties as { target?: { kind?: string } }).target
      if (target?.kind !== "host") return
      void refresh()
    })
    onCleanup(offPreparation)

    const offResync = sdk.event.onResync(() => void refresh())
    onCleanup(offResync)

    const timer = setInterval(() => void refresh(), 5_000)
    onCleanup(() => {
      clearInterval(timer)
      generationAbort?.abort()
    })

    return {
      get status() {
        return status()
      },
      get cli() {
        return cli()
      },
      get unauthorized() {
        return unauthorized()
      },
      get repairingCli() {
        return repairingCli()
      },
      get dshWeb() {
        return dshWeb()
      },
      get dshTools() {
        return dshTools()
      },
      get dshWebReady() {
        return dshWebReady()
      },
      get dshToolsReady() {
        return dshToolsReady()
      },
      get dshTabAvailable() {
        const value = dshWeb()
        return value !== undefined && value !== "disabled"
      },
      canWrite: () => status() === "online" || status() === "degraded",
      canUseSpaceControl: () => canUseSpaceControl(cli()),
      retry: refresh,
      repairCli: async () => {
        if (repairingCli()) return false
        setRepairingCli(true)
        return sdk.client.global.cli
          .repair()
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
