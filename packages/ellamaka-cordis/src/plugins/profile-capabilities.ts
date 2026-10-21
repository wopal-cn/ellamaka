import { createRequire } from "node:module"

interface Row {
  id?: string
  name?: string
  config?: Record<string, unknown> | Row[]
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
 * Compatibility floor, not the forward-compatibility mechanism. Some rc.2
 * providers expose their service through an inherited base class, so the
 * host cannot prove their service name from this row alone. Keep the known
 * adopted providers enabled; new dependencies are discovered from the
 * actual inject graph above this floor.
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

/** Roots that define the adopted tool surface even without a service of their own. */
const adoptedEntryIds = new Set(["tools"])
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

const require = createRequire(import.meta.url)

function unique(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.length > 0))]
}

function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function injectOf(value: unknown): unknown {
  return typeof value === "object" && value !== null && "inject" in value ? value.inject : undefined
}

/**
 * Read declarations without evaluating `apply()`. rc.2 plugins expose either
 * `export const inject` or a Service class with static `inject`; service
 * providers also name themselves in `super(ctx, "service")`.
 */
function declarationFromModule(module: unknown): ServiceDeclaration | undefined {
  if (typeof module !== "object" || module === null) return undefined
  const requires = stringsOf(injectOf(module))
  const provides = new Set<string>()
  for (const [, value] of Object.entries(module)) {
    if (typeof value !== "function") continue
    requires.push(...stringsOf(injectOf(value)))
    const source = Function.prototype.toString.call(value)
    const match = /super\s*\(\s*ctx\s*,\s*["']([^"']+)["']/u.exec(source)
    if (match !== null) provides.add(match[1])
  }
  return requires.length === 0 && provides.size === 0
    ? undefined
    : { requires: unique(requires), provides: [...provides] }
}

/**
 * Metadata fallback. `package.json` has no Cordis service names for rc.2
 * (`inject` is usually a module export), and peerDependencies describe
 * importable packages rather than required services. Only package names are
 * usable here, so they are converted to the service-name shape and used
 * solely when the module cannot be inspected.
 */
function declarationFromManifest(name: string): ServiceDeclaration | undefined {
  try {
    const manifest: unknown = require(`${name}/package.json`)
    const peerDependencies = (
      typeof manifest === "object" &&
      manifest !== null &&
      "peerDependencies" in manifest &&
      typeof manifest.peerDependencies === "object" &&
      manifest.peerDependencies !== null
        ? Object.keys(manifest.peerDependencies)
        : []
    )
      .filter((specifier) => specifier.startsWith("@deepseek-ai/") && specifier !== "@deepseek-ai/cordis")
      .map((specifier) => specifier.replace(/^@deepseek-ai\//u, ""))
    const requires = unique([...stringsOf(injectOf(manifest)), ...peerDependencies])
    return requires.length === 0 ? undefined : { requires, provides: [] }
  } catch {
    return undefined
  }
}

function servicesOf(name: string, cache: Map<string, ServiceDeclaration | undefined>): ServiceDeclaration | undefined {
  if (cache.has(name)) return cache.get(name)
  let declaration: ServiceDeclaration | undefined
  try {
    declaration = declarationFromModule(require(name))
  } catch {
    declaration = undefined
  }
  declaration ??= declarationFromManifest(name)
  cache.set(name, declaration)
  return declaration
}

function nativePresetPlugins(rows: readonly Row[]): Row[] {
  return rows
    .filter((row) => !["workflow-ptc", "workflow-worker-thread", "tool-workflow", "tool-ralph"].includes(row.id ?? ""))
    .map((row) => (row.group && Array.isArray(row.config) ? { ...row, config: nativePresetPlugins(row.config) } : row))
}

function adoptedProviderIds(rows: readonly Row[], inspect: ServicesOf): Set<string> {
  const byId = new Map<string, Row>()
  const byService = new Map<string, string[]>()
  for (const row of rows) {
    if (!row.id) continue
    byId.set(row.id, row)
    const declaration = inspect(row.name ?? "")
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
    if (fallbackProviders.has(row.id)) adopted.add(row.id)
  }
  const queue = [...adopted]
  while (queue.length > 0) {
    const id = queue.shift()!
    const row = byId.get(id)
    if (!row) continue
    const declaration = inspect(row.name ?? "")
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

type ServicesOf = (name: string) => ServiceDeclaration | undefined

/** Host boundaries are generated after the complete user composition. */
export function profileCapabilityPatches(
  profile: string,
  rows: readonly Row[],
  disablePtc: boolean,
  inspect?: ServicesOf,
): Row[] {
  const patches: Row[] = []
  const declarations = new Map<string, ServiceDeclaration | undefined>()
  const adopted =
    profile === "ellamaka-tools"
      ? adoptedProviderIds(rows, inspect ?? ((name) => servicesOf(name, declarations)))
      : undefined
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
