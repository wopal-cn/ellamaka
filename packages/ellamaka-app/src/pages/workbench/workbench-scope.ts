// Single source of truth for the General space name across the workbench.
// Re-exported as GENERAL_TAB_NAME (workbench-store) for backward compatibility.
export const GENERAL_SPACE_NAME = "General"
export const GENERAL_SCOPE_NAME = GENERAL_SPACE_NAME
export const GENERAL_SCOPE_PATH = ""

export type SpaceScope = { kind: "general" } | { kind: "space"; name: string; path: string }

export type ScopeTab = {
  name: string
  path: string
  type?: string
}

export function normalizeSpacePath(path: string) {
  const normalized = path.replaceAll("\\", "/")
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized
  return normalized.replace(/\/+$/, "")
}

export function spaceScope(name: string, path: string): SpaceScope {
  const normalized = normalizeSpacePath(path)
  if (!normalized) throw new Error("Space scope requires a non-empty path")
  return { kind: "space", name, path: normalized }
}

export function scopeFromTab(tab: ScopeTab): SpaceScope {
  if (tab.path === GENERAL_SCOPE_PATH) return { kind: "general" }
  return spaceScope(tab.name, tab.path)
}

export function scopePath(scope: SpaceScope) {
  return scope.kind === "general" ? GENERAL_SCOPE_PATH : scope.path
}

export function scopeName(scope: SpaceScope) {
  return scope.kind === "general" ? GENERAL_SCOPE_NAME : scope.name
}

export function scopeKey(scope: SpaceScope) {
  return scope.kind === "general" ? "general" : `space:${scope.path}`
}
