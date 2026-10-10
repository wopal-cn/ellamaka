interface Row {
  id?: string
  name?: string
  config?: Record<string, unknown> | Row[]
  group?: boolean | null
  disabled?: boolean | null
  insert?: Row[]
}

const toolProviders = new Set([
  "timer",
  "session-projection",
  "subprocess",
  "sandbox",
  "sandbox-policy",
  "bash-sandbox",
  "pwsh-sandbox",
  "approval",
  "shell-env",
  "tool-bash",
  "tool-pwsh",
  "fs-observation-policy",
  "tool-fs",
  "tool-fs-search",
  "timeout-policy",
  "spill-local",
  "spill-policy",
  "tools",
  "system-prompt",
  "fs-sandbox",
  "storage",
  "storage-json",
  "storage-domain",
])

function nativePresetPlugins(rows: readonly Row[]): Row[] {
  return rows
    .filter((row) => !["workflow-ptc", "workflow-worker-thread", "tool-workflow", "tool-ralph"].includes(row.id ?? ""))
    .map((row) => (row.group && Array.isArray(row.config) ? { ...row, config: nativePresetPlugins(row.config) } : row))
}

/** Host boundaries are generated after the complete user composition. */
export function profileCapabilityPatches(profile: string, rows: readonly Row[], disablePtc: boolean): Row[] {
  const patches: Row[] = []
  for (const row of rows) {
    if (!row.id) continue
    if (
      row.id === "hmr" ||
      row.id === "deepseek-account" ||
      row.id === "otel" ||
      row.id === "session-telemetry-otel" ||
      row.id === "llm-deepseek-account" ||
      row.id === "account-controller"
    ) {
      patches.push({ id: row.id, disabled: true })
    }
    if (
      profile === "ellamaka-tools" &&
      typeof row.name === "string" &&
      row.name.startsWith("@deepseek-ai/") &&
      !toolProviders.has(row.id)
    ) {
      patches.push({ id: row.id, disabled: true })
    }
    if (process.versions.electron && row.id === "subprocess") patches.push({ id: row.id, disabled: true })
    if (disablePtc && row.id === "ptc-runtime") patches.push({ id: row.id, disabled: true })
    if (disablePtc && row.id === "preset-ptc") patches.push({ id: row.id, disabled: true })
    if (profile === "web" && disablePtc && ["preset-standard", "preset-cordis"].includes(row.id)) {
      const plugins = (row.config as Record<string, unknown> | undefined)?.plugins
      if (Array.isArray(plugins))
        patches.push({
          id: row.id,
          config: { ...(row.config as Record<string, unknown>), plugins: nativePresetPlugins(plugins) },
        })
    }
  }
  const configOf = (id: string) => {
    const config = rows.find((row) => row.id === id)?.config
    return !Array.isArray(config) && config ? config : {}
  }
  if (profile === "ellamaka-tools") {
    patches.push(
      { id: "tools", config: { ...configOf("tools"), mode: "native" } },
      { id: "tool-bash", config: { ...configOf("tool-bash"), enableRunInBackground: false } },
      { id: "tool-pwsh", config: { ...configOf("tool-pwsh"), enableRunInBackground: false } },
      { insert: [{ id: "tool-str-replace-editor", name: "@deepseek-ai/dsh-tool-str-replace-editor" }] },
    )
  } else if (disablePtc) {
    patches.push({ id: "tools", config: { ...configOf("tools"), mode: "native" } })
  }
  return patches
}
