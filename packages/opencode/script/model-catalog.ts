import { readFile } from "node:fs/promises"

const DEFAULT_MODELS_URL = "https://models.opencode.ai"

type CatalogSource = "explicit" | "network" | "snapshot" | "empty"

type Response = {
  readonly ok: boolean
  readonly text: () => Promise<string>
}

export interface ModelCatalogResult {
  readonly data: string
  readonly source: CatalogSource
}

export interface LoadModelCatalogOptions {
  readonly explicitPath?: string
  readonly snapshotPath: string
  readonly sourceUrl?: string
  readonly release: boolean
  readonly fetch?: (url: string, options: { signal: AbortSignal }) => Promise<Response>
  readonly readFile?: (path: string) => Promise<string>
  readonly warn?: (message: string) => void
  readonly timeoutMs?: number
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function isValidCatalog(input: unknown): input is Record<string, unknown> {
  // Keep this provider-record boundary aligned with ModelsDev. The catalog's
  // model fields evolve upstream independently, so validating the full model
  // schema here would reject valid newer snapshots.
  if (!isRecord(input)) return false
  const entries = Object.entries(input)
  if (entries.length === 0) return false

  return entries.every(
    ([id, provider]) =>
      isRecord(provider) &&
      provider.id === id &&
      typeof provider.name === "string" &&
      Array.isArray(provider.env) &&
      provider.env.every((item) => typeof item === "string") &&
      isRecord(provider.models) &&
      Object.keys(provider.models).length > 0 &&
      Object.values(provider.models).every(isRecord),
  )
}

function validCatalogText(text: string): string | undefined {
  try {
    return isValidCatalog(JSON.parse(text)) ? text : undefined
  } catch {
    return undefined
  }
}

async function loadValidFile(input: {
  readonly path: string | undefined
  readonly label: string
  readonly read: (path: string) => Promise<string>
  readonly warn: (message: string) => void
}) {
  const { path, label, read, warn } = input
  if (!path) return
  try {
    const catalog = validCatalogText(await read(path))
    if (!catalog) warn(`Ignoring invalid ${label} provider catalog`)
    return catalog
  } catch {
    warn(`Unable to read ${label} provider catalog`)
    return
  }
}

async function loadValidNetworkCatalog(input: {
  readonly sourceUrl: string
  readonly fetch: NonNullable<LoadModelCatalogOptions["fetch"]>
  readonly timeoutMs: number
  readonly warn: (message: string) => void
}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  try {
    const base = input.sourceUrl.replace(/\/$/, "")
    const response = await input.fetch(`${base}/api.json`, { signal: controller.signal })
    if (!response.ok) {
      input.warn("Provider catalog endpoint returned a non-OK response; falling back to local snapshot")
      return
    }
    const catalog = validCatalogText(await response.text())
    if (!catalog) input.warn("Provider catalog endpoint returned invalid data; falling back to local snapshot")
    return catalog
  } catch {
    input.warn("Failed to fetch provider catalog; falling back to local snapshot")
    return
  } finally {
    clearTimeout(timer)
  }
}

export async function loadModelCatalog(options: LoadModelCatalogOptions): Promise<ModelCatalogResult> {
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"))
  const warn = options.warn ?? console.warn
  const explicit = await loadValidFile({
    path: options.explicitPath,
    label: "explicit",
    read,
    warn,
  })
  if (explicit) return { data: explicit, source: "explicit" }

  const network = await loadValidNetworkCatalog({
    sourceUrl: options.sourceUrl ?? DEFAULT_MODELS_URL,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? 3000,
    warn,
  })
  if (network) return { data: network, source: "network" }

  const snapshot = await loadValidFile({
    path: options.snapshotPath,
    label: "snapshot",
    read,
    warn,
  })
  if (snapshot) return { data: snapshot, source: "snapshot" }

  const message = "No valid provider catalog available for release build"
  if (options.release) throw new Error(message)
  warn(`${message}; continuing development build with an empty catalog`)
  return { data: "{}", source: "empty" }
}
