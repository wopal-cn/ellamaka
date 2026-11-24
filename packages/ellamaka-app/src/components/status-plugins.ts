import type { Config } from "@wopal/ellamaka-sdk/v2/client"
import { pathKey } from "@/utils/path-key"
import { readSandboxOptions, type DshRuntimeStatus } from "./prompt-input/sandbox-control"

export type PluginSource = "system" | "internal" | "user" | "space"
export type StatusPlugin = {
  name: string
  source?: PluginSource
  enabled?: boolean
  degraded?: boolean
  reason?: string
}

export type DshDiagnosticKey =
  | "workbench.dsh.reason.homeBusy"
  | "workbench.dsh.reason.homeNewer"
  | "workbench.dsh.reason.legacyAdoption"
  | "workbench.dsh.toolsDisabled.generic"
  | "workbench.dsh.toolsDisabled.withReason"

export type DshTranslate = (key: DshDiagnosticKey, params?: Record<string, string>) => string

/** Aggregate MCP health and DSH tools degradation into the status-popover indicator severity. */
export function resolveStatusPopoverIssue(
  mcp: Record<string, { status: string }> | undefined,
  dshTools?: DshRuntimeStatus,
): "critical" | "warning" | undefined {
  const entries = Object.values(mcp ?? {})
  if (entries.some((item) => item.status === "failed" || item.status === "needs_client_registration")) {
    return "critical"
  }
  if (entries.some((item) => item.status === "needs_auth") || dshTools === "degraded") {
    return "warning"
  }
  return undefined
}

/** Translate known DSH Home failure codes into operator-facing messages. */
export function formatDshReason(t: DshTranslate, reason?: string): string | undefined {
  if (!reason) return undefined
  if (reason === "DSH_HOME_BUSY") return t("workbench.dsh.reason.homeBusy")
  if (reason === "DSH_HOME_NEWER_THAN_RUNTIME") return t("workbench.dsh.reason.homeNewer")
  if (reason === "DSH_HOME_LEGACY_ADOPTION_REQUIRED") return t("workbench.dsh.reason.legacyAdoption")
  return reason
}

/** Format the status-bar warning banner shown when `dsh-adapter` falls back to native tools. */
export function formatDshToolsDisabledMessage(t: DshTranslate, reason?: string): string {
  const formatted = formatDshReason(t, reason)
  return formatted
    ? t("workbench.dsh.toolsDisabled.withReason", { reason: formatted })
    : t("workbench.dsh.toolsDisabled.generic")
}

/** Configured extensions plus the product-owned sandbox adapter adoption state. */
export function statusPlugins(
  plugins: Config["plugin"],
  sandbox: unknown,
  dshStatus?: DshRuntimeStatus,
  dshReason?: string,
): StatusPlugin[] {
  const configured = (plugins ?? []).map((item) => ({
    name: typeof item === "string" ? item : item[0],
  }))
  const enabled = dshStatus === "ready" && readSandboxOptions(sandbox)?.enabled === true
  const degraded = dshStatus === "degraded" && readSandboxOptions(sandbox)?.enabled !== false
  return [
    {
      name: "dsh-adapter",
      source: "internal",
      enabled,
      ...(degraded ? { degraded: true, ...(dshReason ? { reason: dshReason } : {}) } : {}),
    },
    ...configured.filter((item) => item.name !== "dsh-adapter"),
  ]
}

/** Presentation only: source labels do not grant filesystem access. */
export function describeStatusPlugin(
  plugin: StatusPlugin,
  roots: { spaceRoot?: string; userHome?: string },
): { name: string; source: PluginSource; enabled?: boolean; degraded?: boolean; reason?: string } {
  const extra = {
    enabled: plugin.enabled,
    ...(plugin.degraded !== undefined ? { degraded: plugin.degraded } : {}),
    ...(plugin.reason !== undefined ? { reason: plugin.reason } : {}),
  }
  let file: string | undefined
  if (plugin.name.startsWith("file:")) {
    try {
      file = decodeURIComponent(new URL(plugin.name).pathname).replace(/^\/([a-z]:\/)/i, "$1")
    } catch {
      return { name: plugin.name, source: plugin.source ?? "internal", ...extra }
    }
  } else if (/^(\/|[a-z]:[\\/]|\\\\)/i.test(plugin.name)) {
    file = plugin.name
  } else if (plugin.name.startsWith("~/") && roots.userHome) {
    file = roots.userHome + plugin.name.slice(1)
  }
  if (!file) return { name: plugin.name, source: plugin.source ?? "internal", ...extra }

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
  return { name, source, ...extra }
}
