#!/usr/bin/env bun
/**
 * Lint gate: keeps the oxlint diagnostics on a baseline that may only shrink.
 *
 * Usage:
 *   bun run lint                  # fail on a new key, a grown count, or a stale entry
 *   bun run lint:fix              # shrink the baseline to the current diagnostics
 *   bun run lint:files <file>...  # judge only these files; never writes the baseline
 *
 * The baseline is an exact debt ledger keyed by "file + rule + message" with a
 * count per key. A new key fails, a higher count fails, and a lower count (or a
 * vanished key) fails too: a fixed diagnostic has to leave the baseline in the
 * same change, otherwise the retired allowance silently pays for the next
 * regression with the same key.
 *
 * Precision boundary (accepted, not solved): because the ledger aggregates by
 * key, removing one occurrence while adding another occurrence of the same key
 * in one run nets to zero. The contract is therefore "no new keys, no per-key
 * growth, no retired allowance", not "every new diagnostic is caught".
 *
 * Scope: every entry point runs oxlint with the same rule set, the same
 * `--report-unused-disable-directives` flag, and the same key normalization.
 * Diagnostics without a `code` (unused disable directives are the real case)
 * enter the key under a fixed placeholder so they cannot overwrite each other.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

export const BASELINE_PATH = ".ci/oxlint-baseline.json"
export const BASELINE_VERSION = 1
const EMPTY_BASELINE: Baseline = { version: BASELINE_VERSION, generatedWith: { oxlint: "unknown" }, entries: [] }
/** Key segment for diagnostics oxlint reports without a rule code. */
export const NO_CODE = "(no-code)"
/** The file extensions every entry point hands to oxlint, taken from `git ls-files`. */
export const LINT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]

const USAGE = [
  "usage:",
  "  bun run lint                  # check the current diagnostics against the baseline",
  "  bun run lint:fix              # shrink the baseline; refuses to grow it",
  "  bun run lint:init             # record the first baseline on a repository that has none",
  "  bun run lint:files <file>...  # judge only these files; never writes the baseline",
].join("\n")

/** One diagnostic as it appears in `oxlint --format json`. */
export type RawDiagnostic = {
  filename: string
  code?: string
  message: string
}

/** One aggregated baseline key. */
export type CountedDiagnostic = {
  file: string
  rule: string
  message: string
  count: number
}

export type BaselineEntry = CountedDiagnostic

export type Baseline = {
  version: number
  generatedWith: { oxlint: string }
  entries: BaselineEntry[]
}

/** One compared key, carrying both the recorded and the current count. */
export type ComparisonRow = {
  file: string
  rule: string
  message: string
  baseline: number
  current: number
}

export type Comparison = {
  /** Keys the baseline does not cover at all. */
  added: ComparisonRow[]
  /** Keys whose current count is above the recorded one. */
  grown: ComparisonRow[]
  /** Keys whose current count is below the recorded one (zero means vanished). */
  stale: ComparisonRow[]
  /** Total diagnostics currently reported inside the compared scope. */
  total: number
  /** Diagnostics currently covered by the baseline. */
  baselined: number
}

export type GateMode = "check" | "fix" | "files" | "init"

export type ParsedArgs =
  | { ok: true; mode: GateMode; files: string[] }
  | { ok: false; error: string }

/**
 * A key is the triple the ledger aggregates on. JSON encoding keeps the three
 * parts unambiguous even when a message contains the separator characters.
 */
export function entryKey(row: Pick<CountedDiagnostic, "file" | "rule" | "message">) {
  return JSON.stringify([row.file, row.rule, row.message])
}

/** Collapse formatting noise so the same diagnostic always produces the same key. */
export function normalizeMessage(message: string) {
  return message.replace(/\s+/g, " ").trim()
}

/**
 * Repository-relative POSIX path for a diagnostic filename or a file argument.
 *
 * Accepts absolute paths, `./` prefixes and platform separators. Returns
 * undefined for a path outside the repository root; such a file is never
 * compared.
 */
