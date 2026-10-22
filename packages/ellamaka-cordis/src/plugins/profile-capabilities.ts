import type { PatchOptions } from "@deepseek-ai/cordis-plugin-include"

type Row = {
  id?: string
  name?: string
  config?: unknown
  group?: boolean | null
  disabled?: boolean | null
  insert?: Row[]
}

const hardDisabledIds = new Set([
  "hmr",
  "deepseek-account",
  "otel",
  "session-telemetry-otel",
  "llm-deepseek-account",
  "account-controller",
])
function nativePresetPlugins(rows: readonly Row[]): Row[] {
  return rows
    .filter((row) => !["workflow-ptc", "workflow-worker-thread", "tool-workflow", "tool-ralph"].includes(row.id ?? ""))
    .map((row) => (row.group && Array.isArray(row.config) ? { ...row, config: nativePresetPlugins(row.config) } : row))
}

export function profileCapabilityPatches(profile: string, rows: readonly Row[], disablePtc: boolean): PatchOptions[] {
  const patches: PatchOptions[] = []
  for (const row of rows) {
    if (!row.id) continue
    if (hardDisabledIds.has(row.id)) patches.push({ id: row.id, disabled: true })
    if (process.versions.electron && row.id === "subprocess") patches.push({ id: row.id, disabled: true })
    if (disablePtc && row.id === "ptc-runtime") patches.push({ id: row.id, disabled: true })
    if (disablePtc && row.id === "preset-ptc") patches.push({ id: row.id, disabled: true })
    if (profile === "web" && disablePtc && ["preset-standard", "preset-cordis"].includes(row.id)) {
      const config = row.config
      if (typeof config === "object" && config !== null && !Array.isArray(config)) {
        const plugins = "plugins" in config ? config.plugins : undefined
        if (Array.isArray(plugins))
          patches.push({ id: row.id, config: { ...config, plugins: nativePresetPlugins(plugins) } })
      }
    }
  }
  const configOf = (id: string) => {
    const config = rows.find((row) => row.id === id)?.config
    return !Array.isArray(config) && config ? config : {}
  }
  if (disablePtc) {
    patches.push({ id: "tools", config: { ...configOf("tools"), mode: "native" } })
  }
  return patches
}
