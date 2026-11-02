import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parse } from "jsonc-parser"
import { SettingsRegistryError, updateSettingsEntry } from "./settings-registry"

export const DSH_WEB_ENABLED_KEY = "wopal.dsh.web.enabled"

export class ProductSettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProductSettingsError"
  }
}

export function parseDshWebEnabled(text: string): boolean | undefined {
  const errors: { error: number; offset: number; length: number }[] = []
  const raw = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown
  if (errors.length) throw new ProductSettingsError("settings.jsonc is not valid JSONC")
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const wopal = "wopal" in raw ? raw.wopal : undefined
  if (!wopal || typeof wopal !== "object" || Array.isArray(wopal)) return undefined
  const dsh = "dsh" in wopal ? wopal.dsh : undefined
  if (!dsh || typeof dsh !== "object" || Array.isArray(dsh)) return undefined
  const web = "web" in dsh ? dsh.web : undefined
  if (!web || typeof web !== "object" || Array.isArray(web)) return undefined
  const enabled = "enabled" in web ? web.enabled : undefined
  return typeof enabled === "boolean" ? enabled : undefined
}

export async function readDshWebEnabled(wopalHome: string): Promise<boolean> {
  const file = join(wopalHome, "config", "settings.jsonc")
  try {
    return parseDshWebEnabled(await readFile(file, "utf8")) ?? true
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true
    throw error
  }
}

export async function updateDshWebEnabled(input: {
  wopalHome: string
  enabled: boolean
}): Promise<{ changed: boolean; apply: "restart-required" }> {
  const file = join(input.wopalHome, "config", "settings.jsonc")
  try {
    const changed = updateSettingsEntry(file, ["wopal", "dsh", "web", "enabled"], input.enabled, {
      validate: parseDshWebEnabled,
    })
    return { changed, apply: "restart-required" }
  } catch (error) {
    if (error instanceof SettingsRegistryError) throw new ProductSettingsError(error.message)
    throw error
  }
}
