// Usage errors must be visible. `dev.sh serve --with-docs` (a typo) once
// produced a completely silent exit: yargs translated the "Unknown argument"
// message, the fail handler matched on the English text, fell through to
// `process.exit(1)`, and the caller saw an empty log. These tests pin the
// contract that matters — a bad flag prints a diagnostic and exits non-zero,
// whatever the locale.
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"

const opencodeRoot = path.resolve(import.meta.dir, "../..")
const cliEntry = path.join(opencodeRoot, "src/index.ts")

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("bun", ["run", "--conditions=browser", cliEntry, ...args], {
    cwd: opencodeRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  })
  return {
    exitCode: result.status ?? -1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  }
}

describe("cli usage errors", () => {
  test("an unknown flag prints a diagnostic and fails, not a silent exit", () => {
    // zh_CN is what surfaced the bug; keep it pinned so the regression can't
    // come back through a localized yargs message.
    const result = run(["serve", "--with-docs"], { LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN.UTF-8" })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.trim().length).toBeGreaterThan(0)
    expect(result.stderr).toContain("with-docs")
  })

  test("an unknown flag fails the same way in an English locale", () => {
    const result = run(["serve", "--nonsense"], { LANG: "C", LC_ALL: "C" })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("nonsense")
  })

  test("an invalid option value reports the value and the choices", () => {
    const result = run(["serve", "--log-level", "NOPE"], { LANG: "C", LC_ALL: "C" })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("NOPE")
    expect(result.stderr).toContain("TRACE")
  })

  test("a valid --help still exits cleanly", () => {
    const result = run(["serve", "--help"], { LANG: "C", LC_ALL: "C" })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("--port")
  })
})
