import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  CAPABILITY_KINDS,
  OntologyServiceError,
  type CapabilityKind,
  type OntologyCapabilityItem,
  type OntologyCapabilityResult,
} from "./types"

function frontmatterDescription(file: string): string | undefined {
  try {
    const match = readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)
    const value = match?.[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim()
    return value?.replace(/^["']|["']$/g, "")
  } catch {
    return undefined
  }
}

function jsonDescription(file: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    const description = "description" in parsed ? parsed.description : undefined
    return typeof description === "string" ? description : undefined
  } catch {
    return undefined
  }
}

function readmeDescription(dir: string): string | undefined {
  try {
    const text = readFileSync(join(dir, "README.md"), "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    return text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#"))
  } catch {
    return undefined
  }
}

/** Description fallbacks match the existing owner: skill metadata, then plugin manifest, then prose. */
function describe(root: string, kind: CapabilityKind, entry: string, directory: boolean): string {
  const path = join(root, kind, entry)
  if (kind === "skills") {
    if (!directory) return ""
    return (
      frontmatterDescription(join(path, "SKILL.md")) ??
      jsonDescription(join(path, ".source.json")) ??
      readmeDescription(path) ??
      ""
    )
  }
  if (kind === "plugins") {
    if (!directory) return ""
    return (
      jsonDescription(join(path, "package.json")) ??
      readmeDescription(path) ??
      frontmatterDescription(join(path, "AGENTS.md")) ??
      ""
    )
  }
  if (!directory) return frontmatterDescription(path) ?? ""
  return frontmatterDescription(join(path, "AGENTS.md")) ?? readmeDescription(path) ?? ""
}

function hasExtension(name: string): boolean {
  const dot = name.lastIndexOf(".")
  return dot > 0 && dot < name.length - 1
}

/** The strict reference that addresses a pool entry; extension-less files gain the noext marker. */
export function capabilityEntryRef(name: string, directory: boolean): string {
  if (directory) return name
  if (!hasExtension(name) || name.endsWith(".noext")) return name + ".noext"
  return name
}

export function capabilityKind(value: string): CapabilityKind {
  const match = CAPABILITY_KINDS.find((kind) => kind === value)
  if (match) return match
  throw new OntologyServiceError({
    code: "ONTOLOGY_CAPABILITY_KIND_INVALID",
    message: "Unknown capability kind: " + value,
    suggestion: "Use one of " + CAPABILITY_KINDS.join(", ") + ".",
  })
}

/**
 * Read the complete candidate pool from the registered ontology. This
 * describes what a Space may select; it does not evaluate Runtime
 * authorization and it never writes.
 */
export function readCapabilities(root: string, kind?: CapabilityKind): OntologyCapabilityResult {
  const items: OntologyCapabilityItem[] = []
  for (const category of kind ? [kind] : CAPABILITY_KINDS) {
    const directory = join(root, category)
    if (!existsSync(directory)) continue
    let entries: string[]
    try {
      entries = readdirSync(directory)
    } catch {
      continue
    }
    for (const entry of entries.sort()) {
      if (entry.startsWith(".")) continue
      let stats
      try {
        stats = statSync(join(directory, entry))
      } catch {
        continue
      }
      const isDirectory = stats.isDirectory()
      if (!isDirectory && !stats.isFile()) continue
      items.push({
        kind: category,
        name: capabilityEntryRef(entry, isDirectory),
        description: describe(root, category, entry, isDirectory),
      })
    }
  }
  return { items, total: items.length }
}