export function relativeFile(root: string, file: string) {
  const absolute = path.resolve(root, file)
  const relative = path.relative(root, absolute)
  // Only a real parent segment escapes the repository. A tracked file may
  // legitimately start with two dots (`..new.ts`), so matching the bare ".."
  // prefix would drop files that belong to the lint scope.
  const escape = ".." + path.sep
  if (relative === "" || relative === ".." || relative.startsWith(escape) || path.isAbsolute(relative)) return undefined
  return relative.split(path.sep).join("/")
}

/** The rule key for a diagnostic; diagnostics without a code share one placeholder. */
export function ruleOf(diagnostic: RawDiagnostic) {
  return typeof diagnostic.code === "string" && diagnostic.code.length > 0 ? diagnostic.code : NO_CODE
}

function compareText(left: string, right: string) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

type OrderedRow = { file: string; rule: string; message: string }

function compareRows(left: OrderedRow, right: OrderedRow) {
  return (
    compareText(left.file, right.file) || compareText(left.rule, right.rule) || compareText(left.message, right.message)
  )
}

function sortedEntries<T extends OrderedRow>(entries: T[]): T[] {
  return [...entries].sort(compareRows)
}

/**
 * Aggregate raw diagnostics into one row per key.
 *
 * `scope` limits the result to the given repository-relative files; it is how
 * selected-file mode keeps unselected files out of the comparison.
 */
export function aggregateDiagnostics(root: string, diagnostics: RawDiagnostic[], scope?: ReadonlySet<string>) {
  const counts = new Map<string, CountedDiagnostic>()
  for (const diagnostic of diagnostics) {
    const file = relativeFile(root, diagnostic.filename)
    if (!file) continue
    if (scope && !scope.has(file)) continue
    const row = { file, rule: ruleOf(diagnostic), message: normalizeMessage(diagnostic.message) }
    const key = entryKey(row)
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
      continue
    }
    counts.set(key, { ...row, count: 1 })
  }
  return sortedEntries([...counts.values()])
}

/**
 * Compare the current diagnostics with the baseline.
 *
 * The baseline may only shrink: a new key has to be fixed, a grown key has to
 * be fixed, and a shrunk or vanished key has to leave the ledger via `lint:fix`.
 * This function only reports; it never edits the baseline. When `scope` is
 * given, baseline entries for files outside it neither provide an allowance nor
 * turn into stale rows.
 */
export function compareBaseline(
  baseline: Baseline,
  current: CountedDiagnostic[],
  scope?: ReadonlySet<string>,
): Comparison {
  const allowed = new Map<string, ComparisonRow>()
  for (const entry of baseline.entries) {
    if (scope && !scope.has(entry.file)) continue
    const key = entryKey(entry)
    const existing = allowed.get(key)
    if (existing) {
      existing.baseline += entry.count
      continue
    }
    allowed.set(key, { file: entry.file, rule: entry.rule, message: entry.message, baseline: entry.count, current: 0 })
  }

  const counted = new Map<string, CountedDiagnostic>()
  for (const row of current) {
    if (scope && !scope.has(row.file)) continue
    const key = entryKey(row)
    const existing = counted.get(key)
    if (existing) {
      existing.count += row.count
      continue
    }
    counted.set(key, { ...row })
  }

  const added: ComparisonRow[] = []
  const grown: ComparisonRow[] = []
  const stale: ComparisonRow[] = []
  let total = 0
  let baselined = 0

  for (const [key, row] of counted) {
    const recorded = allowed.get(key)?.baseline ?? 0
    const comparison = { file: row.file, rule: row.rule, message: row.message, baseline: recorded, current: row.count }
    total += row.count
    baselined += Math.min(recorded, row.count)
    if (recorded === 0) {
      added.push(comparison)
      continue
    }
    if (row.count > recorded) {
      grown.push(comparison)
      continue
    }
    if (row.count < recorded) stale.push(comparison)
  }

  for (const [key, row] of allowed) {
    if (counted.has(key)) continue
    stale.push({ file: row.file, rule: row.rule, message: row.message, baseline: row.baseline, current: 0 })
  }

  return {
    added: sortedEntries(added),
    grown: sortedEntries(grown),
    stale: sortedEntries(stale),
    total,
    baselined,
  }
}

