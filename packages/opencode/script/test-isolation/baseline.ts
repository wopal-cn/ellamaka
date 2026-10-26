/**
 * Baseline bookkeeping for the test isolation gate.
 *
 * A violation is identified by rule, file and target, plus how many times it
 * occurs. The count matters: without it a second identical violation in the
 * same file would match the single recorded entry and go unnoticed.
 */

import type { RuleId } from "./rules"

export type { RuleId }

export type BaselineEntry = {
  rule: RuleId
  file: string
  detail: string
  count: number
}

export type Baseline = {
  version: number
  entries: BaselineEntry[]
}

export const KEY_SEPARATOR = "|"

export function entryKey(entry: { rule: string; file: string; detail: string }) {
  return entry.rule + KEY_SEPARATOR + entry.file + KEY_SEPARATOR + entry.detail
}

export function splitEntryKey(key: string) {
  const parts = key.split(KEY_SEPARATOR)
  return {
    rule: parts[0] ?? "",
    file: parts[1] ?? "",
    detail: parts.slice(2).join(KEY_SEPARATOR),
  }
}

export type Comparison = {
  /** Violations that the baseline does not cover. */
  fresh: string[]
  /** Baseline entries that no longer match any source violation. */
  stale: BaselineEntry[]
  /** The number of violations the baseline still covers. */
  baselined: number
}

/**
 * Compare the current violations against the baseline.
 *
 * The baseline may only shrink: a new violation has to be fixed, and a fixed
 * violation has to be removed from the baseline. This function only reports;
 * it never edits the baseline.
 */
export function compareBaseline(baseline: Baseline, violations: string[]): Comparison {
  const current = new Map<string, number>()
  for (const violation of violations) current.set(violation, (current.get(violation) ?? 0) + 1)

  // Several entries may share one key (an older baseline listed each occurrence
  // separately), so the allowance is the sum of their counts.
  const allowed = new Map<string, number>()
  for (const entry of baseline.entries) {
    const key = entryKey(entry)
    allowed.set(key, (allowed.get(key) ?? 0) + (entry.count ?? 1))
  }

  const fresh: string[] = []
  for (const [key, count] of current) {
    const covered = allowed.get(key) ?? 0
    for (let index = covered; index < count; index += 1) fresh.push(key)
    allowed.set(key, Math.max(0, covered - count))
  }

  // An entry is stale only when its target disappeared completely. A file that
  // still has one of five recorded violations is not stale: shrinking further
  // is a separate step, not a gate failure.
  const stale = baseline.entries.filter((entry) => (current.get(entryKey(entry)) ?? 0) === 0)

  return { fresh, stale, baselined: violations.length - fresh.length }
}

/** The total number of violations a baseline records. */
export function baselineSize(baseline: Baseline) {
  return baseline.entries.reduce((sum, entry) => sum + (entry.count ?? 1), 0)
}
