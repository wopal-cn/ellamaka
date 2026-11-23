import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  aggregateDiagnostics,
  checkBaseline,
  compareBaseline,
  findRepoRoot,
  fixBaseline,
  formatComparison,
  normalizeMessage,
  parseArgs,
  parseOxlintReport,
  parseOxlintVersion,
  relativeFile,
  selectLintFiles,
  shrinkBaseline,
  BASELINE_PATH as BASELINE_PATH_CONST,
  NO_CODE,
  type Baseline,
  type CountedDiagnostic,
  type RawDiagnostic,
} from "./check"

const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lint-gate-"))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function baselineFile(root: string): string {
  return join(root, ".ci", "oxlint-baseline.json")
}

function recorded(entries: Array<Omit<CountedDiagnostic, "count"> & { count?: number }>): Baseline {
  return {
    version: 1,
    generatedWith: { oxlint: "1.60.0" },
    entries: entries.map((entry) => ({ count: 1, ...entry })),
  }
}

function writeBaseline(root: string, baseline: Baseline) {
  mkdirSync(join(root, ".ci"), { recursive: true })
  writeFileSync(baselineFile(root), JSON.stringify(baseline, null, 2) + "\n")
}

function counted(file: string, rule: string, message: string, count: number): CountedDiagnostic {
  return { file, rule, message, count }
}

function diagnostic(filename: string, code: string | undefined, message: string): RawDiagnostic {
  return code === undefined ? { filename, message } : { filename, code, message }
}

test("a diagnostic without a code uses a fixed placeholder instead of being dropped", () => {
  const rows = aggregateDiagnostics("/repo", [
    diagnostic("packages/a.ts", undefined, "Unused eslint-disable directive (no problems were reported)."),
    diagnostic("packages/a.ts", undefined, "Unused eslint-disable directive (no problems were reported)."),
    diagnostic("packages/a.ts", "eslint(no-debugger)", "Unused eslint-disable directive (no problems were reported)."),
  ])
  expect(rows.filter((row) => row.rule === NO_CODE)).toEqual([
    counted("packages/a.ts", NO_CODE, "Unused eslint-disable directive (no problems were reported).", 2),
  ])
  expect(rows.filter((row) => row.rule === "eslint(no-debugger)")).toHaveLength(1)
})

test("messages are folded to one line so formatting noise cannot create a new key", () => {
  expect(normalizeMessage("  Promises must be\n\tawaited, add void operator.  ")).toBe(
    "Promises must be awaited, add void operator.",
  )
})

test("diagnostic filenames are normalized to repository-relative POSIX paths", () => {
  const root = "/repo"
  const rows = aggregateDiagnostics(root, [
    diagnostic("/repo/packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used."),
    diagnostic("./packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used."),
    diagnostic("/elsewhere/b.ts", "eslint(no-unused-vars)", "'y' is defined but never used."),
  ])
  expect(rows).toEqual([counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 2)])
  expect(relativeFile(root, "/elsewhere/b.ts")).toBeUndefined()
})

test("a legal file name starting with two dots stays inside the scope", () => {
  const root = "/repo"
  // `..new.ts` is a legal tracked name; only a real parent segment escapes.
  expect(relativeFile(root, "..new.ts")).toBe("..new.ts")
  expect(relativeFile(root, "packages/example/..new.ts")).toBe("packages/example/..new.ts")
  expect(relativeFile(root, join(root, "..new.ts"))).toBe("..new.ts")
  expect(relativeFile(root, "../outside.ts")).toBeUndefined()
  expect(relativeFile(root, "/elsewhere/outside.ts")).toBeUndefined()
  expect(selectLintFiles(root, ["..new.ts", "packages/example/..new.ts", "../outside.ts"])).toEqual([
    "..new.ts",
    "packages/example/..new.ts",
  ])
})

test("a new diagnostic in a dot-dot file is aggregated instead of being dropped", () => {
  const rows = aggregateDiagnostics(
    "/repo",
    [diagnostic("/repo/..new.ts", "eslint(no-debugger)", "'debugger' statement is not allowed.")],
    new Set(["..new.ts"]),
  )
  expect(rows).toEqual([counted("..new.ts", "eslint(no-debugger)", "'debugger' statement is not allowed.", 1)])
})

