import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { resolve as resolveExports } from "resolve.exports"

export interface ProfileModuleContext {
  installAnchor: string
  dir: string
}

function packageName(specifier: string): string {
  const parts = specifier.split("/")
  return parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/")
}

/** Profile packages do not borrow entities from a sibling profile. */
export function resolveProfileModule(
  specifier: string,
  context: ProfileModuleContext,
  parentURL = pathToFileURL(join(context.dir, "cordis.yml")).href,
): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) return specifier
  if (isAbsolute(specifier)) return pathToFileURL(specifier).href
  if (specifier.startsWith(".")) return new URL(specifier, parentURL).href
  const name = packageName(specifier)
  const installationOwned = name.startsWith("@deepseek-ai/")
  const roots = installationOwned
    ? (createRequire(realpathSync(context.installAnchor)).resolve.paths(name) ?? [])
    : [join(context.dir, "node_modules")]
  const directory = roots.map((root) => join(root, name)).find((dir) => existsSync(join(dir, "package.json")))
  if (!directory) {
    const error = new Error(
      `Cannot find module '${specifier}' in ${installationOwned ? "the runtime closure" : "profile " + context.dir}`,
    )
    Object.assign(error, { code: "MODULE_NOT_FOUND" })
    throw error
  }
  const root = realpathSync(directory)
  const manifestPath = join(root, "package.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  const subpath = specifier === name ? "." : "." + specifier.slice(name.length)
  let filename: string
  if (manifest.exports !== undefined) {
    let targets: ReturnType<typeof resolveExports>
    try {
      targets = resolveExports(manifest, subpath, {
        conditions: process.versions.bun ? ["bun"] : [],
      })
    } catch (error) {
      if (error instanceof Error && /^(Missing|No known conditions for) /.test(error.message))
        Object.assign(error, { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
      throw error
    }
    const target = targets?.[0]
    if (!target?.startsWith("./")) throw new Error(`Invalid or missing export '${specifier}'`)
    filename = resolve(root, target)
  } else {
    const target = subpath === "." ? (manifest.main ?? "./index.js") : subpath
    filename = createRequire(manifestPath).resolve(target.startsWith(".") ? target : "./" + target)
  }
  const path = relative(root, filename)
  if (path === ".." || path.startsWith(".." + sep) || isAbsolute(path))
    throw new Error(`Package export escapes '${name}'`)
  return pathToFileURL(filename).href
}

interface ImportTree {
  ctx: {
    baseUrl?: string
    get?(name: string, required?: boolean): unknown
  }
}
interface ImportPrototype {
  import(this: ImportTree, name: string, outerStack?: () => string[]): unknown
}

const routed = new WeakSet<object>()

/**
 * Route the public EntryTree import seam using each tree's inherited profile
 * facts. Include and preset subtrees inherit this method. Native loader
 * internals, module caches and official package files remain unchanged.
 */
export function installProfileModuleRouting(prototype: ImportPrototype): void {
  if (routed.has(prototype)) return
  routed.add(prototype)
  const original = prototype.import
  prototype.import = function (name, outerStack) {
    const profile = this.ctx.get?.("profileContext", false) as ProfileModuleContext | undefined
    const imported = original.call(
      this,
      profile ? resolveProfileModule(name, profile, this.ctx.baseUrl) : name,
      outerStack,
    )
    const adapt = this.ctx.get?.("ellamakaPluginModuleAdapter", false) as
      | ((specifier: string, module: unknown) => unknown)
      | undefined
    return adapt ? Promise.resolve(imported).then((module) => adapt(name, module)) : imported
  }
}

interface RuntimeResolution {
  profilesDir: string
  entries: readonly { scope: string; name: string; packageDir: string }[]
}

/** Project only installation-owned packages; never replace a user's real directory. */
export function projectRuntimePackages(resolution: RuntimeResolution): void {
  let sequence = 0
  for (const entry of resolution.entries) {
    if (entry.scope !== "installation") continue
    const link = join(resolution.profilesDir, "node_modules", entry.name)
    mkdirSync(dirname(link), { recursive: true })
    let current: ReturnType<typeof lstatSync> | undefined
    try {
      current = lstatSync(link)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (current && !current.isSymbolicLink()) throw new Error(`Runtime projection conflicts with a real path: ${link}`)
    if (current) {
      try {
        if (realpathSync(link) === realpathSync(entry.packageDir)) continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    const candidate = link + `.projection-${process.pid}-${sequence++}`
    symlinkSync(entry.packageDir, candidate, process.platform === "win32" ? "junction" : "dir")
    renameSync(candidate, link)
  }
}
