export * as ConfigWopalPluginConfig from "./wopal-plugin-config"

import path from "path"
import * as Log from "@wopal/ellamaka-core/util/log"
import { isRecord } from "@/util/record"
import { ConfigParse } from "./parse"

const log = Log.create({ service: "config" })

export type PluginConfigSource = "global" | "space" | "space-local"
export type PluginConfigTable = Record<string, Record<string, unknown>>
export type PluginConfigSources = Record<string, PluginConfigSource>

export interface PluginConfigLayer {
  source: PluginConfigSource
  path: string
  text: string | undefined
}

export interface PluginConfigMerge {
  pluginConfig: PluginConfigTable
  sources: PluginConfigSources
}

export function settingsFileSource(filePath: string): PluginConfigSource {
  return path.basename(filePath) === "settings.local.jsonc" ? "space-local" : "space"
}

// Merges `wopal.pluginConfig` sections of the given layers in load order
// (global -> space public -> space local). Objects deep merge, everything else
// replaces the whole key; sources records the effective layer per leaf dot path.
export function mergePluginConfig(layers: PluginConfigLayer[]): PluginConfigMerge {
  const pluginConfig: PluginConfigTable = {}
  const sources: PluginConfigSources = {}
  for (const layer of layers) {
    const section = extractPluginConfigSection(layer)
    if (!section) continue
    mergeEntries(pluginConfig, sources, section, layer.source, "")
  }
  return { pluginConfig, sources }
}

function extractPluginConfigSection(layer: PluginConfigLayer): Record<string, unknown> | undefined {
  if (layer.text === undefined) return undefined
  let raw: unknown
  try {
    raw = ConfigParse.jsonc(layer.text, layer.path)
  } catch (err) {
    // Mirror the `ellamaka` section degradation: a layer that cannot be parsed
    // contributes nothing instead of aborting the whole config load.
    log.warn("failed to parse wopal plugin config, skipping layer", {
      path: layer.path,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
  if (!isRecord(raw) || !isRecord(raw.wopal)) return undefined
  const pluginConfig = raw.wopal.pluginConfig
  if (pluginConfig === undefined) return undefined
  if (!isRecord(pluginConfig)) throw invalidPluginConfig(layer.path, "wopal.pluginConfig", pluginConfig)
  for (const [name, entry] of Object.entries(pluginConfig)) {
    if (!isRecord(entry)) throw invalidPluginConfig(layer.path, `wopal.pluginConfig.${name}`, entry)
  }
  return pluginConfig
}

function invalidPluginConfig(filePath: string, key: string, value: unknown) {
  return new Error(`invalid ${key} at ${filePath}: expected an object, got ${describeValue(value)}`)
}

function describeValue(value: unknown) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function mergeEntries(
  target: Record<string, unknown>,
  sources: PluginConfigSources,
  incoming: Record<string, unknown>,
  source: PluginConfigSource,
  prefix: string,
) {
  for (const [key, value] of Object.entries(incoming)) {
    const keyPath = prefix ? `${prefix}.${key}` : key
    if (isRecord(value)) {
      const existing = target[key]
      if (isRecord(existing)) {
        mergeEntries(existing, sources, value, source, keyPath)
        continue
      }
      clearSources(sources, keyPath)
      const next: Record<string, unknown> = {}
      target[key] = next
      mergeEntries(next, sources, value, source, keyPath)
      continue
    }
    target[key] = value
    clearSources(sources, keyPath)
    sources[keyPath] = source
  }
}

// A replaced subtree leaves sources for keys that no longer exist in the
// effective table, so drop the whole prefix before recording the new shape.
function clearSources(sources: PluginConfigSources, prefix: string) {
  for (const key of Object.keys(sources)) {
    if (key === prefix || key.startsWith(`${prefix}.`)) delete sources[key]
  }
}
