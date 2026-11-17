import type { TuiPluginStatus } from "@wopal/ellamaka-plugin/tui"

type ServerSource = "internal" | "user" | "space"
type ServerStatus = "enabled" | "disabled" | "preparing" | "unavailable" | "unknown" | "configured"
type DshStatus = "disabled" | "preparing" | "ready" | "degraded"
type PluginSpec = string | readonly [string, unknown]

function describe(spec: string, roots: { spaceRoot?: string; home?: string }): { name: string; source: ServerSource } {
  let file: string | undefined
  if (spec.startsWith("file:")) {
    try {
      file = decodeURIComponent(new URL(spec).pathname).replace(/^\/([a-z]:\/)/i, "$1")
    } catch {
      return { name: spec, source: "internal" }
    }
  } else if (/^(\/|[a-z]:[\\/]|\\\\)/i.test(spec)) {
    file = spec
  } else if (spec.startsWith("~/") && roots.home) {
    file = roots.home + spec.slice(1)
  }
  if (!file) return { name: spec, source: "internal" }
  const normalized = file.replaceAll("\\", "/").replace(/\/+$/, "")
  const inside = (root?: string) => {
    if (!root) return false
    let base = root.replaceAll("\\", "/").replace(/\/+$/, "")
    let target = normalized
    if (/^[a-z]:\//i.test(target) || target.startsWith("//")) {
      base = base.toLowerCase()
      target = target.toLowerCase()
    }
    return target === base || target.startsWith(base + "/")
  }
  const parts = normalized.split("/").filter(Boolean)
  let name = (parts.pop() ?? spec).replace(/\.[cm]?[jt]sx?$/i, "")
  if (name === "index") {
    while (["src", "lib", "dist", "build"].includes(parts.at(-1) ?? "")) parts.pop()
    name = parts.at(-1) ?? name
  }
  return { name, source: inside(roots.spaceRoot) ? "space" : inside(roots.home) ? "user" : "internal" }
}

export function serverPlugins(
  specs: readonly PluginSpec[] | undefined,
  sandbox: unknown,
  dsh: DshStatus | undefined,
  roots: { spaceRoot?: string; home?: string },
): { name: string; source: ServerSource; status: ServerStatus }[] {
  const enabled = typeof sandbox === "object" && sandbox !== null && "enabled" in sandbox ? sandbox.enabled : undefined
  const status: ServerStatus =
    enabled === false || dsh === "disabled"
      ? "disabled"
      : dsh === "preparing"
        ? "preparing"
        : dsh === "degraded"
          ? "unavailable"
          : dsh === "ready" && enabled === true
            ? "enabled"
            : "unknown"
  return [
    { name: "dsh-adapter", source: "internal", status },
    ...(specs ?? []).flatMap((item) => {
      const spec = typeof item === "string" ? item : item[0]
      if (spec === "dsh-adapter") return []
      return [{ ...describe(spec, roots), status: "configured" as const }]
    }),
  ]
}

export function tuiPlugins(plugins: ReadonlyArray<TuiPluginStatus>) {
  return plugins.map((item) => ({
    name: item.id,
    source: item.source,
    status: !item.enabled ? ("disabled" as const) : item.active ? ("active" as const) : ("inactive" as const),
  }))
}