/**
 * Build the shrunken baseline from the current diagnostics.
 *
 * Returns undefined when the comparison reports a new key or a grown count:
 * the baseline may only shrink, so there is no result that could be written.
 */
export function shrinkBaseline(
  baseline: Baseline,
  current: CountedDiagnostic[],
  generatedWith: { oxlint: string } = baseline.generatedWith,
): Baseline | undefined {
  const comparison = compareBaseline(baseline, current)
  if (comparison.added.length > 0 || comparison.grown.length > 0) return undefined

  const counts = new Map<string, number>()
  for (const row of current) counts.set(entryKey(row), (counts.get(entryKey(row)) ?? 0) + row.count)

  // Aggregate the recorded entries first so a baseline that repeats one key
  // (an older ledger, or a hand merge) still collapses into one entry.
  const recorded = new Map<string, BaselineEntry>()
  for (const entry of baseline.entries) {
    const key = entryKey(entry)
    const existing = recorded.get(key)
    if (existing) {
      existing.count += entry.count
      continue
    }
    recorded.set(key, { ...entry })
  }

  const entries: BaselineEntry[] = []
  for (const [key, entry] of recorded) {
    const count = counts.get(key) ?? 0
    if (count === 0) continue
    entries.push({ file: entry.file, rule: entry.rule, message: entry.message, count })
  }

  return { version: baseline.version, generatedWith, entries: sortedEntries(entries) }
}

/** Build a fresh baseline from the current diagnostics. */
export function baselineFrom(current: CountedDiagnostic[], oxlintVersion: string): Baseline {
  const counts = new Map<string, BaselineEntry>()
  for (const row of current) {
    const key = entryKey(row)
    const existing = counts.get(key)
    if (existing) {
      existing.count += row.count
      continue
    }
    counts.set(key, { file: row.file, rule: row.rule, message: row.message, count: row.count })
  }
  return {
    version: BASELINE_VERSION,
    generatedWith: { oxlint: oxlintVersion },
    entries: sortedEntries([...counts.values()]),
  }
}

function formatRows(label: string, rows: ComparisonRow[]) {
  const lines = [label + " (" + rows.length + "):"]
  for (const row of rows) {
    lines.push("  " + row.file)
    lines.push("    rule: " + row.rule)
    lines.push("    message: " + row.message)
    lines.push("    baseline " + row.baseline + ", current " + row.current)
  }
  return lines.join("\n")
}

/** The human-readable failure detail for every category a comparison can report. */
export function formatComparison(comparison: Comparison) {
  const sections: string[] = []
  if (comparison.added.length > 0) sections.push(formatRows("NEW diagnostics", comparison.added))
  if (comparison.grown.length > 0) sections.push(formatRows("INCREASED diagnostics", comparison.grown))
  if (comparison.stale.length > 0) {
    sections.push(formatRows("STALE baseline entries", comparison.stale))
    sections.push("run 'bun run lint:fix' to shrink the baseline to the current diagnostics")
  }
  return sections.join("\n\n")
}

function summaryLine(fileCount: number, comparison: Comparison, failed: boolean) {
  const files = fileCount + (fileCount === 1 ? " file" : " files")
  const diagnostics = comparison.total + (comparison.total === 1 ? " diagnostic" : " diagnostics")
  if (!failed) return "lint gate: " + files + ", " + diagnostics + ", all within baseline"
  return (
    "lint gate: " +
    files +
    ", " +
    diagnostics +
    " (" +
    comparison.added.length +
    " new, " +
    comparison.grown.length +
    " increased, " +
    comparison.stale.length +
    " stale)"
  )
}

export function parseOxlintVersion(output: string) {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output)
  const version = match?.[1]
  if (!version) throw new Error("cannot parse the oxlint version from: " + output.trim())
  return version
}

export type OxlintReport = {
  diagnostics: RawDiagnostic[]
  fileCount: number
}