test("a diagnostic outside the selected scope never enters the current count", () => {
  const rows = aggregateDiagnostics(
    "/repo",
    [
      diagnostic("packages/a.ts", "eslint(no-debugger)", "'debugger' statement is not allowed."),
      diagnostic("packages/b.ts", "eslint(no-debugger)", "'debugger' statement is not allowed."),
    ],
    new Set(["packages/a.ts"]),
  )
  expect(rows).toEqual([counted("packages/a.ts", "eslint(no-debugger)", "'debugger' statement is not allowed.", 1)])
})

test("a key that is missing from the baseline is reported as new with both counts", () => {
  const baseline = baselineOf([
    counted("packages/a.ts", "eslint(no-debugger)", "'debugger' statement is not allowed.", 1),
  ])
  const comparison = compareBaseline(baseline, [
    counted("packages/a.ts", "eslint(no-debugger)", "'debugger' statement is not allowed.", 2),
  ])
  // Same key but a higher count: the increase is reported separately from a new key.
  expect(comparison.added).toEqual([])
  expect(comparison.grown).toEqual([
    {
      file: "packages/a.ts",
      rule: "eslint(no-debugger)",
      message: "'debugger' statement is not allowed.",
      baseline: 1,
      current: 2,
    },
  ])

  const fresh = compareBaseline(baseline, [
    counted("packages/a.ts", "eslint(no-debugger)", "'debugger' statement is not allowed.", 2),
    counted("packages/b.ts", "typescript-eslint(no-floating-promises)", "Promises must be awaited.", 1),
  ])
  expect(fresh.added).toEqual([
    {
      file: "packages/b.ts",
      rule: "typescript-eslint(no-floating-promises)",
      message: "Promises must be awaited.",
      baseline: 0,
      current: 1,
    },
  ])
  const report = formatComparison(fresh)
  expect(report).toContain("packages/b.ts")
  expect(report).toContain("typescript-eslint(no-floating-promises)")
  expect(report).toContain("Promises must be awaited.")
  expect(report).toContain("baseline 0, current 1")
})

test("a count above the recorded one fails and names the rule and message", () => {
  const comparison = compareBaseline(
    recorded([counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 1)]),
    [counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 3)],
  )
  expect(comparison.grown).toHaveLength(1)
  expect(comparison.added).toEqual([])
  expect(comparison.stale).toEqual([])
  expect(formatComparison(comparison)).toContain("baseline 1, current 3")
})

test("a count below the recorded one is stale and points at lint:fix", () => {
  const comparison = compareBaseline(
    recorded([counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 2)]),
    [counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 1)],
  )
  expect(comparison.stale).toEqual([
    {
      file: "packages/a.ts",
      rule: "eslint(no-unused-vars)",
      message: "'x' is defined but never used.",
      baseline: 2,
      current: 1,
    },
  ])
  expect(comparison.added).toEqual([])
  expect(formatComparison(comparison)).toContain("lint:fix")
})

test("a vanished key is stale with a current count of zero", () => {
  const comparison = compareBaseline(
    recorded([counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 1)]),
    [],
  )
  expect(comparison.stale).toEqual([
    {
      file: "packages/a.ts",
      rule: "eslint(no-unused-vars)",
      message: "'x' is defined but never used.",
      baseline: 1,
      current: 0,
    },
  ])
  expect(comparison.added).toEqual([])
  expect(comparison.total).toBe(0)
  expect(comparison.baselined).toBe(0)
})

test("a matching baseline reports nothing and still counts the diagnostics", () => {
  const comparison = compareBaseline(
    recorded([
      counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 2),
      counted("packages/b.ts", "eslint(no-debugger)", "'debugger' statement is not allowed.", 1),
    ]),
    [
      counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 2),
      counted("packages/b.ts", "eslint(no-debugger)", "'debugger' statement is not allowed.", 1),
    ],
  )
  expect(comparison.added).toEqual([])
  expect(comparison.grown).toEqual([])
  expect(comparison.stale).toEqual([])
  expect(comparison.total).toBe(3)
  expect(comparison.baselined).toBe(3)
})

