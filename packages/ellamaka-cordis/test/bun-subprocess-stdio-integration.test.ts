import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const fixture = join(import.meta.dir, "fixtures/bun-subprocess-stdio-preload.ts")
const runner = createRequire(import.meta.url).resolve("@deepseek-ai/dsh-subprocess-local/runner")

// The native execve boundary exists only on Linux. Other hosts exercise their
// own spawn/Job path in bun-subprocess-child.test.ts.
if (process.platform === "linux") {
  test("exec target gets blocking stdout/stderr after Bun initialized them", () => {
    const root = mkdtempSync(join(tmpdir(), "ellamaka-stdio-request-"))
    try {
      const request = join(root, "launch-request.json")
      writeFileSync(request, JSON.stringify({ cwd: root, env: { PATH: "/usr/bin:/bin" } }))
      const result = spawnSync(
        process.execPath,
        [
          "--preload",
          fixture,
          runner,
          "--",
          "--",
          "/bin/sh",
          "-c",
          "cat /proc/$$/fdinfo/1; cat /proc/$$/fdinfo/2; head -c 262144 /dev/zero",
        ],
        {
          env: { PATH: "/usr/bin:/bin", DSH_SUBPROCESS_RUNNER: request },
          cwd: join(import.meta.dir, "../../opencode"),
          encoding: "utf8",
          timeout: 10_000,
        },
      )
      expect(result.status, result.stderr).toBe(0)
      const flags = [...result.stdout.matchAll(/flags:\s+([0-7]+)/g)].map((match) => parseInt(match[1], 8))
      expect(flags).toHaveLength(2)
      for (const flag of flags) expect(flag & 0o4000).toBe(0)
      expect(result.stdout.endsWith("\0".repeat(262144))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