function isRawDiagnostic(value: unknown): value is RawDiagnostic {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { filename?: unknown; code?: unknown; message?: unknown }
  if (typeof candidate.filename !== "string" || typeof candidate.message !== "string") return false
  return candidate.code === undefined || typeof candidate.code === "string"
}

/**
 * Parse an `oxlint --format json` report.
 *
 * oxlint prints a plain "No files found to lint" notice before the JSON when
 * every path was ignored, so the report starts at the first object brace.
 */
export function parseOxlintReport(stdout: string): OxlintReport {
  const start = stdout.indexOf("{")
  if (start < 0) throw new Error("oxlint printed no JSON report")
  const parsed: unknown = JSON.parse(stdout.slice(start))
  if (typeof parsed !== "object" || parsed === null) throw new Error("oxlint printed a non-object report")
  const report = parsed as { diagnostics?: unknown; number_of_files?: unknown }
  if (!Array.isArray(report.diagnostics)) throw new Error("oxlint report has no diagnostics array")
  if (!report.diagnostics.every(isRawDiagnostic)) throw new Error("oxlint report has a malformed diagnostic")
  if (typeof report.number_of_files !== "number") throw new Error("oxlint report has no number_of_files")
  return { diagnostics: report.diagnostics, fileCount: report.number_of_files }
}

/** Walk up from `start` until a directory that carries `.git` is found. */
export function findRepoRoot(start: string) {
  let current = path.resolve(start)
  while (true) {
    if (existsSync(path.join(current, ".git"))) return current
    const parent = path.dirname(current)
    if (parent === current) throw new Error("cannot find the repository root above " + start)
    current = parent
  }
}

/**
 * Parse the checker's own arguments.
 *
 * Positional files are accepted as a compatibility path for the current
 * pre-commit hook (`bun run lint -- <staged files>`); Task 3 switches the hook
 * to `lint:files`, and only unknown options are rejected.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  let fix = false
  let init = false
  let explicitFiles = false
  const files: string[] = []
  for (const argument of argv) {
    if (argument === "--fix") {
      fix = true
      continue
    }
    if (argument === "--init") {
      init = true
      continue
    }
    if (argument === "--files") {
      explicitFiles = true
      continue
    }
    if (argument.startsWith("-")) return { ok: false, error: "unknown option: " + argument }
    files.push(argument)
  }
  if (init && (explicitFiles || files.length > 0)) return { ok: false, error: "--init does not accept a file list" }
  if (init) return { ok: true, mode: "init", files: [] }
  if (fix && (explicitFiles || files.length > 0)) return { ok: false, error: "--fix does not accept a file list" }
  if (fix) return { ok: true, mode: "fix", files: [] }
  if (explicitFiles) {
    if (files.length === 0) return { ok: false, error: "--files needs at least one path" }
    return { ok: true, mode: "files", files }
  }
  if (files.length > 0) return { ok: true, mode: "files", files }
  return { ok: true, mode: "check", files: [] }
}

/** Normalize file arguments and drop anything that is not a lintable file. */
export function selectLintFiles(root: string, files: string[]) {
  const selected: string[] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (!LINT_EXTENSIONS.includes(path.extname(file).toLowerCase())) continue
    const relative = relativeFile(root, file)
    if (!relative || seen.has(relative)) continue
    seen.add(relative)
    selected.push(relative)
  }
  return selected
}

export function baselineFile(root: string) {
  return path.join(root, BASELINE_PATH)
}

export function readBaseline(root: string): Baseline | undefined {
  const file = baselineFile(root)
  if (!existsSync(file)) return undefined
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
  if (typeof parsed !== "object" || parsed === null) throw new Error("invalid baseline: expected an object")
  const candidate = parsed as { version?: unknown; generatedWith?: unknown; entries?: unknown }
  if (!Array.isArray(candidate.entries)) throw new Error("invalid baseline: missing entries array")
  if (!candidate.entries.every(isBaselineEntry)) throw new Error("invalid baseline: malformed entry")
  const generated = candidate.generatedWith as { oxlint?: unknown } | undefined
  return {
    version: typeof candidate.version === "number" ? candidate.version : BASELINE_VERSION,
    generatedWith: { oxlint: typeof generated?.oxlint === "string" ? generated.oxlint : "unknown" },
    entries: candidate.entries,
  }
}

