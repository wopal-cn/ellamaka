import { Context, Layer } from "effect"

export type DshRuntimeStatus = "disabled" | "preparing" | "ready" | "degraded"
export type DshRuntimeProfile = "web" | "tools"
export type DshRuntimeStatuses = Readonly<Record<DshRuntimeProfile, DshRuntimeStatus>>

const holder: Record<DshRuntimeProfile, DshRuntimeStatus> = {
  web: "disabled",
  tools: "disabled",
}

/** Publish one profile's runtime loading/activation status. */
export function setDshStatus(profile: DshRuntimeProfile, status: DshRuntimeStatus): void {
  holder[profile] = status
}

/** Snapshot both profile statuses for health responses. */
export function getDshStatus(): DshRuntimeStatuses {
  return { web: holder.web, tools: holder.tools }
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
