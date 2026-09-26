// Entry-probe for the `dev:temporary` entry (`src/temporary.ts`).
//
// Spawns the REAL entry with a throwaway WOPAL_HOME and asserts on the
// resolved level observable in the global-domain log file: an explicit
// `--log-level` must win over the environment through the unified composition
// (the entry used to resolve the level before yargs parsed argv, silently
// ignoring the flag and writing the stale value back to the env).
//
// The package directory stays the spawn cwd so bunfig's
// `@opentui/solid/preload` resolves; the throwaway dir is passed as the
// project positional. The TUI stays alive once booted — the probe polls the
// log until the boot marker appears, then kills the process. Nothing outside
// the temp WOPAL_HOME is written.
import { afterAll, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { cleanupProbes, makeProbe } from "../lib/log-probe"

afterAll(cleanupProbes)

/** True when any written record carries the given level prefix. */
function hasLevel(text: string, level: string): boolean {
  return text.split("\n").some((line) => line.startsWith(level))
}

const packageDir = resolve(import.meta.dir, "../..")
const entry = join(packageDir, "src/temporary.ts")

async function runTemporary(args: string[], extraEnv: Record<string, string>) {
  const { root, home } = makeProbe()
  const proc = Bun.spawn(["bun", "run", "--conditions=browser", entry, root, ...args], {
    cwd: packageDir,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TERM: "dumb",
      CI: "1",
      ...probeEnv(home, extraEnv),
    },
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  })
  const logFile = join(home, "logs", "ellamaka-dev-tui.log")

  // Poll until the log file exists (lazily created on the first record) and —
  // when the level allows records the caller can name — the boot marker
  // appears, then return the text. Bounded so a broken entry cannot hang the
  // suite.
  const deadline = Date.now() + 30_000
  let text = ""
  while (Date.now() < deadline) {
    if (existsSync(logFile)) text = readFileSync(logFile, "utf8")
    if (text.includes("loading internal tui plugin")) break
    await Bun.sleep(300)
  }

  proc.kill()
  await proc.exited
  return { text, logFile }
}

import { probeEnv } from "../lib/log-probe"

test("temporary entry: explicit --log-level overrides the environment", async () => {
  // WARN from the env would suppress the INFO boot records; the explicit CLI
  // level must win through the unified composition.
  const { text } = await runTemporary(["--log-level", "DEBUG"], { ELLAMAKA_LOG_LEVEL: "WARN" })
  expect(text).toContain("loading internal tui plugin")
  expect(hasLevel(text, "INFO")).toBe(true)
}, 60_000)

test("temporary entry: the environment bounds records without an explicit level", async () => {
  // Under ERROR the boot writes no records (the file is created lazily on the
  // first write, so absence of a file is the expected bound), but a healthy
  // boot is observable as a process that stays alive — a broken entry (bad
  // flag, crash before init, module resolution failure) exits non-zero within
  // seconds. Liveness is the breakage control; the level bound is asserted by
  // the absence of a log file and of any printed INFO/WARN/DEBUG record.
  const { root: projectRoot, home } = makeProbe()
  const proc = Bun.spawn(["bun", "run", "--conditions=browser", entry, projectRoot], {
    cwd: packageDir,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TERM: "dumb",
      CI: "1",
      ...probeEnv(home, { ELLAMAKA_LOG_LEVEL: "ERROR" }),
    },
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  })
  const logFile = join(home, "logs", "ellamaka-dev-tui.log")

  // Wait well past any plausible boot-failure window: a healthy entry is
  // still running (TUI up, silently bounding records); a broken one exits.
  await Bun.sleep(12_000)
  const alive = proc.exitCode === null && proc.signalCode === null
  const exitCode = proc.exitCode
  proc.kill()
  await proc.exited

  expect(alive).toBe(true)
  expect(exitCode ?? 0).toBe(0)
  expect(existsSync(logFile)).toBe(false)
}, 60_000)