test("shrinking removes stale entries and lowers the remaining counts", () => {
  const next = shrinkBaseline(
    recorded([
      counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 2),
      counted("packages/b.ts", "eslint(no-debugger)", "'debugger' statement is not allowed.", 1),
      counted("packages/c.ts", "eslint(no-unused-vars)", "'z' is defined but never used.", 1),
    ]),
    [
      counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 1),
      counted("packages/c.ts", "eslint(no-unused-vars)", "'z' is defined but never used.", 1),
    ],
    { oxlint: "1.61.0" },
  )
  expect(next).toEqual({
    version: 1,
    generatedWith: { oxlint: "1.61.0" },
    entries: [
      counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 1),
      counted("packages/c.ts", "eslint(no-unused-vars)", "'z' is defined but never used.", 1),
    ],
  })
})

test("shrinking refuses a new key and a grown count instead of recording them", () => {
  const baseline = recorded([counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 1)])
  expect(
    shrinkBaseline(baseline, [
      counted("packages/b.ts", "eslint(no-debugger)", "'debugger' statement is not allowed.", 1),
    ]),
  ).toBeUndefined()
  expect(
    shrinkBaseline(baseline, [counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 2)]),
  ).toBeUndefined()
})

test("a missing baseline makes an explicit --init initialize it once with the current diagnostics", () => {
  const root = temporaryRoot()
  const outcome = fixBaseline({
    root,
    current: [
      counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 2),
      counted("packages/b.ts", NO_CODE, "Unused eslint-disable directive (no problems were reported).", 1),
    ],
    oxlintVersion: "1.60.0",
    fileCount: 2,
    initialize: true,
  })
  expect(outcome.exitCode).toBe(0)
  expect(outcome.initialized).toBe(true)
  expect(outcome.written).toBe(true)
  const written = JSON.parse(readFileSync(baselineFile(root), "utf8")) as Baseline
  expect(written.generatedWith).toEqual({ oxlint: "1.60.0" })
  expect(written.entries).toEqual([
    counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 2),
    counted("packages/b.ts", NO_CODE, "Unused eslint-disable directive (no problems were reported).", 1),
  ])
})

test("a missing baseline fails a plain --fix and records nothing", () => {
  const root = temporaryRoot()
  const outcome = fixBaseline({
    root,
    // A violation that would be accepted as debt by the old bootstrap path.
    current: [counted("packages/a.ts", "eslint(no-debugger)", "'debugger' statement is not allowed.", 1)],
    oxlintVersion: "1.60.0",
    fileCount: 1,
  })
  expect(outcome.exitCode).toBe(1)
  expect(outcome.written).toBe(false)
  expect(outcome.initialized).toBe(false)
  expect(existsSync(baselineFile(root))).toBe(false)
  expect(outcome.report).toContain("refusing to record violations anew")
})

test("--init refuses when a baseline was ever established, so deleting it is not a reset", () => {
  const root = temporaryRoot()
  const outcome = fixBaseline({
    root,
    current: [counted("packages/a.ts", "eslint(no-debugger)", "'debugger' statement is not allowed.", 1)],
    oxlintVersion: "1.60.0",
    fileCount: 1,
    initialize: true,
    established: true,
  })
  expect(outcome.exitCode).toBe(1)
  expect(outcome.written).toBe(false)
  expect(existsSync(baselineFile(root))).toBe(false)
  expect(outcome.report).toContain("was established in this repository")
})

test("--init refuses when a working-tree baseline already exists instead of shrinking it", () => {
  const root = temporaryRoot()
  writeBaseline(root, recorded([counted("packages/a.ts", "eslint(no-debugger)", "boom", 1)]))
  const before = readFileSync(baselineFile(root))

  const outcome = fixBaseline({
    root,
    current: [],
    oxlintVersion: "1.60.0",
    fileCount: 1,
    initialize: true,
  })
  expect(outcome.exitCode).toBe(1)
  expect(outcome.written).toBe(false)
  expect(outcome.report).toContain("already exists")
  expect(outcome.report).toContain("bun run lint:fix")
  expect(readFileSync(baselineFile(root))).toEqual(before)
})

