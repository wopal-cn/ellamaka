import { describe, expect, test } from "bun:test"
import { spawnSync } from "bun"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// copy-icons.ts resolves ./icons/<set> relative to the CWD and copies it to
// resources/icons, so each scenario runs the real script inside a throwaway
// directory seeded with marker files — the package's own icons/resources are
// never touched.
const PACKAGE_ROOT = join(import.meta.dir, "../..")
const SCRIPT = join(PACKAGE_ROOT, "scripts", "copy-icons.ts")

const ICON_SETS = ["main", "beta", "stable"] as const

type Run = {
  exitCode: number | null
  stdout: string
  stderr: string
  dir: string
}

function seed(dir: string) {
  // The real package ships a resources/ directory; cp -R needs the parent to
  // exist, so the fixture mirrors that layout.
  mkdirSync(join(dir, "resources"), { recursive: true })
  for (const set of ICON_SETS) {
    mkdirSync(join(dir, "icons", set), { recursive: true })
    writeFileSync(join(dir, "icons", set, "marker.txt"), set)
  }
}

function run(args: string[]): Run {
  const dir = mkdtempSync(join(tmpdir(), "ellamaka-icons-"))
  seed(dir)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key === "ELLAMAKA_CHANNEL") continue
    env[key] = value
  }
  const result = spawnSync({ cmd: ["bun", SCRIPT, ...args], cwd: dir, env })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    dir,
  }
}

function copiedMarker(run: Run): string {
  const marker = join(run.dir, "resources", "icons", "marker.txt")
  expect(existsSync(marker)).toBe(true)
  return readFileSync(marker, "utf8")
}

describe("copy-icons channel argument", () => {
  test("rejects the legacy dev channel with a clear error", () => {
    const result = run(["dev"])
    try {
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("invalid build channel")
      expect(result.stderr).toContain("dev")
    } finally {
      rmSync(result.dir, { recursive: true, force: true })
    }
  })

  test("rejects any out-of-vocabulary channel", () => {
    for (const raw of ["prod", "latest", "canary"]) {
      const result = run([raw])
      try {
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("invalid build channel")
      } finally {
        rmSync(result.dir, { recursive: true, force: true })
      }
    }
  })

  test("copies the icon set matching the channel", () => {
    for (const channel of ["main", "beta", "stable"] as const) {
      const result = run([channel])
      try {
        expect(result.exitCode).toBe(0)
        expect(copiedMarker(result)).toBe(channel)
      } finally {
        rmSync(result.dir, { recursive: true, force: true })
      }
    }
  })

  test("local projects onto the main icon set instead of folding silently", () => {
    // There is no icons/local set: local is a dev channel and shares the main
    // assets (mirroring electron-builder's local→main app identity).
    const result = run(["local"])
    try {
      expect(result.exitCode).toBe(0)
      expect(copiedMarker(result)).toBe("main")
      expect(result.stdout).toContain("channel: local")
    } finally {
      rmSync(result.dir, { recursive: true, force: true })
    }
  })
})
