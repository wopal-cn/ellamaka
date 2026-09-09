import { describe, expect, test } from "bun:test"
import { Module } from "node:module"

/**
 * Runtime gate (DESIGN-dsh-poc §7 current convention 2).
 *
 * The six deeply-coupled dsh packages (agent-loop/session/session-query/
 * compaction/subagent/schedule) must never be loaded at runtime by the
 * mainline. The gate verifies the stronger, real invariant: zero runtime
 * module resolutions while loading this package's public API surface.
 */
const FORBIDDEN = [
  "dsh-agent-loop",
  "dsh-session",
  "dsh-session-query",
  "dsh-compaction",
  "dsh-subagent",
  "dsh-schedule",
] as const

describe("runtime gate (§7 current convention 2)", () => {
  test("loading the package public API resolves zero forbidden packages", async () => {
    const resolved: string[] = []
    const mod = Module as unknown as {
      _resolveFilename: (request: string, ...rest: unknown[]) => string
    }
    const orig = mod._resolveFilename
    mod._resolveFilename = function (request: string, ...rest: unknown[]) {
      resolved.push(request)
      return orig.call(this, request, ...rest)
    }

    try {
      // The public surface the opencode mainline loads from this package.
      await import("../src/index")
      await import("../src/dsh-web")
    } finally {
      mod._resolveFilename = orig
    }

    const hits = resolved.filter((request) =>
      FORBIDDEN.some((name) => request.includes(name)),
    )
    expect(hits).toEqual([])
  })
})
