import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { PatchOptions } from "@deepseek-ai/cordis-plugin-include"
import { resolveProfileModule } from "./profile-resolution.js"

type Row = {
  id?: string
  name?: string
  config?: unknown
  group?: boolean | null
  disabled?: boolean | null
  insert?: Row[]
}

/**
 * Service declarations read from one adopted row's package. The module's
 * `inject` export and Service-class metadata are authoritative; package.json
 * is only a fallback when the module shape cannot be inspected.
 */
interface ServiceDeclaration {
  requires: string[]
  provides: string[]
}

/**
 * Compatibility floor only for rows whose declaration cannot be read (for
 * example an inherited Service base class with no literal service name).
 * This is NOT the forward-compatibility mechanism: new dependencies are
 * discovered from the adopted inject graph, and an unresolvable install
 * anchor still throws.
 */
const fallbackProviders = new Set([
  "timer",
  "session-projection",
  "subprocess",
  "sandbox",
  "sandbox-policy",
  "bash-sandbox",
  "pwsh-sandbox",
  "approval",
  "ptc-runtime",
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

/** Tool-surface entry points; the closure starts from what the container adopts. */
const adoptedEntryIds = new Set(["tools", "tool-bash", "tool-pwsh", "tool-fs", "tool-fs-search"])
const explicitProviderNames = new Set(["@deepseek-ai/dsh-tool-str-replace-editor"])
const hardDisabledIds = new Set([
  "hmr",
  "deepseek-account",
  "otel",
  "session-telemetry-otel",
  "llm-deepseek-account",
  "account-controller",
])
const forbiddenServices = new Set(["sessions", "agents"])

/**
 * Parse the declaration surface only: no module evaluation. The type entry
 * names the classes and their static `inject`; the runtime entry holds the
 * literal `inject` arrays and the `super(ctx, "service")` provider names.
 */
function declarationFromSource(source: string): ServiceDeclaration | undefined {
  const requires = new Set<string>()
  for (const match of source.matchAll(/(?:export\s+)?(?:declare\s+)?const\s+inject\s*=\s*\[([\s\S]*?)\]/gu)) {
    for (const service of stringArray(match[1])) requires.add(service)
  }
  for (const match of source.matchAll(/static\s+inject\s*=\s*\[([\s\S]*?)\]/gu)) {
    for (const service of stringArray(match[1])) requires.add(service)
  }
  const provides = new Set<string>()
  for (const match of source.matchAll(/super\s*\(\s*ctx\s*,\s*["']([^"']+)["']/gu)) provides.add(match[1])
  return requires.size === 0 && provides.size === 0 ? undefined : { requires: [...requires], provides: [...provides] }
}

function stringArray(value: string): string[] {
  return [...value.matchAll(/["']([^"']+)["']/gu)].map((match) => match[1])
}

function readSource(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function typesEntryOf(packageRoot: string, manifestSource: string): string | undefined {
  try {
    const manifest: unknown = JSON.parse(manifestSource)
    if (typeof manifest !== "object" || manifest === null || !("exports" in manifest)) return undefined
    const exports = manifest.exports
    if (typeof exports !== "object" || exports === null || !("." in exports)) return undefined
    const root = exports["."]
    if (typeof root === "object" && root !== null && "types" in root && typeof root.types === "string") {
      return resolve(packageRoot, root.types)
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Resolve a package through the product closure anchor and read declarations
 * as text. Anchoring here is mandatory: packaged hosts do not carry the DSH
 * packages in their own module graph.
 */
function declarationForPackage(name: string, installAnchor: string): ServiceDeclaration | undefined {
  const context = { installAnchor, dir: dirname(installAnchor) }
  let entry: string
  try {
    entry = resolveProfileModule(name, context)
  } catch (error) {
    throw new Error(
      `dsh profile capabilities: cannot resolve ${JSON.stringify(name)} from install anchor ${installAnchor}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }
  const runtimeFile = fileURLToPath(entry)
  const packageRoot = dirname(dirname(runtimeFile))
  const manifestSource = readSource(resolve(packageRoot, "package.json"))
  const typesFile = manifestSource === undefined ? undefined : typesEntryOf(packageRoot, manifestSource)
  const declarationSource = (typesFile === undefined ? undefined : readSource(typesFile)) ?? readSource(runtimeFile)
  return declarationSource === undefined ? undefined : declarationFromSource(declarationSource)
}

interface Inspection {
  declaration: ServiceDeclaration | undefined
  /** The package was found at the anchor but its declaration surface was unreadable. */
  unreadable: boolean
}

function servicesOf(name: string, installAnchor: string, cache: Map<string, Inspection>): Inspection {
  if (cache.has(name)) return cache.get(name)!
  if (!name.startsWith("@deepseek-ai/")) {
    const result = { declaration: undefined, unreadable: false }
    cache.set(name, result)
    return result
  }
  const declaration = declarationForPackage(name, installAnchor)
  const result = { declaration, unreadable: declaration === undefined }
  cache.set(name, result)
  return result
}

function nativePresetPlugins(rows: readonly Row[]): Row[] {
  return rows
    .filter((row) => !["workflow-ptc", "workflow-worker-thread", "tool-workflow", "tool-ralph"].includes(row.id ?? ""))
    .map((row) => (row.group && Array.isArray(row.config) ? { ...row, config: nativePresetPlugins(row.config) } : row))
}

function adoptedProviderIds(rows: readonly Row[], inspect: (name: string) => Inspection): Set<string> {
  const byId = new Map<string, Row>()
  const byService = new Map<string, string[]>()
  for (const row of rows) {
    if (!row.id) continue
    byId.set(row.id, row)
    const { declaration } = inspect(row.name ?? "")
    if (!declaration) continue
    for (const service of declaration.provides) {
      const owners = byService.get(service) ?? []
      owners.push(row.id)
      byService.set(service, owners)
    }
  }
  const adopted = new Set<string>(adoptedEntryIds)
  for (const row of rows) {
    if (!row.id) continue
    if (explicitProviderNames.has(row.name ?? "")) adopted.add(row.id)
    const inspection = inspect(row.name ?? "")
    if (inspection.unreadable && fallbackProviders.has(row.id)) adopted.add(row.id)
  }
  const queue = [...adopted]
  while (queue.length > 0) {
    const id = queue.shift()!
    const row = byId.get(id)
    if (!row) continue
    const { declaration } = inspect(row.name ?? "")
    if (!declaration) continue
    for (const service of declaration.requires) {
      if (forbiddenServices.has(service)) continue
      for (const provider of byService.get(service) ?? []) {
        if (adopted.has(provider)) continue
        adopted.add(provider)
        queue.push(provider)
      }
    }
  }
  return adopted
}

/** Host boundaries are generated after the complete user composition. */
export interface ProfileCapabilityPatchOptions {
  /** Absolute @deepseek-ai/dsh/package.json of the materialised product closure. */
  installAnchor: string
  /** Test seam; production always resolves declarations from `installAnchor`. */
  inspect?: (name: string) => ServiceDeclaration | undefined
}

export function profileCapabilityPatches(
  profile: string,
  rows: readonly Row[],
  disablePtc: boolean,
  options: ProfileCapabilityPatchOptions,
): PatchOptions[] {
  const patches: PatchOptions[] = []
  const declarations = new Map<string, Inspection>()
  const inspect = options.inspect
    ? (name: string): Inspection => {
        const declaration = options.inspect!(name)
        return { declaration, unreadable: declaration === undefined }
      }
    : (name: string) => servicesOf(name, options.installAnchor, declarations)
  const adopted = profile === "ellamaka-tools" ? adoptedProviderIds(rows, inspect) : undefined
  for (const row of rows) {
    if (!row.id) continue
    if (hardDisabledIds.has(row.id)) patches.push({ id: row.id, disabled: true })
    if (profile === "ellamaka-tools" && typeof row.name === "string" && row.name.startsWith("@deepseek-ai/")) {
      if (adopted?.has(row.id) !== true) patches.push({ id: row.id, disabled: true })
    }
    if (process.versions.electron && row.id === "subprocess") patches.push({ id: row.id, disabled: true })
    if (disablePtc && row.id === "ptc-runtime") patches.push({ id: row.id, disabled: true })
    if (disablePtc && row.id === "preset-ptc") patches.push({ id: row.id, disabled: true })
    if (profile === "web" && disablePtc && ["preset-standard", "preset-cordis"].includes(row.id)) {
      const config = row.config
      if (typeof config === "object" && config !== null && !Array.isArray(config)) {
        const plugins = "plugins" in config ? config.plugins : undefined
        if (Array.isArray(plugins))
          patches.push({ id: row.id, config: { ...config, plugins: nativePresetPlugins(plugins) } })
      }
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
