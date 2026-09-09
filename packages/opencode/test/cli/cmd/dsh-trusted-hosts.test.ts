import { describe, expect, test, spyOn } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Global } from "@wopal/ellamaka-core/global"
import { AppRuntime } from "@/effect/app-runtime"
import { Config } from "@/config/config"

/**
 * W-01 regression: `readDshTrustedHosts` used to parse settings.jsonc with a
 * bare `ConfigParse.jsonc` + schema pass, bypassing the loader's
 * `ConfigVariable.substitute()` step. `{env:VAR}` / `{file:...}` values then
 * landed in the fence as literal text and a legitimate LAN deployment still
 * got 403. The reader must reuse the same substitution + schema chain as
 * `loadSettingsFile`, and every failure mode must degrade to the fail-closed
 * `[]` default.
 */
describe("readDshTrustedHosts (W-01 variable substitution)", () => {
  const originalConfig = Global.Path.config
  let dir: string | undefined

  function withGlobalSettings(content: unknown | string): void {
    dir = mkdtempSync(join(tmpdir(), "dsh-trusted-hosts-"))
    ;(Global.Path as { config: string }).config = dir
    const text = typeof content === "string" ? content : JSON.stringify(content, null, 2)
    writeFileSync(join(dir, "settings.jsonc"), text)
  }

  function restore(): void {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
    ;(Global.Path as { config: string }).config = originalConfig
  }

  /** The loader caches its global snapshot for the process lifetime; each
   * case rewrites the settings file, so drop the cache before reading. */
  async function invalidateGlobalCache(): Promise<void> {
    await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.invalidate()))
  }

  test("returns the empty default when no settings file exists", async () => {
    dir = mkdtempSync(join(tmpdir(), "dsh-trusted-hosts-empty-"))
    ;(Global.Path as { config: string }).config = dir
    try {
      await invalidateGlobalCache()
      const { readDshTrustedHosts } = await import("../../../src/cli/cmd/dsh-mount")
      expect(await readDshTrustedHosts()).toEqual([])
    } finally {
      restore()
    }
  })

  test("returns configured hosts from the ellamaka.dsh domain", async () => {
    withGlobalSettings({
      ellamaka: { dsh: { trustedHosts: ["192.168.1.10:4096", "app.internal"] } },
    })
    try {
      await invalidateGlobalCache()
      const { readDshTrustedHosts } = await import("../../../src/cli/cmd/dsh-mount")
      expect(await readDshTrustedHosts()).toEqual(["192.168.1.10:4096", "app.internal"])
    } finally {
      restore()
    }
  })

  test("substitutes {env:VAR} tokens like the standard loader (W-01)", async () => {
    process.env.ELLAMAKA_TEST_LAN_HOST = "192.168.7.42"
    withGlobalSettings({
      ellamaka: { dsh: { trustedHosts: ["{env:ELLAMAKA_TEST_LAN_HOST}:4096"] } },
    })
    try {
      await invalidateGlobalCache()
      const { readDshTrustedHosts } = await import("../../../src/cli/cmd/dsh-mount")
      expect(await readDshTrustedHosts()).toEqual(["192.168.7.42:4096"])
    } finally {
      restore()
      delete process.env.ELLAMAKA_TEST_LAN_HOST
    }
  })

  test("degrades to the empty default on an unparsable settings file (fail closed)", async () => {
    withGlobalSettings("{ broken jsonc !!!")
    const logSpy = spyOn(console, "error").mockImplementation(() => {})
    try {
      await invalidateGlobalCache()
      const { readDshTrustedHosts } = await import("../../../src/cli/cmd/dsh-mount")
      expect(await readDshTrustedHosts()).toEqual([])
    } finally {
      restore()
      logSpy.mockRestore()
    }
  })
})
