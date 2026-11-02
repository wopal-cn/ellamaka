import { parseYaml } from "./structured-text"

/**
 * Comment-preserving manifest edits.
 *
 * The Space archetype manifest is user-visible YAML: a capability change
 * must not reformat it or drop comments. These helpers edit one named
 * block in place — a block-style list is changed line by line, and a
 * flow-style value is rewritten on its own line. Everything outside the
 * edited block is left byte for byte.
 */

interface Line {
  readonly text: string
  readonly indent: number
  readonly content: string
}

function lines(raw: string): Line[] {
  return raw.split("\n").map((text) => {
    const indent = text.length - text.trimStart().length
    return { text, indent, content: text.trim() }
  })
}

function isIgnorable(line: Line): boolean {
  return line.content.length === 0 || line.content.startsWith("#")
}

/** Locate the block a top-level key owns: [headerIndex, endIndex). */
function findBlock(all: readonly Line[], key: string): { header: number; end: number } | null {
  for (let index = 0; index < all.length; index += 1) {
    const line = all[index]
    if (line === undefined || line.indent !== 0) continue
    if (!line.content.startsWith(key + ":")) continue
    let end = index + 1
    while (end < all.length) {
      const next = all[end]
      if (next === undefined) break
      if (!isIgnorable(next) && next.indent === 0) break
      end += 1
    }
    return { header: index, end }
  }
  return null
}

/** Locate a nested block inside [start, end) at one deeper indent level. */
function findNested(
  all: readonly Line[],
  start: number,
  end: number,
  key: string,
): { header: number; end: number; indent: number } | null {
  let indent: number | null = null
  for (let index = start; index < end; index += 1) {
    const line = all[index]
    if (line === undefined || isIgnorable(line)) continue
    if (indent === null) indent = line.indent
    if (line.indent !== indent) continue
    if (!line.content.startsWith(key + ":")) continue
    let nestedEnd = index + 1
    while (nestedEnd < end) {
      const next = all[nestedEnd]
      if (next === undefined) break
      if (!isIgnorable(next) && next.indent <= indent) break
      nestedEnd += 1
    }
    return { header: index, end: nestedEnd, indent }
  }
  return null
}

