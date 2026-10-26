import type { Config } from "@wopal/ellamaka-sdk/v2/client"
import { pathKey } from "@/utils/path-key"
import { readSandboxOptions, type DshRuntimeStatus } from "./prompt-input/sandbox-control"

export type PluginSource = "system" | "internal" | "user" | "space"
export type StatusPlugin = { name: string; source?: PluginSource; enabled?: boolean }

/** Configured extensions plus the product-owned sandbox adapter adoption state. */
export function statusPlugins(
  plugins: Config["plugin"],
  sandbox: unknown,
  dshStatus?: DshRuntimeStatus,
): StatusPlugin[] {
  const configured = (plugins ?? []).map((item) => ({
    name: typeof item === "string" ? item : item[0],
  }))
  const enabled = dshStatus === "ready" && readSandboxOptions(sandbox)?.enabled === true
  return [
    { name: "dsh-adapter", source: "internal", enabled },
    ...configured.filter((item) => item.name !== "dsh-adapter"),
  ]
}

/** Presentation only: source labels do not grant filesystem access. */
export function describeStatusPlugin(
  plugin: StatusPlugin,
  roots: { spaceRoot?: string; userHome?: string },
): { name: string; source: PluginSource; enabled?: boolean } {
  let file: string | undefined
  if (plugin.name.startsWith("file:")) {
    try {
      file = decodeURIComponent(new URL(plugin.name).pathname).replace(/^\/([a-z]:\/)/i, "$1")
    } catch {
      return { name: plugin.name, source: plugin.source ?? "internal", enabled: plugin.enabled }
    }
  } else if (/^(\/|[a-z]:[\\/]|\\\\)/i.test(plugin.name)) {
    file = plugin.name
  } else if (plugin.name.startsWith("~/") && roots.userHome) {
    file = roots.userHome + plugin.name.slice(1)
  }
  if (!file) return { name: plugin.name, source: plugin.source ?? "internal", enabled: plugin.enabled }

  const path = pathKey(file)
  const inside = (root?: string) => {
    if (!root) return false
    const windows = /^[a-z]:\//i.test(path) || path.startsWith("//")
    const target = windows ? path.toLowerCase() : path
    const normalized = pathKey(root)
    const base = windows ? normalized.toLowerCase() : normalized
    return target === base || target.startsWith(base.endsWith("/") ? base : base + "/")
  }
  const segments = path.split("/").filter(Boolean)
  const leaf = segments.pop() ?? plugin.name
  let name = leaf.replace(/\.[cm]?[jt]sx?$/i, "")
  if (name === "index") {
    while (["src", "lib", "dist", "build"].includes(segments.at(-1) ?? "")) segments.pop()
    name = segments.at(-1) ?? name
  }
  const source = plugin.source ?? (inside(roots.spaceRoot) ? "space" : inside(roots.userHome) ? "user" : "internal")
  return { name, source, enabled: plugin.enabled }
}
