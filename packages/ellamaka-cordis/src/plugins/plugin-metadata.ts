import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { dirname, extname, isAbsolute, relative, resolve, sep, win32 } from "node:path"
import { fileURLToPath } from "node:url"
import type { PluginLocalizedMeta } from "@deepseek-ai/dsh-package-manifest"
import { resolveProfileModule, type ProfileModuleContext } from "./profile-resolution.js"

type Fields = { title?: string; description?: string }
const languageId = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u
const iconTypes = new Map([
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
])

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(path + " must be an object")
  return value as Record<string, unknown>
}
function readObject(path: string): Record<string, unknown> {
  return object(JSON.parse(readFileSync(path, "utf8")), path)
}
function text(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim()) throw new Error(path + " must be a non-empty string")
  return value
}
function fallback(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

/** Read only exported resources using the same closure/profile routing as plugins. */
export function readProfilePluginMeta(
  specifier: string,
  context: ProfileModuleContext,
  parentURL?: string,
): PluginLocalizedMeta | undefined {
  if (!specifier || /^[./#]/.test(specifier) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) return undefined
  const resource = (name: string): string | undefined => {
    try {
      return realpathSync(fileURLToPath(resolveProfileModule(name, context, parentURL)))
    } catch (error) {
      if (
        ["ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return undefined
      throw error
    }
  }
  try {
    const english = resource(specifier + "/locale/en.json")
    const dictionaries = new Map<string, Fields>()
    if (english) {
      for (const entry of readdirSync(dirname(english), { withFileTypes: true })) {
        if (!entry.name.endsWith(".json")) continue
        const language = entry.name.slice(0, -5)
        if (!languageId.test(language)) throw new Error(entry.name + " must use a language id")
        const id = language.toLowerCase()
        if (dictionaries.has(id)) throw new Error("duplicate locale " + id)
        const file = resource(specifier + "/locale/" + entry.name)
        if (!file || dirname(file) !== dirname(english))
          throw new Error(entry.name + " must share the English locale directory")
        const data = readObject(file)
        const meta = data.meta === undefined ? undefined : object(data.meta, file + ": meta")
        dictionaries.set(id, {
          title: text(meta?.title, file + ": meta.title"),
          description: text(meta?.description, file + ": meta.description"),
        })
      }
    }
    const manifestPath = resource(specifier + "/package.json")
    const manifest = manifestPath ? readObject(manifestPath) : undefined
    const localized = (field: keyof Fields, defaultValue: string | undefined, finalValue: string) => {
      const entries = [...dictionaries].flatMap(([language, fields]) =>
        fields[field] === undefined ? [] : [[language, fields[field]!]],
      )
      return entries.length ? { en: defaultValue ?? finalValue, ...Object.fromEntries(entries) } : defaultValue
    }
    const title = localized("title", fallback(manifest?.name), specifier)
    const description = localized("description", fallback(manifest?.description), "")
    const display = { ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { description }) }
    try {
      const icon = text(manifest?.icon, "icon")
      if (!icon || !manifestPath) return title === undefined && description === undefined ? undefined : display
      if (isAbsolute(icon) || win32.isAbsolute(icon) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(icon))
        throw new Error("icon must be a relative file path")
      const mediaType = iconTypes.get(extname(icon).toLowerCase())
      if (!mediaType) throw new Error("icon must be SVG, PNG, JPEG, or WebP")
      const directory = dirname(manifestPath)
      const file = realpathSync(resolve(directory, icon))
      const local = relative(directory, file)
      if (local === ".." || local.startsWith(".." + sep) || isAbsolute(local))
        throw new Error("icon must remain inside its manifest directory")
      const stat = statSync(file)
      if (!stat.isFile()) throw new Error("icon must be a regular file")
      if (stat.size > 256 * 1024) throw new Error("icon exceeds 256 KiB")
      const bytes = readFileSync(file)
      if (bytes.length > 256 * 1024) throw new Error("icon exceeds 256 KiB")
      return { ...display, icon: "data:" + mediaType + ";base64," + bytes.toString("base64") }
    } catch (error) {
      return { ...display, error: "Plugin metadata for " + specifier + ": " + String(error) }
    }
  } catch (error) {
    return { error: "Plugin metadata for " + specifier + ": " + String(error) }
  }
}

/** Adapt the public service; never emulate Node's internal module resolver. */
export function createProfilePackages(
  Base: typeof import("@deepseek-ai/dsh-app-boot").PluginPackages,
  context: ProfileModuleContext,
): typeof Base {
  return class ProfilePackages extends Base {
    override metaOf(specifier: string, parentURL: string): PluginLocalizedMeta | undefined {
      return readProfilePluginMeta(specifier, context, parentURL)
    }
  }
}

/** Keep native install/compatibility diagnostics; read bundle display resources through the host resolver. */
export function createProfilePluginManager(
  Base: typeof import("@deepseek-ai/dsh-plugin-manager").PluginManager,
  context: ProfileModuleContext,
): typeof Base {
  return class ProfilePluginManager extends Base {
    override async listBundles() {
      const rows = await super.listBundles()
      return rows.map((row) => {
        const { meta: _native, ...facts } = row
        const meta = readProfilePluginMeta(row.name, context)
        return { ...facts, ...(meta === undefined ? {} : { meta }) }
      })
    }
  }
}
