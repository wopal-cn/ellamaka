import { createEffect } from "solid-js"
import { useServer } from "@/context/server"
import { useCheckServerHealth } from "@/utils/server-health"
import { useWorkbenchState } from "./view-store"

export function isDshReady(status: unknown): boolean {
  return status === true || status === "ready"
}

/**
 * Binds the server health probe's `dsh` flag (the server-side `ELLAMAKA_DSH`
 * kill switch) into the WorkbenchState store. Mounted inside the provider
 * tree; re-probes whenever the server identity changes, mirroring
 * WorkbenchRuntime's refresh cadence ownership (WorkbenchRuntime polls every
 * 5s for status; this binding only needs the flag at connection time).
 *
 * Context wrapper component — consumes ServerContext and WorkbenchStateContext.
 */
export function WorkbenchDshFlagBinding() {
  const server = useServer()
  const wb = useWorkbenchState()
  const checkHealth = useCheckServerHealth()

  createEffect(() => {
    const current = server.current
    if (!current) {
      wb.setDshEnabled(undefined)
      return
    }
    void checkHealth(current.http).then((health) => {
      wb.setDshEnabled(isDshReady(health.dsh))
    })
  })

  return null
}
