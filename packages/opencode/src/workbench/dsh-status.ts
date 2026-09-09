import { Context, Layer } from "effect"

/**
 * The DSH runtime terminal status for the current process.
 *
 * Mirrors `@wopal/ellamaka-cordis`'s `DshRuntimeStatus` shape as a local
 * structural type (same approach as the desktop `env.d.ts` declaration), so
 * this holder needs no cordis package dependency. The Runtime Manager
 * (`initializeDshRuntime`) runs once per launch and returns its terminal
 * status: `disabled` (kill switch `ELLAMAKA_DSH=0`), `ready` (closure verified
 * and containers mounted), or `degraded` (materialisation / validation / load
 * failed; ellamaka keeps running without dsh).
 *
 * Every mount site publishes that status here immediately after the manager
 * settles, and the `/global/health` endpoint reads it per request so the
 * frontend can gate dsh-dependent UI on a runtime fact instead of a config
 * string. The holder owns no runtime state — the manager's result is written
 * exactly once per launch, and the default before any mount (`disabled`) is
 * the safe "no dsh" baseline.
 */

export type DshRuntimeStatus = "disabled" | "preparing" | "ready" | "degraded"

const holder: { status: DshRuntimeStatus } = { status: "disabled" }

/** Publish the runtime manager's terminal status (exactly once per launch). */
export function setDshStatus(status: DshRuntimeStatus): void {
  holder.status = status
}

/** The runtime manager's terminal status; `disabled` before any mount. */
export function getDshStatus(): DshRuntimeStatus {
  return holder.status
}

export class WorkbenchDshStatus extends Context.Service<WorkbenchDshStatus, {
  /** The runtime manager's terminal status; `disabled` before any mount. */
  readonly get: () => DshRuntimeStatus
}>()("@opencode/WorkbenchDshStatus") {}

/** Thin adapter over the module-level holder for Effect handlers. */
export const layer: Layer.Layer<WorkbenchDshStatus> = Layer.succeed(
  WorkbenchDshStatus,
  WorkbenchDshStatus.of({ get: getDshStatus }),
)
