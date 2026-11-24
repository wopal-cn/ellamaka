import { Context, Layer } from "effect"

export type DshRuntimeStatus = "disabled" | "preparing" | "ready" | "degraded"
export type DshRuntimeProfile = "web" | "tools"
export type DshRuntimeStatuses = Readonly<Record<DshRuntimeProfile, DshRuntimeStatus>>

const holder: Record<DshRuntimeProfile, DshRuntimeStatus> = {
  web: "disabled",
  tools: "disabled",
}

const reasons: Record<DshRuntimeProfile, string | undefined> = {
  web: undefined,
  tools: undefined,
}

/** Publish one profile's runtime loading/activation status and optional degradation reason. */
export function setDshStatus(profile: DshRuntimeProfile, status: DshRuntimeStatus, reason?: string): void {
  holder[profile] = status
  reasons[profile] = status === "degraded" && reason ? reason : undefined
}

/** Snapshot both profile statuses for health responses. */
export function getDshStatus(): DshRuntimeStatuses {
  return { web: holder.web, tools: holder.tools }
}

/** Return the latest degradation reason recorded for a profile, if currently degraded. */
export function getDshStatusReason(profile: DshRuntimeProfile): string | undefined {
  return holder[profile] === "degraded" ? reasons[profile] : undefined
}

export function getDshProfileStatus(profile: DshRuntimeProfile): DshRuntimeStatus {
  return holder[profile]
}

export class WorkbenchDshStatus extends Context.Service<
  WorkbenchDshStatus,
  {
    readonly get: () => DshRuntimeStatuses
  }
>()("@opencode/WorkbenchDshStatus") {}

export const layer: Layer.Layer<WorkbenchDshStatus> = Layer.succeed(
  WorkbenchDshStatus,
  WorkbenchDshStatus.of({ get: getDshStatus }),
)
