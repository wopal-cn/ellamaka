import { existsSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"

function exportTarget(value: unknown, conditions: ReadonlySet<string>): string | undefined {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = exportTarget(item, conditions)
      if (target) return target
    }
    return undefined
  }
  if (value && typeof value === "object") {
    for (const [condition, target] of Object.entries(value as Record<string, unknown>)) {
      if (conditions.has(condition)) return exportTarget(target, conditions)
    }
  }
  return undefined
}

/**
 * Resolve an installed package entry for ESM-capable hosts without assuming a
 * CommonJS main. Package `exports` are authoritative: a plugin may expose only
 * `import` (as @wopal/ellamaka-plugin does), which `require.resolve` rejects.
 */
export function resolveInstalledModule(id: string, dir: string): string | undefined {
  const parts = id.split("/")
  const name = parts.slice(0, id.startsWith("@") ? 2 : 1).join("/")
  let search = path.resolve(dir)
  let packageDir: string | undefined
  while (true) {
    const candidate = path.join(search, "node_modules", name)
    if (existsSync(path.join(candidate, "package.json"))) {
      packageDir = candidate
      break
    }
    const parent = path.dirname(search)
    if (parent === search) return undefined
    search = parent
  }
  const manifestPath = path.join(packageDir, "package.json")
  let manifest: { main?: unknown; exports?: unknown }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest
  } catch {
    return undefined
  }
  const subpath = id === name ? "." : "." + id.slice(name.length)
  const conditions = new Set(["node", "import", "default"])
  let target: string | undefined
  if (manifest.exports !== undefined) {
    const exports = manifest.exports
    const entry =
      typeof exports === "string" || Array.isArray(exports)
        ? subpath === "."
          ? exports
          : undefined
        : subpath in (exports as Record<string, unknown>)
          ? (exports as Record<string, unknown>)[subpath]
          : subpath === "." && !Object.keys(exports as object).some((key) => key.startsWith("."))
            ? exports
            : undefined
    target = exportTarget(entry, conditions)
  } else {
    target = subpath === "." ? (typeof manifest.main === "string" ? manifest.main : "./index.js") : subpath
  }
  if (!target) return undefined
  const filename = path.resolve(packageDir, target.startsWith("./") ? target : "./" + target)
  const relative = path.relative(packageDir, filename)
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return undefined
  if (!existsSync(filename)) return undefined
  try {
    return realpathSync(filename)
  } catch {
    return undefined
  }
}

export namespace Module {
  export function resolve(id: string, dir: string) {
    return resolveInstalledModule(id, dir)
  }
}