test("--fix refuses to write when the current diagnostics grew, leaving the file byte-identical", () => {
  const root = temporaryRoot()
  writeBaseline(
    root,
    recorded([counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 1)]),
  )
  const before = readFileSync(baselineFile(root))

  const outcome = fixBaseline({
    root,
    current: [
      counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 2),
      counted("packages/b.ts", "eslint(no-debugger)", "'debugger' statement is not allowed.", 1),
    ],
    oxlintVersion: "1.60.0",
    fileCount: 2,
  })

  expect(outcome.exitCode).toBe(1)
  expect(outcome.written).toBe(false)
  expect(outcome.comparison.added).toHaveLength(1)
  expect(outcome.comparison.grown).toHaveLength(1)
  expect(readFileSync(baselineFile(root))).toEqual(before)
  expect(outcome.report).toContain("refusing to grow the baseline")
})

test("--fix writes the shrunken baseline when there are only retired entries", () => {
  const root = temporaryRoot()
  writeBaseline(
    root,
    recorded([
      counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 2),
      counted("packages/b.ts", "eslint(no-debugger)", "'debugger' statement is not allowed.", 1),
    ]),
  )
  const outcome = fixBaseline({
    root,
    current: [counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 1)],
    oxlintVersion: "1.60.0",
    fileCount: 1,
  })
  expect(outcome.exitCode).toBe(0)
  expect(outcome.written).toBe(true)
  const written = JSON.parse(readFileSync(baselineFile(root), "utf8")) as Baseline
  expect(written.entries).toEqual([
    counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 1),
  ])
})

test("a missing baseline fails the check even when there is nothing to report", () => {
  const root = temporaryRoot()
  const outcome = checkBaseline({ root, current: [], fileCount: 1 })
  expect(outcome.exitCode).toBe(1)
  expect(outcome.missing).toBe(true)
  expect(outcome.report).toContain("baseline missing")
  expect(outcome.report).toContain("git checkout -- " + BASELINE_PATH_CONST)
})

test("a missing baseline fails the check and reports the diagnostics as all-new", () => {
  const root = temporaryRoot()
  const outcome = checkBaseline({
    root,
    current: [counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 1)],
    fileCount: 1,
  })
  expect(outcome.exitCode).toBe(1)
  expect(outcome.comparison.added).toHaveLength(1)
  expect(outcome.report).toContain("lint:init")
  expect(outcome.report).toContain("packages/a.ts")
})

test("a matching baseline passes and the report includes the diagnostic total", () => {
  const root = temporaryRoot()
  writeBaseline(
    root,
    recorded([counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 2)]),
  )
  const outcome = checkBaseline({
    root,
    current: [counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 2)],
    fileCount: 7,
  })
  expect(outcome.exitCode).toBe(0)
  expect(outcome.report).toContain("7 files")
  expect(outcome.report).toContain("2 diagnostics")
  expect(outcome.report).not.toContain("lint:fix")
})

test("the check never rewrites the baseline file", () => {
  const root = temporaryRoot()
  writeBaseline(
    root,
    recorded([counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 2)]),
  )
  const before = readFileSync(baselineFile(root))
  checkBaseline({ root, current: [], fileCount: 1 })
  expect(readFileSync(baselineFile(root))).toEqual(before)
})

test("a stale entry fails the check and points at lint:fix", () => {
  const root = temporaryRoot()
  writeBaseline(
    root,
    recorded([counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 1)]),
  )
  const outcome = checkBaseline({ root, current: [], fileCount: 1 })
  expect(outcome.exitCode).toBe(1)
  expect(outcome.report).toContain("STALE baseline entries")
  expect(outcome.report).toContain("lint:fix")
})

test("selected files apply the same three verdicts while unselected entries stay out of the comparison", () => {
  const baseline = recorded([
    counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 1),
    counted("packages/b.ts", "eslint(no-debugger)", "'debugger' statement is not allowed.", 2),
  ])
  const scope = new Set(["packages/a.ts"])

  expect(
    compareBaseline(
      baseline,
      [counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 1)],
      scope,
    ),
  ).toMatchObject({
    added: [],
    grown: [],
    stale: [],
  })
  expect(
    compareBaseline(
      baseline,
      [counted("packages/a.ts", "eslint(no-unused-vars)", "'x' is defined but never used.", 2)],
      scope,
    ).grown,
  ).toHaveLength(1)
  expect(compareBaseline(baseline, [], scope).stale).toEqual([
    {
      file: "packages/a.ts",
      rule: "eslint(no-unused-vars)",
      message: "'x' is defined but never used.",
      baseline: 1,
      current: 0,
    },
  ])
  expect(
    compareBaseline(
      baseline,
      [counted("packages/a.ts", "eslint(no-debugger)", "'debugger' statement is not allowed.", 1)],
      scope,
    ).added,
  ).toHaveLength(1)
})

