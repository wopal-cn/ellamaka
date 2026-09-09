import { readFileSync, writeFileSync } from "node:fs"
import { parseDocument, type Document } from "yaml"

/**
 * User patch layer (`cordis.patch.yml`) write library (Plan Task 7).
 *
 * Implements the CLI's enable/disable surface with the SAME semantics as the
 * official dshmarket `src/patch.ts` (lab reference):
 *
 * - `disableRow`: append a `- id: X` + `  disabled: true` row (idempotent).
 * - `enableRow`: remove the disabled row; when a lower layer (bundle/home
 *   patch) holds the row down, force-enable it with `disabled: false`.
 * - `readUserPatchState`: scan the disables / forced / inserts the layer
 *   declares.
 *
 * All reads and writes go through the `yaml` parser's document model
 * (`parseDocument`), which preserves comments and formatting across a
 * round-trip — hand-rolled line scans cannot see the difference between a
 * `[]` placeholder inside a comment block and a real empty document, and
 * appending after a trailing comment once produced a two-document file the
 * composition layer rejects. The parser is the single source of structural
 * truth; the queued writer below only serialises concurrent processes.
 */

/** The patch state one file declares. */
export interface PatchState {
  /** Row ids the user patch disables (`disabled: true`). */
  disables: string[]
  /** Row ids the user patch force-enables (`disabled: false`). */
  forced: string[]
  /** Row ids the user patch inserts (from `- insert:` blocks). */
  inserts: string[]
}

/** Row ids allowed to be written: plain unquoted YAML scalars. */
const ROW_ID_RE = /^[A-Za-z0-9_.-]+$/u

/** One queued write chain per process (CLI usage is one file per run). */
let writeChain: Promise<unknown> = Promise.resolve()

/**
 * Serialize `fn` through the process-wide write chain: every queued write
 * observes the file state left by the previous one (official queuedWrite
 * semantics).
 */
export function queuedWrite<T>(fn: () => Promise<T>): Promise<T> {
  const task = writeChain.then(fn, fn)
  writeChain = task.catch(() => undefined)
  return task
}

/** Parse one patch file's text into a YAML document (`undefined` on read failure). */
function parsePatchDocument(patchPath: string): Document | undefined {
  let text: string
  try {
    text = readFileSync(patchPath, "utf8")
  } catch {
    return undefined
  }
  return parseDocument(text)
}

/** The block-style row node the disable/enable rows are written as. */
function rowNode(document: Document, rowId: string, disabled: boolean) {
  return document.createNode({ id: rowId, disabled })
}

/**
 * The append target as a BLOCK sequence. A parsed `[]` placeholder (or a
 * fresh empty document) is a flow sequence — appending rows to it would
 * stringify as `[ { id: X, ... } ]`, but the patch layer is a human-edited
 * dialect written in block form (`- id: X` + `  disabled: true`). Rebuild
 * the contents as a block sequence so every written row lands in that form.
 */
function appendTarget(document: Document): { items: unknown[] } {
  const body = document.contents as { items?: unknown[]; flow?: boolean } | null
  if (body !== null && body !== undefined && Array.isArray(body.items)) {
    // A NON-EMPTY flow sequence stays flow (it was written that way by hand);
    // an EMPTY sequence is the `[]` placeholder and must become block before
    // the first row lands in it.
    if (!(body.flow === true && body.items.length === 0)) return body as { items: unknown[] }
  }
  const node = document.createNode([]) as unknown as { items: unknown[] }
  document.contents = node as never
  return node
}

/** The parsed row shapes the patch-layer functions read and write. */
interface ParsedRow {
  id?: string
  disabled?: boolean
  insertIds?: string[]
}

/** Read a mapping Pair's value as a plain string (`key.value`/`value.value` Pair model). */
function pairScalar(pair: unknown, key: string): string | boolean | undefined {
  const p = pair as { key?: { value?: unknown }; value?: { value?: unknown } }
  if (p?.key?.value !== key) return undefined
  const v = p?.value?.value
  if (typeof v === "string" || typeof v === "boolean") return v
  return undefined
}

/**
 * The top-level rows of a patch document (`undefined` when the body is not
 * a top-level sequence). Each item is a mapping of `id`/`disabled` pairs or
 * an `insert:` block whose items carry row ids.
 */
