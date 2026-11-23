/**
 * Integration layer: the baseline's missing-file contract against real git.
 *
 * The unit layer cannot cover this. `baselineEstablished` shells out to git, and
 * the whole point of the bootstrap guard is that an established ledger cannot be
 * recreated by deleting it — a property that only exists in a real repository
 * with real history.
 */

import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  baselineEstablished,
  baselineFile,
  checkBaseline,
  fixBaseline,
  BASELINE_PATH,
  type CountedDiagnostic,
} from "./check"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lint-gate-git-"))
  temporaryRoots.push(root)
  return root
}

function git(root: string, args: string[]) {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: root,
    env: {
      ...(process.env as Record<string, string>),
      GIT_AUTHOR_NAME: "lint gate test",
      GIT_AUTHOR_EMAIL: "lint-gate@example.com",
      GIT_COMMITTER_NAME: "lint gate test",
      GIT_COMMITTER_EMAIL: "lint-gate@example.com",
    },
  })
  if (result.exitCode !== 0) throw new Error("git " + args.join(" ") + ": " + result.stderr.toString())
  return result.stdout.toString()
}

function recorded(): CountedDiagnostic[] {
  return [{ file: "packages/a.ts", rule: "eslint(no-debugger)", message: "boom", count: 1 }]
}

function commitBaseline(root: string) {
  mkdirSync(join(root, ".ci"), { recursive: true })
  writeFileSync(
    baselineFile(root),
    JSON.stringify({ version: 1, generatedWith: { oxlint: "1.60.0" }, entries: recorded() }, null, 2) + "\n",
  )
  git(root, ["add", BASELINE_PATH])
  git(root, ["commit", "-q", "-m", "record the baseline"])
}

function initRepo(root: string) {
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "lint-gate@example.com"])
  git(root, ["config", "user.name", "lint gate test"])
  writeFileSync(join(root, "README.md"), "x\n")
  git(root, ["add", "README.md"])
  git(root, ["commit", "-q", "-m", "init"])
}

/** The violations a bypass would smuggle into a fresh ledger. */
function freshViolations(): CountedDiagnostic[] {
  return [
    { file: "packages/regression.ts", rule: "eslint(no-debugger)", message: "boom", count: 3 },
    { file: "packages/regression2.ts", rule: "eslint(no-debugger)", message: "boom", count: 2 },
  ]
}

function attemptInit(root: string) {
  return fixBaseline({
    root,
    current: freshViolations(),
    oxlintVersion: "1.60.0",
    fileCount: 2,
    initialize: true,
    established: baselineEstablished(root),
  })
}

test("an established baseline stays established after it is deleted from the working tree", () => {
  const root = temporaryRoot()
  initRepo(root)
  expect(baselineEstablished(root)).toBe(false)

  commitBaseline(root)
  expect(baselineEstablished(root)).toBe(true)

  rmSync(baselineFile(root))
  // The file is gone from the working tree, `HEAD` still carries it.
  expect(baselineEstablished(root)).toBe(true)
})

test("an established baseline stays established after the deletion is itself committed", () => {
  const root = temporaryRoot()
  initRepo(root)
  commitBaseline(root)
  rmSync(baselineFile(root))
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", "remove the baseline"])

  // `HEAD` no longer has the file; history still does. This is exactly the
  // shape that a `HEAD`-only check mistook for "never recorded".
  const headLookup = Bun.spawnSync({
    cmd: ["git", "cat-file", "-e", "HEAD:" + BASELINE_PATH],
    cwd: root,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  expect(headLookup.exitCode).not.toBe(0)
  expect(baselineEstablished(root)).toBe(true)
})

test("a committed deletion cannot bootstrap a new ledger from new violations", () => {
  const root = temporaryRoot()
  initRepo(root)
  commitBaseline(root)
  rmSync(baselineFile(root))
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", "remove the baseline"])

  const outcome = attemptInit(root)
  expect(outcome.exitCode).toBe(1)
  expect(outcome.written).toBe(false)
  expect(outcome.initialized).toBe(false)
  expect(outcome.report).toContain("was established in this repository's history")
  // Nothing was recreated on disk.
  expect(() => readFileSync(baselineFile(root))).toThrow()
})

test("a deleted baseline still fails the check and lint:init still refuses", () => {
  const root = temporaryRoot()
  initRepo(root)
  commitBaseline(root)
  const before = readFileSync(baselineFile(root))
  rmSync(baselineFile(root))

  // 1. The check fails even though the working tree reports no diagnostics.
  const checked = checkBaseline({ root, current: [], fileCount: 1 })
  expect(checked.exitCode).toBe(1)
  expect(checked.missing).toBe(true)

  // 2. The bootstrap path refuses.
  expect(attemptInit(root).exitCode).toBe(1)

  // 3. Restoring the committed file re-establishes the exact same ledger.
  git(root, ["checkout", "--", BASELINE_PATH])
  expect(readFileSync(baselineFile(root))).toEqual(before)
})

test("a repair in a shallow clone fails closed instead of trusting a truncated history", () => {
  const origin = temporaryRoot()
  initRepo(origin)
  commitBaseline(origin)

  const shallowRoot = temporaryRoot()
  const clone = Bun.spawnSync({
    cmd: ["git", "clone", "-q", "--depth", "1", "file://" + origin, shallowRoot],
    cwd: tmpdir(),
    env: { ...(process.env as Record<string, string>) },
  })
  expect(clone.exitCode).toBe(0)
  expect(git(shallowRoot, ["rev-parse", "--is-shallow-repository"]).trim()).toBe("true")

  // A shallow clone cannot prove the path was never recorded, so the answer is
  // "established" and the bootstrap path refuses rather than guessing.
  rmSync(baselineFile(shallowRoot), { force: true })
  expect(baselineEstablished(shallowRoot)).toBe(true)
})

test("a repository that never committed a baseline can initialize it once", () => {
  const root = temporaryRoot()
  initRepo(root)
  expect(baselineEstablished(root)).toBe(false)

  const outcome = fixBaseline({
    root,
    current: recorded(),
    oxlintVersion: "1.60.0",
    fileCount: 1,
    initialize: true,
    established: baselineEstablished(root),
  })
  expect(outcome.exitCode).toBe(0)
  expect(outcome.initialized).toBe(true)
  expect(checkBaseline({ root, current: recorded(), fileCount: 1 }).exitCode).toBe(0)
})