test("selected-file mode never judges a baseline entry for a file that was not selected", () => {
  const baseline = recorded([
    counted("packages/unselected.ts", "eslint(no-debugger)", "'debugger' statement is not allowed.", 2),
  ])
  const outcome = checkBaseline({
    root: temporaryRoot(),
    current: [],
    fileCount: 1,
    scope: new Set(["packages/selected.ts"]),
    selected: true,
  })
  // The root has no baseline file at all, so this doubles as the all-new path;
  // the point is that the unselected entry never turns into a stale report.
  expect(outcome.comparison.stale).toEqual([])

  const scoped = compareBaseline(baseline, [], new Set(["packages/selected.ts"]))
  expect(scoped.stale).toEqual([])
  expect(scoped.total).toBe(0)
})

test("file arguments are normalized against the repository root and filtered to lintable extensions", () => {
  const root = "/repo"
  expect(
    selectLintFiles(root, ["packages/a.ts", "./packages/b.tsx", join(root, "packages/c.js"), "docs/readme.md"]),
  ).toEqual(["packages/a.ts", "packages/b.tsx", "packages/c.js"])
  expect(selectLintFiles(root, ["packages/a.ts", "./packages/a.ts"])).toEqual(["packages/a.ts"])
})

test("the oxlint version is parsed from the real --version output", () => {
  expect(parseOxlintVersion("Version: 1.60.0\n")).toBe("1.60.0")
  expect(parseOxlintVersion("1.60.0")).toBe("1.60.0")
  expect(() => parseOxlintVersion("no version here")).toThrow()
})

test("the JSON report is parsed even when oxlint prints a leading notice", () => {
  const plain = parseOxlintReport(
    JSON.stringify({ diagnostics: [diagnostic("packages/a.ts", "eslint(no-debugger)", "boom")], number_of_files: 3 }),
  )
  expect(plain.fileCount).toBe(3)
  expect(plain.diagnostics).toHaveLength(1)

  const noticed = parseOxlintReport(
    "No files found to lint. Please check your paths and ignore patterns.\n" +
      JSON.stringify({ diagnostics: [], number_of_files: 0 }),
  )
  expect(noticed).toEqual({ diagnostics: [], fileCount: 0 })
  expect(() => parseOxlintReport("oxlint exploded")).toThrow()
})

test("the repository root is found from the script location, not from the current directory", () => {
  const root = temporaryRoot()
  mkdirSync(join(root, "packages", "deep", "dir"), { recursive: true })
  writeFileSync(join(root, ".git"), "gitdir: elsewhere\n")
  expect(findRepoRoot(join(root, "packages", "deep", "dir"))).toBe(root)
  expect(findRepoRoot(root)).toBe(root)
})

test("argument parsing separates the check, fix, init and files modes and rejects unknown options", () => {
  expect(parseArgs([])).toEqual({ ok: true, mode: "check", files: [] })
  expect(parseArgs(["--fix"])).toEqual({ ok: true, mode: "fix", files: [] })
  expect(parseArgs(["--init"])).toEqual({ ok: true, mode: "init", files: [] })
  expect(parseArgs(["--files", "a.ts", "b.ts"])).toEqual({ ok: true, mode: "files", files: ["a.ts", "b.ts"] })
  // Compatibility path for the pre-Task-3 hook: `bun run lint -- <staged files>`.
  expect(parseArgs(["a.ts", "b.ts"])).toEqual({ ok: true, mode: "files", files: ["a.ts", "b.ts"] })
  expect(parseArgs(["--bogus"])).toEqual({ ok: false, error: "unknown option: --bogus" })
  expect(parseArgs(["--fix", "a.ts"]).ok).toBe(false)
  expect(parseArgs(["--init", "a.ts"]).ok).toBe(false)
  expect(parseArgs(["--files"]).ok).toBe(false)
})

function baselineOf(entries: CountedDiagnostic[]): Baseline {
  return { version: 1, generatedWith: { oxlint: "1.60.0" }, entries }
}
