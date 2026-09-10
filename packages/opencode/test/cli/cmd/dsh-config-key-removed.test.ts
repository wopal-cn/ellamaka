import { describe, expect, test } from "bun:test"
import { Global } from "@wopal/ellamaka-core/global"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
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
    const originalConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = dir
    mkdirSync(dir, { recursive: true })
    await (
      await import("node:fs")
    ).promises.writeFile(
      join(dir, "settings.jsonc"),
      JSON.stringify({ ellamaka: { dsh: { trustedHosts: ["192.168.1.10:4096"] } } }),
    )
    try {
      const { AppRuntime } = await import("../../../src/effect/app-runtime")
      const { Config } = await import("../../../src/config/config")
      const exit = await AppRuntime.runPromise(Effect.exit(Config.Service.use((cfg) => cfg.getGlobal())))
      // The loader degrades a schema-invalid settings file to `{}` — the key
      // must be gone either way, never half-applied to the fence.
      const config = exit._tag === "Success" ? (exit.value as { dsh?: unknown }) : undefined
      expect(config?.dsh).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      ;(Global.Path as { config: string }).config = originalConfig
    }
  })
})

import { Effect } from "effect"