/** The literal entries of a block-style list, with their line indexes. */
function listEntries(all: readonly Line[], block: { header: number; end: number; indent: number }) {
  const entries: { value: string; index: number }[] = []
  for (let index = block.header + 1; index < block.end; index += 1) {
    const line = all[index]
    if (line === undefined || isIgnorable(line) || line.indent <= block.indent) continue
    if (!line.content.startsWith("- ")) continue
    const value = line.content
      .slice(2)
      .trim()
      .replace(/^["']|["']$/g, "")
    entries.push({ value, index })
  }
  return entries
}

/** Rewrite a flow-style value list on its header line. */
function rewriteFlow(header: string, key: string, values: readonly string[]): string {
  const indent = header.length - header.trimStart().length
  const rendered = values.length === 0 ? "[]" : "[" + values.map((value) => quote(value)).join(", ") + "]"
  return `${" ".repeat(indent)}${key}: ${rendered}`
}

function quote(value: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(value) ? value : JSON.stringify(value)
}

function flowValues(header: string, key: string): string[] | null {
  const match = header.match(new RegExp("^\\s*" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":\\s*\\[(.*)]\\s*$"))
  if (match === null) return null
  const body = (match[1] ?? "").trim()
  if (body.length === 0) return []
  return body
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter((entry) => entry.length > 0)
}

/**
 * Add or remove one name in a manifest's flat list key.
 * Returns the new document; an unchanged name is a no-op.
 */
export function editManifestList(raw: string, key: string, name: string, operation: "add" | "remove"): string {
  const all = lines(raw)
  const block = findBlock(all, key)
  if (block === null) {
    if (operation === "remove") return raw
    const header = [key + ":", "  - " + quote(name)].join("\n")
    return raw.replace(/\n?$/, "\n") + header + "\n"
  }

  const headerLine = all[block.header]
  if (headerLine === undefined) return raw
  const flow = flowValues(headerLine.text, key)
  if (flow !== null) {
    const next = operation === "add" ? [...new Set([...flow, name])] : flow.filter((entry) => entry !== name)
    if (next.length === flow.length && operation === "add") return raw
    const replaced = [...all]
    replaced[block.header] = {
      text: rewriteFlow(headerLine.text, key, next),
      indent: headerLine.indent,
      content: key + ": " + next.length,
    }
    return replaced.map((line) => line.text).join("\n")
  }

  const entries = listEntries(all, { header: block.header, end: block.end, indent: headerLine.indent })
  const present = entries.some((entry) => entry.value === name)
  if (present) {
    if (operation === "add") return raw
    const removed = entries.filter((entry) => entry.value === name)
    const drop = new Set(removed.map((entry) => entry.index))
    // An empty list block reads back as null, which the manifest parser
    // refuses: drop the header with its last entry.
    if (removed.length === entries.length) drop.add(block.header)
    return all
      .filter((_, index) => !drop.has(index))
      .map((line) => line.text)
      .join("\n")
  }
  if (operation === "remove") return raw
  const insertAt = entries.length > 0 ? (entries[entries.length - 1]?.index ?? block.header) + 1 : block.header + 1
  const itemIndent = entries.length > 0 ? (all[insertAt - 1]?.indent ?? headerLine.indent + 2) : headerLine.indent + 2
  const inserted = " ".repeat(itemIndent) + "- " + quote(name)
  const next = [...all]
  next.splice(insertAt, 0, { text: inserted, indent: itemIndent, content: "- " + name })
  return next.map((line) => line.text).join("\n")
}

/**
 * Add or remove one name under plugins.<section>, creating the section
 * when it does not exist yet.
 */
export function editManifestPlugin(raw: string, section: string, name: string, operation: "add" | "remove"): string {
  const all = lines(raw)
  const plugins = findBlock(all, "plugins")
  if (plugins === null) {
    if (operation === "remove") return raw
    const block = ["plugins:", "  " + section + ":", "    - " + quote(name)].join("\n")
    return raw.replace(/\n?$/, "\n") + block + "\n"
  }

  const nested = findNested(all, plugins.header + 1, plugins.end, section)
  if (nested === null) {
    if (operation === "remove") return raw
    const next = [...all]
    const insertion = ["  " + section + ":", "    - " + quote(name)].join("\n")
    next.splice(plugins.header + 1, 0, {
      text: insertion,
      indent: 2,
      content: section + ":",
    })
    return next.map((line) => line.text).join("\n")
  }

  const headerLine = all[nested.header]
  if (headerLine === undefined) return raw
  const flow = flowValues(headerLine.text, section)
  if (flow !== null) {
    const next = operation === "add" ? [...new Set([...flow, name])] : flow.filter((entry) => entry !== name)
    if (next.length === flow.length && operation === "add") return raw
    const replaced = [...all]
    if (next.length === 0) {
      return replaced
        .filter((_, index) => index !== nested.header)
        .map((line) => line.text)
        .join("\n")
    }
    replaced[nested.header] = {
      text: rewriteFlow(headerLine.text, section, next),
      indent: headerLine.indent,
      content: section + ": " + next.length,
    }
    return replaced.map((line) => line.text).join("\n")
  }

  const entries = listEntries(all, { header: nested.header, end: nested.end, indent: nested.indent })
  const present = entries.some((entry) => entry.value === name)
  if (present) {
    if (operation === "add") return raw
    const removed = entries.filter((entry) => entry.value === name)
    const drop = new Set(removed.map((entry) => entry.index))
    if (removed.length === entries.length) {
      // An empty section reads back as null, so drop the section header; an
      // empty plugins map is null too, so drop that when it is the last one.
      drop.add(nested.header)
      const remainingSections = all.filter(
        (line, index) =>
          index > plugins.header &&
          index < plugins.end &&
          !drop.has(index) &&
          !isIgnorable(line) &&
          line.indent === nested.indent &&
          !line.content.startsWith("- "),
      )
      if (remainingSections.length === 0) drop.add(plugins.header)
    }
    return all
      .filter((_, index) => !drop.has(index))
      .map((line) => line.text)
      .join("\n")
  }
  if (operation === "remove") return raw
  const insertAt = entries.length > 0 ? (entries[entries.length - 1]?.index ?? nested.header) + 1 : nested.header + 1
  const itemIndent = entries.length > 0 ? (all[insertAt - 1]?.indent ?? nested.indent + 2) : nested.indent + 2
  const next = [...all]
  next.splice(insertAt, 0, {
    text: " ".repeat(itemIndent) + "- " + quote(name),
    indent: itemIndent,
    content: "- " + name,
  })
  return next.map((line) => line.text).join("\n")
}

/**
 * Verify one edit before it is committed.
 *
 * The editor is deliberately narrow: it understands the controlled
 * manifest shape (block and flow name lists, plugins section map). This
 * guard reparses both documents and refuses the edit unless the whole
 * semantic change is exactly the intended one and every comment line
 * survives, so an unfamiliar shape is rejected instead of rewritten.
 */
export function verifyManifestEdit(
  before: string,
  after: string,
  expected: (previous: Record<string, unknown>, next: Record<string, unknown>) => boolean,
): string | null {
  const previous = parseMap(before)
  if (previous === null) return "the current manifest is not a readable YAML map"
  const next = parseMap(after)
  if (next === null) return "the edited manifest would not be a readable YAML map"
  if (!expected(previous, next)) return "the edit would change more than the intended reference"
  const beforeComments = commentLines(before)
  const afterComments = commentLines(after)
  if (beforeComments.length !== afterComments.length) return "the edit would drop comments"
  for (let index = 0; index < beforeComments.length; index += 1) {
    if (beforeComments[index] !== afterComments[index]) return "the edit would reorder or rewrite comments"
  }
  return null
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parseMap(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = parseYaml(raw)
    return isPlainMap(parsed) ? parsed : null
  } catch {
    return null
  }
}

function commentLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("#"))
}

/** Normalized view of a manifest field, for edit verification. */
export function fieldOf(manifest: Record<string, unknown>, key: string): unknown {
  const value = manifest[key]
  return value === undefined || value === null ? [] : value
}

/** Do two manifests agree on every field except the edited one? */
export function onlyFieldChanged(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  key: string,
): boolean {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
  for (const candidate of keys) {
    if (candidate === key) continue
    if (JSON.stringify(previous[candidate] ?? null) !== JSON.stringify(next[candidate] ?? null)) return false
  }
  return true
}
