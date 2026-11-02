import type { DshMountController } from "@/cli/cmd/dsh-mount-controller"
import * as Log from "@wopal/ellamaka-core/util/log"

/**
 * Process-wide handle to the serve command's DSH mount controller.
 *
 * `serve` owns the single mount; HTTP handlers that need DSH (Workbench entry,
 * health probes) call through this registry instead of importing the CLI
 * command. The registry is empty in processes that never mounted a controller
 * — e.g. `run`, which is permanently DSH-disabled.
 */
export function createDshStageGate(activate: () => Promise<boolean>, ready: boolean) {
  let inflight: Promise<boolean> | undefined
  return {
    completeSetup() {
      ready = true
    },
    ensure(): Promise<boolean> {
      if (!ready) return Promise.resolve(false)
      if (inflight) return inflight
      inflight = activate().finally(() => {
        inflight = undefined
      })
      return inflight
    },
  }
}

let current: DshMountController | undefined
let gate: ReturnType<typeof createDshStageGate> | undefined

export function installDshMountController(controller: DshMountController, setupReady: boolean): void {
  current = controller
  gate = createDshStageGate(() => controller.ensure(), setupReady)
}

export function completeDshSetup(): void {
  gate?.completeSetup()
  void gate?.ensure().catch((error) => {
    Log.Default.error("dsh activation after setup failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

export function getDshMountController(): DshMountController | undefined {
  return current
}

/**
 * Mount DSH if a controller exists and the runtime is not mounted yet.
 * Returns `true` when the runtime is available (already or after this call),
 * `false` when this host has no DSH controller and therefore cannot mount.
 */
export async function ensureDshMounted(): Promise<boolean> {
  if (!gate) return false
  return gate.ensure()
}
