#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { findUnrestoredMocksIn, type MockLeak } from "./check-test-order-isolation.shared"

export type TestRun = {
  label: string
  files: string[]
}

const TEST_FILE_PATTERN = /\.test\.(?:ts|tsx)$/
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".artifacts", "dist", "e2e"])
const PAIR_ROOT = "src/context/global-sync/"
const RUN_TIMEOUT_MS = 180_000

function toPosix(value: string) {
  return value.split(path.sep).join("/")
}

async function walk(root: string, current: string): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const absolute = path.join(current, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      files.push(...(await walk(root, absolute)))
      continue
    }
    if (!entry.isFile()) continue
    if (!TEST_FILE_PATTERN.test(entry.name)) continue
    files.push(toPosix(path.relative(root, absolute)))
  }
  return files
}

export async function collectTestFiles(root: string, testRoot = "src") {
  const files = await walk(root, path.join(root, testRoot))
  return files.sort()
}

export function buildRuns(files: string[], pairRoot = PAIR_ROOT): TestRun[] {
  const paired = files.filter((file) => file.startsWith(pairRoot))
  const runs: TestRun[] = [
    { label: "forward (" + files.length + " files)", files: [...files] },
    { label: "reverse (" + files.length + " files)", files: [...files].reverse() },
  ]
  for (const first of paired) {
    for (const second of paired) {
      if (first === second) continue
      runs.push({ label: first + " -> " + second, files: [first, second] })
    }
  }
  return runs
}

/**
 * Runs the given files in one Bun test process and verifies the order Bun
 * actually evaluated them in.
 *
 * Bun documents positional test arguments as file filters, not as a loading
 * contract. Every executed test file prints a "src/....test.ts:" heading, so
 * the real order is read back from the output and compared with the request.
 * A run whose real order differs fails closed instead of silently passing.
 */
export async function findUnrestoredMocks(root: string) {
  const leaks: MockLeak[] = []
  for (const file of await collectTestFiles(root)) {
    const source = await Bun.file(path.join(root, file)).text()
    leaks.push(...findUnrestoredMocksIn(file, source))
  }
  return leaks
}
/**
 * Bun hides per-file headings when it detects an AI agent, which would make the
 * order probe unable to read the real execution order. The checker needs that
 * detail, so the child process always runs with those flags removed.
 */
export function quietOutputDisabled() {
  const env = { ...process.env }
  for (const key of ["AGENT", "CLAUDECODE", "REPL_ID"]) delete env[key]
  return env
}
export async function runOrderedFiles(files: string[], cwd: string) {
  const result = await new Promise<{ ok: boolean; output: string }>((resolve) => {
    const child = spawn(process.execPath, ["test", "--conditions=browser", ...files.map((file) => "./" + file)], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: quietOutputDisabled(),
    })
    let output = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      output += "\n[timeout] run exceeded " + RUN_TIMEOUT_MS + "ms\n"
    }, RUN_TIMEOUT_MS)
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, output })
    })
  })

  const actual = parseExecutedOrder(result.output)
  if (!arraysEqual(actual, files)) {
    return {
      ok: false,
      output:
        "load order mismatch\nrequested: " +
        files.join(", ") +
        "\nactual:    " +
        (actual.length ? actual.join(", ") : "<nothing recorded>") +
        "\n" +
        result.output,
    }
  }
  return result
}

/** Test-file headings Bun prints in execution order. */
export function parseExecutedOrder(output: string) {
  const found: string[] = []
  for (const line of output.split("\n")) {
    const match = /^(src\/\S+\.test\.(?:ts|tsx)):$/.exec(line.trim())
    if (match) found.push(match[1])
  }
  return found
}

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function tail(output: string, lines = 40) {
  const all = output.trimEnd().split("\n")
  return all.slice(Math.max(0, all.length - lines)).join("\n")
}

async function main() {
  const root = path.resolve(import.meta.dir, "..")
  const files = await collectTestFiles(root)
  if (files.length === 0) throw new Error("no test files found under " + root)
  const leaks = await findUnrestoredMocks(root)
  if (leaks.length > 0) {
    for (const leak of leaks) {
      process.stdout.write("LEAK  " + leak.file + " -> " + leak.module + "\n")
    }
    process.stdout.write("\n" + leaks.length + " module mocks are never restored\n")
    process.exit(1)
  }
  const runs = buildRuns(files)
  const failures: string[] = []
  const startedAt = Date.now()
  process.stdout.write("order isolation: " + files.length + " test files, " + runs.length + " runs\n")
  for (const [index, run] of runs.entries()) {
    const progress = "[" + (index + 1) + "/" + runs.length + "] " + run.label
    const result = await runOrderedFiles(run.files, root)
    if (result.ok) {
      process.stdout.write("pass  " + progress + "\n")
      continue
    }
    process.stdout.write("FAIL  " + progress + "\n")
    failures.push(progress + "\n" + tail(result.output))
  }
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  if (failures.length === 0) {
    process.stdout.write("\nall " + runs.length + " runs passed in " + seconds + "s\n")
    return
  }
  for (const failure of failures) process.stdout.write("\n" + failure + "\n")
  process.stdout.write("\n" + failures.length + " of " + runs.length + " runs failed in " + seconds + "s\n")
  process.exit(1)
}

if (import.meta.main) await main()
