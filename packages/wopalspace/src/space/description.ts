import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Description } from "./types"

/** Longest description this extractor returns. */
const maxDescriptionLength = 200

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function firstSentence(text: string): string {
  const index = text.indexOf(". ")
  return index >= 0 ? text.slice(0, index + 1) : text
}

function normalize(
  raw: string,
  source: Description["source"],
  confidence: Description["confidence"],
  sourcePath?: string,
): Description {
  const sentence = firstSentence(collapse(stripMarkdown(raw)))
  if (sentence.length > maxDescriptionLength) {
    return { text: sentence.slice(0, maxDescriptionLength), source, confidence, truncated: true, sourcePath }
  }
  return { text: sentence, source, confidence, sourcePath }
}

/** Split a markdown document into its frontmatter fields and body. */
function frontmatter(content: string): { fields: Map<string, string>; body: string } {
  const fields = new Map<string, string>()
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { fields, body: content }
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const separator = line.indexOf(":")
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "")
    if (key.length > 0) fields.set(key, value)
  }
  return { fields, body: content.slice(match[0].length) }
}

function firstParagraph(body: string): string | null {
  const lines: string[] = []
  let started = false
  for (const line of body.split("\n")) {
    const trimmed = line.trim()
    if (/^#{1,6}\s/.test(trimmed)) continue
    if (trimmed.length === 0) {
      if (started) break
      continue
    }
    if (/^---+$/.test(trimmed) || /^[\w-]+:\s/.test(trimmed)) continue
    started = true
    lines.push(trimmed)
  }
  return lines.length > 0 ? lines.join(" ") : null
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
 * Directory description, in the older owner's order: AGENTS.md frontmatter,
 * AGENTS.md first paragraph, README.md first paragraph, package.json
 * description. Unreadable or malformed files simply fall through.
 */
export function describeDirectory(
  directory: string,
  agentsFile: string | undefined,
  agentsLabel: string | undefined,
  baseLabel: string,
): Description | null {
  const agentsPath = agentsFile ?? join(directory, "AGENTS.md")
  const agentsSource = agentsLabel ?? "AGENTS.md"
  const agents = readText(agentsPath)
  if (agents !== null) {
    const parsed = frontmatter(agents)
    const description = parsed.fields.get("description")
    if (description !== undefined && description.length > 0) {
      return normalize(description, "agents.frontmatter.description", "high", agentsSource)
    }
    const paragraph = firstParagraph(parsed.body)
    if (paragraph !== null) return normalize(paragraph, "agents.first_paragraph", "high", agentsSource)
  }

  const readme = readText(join(directory, "README.md"))
  if (readme !== null) {
    const paragraph = firstParagraph(frontmatter(readme).body)
    if (paragraph !== null) {
      return normalize(paragraph, "readme.first_paragraph", "medium", baseLabel + "/README.md")
    }
  }

  const pkg = readText(join(directory, "package.json"))
  if (pkg !== null) {
    try {
      const parsed: unknown = JSON.parse(pkg)
      const description =
        parsed !== null && typeof parsed === "object" && "description" in parsed ? parsed.description : undefined
      if (typeof description === "string" && description.length > 0) {
        return normalize(description, "package.metadata.description", "medium", baseLabel + "/package.json")
      }
    } catch {
      // A malformed package.json contributes no description.
    }
  }

  return null
}