function isBaselineEntry(value: unknown): value is BaselineEntry {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { file?: unknown; rule?: unknown; message?: unknown; count?: unknown }
  return (
    typeof candidate.file === "string" &&
    typeof candidate.rule === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.count === "number" &&
    candidate.count > 0
  )
}

export function writeBaseline(root: string, baseline: Baseline) {
  const file = baselineFile(root)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(baseline, null, 2) + "\n")
}

/**
 * Whether the baseline has ever been part of the committed history.
 *
 * Checking `HEAD` alone is not enough: committing a deletion moves the file out
 * of `HEAD` while the ledger it held stays in history, and that must not become
 * a way to bootstrap a fresh one. `git rev-list --all -- <path>` finds any
 * reachable commit that touched the path, so both "present now" and "deleted in
 * a later commit" are covered.
 *
 * The answer must never be guessed. A git failure, or a shallow clone whose
 * history is truncated, cannot prove the baseline was never established, so
 * both fail closed (report it as established) and let the operator unshallow.
 */
export function baselineEstablished(root: string): boolean {
  const text = (output: Uint8Array) => new TextDecoder().decode(output)
  const history = Bun.spawnSync({
    cmd: ["git", "rev-list", "-1", "--all", "--", BASELINE_PATH],
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  if (history.exitCode !== 0) return true
  if (text(history.stdout).trim().length > 0) return true

  // No reachable commit touched the path. Only a complete history can prove
  // that nothing was ever recorded.
  const shallow = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--is-shallow-repository"],
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  if (shallow.exitCode !== 0) return true
  return text(shallow.stdout).trim() !== "false"
}

/** The explicit `git ls-files` list every full run hands to oxlint. */
export async function collectLintFiles(root: string): Promise<string[]> {
  const pathspecs = LINT_EXTENSIONS.map((extension) => "*" + extension)
  const proc = Bun.spawn(["git", "ls-files", "-z", "--", ...pathspecs], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error("git ls-files failed: " + stderr.trim())
  return stdout.split("\0").filter((file) => file.length > 0)
}

function oxlintBinary(root: string) {
  return path.join(root, "node_modules", ".bin", "oxlint")
}

/** Run oxlint over an explicit file list and return its JSON report. */
export async function runOxlint(root: string, files: string[]): Promise<OxlintReport> {
  const proc = Bun.spawn([oxlintBinary(root), "--format", "json", "--report-unused-disable-directives", ...files], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  try {
    return parseOxlintReport(stdout)
  } catch (error) {
    const detail = stderr.trim() || stdout.trim() || (error instanceof Error ? error.message : String(error))
    throw new Error("oxlint exited with code " + exitCode + " and produced no usable report: " + detail)
  }
}

export async function oxlintVersion(root: string): Promise<string> {
  const proc = Bun.spawn([oxlintBinary(root), "--version"], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error("oxlint --version failed: " + (stderr.trim() || stdout.trim()))
  return parseOxlintVersion(stdout)
}

export type CheckBaselineInputs = {
  root: string
  current: CountedDiagnostic[]
  fileCount: number
  /** Repository-relative files to compare; omitted for a full run. */
  scope?: ReadonlySet<string>
  /** Present the summary as a selected-file run. */
  selected?: boolean
}

export type CheckOutcome = {
  exitCode: number
  report: string
  comparison: Comparison
  /** True when the baseline file is absent; a missing ledger is always a failure. */
  missing: boolean
}

/**
 * Judge the current diagnostics against the baseline without writing anything.
 *
 * A missing baseline is not a pass, even when the current diagnostics are
 * empty: deleting the ledger would otherwise turn every recorded violation
 * back into accepted debt. The operator restores the committed file, or — on a
 * repository that never recorded one — runs `lint:init` once.
 */
export function checkBaseline(inputs: CheckBaselineInputs): CheckOutcome {
  const baseline = readBaseline(inputs.root)
  if (!baseline) {
    const comparison = compareBaseline(EMPTY_BASELINE, inputs.current, inputs.scope)
    return {
      exitCode: 1,
      report: [
        "lint gate: " + inputs.fileCount + (inputs.fileCount === 1 ? " file" : " files") + ", baseline missing",
        "",
        "no baseline at " + BASELINE_PATH + ": restore it with 'git checkout -- " + BASELINE_PATH + "';",
        "only a repository that never recorded one may create it with 'bun run lint:init'",
        ...(comparison.total > 0 ? ["", formatComparison(comparison)] : []),
      ].join("\n"),
      comparison,
      missing: true,
    }
  }
  const comparison = compareBaseline(baseline, inputs.current, inputs.scope)
  const failed = comparison.added.length > 0 || comparison.grown.length > 0 || comparison.stale.length > 0
  const lines = [summaryLine(inputs.fileCount, comparison, failed)]
  const details = formatComparison(comparison)
  if (details) {
    lines.push("")
    lines.push(details)
  }
  return { exitCode: failed ? 1 : 0, report: lines.join("\n"), comparison, missing: false }
}

export type FixBaselineInputs = {
  root: string
  current: CountedDiagnostic[]
  oxlintVersion: string
  fileCount: number
  /** Record the first baseline instead of shrinking an existing one. */
  initialize?: boolean
  /**
   * Whether a baseline was ever committed to this repository, including one
   * whose deletion is itself committed. See `baselineEstablished`.
   */
  established?: boolean
}

export type FixOutcome = {
  exitCode: number
  report: string
  written: boolean
  initialized: boolean
  comparison: Comparison
}

/**
 * Shrink the baseline to the current diagnostics, or create it once.
 *
 * Two modes, deliberately kept apart:
 * - `fix` (the default) may only lose entries or lower counts. A new key or a
 *   grown count refuses the write and leaves the file untouched. A *missing*
 *   ledger fails too: silently rebuilding it from the current diagnostics would
 *   turn every recorded violation back into accepted debt, so deleting the file
 *   must never be a reset button.
 * - `init` records the first ledger, and only on a repository that never had
 *   one. A file in the working tree and a baseline anywhere in reachable
 *   history both refuse, so the bootstrap path can neither erase established
 *   debt nor resurrect it after the deletion was itself committed.
 */
export function fixBaseline(inputs: FixBaselineInputs): FixOutcome {
  const baseline = readBaseline(inputs.root)

  if (inputs.initialize) {
    if (baseline) {
      return {
        exitCode: 1,
        report: [
          "lint gate: " + BASELINE_PATH + " already exists in the working tree",
          "",
          "lint:init only records a first baseline; shrink an existing one with 'bun run lint:fix'",
        ].join("\n"),
        written: false,
        initialized: false,
        comparison: compareBaseline(baseline, inputs.current),
      }
    }
    if (inputs.established) {
      return {
        exitCode: 1,
        report: [
          "lint gate: " + BASELINE_PATH + " was established in this repository's history",
          "",
          "restore it with 'git checkout <commit> -- " + BASELINE_PATH + "'",
          "lint:init only records a first baseline and never recreates an established one",
        ].join("\n"),
        written: false,
        initialized: false,
        comparison: compareBaseline(EMPTY_BASELINE, inputs.current),
      }
    }
    const initialized = baselineFrom(inputs.current, inputs.oxlintVersion)
    writeBaseline(inputs.root, initialized)
    return {
      exitCode: 0,
      report:
        "lint gate: baseline initialized at " +
        BASELINE_PATH +
        " with " +
        initialized.entries.length +
        " entries (" +
        inputs.current.reduce((sum, row) => sum + row.count, 0) +
        " diagnostics)",
      written: true,
      initialized: true,
      comparison: compareBaseline(EMPTY_BASELINE, inputs.current),
    }
  }

  if (!baseline) {
    const comparison = compareBaseline(EMPTY_BASELINE, inputs.current)
    const reason = inputs.established
      ? "the baseline was established in this repository's history; restore it with 'git checkout <commit> -- " +
        BASELINE_PATH +
        "'"
      : "the baseline is missing; restore it, or create the first one with 'bun run lint:init'"
    return {
      exitCode: 1,
      report: ["lint gate: " + BASELINE_PATH + " missing", "", reason, "refusing to record violations anew"].join("\n"),
      written: false,
      initialized: false,
      comparison,
    }
  }

  const comparison = compareBaseline(baseline, inputs.current)
  if (comparison.added.length > 0 || comparison.grown.length > 0) {
    return {
      exitCode: 1,
      report: [
        summaryLine(inputs.fileCount, comparison, true),
        "",
        formatComparison(comparison),
        "",
        "refusing to grow the baseline: fix the reported diagnostics instead of recording them",
      ].join("\n"),
      written: false,
      initialized: false,
      comparison,
    }
  }

  const next = shrinkBaseline(baseline, inputs.current, { oxlint: inputs.oxlintVersion })
  if (!next) throw new Error("shrinkBaseline refused a comparison it had already accepted")

  const before = JSON.stringify(baseline)
  const after = JSON.stringify(next)
  if (before === after) {
    return {
      exitCode: 0,
      report:
        "lint gate: baseline unchanged at " + next.entries.length + " entries (" + comparison.total + " diagnostics)",
      written: false,
      initialized: false,
      comparison,
    }
  }

  writeBaseline(inputs.root, next)
  return {
    exitCode: 0,
    report:
      "lint gate: baseline shrunk from " +
      baseline.entries.length +
      " to " +
      next.entries.length +
      " entries (" +
      comparison.total +
      " diagnostics)",
    written: true,
    initialized: false,
    comparison,
  }
}

async function main(argv: string[]) {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    process.stderr.write(parsed.error + "\n" + USAGE + "\n")
    process.exit(2)
  }

  const root = findRepoRoot(import.meta.dir)

  if (parsed.mode === "files") {
    const selected = selectLintFiles(root, parsed.files)
    if (selected.length === 0) {
      process.stdout.write("lint gate: no lint files selected\n")
      return
    }
    const scope = new Set(selected)
    const report = await runOxlint(root, selected)
    if (report.fileCount === 0) {
      // Every selected path is outside the lint scope (an upstream or generated
      // file, for example). Nothing to judge and nothing to shrink.
      process.stdout.write("lint gate: the selected files are outside the lint scope\n")
      return
    }
    const current = aggregateDiagnostics(root, report.diagnostics, scope)
    const outcome = checkBaseline({ root, current, fileCount: report.fileCount, scope, selected: true })
    process.stdout.write(outcome.report + "\n")
    if (outcome.exitCode !== 0) process.exit(outcome.exitCode)
    return
  }

  const files = await collectLintFiles(root)
  const report = await runOxlint(root, files)
  if (report.fileCount === 0) {
    throw new Error("oxlint linted no files; check the lint scope and the file list")
  }
  const current = aggregateDiagnostics(root, report.diagnostics)

  if (parsed.mode === "fix" || parsed.mode === "init") {
    // Asked for both modes: `fix` needs it to explain a missing ledger, and
    // `init` uses it to refuse a repository that ever had one.
    const established = baselineEstablished(root)
    const outcome = fixBaseline({
      root,
      current,
      oxlintVersion: await oxlintVersion(root),
      fileCount: report.fileCount,
      initialize: parsed.mode === "init",
      established,
    })
    process.stdout.write(outcome.report + "\n")
    if (outcome.exitCode !== 0) process.exit(outcome.exitCode)
    return
  }

  const outcome = checkBaseline({ root, current, fileCount: report.fileCount })
  process.stdout.write(outcome.report + "\n")
  if (outcome.exitCode !== 0) process.exit(outcome.exitCode)
}

if (import.meta.main) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write("lint gate: " + (error instanceof Error ? error.message : String(error)) + "\n")
    process.exit(1)
  })
}
