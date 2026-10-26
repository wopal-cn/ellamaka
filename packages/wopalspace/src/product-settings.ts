import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"

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
  const wopal = (raw as Record<string, unknown>).wopal
  if (!wopal || typeof wopal !== "object" || Array.isArray(wopal)) return undefined
  const dsh = (wopal as Record<string, unknown>).dsh
  if (!dsh || typeof dsh !== "object" || Array.isArray(dsh)) return undefined
  const web = (dsh as Record<string, unknown>).web
  if (!web || typeof web !== "object" || Array.isArray(web)) return undefined
  const enabled = (web as Record<string, unknown>).enabled
  return typeof enabled === "boolean" ? enabled : undefined
}

export async function readDshWebEnabled(wopalHome: string): Promise<boolean> {
  const file = join(wopalHome, "config", "settings.jsonc")
  try {
    return parseDshWebEnabled(await readFile(file, "utf8")) ?? true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    throw error
  }
}

export async function updateDshWebEnabled(input: {
  wopalHome: string
  enabled: boolean
}): Promise<{ changed: boolean; apply: "restart-required" }> {
  const file = join(input.wopalHome, "config", "settings.jsonc")
  let current = "{}\n"
  try {
    current = await readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (parseDshWebEnabled(current) === input.enabled) {
    return { changed: false, apply: "restart-required" }
  }
  const edits = modify(current, ["wopal", "dsh", "web", "enabled"], input.enabled, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  })
  const next = applyEdits(current, edits)
  const dir = dirname(file)
  await mkdir(dir, { recursive: true })
  const temporary = join(dir, `.settings.jsonc.${process.pid}.${crypto.randomUUID()}.tmp`)
  await writeFile(temporary, next, "utf8")
  await rename(temporary, file)
  return { changed: true, apply: "restart-required" }
}
