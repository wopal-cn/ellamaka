import type { ChangeResult } from "@deepseek-ai/dsh-plugin-manager"

export type OptionalPresetBundleResult =
  | { readonly selected: false }
  | { readonly selected: true; readonly change: ChangeResult }

type PresetBundleManager = {
  installBundle(spec: string, options?: { enabled?: boolean }): Promise<ChangeResult>
}

type PresetBundleContext = {
  get(name: string, strict?: boolean): unknown
}

function isPresetBundleManager(value: unknown): value is PresetBundleManager {
  return (
    typeof value === "object" && value !== null && "installBundle" in value && typeof value.installBundle === "function"
  )
}

/**
 * Install an optional declarative preset bundle through DSH's one controlled
 * plugin mutation queue. A non-selected enhancement is a strict no-op: it
 * does not even require the manager service, so no profile resource can be
 * created as a side effect.
 */
export async function installOptionalPresetBundle(
  ctx: PresetBundleContext,
  selection: { readonly selected: boolean; readonly spec: string },
): Promise<OptionalPresetBundleResult> {
  if (!selection.selected) return { selected: false }
  const candidate = ctx.get("pluginManager", false)
  if (!isPresetBundleManager(candidate)) {
    throw new Error("DSH plugin manager unavailable for preset bundle installation")
  }
  const manager = candidate
  return {
    selected: true,
    change: await manager.installBundle(selection.spec, { enabled: true }),
  }
}
