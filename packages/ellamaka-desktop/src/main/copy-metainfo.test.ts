import { describe, expect, test } from "bun:test"
import { spawnSync } from "bun"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// copy-metainfo.ts accepts a channel argument and writes
// resources/<appId>.metainfo.xml relative to the CWD, so each scenario runs
// the real script in a throwaway directory. The channel vocabulary is closed
// ({stable, beta, main, local}): the legacy "dev" value must be rejected
// rather than silently folded.
const PACKAGE_ROOT = join(import.meta.dir, "../..")
const SCRIPT = join(PACKAGE_ROOT, "scripts", "copy-metainfo.ts")

type Run = {
  exitCode: number | null
  stdout: string
  stderr: string
  dir: string
}

function run(args: string[]): Run {
  const dir = mkdtempSync(join(tmpdir(), "ellamaka-metainfo-"))
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key === "ELLAMAKA_CHANNEL") continue
    env[key] = value
  }
  const result = spawnSync({
    cmd: ["bun", SCRIPT, ...args],
    cwd: dir,
    env,
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    dir,
  }
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true })
}

function metainfo(run: Run, appId: string): string {
  const path = join(run.dir, "resources", `${appId}.metainfo.xml`)
  expect(existsSync(path)).toBe(true)
  return readFileSync(path, "utf8")
}

describe("copy-metainfo channel argument", () => {
  test("rejects the legacy dev channel with a clear error", () => {
    const result = run(["dev"])
    try {
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("invalid build channel")
      expect(result.stderr).toContain("dev")
      expect(result.stderr).toContain("stable")
    } finally {
      cleanup(result.dir)
    }
  })

  test("rejects any out-of-vocabulary channel", () => {
    for (const raw of ["prod", "latest", "canary"]) {
      const result = run([raw])
      try {
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("invalid build channel")
      } finally {
        cleanup(result.dir)
      }
    }
  })

  test("stable composes the base app id and product name", () => {
    const result = run(["stable"])
    try {
      expect(result.exitCode).toBe(0)
      const xml = metainfo(result, "ai.opencode.desktop")
      expect(xml).toContain("<id>ai.opencode.desktop</id>")
      expect(xml).toContain("<name>OpenCode</name>")
    } finally {
      cleanup(result.dir)
    }
  })

  test("non-stable channels compose a suffixed app id and product name", () => {
    for (const [channel, appId, name] of [
      ["beta", "ai.opencode.desktop.beta", "OpenCode Beta"],
      ["main", "ai.opencode.desktop.main", "OpenCode Main"],
      ["local", "ai.opencode.desktop.local", "OpenCode Local"],
    ] as const) {
      const result = run([channel])
      try {
        expect(result.exitCode).toBe(0)
        const xml = metainfo(result, appId)
        expect(xml).toContain(`<id>${appId}</id>`)
        expect(xml).toContain(`<name>${name}</name>`)
      } finally {
        cleanup(result.dir)
      }
    }
  })

  test("no argument resolves from ELLAMAKA_CHANNEL, defaulting to main", () => {
    const result = run([])
    try {
      expect(result.exitCode).toBe(0)
      expect(readFileSync(join(result.dir, "resources", "ai.opencode.desktop.main.metainfo.xml"), "utf8")).toContain(
        "<id>ai.opencode.desktop.main</id>",
      )
    } finally {
      cleanup(result.dir)
    }
  })
})
