#!/usr/bin/env bun
/**
 * Test isolation gate.
 *
 * Usage:
 *   bun run check:test-isolation          # fail on any violation outside the baseline
 *   bun run check:test-isolation -- --fix # rewrite the baseline from the current source
 *
 * The baseline is an exact debt list. A new violation fails the gate, and a
 * fixed violation fails too, because the stale baseline entry has to be
 * removed. The baseline may only shrink.
 */

import { readdir, readFile, writeFile, stat } from "node:fs/promises"
import path from "node:path"
import { RULES, type RuleId } from "./rules"
import { scanSource, violationKey, type Violation } from "./scan"
import { baselineSize, compareBaseline, entryKey, type Baseline } from "./baseline"

const BASELINE_PATH = ".ci/test-isolation-baseline.json"
const SCAN_ROOTS = ["packages", "scripts"]
const NL = "\n"
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".artifacts", "coverage", "e2e", "build"])

async function collectTestFiles(root: string, current: string, out: string[] = []) {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const absolute = path.join(current, entry.name)
    if (entry.isDirectory()) {
      await collectTestFiles(root, absolute, out)
      continue
    }
    if (!entry.isFile()) continue
    if (!/\.test\.(?:ts|tsx)$/.test(entry.name)) continue
    out.push(path.relative(root, absolute).split(path.sep).join("/"))
  }
  return out
}

async function readBaseline(root: string): Promise<Baseline> {
  const file = path.join(root, BASELINE_PATH)
  const content = await readFile(file, "utf8").catch(() => undefined)
  if (!content) return { version: 1, entries: [] }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- The baseline file is written by this script and validated below.
  return JSON.parse(content) as Baseline
}

async function writeBaseline(root: string, baseline: Baseline) {
  const file = path.join(root, BASELINE_PATH)
  await stat(path.dirname(file)).catch(async () => {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(path.dirname(file), { recursive: true })
  })
  const sorted = {
    version: baseline.version,
    entries: [...baseline.entries].sort((a, b) =>
      (a.rule + a.file + a.detail).localeCompare(b.rule + b.file + b.detail),
    ),
  }
  await writeFile(file, JSON.stringify(sorted, null, 2) + "\n")
}

/** Rebuild the baseline from the current violations, keeping one entry per target. */
function rebuildBaseline(baseline: Baseline, violations: Violation[]): Baseline {
  const counts = new Map<string, { rule: RuleId; file: string; detail: string; count: number }>()
  for (const violation of violations) {
    const record = { rule: violation.rule, file: violation.file, detail: violation.detail }
    const key = entryKey(record)
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
      continue
    }
    counts.set(key, { ...record, count: 1 })
  }
  return { version: baseline.version, entries: [...counts.values()] }
}

async function main() {
  const root = path.resolve(import.meta.dir, "..", "..", "..", "..")
  const fix = process.argv.includes("--fix")
  const files: string[] = []
  for (const scanRoot of SCAN_ROOTS) {
    const absolute = path.join(root, scanRoot)
    const exists = await stat(absolute).catch(() => undefined)
    if (!exists) continue
    await collectTestFiles(root, absolute, files)
  }
  files.sort()

  const violations: Violation[] = []
  for (const file of files) {
    const source = await readFile(path.join(root, file), "utf8")
    violations.push(...scanSource(file, source, { root }))
  }

  const baseline = await readBaseline(root)
  const comparison = compareBaseline(
    baseline,
    violations.map((violation) => violationKey(violation)),
  )
  const fresh = comparison.fresh
  const freshViolations = violations.filter((violation) => fresh.includes(violationKey(violation)))

  if (fix) {
    const next = rebuildBaseline(baseline, violations)
    const before = baselineSize(baseline)
    const after = baselineSize(next)
    if (comparison.fresh.length > 0) {
      process.stdout.write("refusing to grow the baseline: " + before + " -> " + after + " violations" + NL)
      process.stdout.write("the baseline may only shrink; fix the new violations instead of recording them." + NL)
      process.exit(1)
    }
    await writeBaseline(root, next)
    process.stdout.write("baseline rewritten: " + next.entries.length + " entries, " + after + " violations" + NL)
    return
  }

  let failed = false

  if (fresh.length > 0) {
    failed = true
    process.stdout.write("\nNEW test isolation violations (" + fresh.length + "):\n")
    for (const violation of freshViolations) {
      const rule = RULES[violation.rule]
      process.stdout.write("\n  " + violation.rule + "  " + violation.file + ":" + violation.line + "\n")
      process.stdout.write("    " + rule.title + "\n")
      process.stdout.write("    " + rule.message + "\n")
    }
  }

  if (comparison.stale.length > 0) {
    failed = true
    process.stdout.write("\nSTALE baseline entries (" + comparison.stale.length + "):\n")
    for (const entry of comparison.stale) {
      const rule = RULES[entry.rule]
      process.stdout.write("\n  " + entry.rule + "  " + entry.file + "\n")
      process.stdout.write("    " + rule.title + "\n")
      process.stdout.write("    " + RULES.TISO007.message + "\n")
    }
  }

  process.stdout.write(
    "\ntest isolation: " +
      files.length +
      " test files, " +
      violations.length +
      " violations (" +
      comparison.baselined +
      " baselined, " +
      freshViolations.length +
      " new, " +
      comparison.stale.length +
      " stale)\n",
  )

  if (failed) {
    process.stdout.write(
      "\nfix the violations, or run 'bun run check:test-isolation -- --fix' after reviewing each one.\n",
    )
    process.exit(1)
  }
  process.stdout.write("all test isolation rules satisfied\n")
}

await main()
