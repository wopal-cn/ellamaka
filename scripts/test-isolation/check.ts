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

const BASELINE_PATH = ".ci/test-isolation-baseline.json"
const SCAN_ROOTS = ["packages"]
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".artifacts", "coverage", "e2e", "build"])

type Baseline = {
  version: number
  entries: Array<{ rule: RuleId; file: string; detail: string }>
}

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

async function main() {
  const root = path.resolve(import.meta.dir, "..", "..")
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
    violations.push(...scanSource(file, source, { root, relative: (value) => value }))
  }

  const baseline = await readBaseline(root)
  const known = new Set(baseline.entries.map((entry) => entry.rule + "|" + entry.file + "|" + entry.detail))
  const current = new Set(violations.map(violationKey))

  const fresh = violations.filter((violation) => !known.has(violationKey(violation)))
  const stale = baseline.entries.filter((entry) => !current.has(entry.rule + "|" + entry.file + "|" + entry.detail))

  if (fix) {
    const next: Baseline = {
      version: baseline.version,
      entries: violations.map((violation) => ({
        rule: violation.rule,
        file: violation.file,
        detail: violation.detail,
      })),
    }
    await writeBaseline(root, next)
    process.stdout.write("baseline rewritten: " + next.entries.length + " entries\n")
    return
  }

  let failed = false

  if (fresh.length > 0) {
    failed = true
    process.stdout.write("\nNEW test isolation violations (" + fresh.length + "):\n")
    for (const violation of fresh) {
      const rule = RULES[violation.rule]
      process.stdout.write("\n  " + violation.rule + "  " + violation.file + ":" + violation.line + "\n")
      process.stdout.write("    " + rule.title + "\n")
      process.stdout.write("    " + rule.message + "\n")
    }
  }

  if (stale.length > 0) {
    failed = true
    process.stdout.write("\nSTALE baseline entries (" + stale.length + "):\n")
    for (const entry of stale) {
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
      (violations.length - fresh.length) +
      " baselined, " +
      fresh.length +
      " new, " +
      stale.length +
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
