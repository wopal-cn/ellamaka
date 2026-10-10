export interface PresetPluginRow {
  id?: string
  name?: string
  group?: boolean
  config?: unknown
  isolate?: Record<string, unknown>
  [key: string]: unknown
}

/** Upgrade known runtime references without rewriting persona or tool filters. */
export function upgradePresetPlugins(source: readonly PresetPluginRow[]): PresetPluginRow[] {
  return structuredClone(source).map((row) => {
    if (
      row.name === "@deepseek-ai/dsh-persona" &&
      row.config &&
      typeof row.config === "object" &&
      !Array.isArray(row.config)
    ) {
      const config = row.config as Record<string, unknown>
      if (config.prefix === undefined && typeof config.text === "string") {
        config.prefix = config.text
        delete config.text
      }
    }
    if (row.name === "@deepseek-ai/dsh-workflow-worker-thread") {
      row.name = "@deepseek-ai/dsh-workflow-ptc"
      row.id = row.id === "workflow-worker-thread" ? "workflow-ptc" : row.id
    }
    if (row.group && Array.isArray(row.config)) {
      row.config = upgradePresetPlugins(row.config)
      const keys =
        row.id === "planning"
          ? ["planMode"]
          : row.id === "compaction"
            ? ["compaction", "toolResultPruner"]
            : row.id === "delegation"
              ? ["workflowEngine"]
              : []
      if (keys.length) row.isolate = { ...row.isolate, ...Object.fromEntries(keys.map((key) => [key, true])) }
    }
    return row
  })
}
