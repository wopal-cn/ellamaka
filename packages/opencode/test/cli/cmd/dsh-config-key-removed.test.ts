import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The `ellamaka.dsh.trustedHosts` settings key is REMOVED: the DSH connection
 * fence derives its authorities from the CORS trust decision
 * (`trustedHostsFromCors` over `server.cors` + `--cors`), so a separate dsh
 * config surface would be a second source of truth for the same decision.
 * These guards keep the key deleted — a reintroduced schema field or a stale
 * settings file carrying the key must not resurrect a split configuration
 * surface.
 */
describe("dsh trustedHosts configuration removal", () => {
  test("the Config schema no longer accepts an ellamaka.dsh key", async () => {
    const { Config } = await import("../../../src/config/config")
    const info = Config.Info as unknown as { fields?: Record<string, unknown> }
    expect(info.fields?.dsh).toBeUndefined()
  })

  test("a stale settings file carrying ellamaka.dsh.trustedHosts is rejected by the schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-config-removed-"))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "settings.jsonc"),
      JSON.stringify({ ellamaka: { dsh: { trustedHosts: ["192.168.1.10:4096"] } } }),
    )

    try {
      const { Config } = await import("../../../src/config/config")
      const raw = JSON.parse(JSON.stringify({ ellamaka: { dsh: { trustedHosts: ["192.168.1.10:4096"] } } }))

      // Decode the stale document straight through the schema instead of
      // loading it via Global.Path.config: that path is module state shared
      // with every other test file, and mutating it leaked into unrelated
      // suites in the same process.
      const decoded = Schema.decodeUnknownSync(Config.Info)(raw) as { ellamaka?: { dsh?: unknown } }
      expect(decoded.ellamaka?.dsh).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
