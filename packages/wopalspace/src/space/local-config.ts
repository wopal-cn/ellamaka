import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ArchetypeManifest } from "./assembly"
import { parseJsonc } from "./structured-text"

/**
 * Space-local plugin configuration.
 *
 * The archetype manifest is the single truth for plugin references. For each
 * settings section, specs the shared settings do not declare are appended to
 * settings.local.jsonc, and CLI-managed entries whose regenerated form
 * differs are removed. User-authored entries are preserved whole: the file is
 * git-ignored, so deleting an unrecognized reference would be unrecoverable.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Read a JSONC object file, or null when missing/unreadable. */
function readJsoncRecord(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    // The store tolerates comments and trailing commas the way the previous owner did.
    const parsed: unknown = parseJsonc(readFileSync(path, "utf8"))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** The plugin directory name of a spec, or null when it carries no name. */
function pluginNameFromSpec(spec: unknown): string | null {
  const value = Array.isArray(spec) ? spec[0] : spec
  if (typeof value !== "string") return null
  const match = value.match(/plugins\/([^/]+)/)
  if (match) return match[1] ?? null
  if (!value.includes("/")) return value
  return null
}

/** A CLI-managed spec: the config-relative form or a bare direct reference. */
function managedPluginSpec(spec: unknown): { name: string; form: "config-relative" | "direct" } | null {
  if (typeof spec !== "string") return null
  const relative = spec.match(/^\.\.\/plugins\/([^/]+)$/)
  if (relative) return { name: relative[1] ?? "", form: "config-relative" }
  if (!spec.includes("/")) return { name: spec, form: "direct" }
  return null
}

function pluginNamesFromContent(content: string | null, section: string): Set<string> {
  const names = new Set<string>()
  if (content === null) return names
  let parsed: unknown
  try {
    parsed = parseJsonc(content)
  } catch {
    return names
  }
  if (!isRecord(parsed) || !Object.hasOwn(parsed, section)) return names
  const block = parsed[section]
  if (!isRecord(block) || !Array.isArray(block.plugin)) return names
  for (const spec of block.plugin) {
    const name = pluginNameFromSpec(spec)
    if (name !== null) names.add(name)
  }
  return names
}

function readText(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

/**
 * A cached "what does the shared settings file declare in this section"
 * lookup, shared by init and the drift probe so the question has exactly one
 * implementation.
 */
export function declaredPluginNamesFromSettings(content: string | null): (section: string) => Set<string> {
  const cache = new Map<string, Set<string>>()
  return (section) => {
    let declared = cache.get(section)
    if (declared === undefined) {
      declared = pluginNamesFromContent(content, section)
      cache.set(section, declared)
    }
    return declared
  }
}

export function readDeclaredPluginNames(ontologyPath: string, section = "ellamaka"): Set<string> {
  return pluginNamesFromContent(readText(join(ontologyPath, "config", "settings.jsonc")), section)
}

/**
 * The per-section specs a Space needs locally: manifest plugins the shared
 * settings do not declare in that same section.
 */
export function spacePluginSpecs(
  declaredFor: (section: string) => Set<string>,
  manifest: ArchetypeManifest,
): Record<string, string[]> {
  const specs: Record<string, string[]> = Object.create(null)
  for (const [section, names] of Object.entries(manifest.plugins)) {
    const declared = declaredFor(section)
    specs[section] = names.filter((name) => !declared.has(name)).map((name) => "../plugins/" + name)
  }
  return specs
}

/** Plugin names a Space's exclude selections locally disable. */
export function excludedPluginNames(excludeRefs: readonly string[]): Set<string> {
  const names = new Set<string>()
  for (const ref of excludeRefs) {
    const colon = ref.indexOf(":")
    if (colon <= 0) continue
    if (ref.slice(0, colon) !== "plugin") continue
    const body = ref.slice(colon + 1)
    const target = body.endsWith("/") ? body.slice(0, -1) : body
    const last = target.split("/").pop()
    if (last !== undefined) names.add(last)
  }
  return names
}

/** Fold exclusions into the desired specs and the managed removal set. */
export function applyPluginExclusions(
  desired: Record<string, string[]>,
  manifest: ArchetypeManifest,
  excluded: ReadonlySet<string>,
): { desired: Record<string, string[]>; extraManaged: Record<string, string[]> } {
  const next: Record<string, string[]> = Object.create(null)
  const extraManaged: Record<string, string[]> = Object.create(null)
  for (const [section, specs] of Object.entries(desired)) {
    next[section] = specs.filter((spec) => {
      const name = pluginNameFromSpec(spec)
      return name === null || !excluded.has(name)
    })
    const names = Object.hasOwn(manifest.plugins, section) ? (manifest.plugins[section] ?? []) : []
    extraManaged[section] = names.filter((name) => excluded.has(name))
  }
  return { desired: next, extraManaged }
}

interface Alignment {
  readonly plugins: unknown[]
  readonly added: string[]
  readonly removed: unknown[]
}

/**
 * Align one section's plugin list with the desired specs. Removal is limited
 * to managed entries whose name the section owns; array-form specs and
 * unknown names are preserved.
 */
function alignSection(
  existing: readonly unknown[],
  desiredSpecs: readonly string[],
  sharedDeclared: ReadonlySet<string>,
  extraManaged: readonly string[],
): Alignment {
  const desiredNames = new Set<string>()
  for (const spec of desiredSpecs) {
    const name = pluginNameFromSpec(spec)
    if (name !== null) desiredNames.add(name)
  }
  const managedNames = new Set<string>([...desiredNames, ...sharedDeclared, ...extraManaged])
  const removed = existing.filter((spec) => {
    const managed = managedPluginSpec(spec)
    if (managed === null || !managedNames.has(managed.name)) return false
    if (desiredNames.has(managed.name)) return managed.form !== "config-relative"
    return true
  })
  const kept = existing.filter((spec) => !removed.includes(spec))
  const keptNames = new Set(
    kept.map((spec) => pluginNameFromSpec(spec)).filter((name): name is string => name !== null),
  )
  const added = desiredSpecs.filter((spec) => {
    const name = pluginNameFromSpec(spec)
    return name === null || !keptNames.has(name)
  })
  return { plugins: [...kept, ...added], added, removed }
}

export interface SpaceConfigAlignment {
  readonly ok: boolean
  readonly error?: string
  readonly added: readonly string[]
  readonly removed: readonly unknown[]
  readonly changed: boolean
}

/**
 * Align settings.local.jsonc plugin references with the effective assembly.
 * Sections outside the desired set are left untouched, and the shared
 * settings file is never rewritten.
 */
export function alignSpaceConfig(
  wopalDir: string,
  desiredBySection: Record<string, string[]>,
  extraManagedBySection: Record<string, string[]> = {},
): SpaceConfigAlignment {
  const configDir = join(wopalDir, "config")
  const target = join(configDir, "settings.local.jsonc")
  try {
    const existing = readJsoncRecord(target) ?? {}
    const sharedPath = join(configDir, "settings.jsonc")
    const merged: Record<string, unknown> = Object.assign(Object.create(null), existing)
    const added: string[] = []
    const removed: unknown[] = []
    const sections = [...new Set([...Object.keys(desiredBySection), ...Object.keys(extraManagedBySection)])]
    let existingEntries = 0

    for (const section of sections) {
      const block = Object.hasOwn(existing, section) && isRecord(existing[section]) ? existing[section] : {}
      const existingPlugins = Array.isArray(block.plugin) ? block.plugin : []
      existingEntries += existingPlugins.length
      const aligned = alignSection(
        existingPlugins,
        Object.hasOwn(desiredBySection, section) ? (desiredBySection[section] ?? []) : [],
        pluginNamesFromContent(readText(sharedPath), section),
        Object.hasOwn(extraManagedBySection, section) ? (extraManagedBySection[section] ?? []) : [],
      )
      added.push(...aligned.added)
      removed.push(...aligned.removed)
      if (aligned.added.length > 0 || aligned.removed.length > 0) {
        merged[section] = { ...block, plugin: aligned.plugins }
      }
    }

    if (added.length === 0 && removed.length === 0) {
      return { ok: true, added: [], removed: [], changed: false }
    }
    mkdirSync(configDir, { recursive: true })
    writeFileSync(target, JSON.stringify(merged, null, 2) + "\n", "utf8")
    return { ok: true, added, removed, changed: true }
  } catch (error) {
    return {
      ok: false,
      error:
        "Failed to write space config at " + target + ": " + (error instanceof Error ? error.message : String(error)),
      added: [],
      removed: [],
      changed: false,
    }
  }
}