function topRows(document: Document): ParsedRow[] | undefined {
  const body = document.contents as { items?: unknown[] } | null | undefined
  if (body === null || body === undefined) return []
  if (!Array.isArray(body.items)) return undefined
  const rows: ParsedRow[] = []
  for (const item of body.items) {
    const pairs = (item as { items?: unknown[] }).items
    if (!Array.isArray(pairs)) {
      rows.push({})
      continue
    }
    const row: ParsedRow = {}
    for (const pair of pairs) {
      const id = pairScalar(pair, "id")
      if (typeof id === "string") row.id = id
      const disabled = pairScalar(pair, "disabled")
      if (typeof disabled === "boolean") row.disabled = disabled
      const insertKey = (pair as { key?: { value?: unknown } }).key?.value
      if (insertKey === "insert") {
        const insertSeq = (pair as { value?: { items?: unknown[] } }).value?.items
        if (Array.isArray(insertSeq)) {
          row.insertIds = []
          for (const entry of insertSeq) {
            const entryPairs = (entry as { items?: unknown[] }).items
            if (!Array.isArray(entryPairs)) continue
            for (const entryPair of entryPairs) {
              const entryId = pairScalar(entryPair, "id")
              if (typeof entryId === "string") row.insertIds.push(entryId)
            }
          }
        }
      }
    }
    rows.push(row)
  }
  return rows
}

/**
 * Scan one patch file's declared state. A missing file — or a file that is
 * not a top-level sequence — is the ordinary empty state: the composition
 * layer owns that rejection, this scan only reports what a valid document
 * declares.
 */
export function readUserPatchState(patchPath: string): PatchState {
  const document = parsePatchDocument(patchPath)
  const rows = document ? topRows(document) : []
  if (rows === undefined) return { disables: [], forced: [], inserts: [] }
  const disables: string[] = []
  const forced: string[] = []
  const inserts: string[] = []
  for (const row of rows) {
    if (row.insertIds) {
      inserts.push(...row.insertIds)
      continue
    }
    if (row.id === undefined) continue
    if (row.disabled === true) disables.push(row.id)
    else if (row.disabled === false) forced.push(row.id)
  }
  return { disables, forced, inserts }
}

/**
 * Disable one row: append `- id: X` + `disabled: true` (idempotent). The
 * document round-trips, so existing comments and formatting survive.
 */
export function disableRow(patchPath: string, rowId: string): Promise<{ ok: boolean; reason: string | null }> {
  return queuedWrite(async () => {
    if (!ROW_ID_RE.test(rowId)) {
      return { ok: false, reason: `行 id 含特殊字符,不支持写入补丁层 / row id ${JSON.stringify(rowId)} cannot be written to the patch layer` }
    }
    const document = parsePatchDocument(patchPath) ?? parseDocument("")
    const rows = topRows(document)
    if (rows === undefined) {
      return { ok: false, reason: "补丁层不是合法的条目数组,已拒绝修改以免破坏 / the patch layer is not a valid entry list; refused to modify" }
    }
    if (rows.some((row) => row.id === rowId && row.disabled === true)) {
      return { ok: true, reason: null } // already disabled — idempotent no-op
    }
    const existing = rows.find((row) => row.id === rowId && row.disabled === false)
    if (existing !== undefined) {
      return { ok: false, reason: `行 ${rowId} 被显式 force-enable,请手工处理 / row ${rowId} is force-enabled; resolve it by hand` }
    }
    const disabled = rowNode(document, rowId, true)
    const seq = appendTarget(document)
    seq.items.push(disabled)
    writeFileSync(patchPath, String(document))
    return { ok: true, reason: null }
  })
}

/**
 * Enable one row: remove the `disabled: true` row; when the row is absent
 * from the layer, write `disabled: false` (force-enable) so a lower layer
 * (bundle/home patch) cannot keep the row down (official patch.ts
 * enableRow semantics).
 */
export function enableRow(patchPath: string, rowId: string): Promise<{ ok: boolean; reason: string | null }> {
  return queuedWrite(async () => {
    if (!ROW_ID_RE.test(rowId)) {
      return { ok: false, reason: `行 id 含特殊字符,不支持写入补丁层 / row id ${JSON.stringify(rowId)} cannot be written to the patch layer` }
    }
    const document = parsePatchDocument(patchPath) ?? parseDocument("")
    const rows = topRows(document)
    if (rows === undefined) {
      return { ok: false, reason: "补丁层不是合法的条目数组,已拒绝修改以免破坏 / the patch layer is not a valid entry list; refused to modify" }
    }
    const index = rows.findIndex((row) => row.id === rowId && row.disabled === true)
    const seq = appendTarget(document)
    if (index !== -1) {
      seq.items.splice(index, 1)
    } else if (!rows.some((row) => row.id === rowId && row.disabled === false)) {
      // No disable row and no force-enable row: write the force-enable.
      seq.items.push(rowNode(document, rowId, false))
    } else {
      return { ok: true, reason: null } // already force-enabled — idempotent no-op
    }
    // Removing the LAST row must leave a valid top-level array, not an
    // empty document (an invalid layer bricks the profile boot).
    if (seq.items.length === 0) document.contents = document.createNode([])
    writeFileSync(patchPath, String(document))
    return { ok: true, reason: null }
  })
}
