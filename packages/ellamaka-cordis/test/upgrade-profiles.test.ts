import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bootDshTools, bootDshWeb } from "../src/dsh-web"

describe("rc.2 profile assembly", () => {
  test("tools supplies every adopted provider without Session or model lifecycle", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-rc2-tools-"))
    const host = await bootDshTools({ home, port: 0 })
    try {
      const tools = host.ctx.get("tools") as { schemas(): { name: string }[] }
      expect(
        tools
          .schemas()
          .map((s) => s.name)
          .sort(),
      ).toEqual(["bash", "edit", "glob", "grep", "read", "str_replace_editor", "write"].sort())
      expect(host.ctx.get("sessions", false)).toBeUndefined()
      expect(host.ctx.get("agents", false)).toBeUndefined()
      expect(host.ctx.get("configEditor", false)).toBeUndefined()
      expect(host.ctx.get("approval", false)).toBeDefined()
    } finally {
      await host.dispose()
    }
  }, 30000)
  test("Bun web uses profileContext, config HMR and healthy native presets", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-rc2-web-"))
    const host = await bootDshWeb({
      home,
      port: 0,
      disableCodeRuntime: true,
      ellamakaCommand: [process.execPath, "fixture.ts"],
    })
    try {
      expect(host.ctx.get("configEditor", false)).toBeDefined()
      const facts = host.ctx.get("profileContext") as {
        home: string
        name: string
        packageManager?: { command: string; args: string[] }
      }
      expect(facts.home).toBe(join(home, "home"))
      expect(facts.name).toBe("web")
      expect(facts.packageManager?.command).toBe(process.execPath)
      expect(facts.packageManager?.args).toContain("package-worker")
      const hmr = host.ctx.get("hmr") as { watchConfig: unknown; runExclusive: unknown }
      expect(typeof hmr.watchConfig).toBe("function")
      expect(typeof hmr.runExclusive).toBe("function")
      const presets = host.ctx.get("agentPresets") as { list(): Promise<{ id: string; broken?: boolean }[]> }
      const list = await presets.list()
      expect(list.map((p) => p.id).sort()).toEqual(["cordis", "minimal", "standard"])
      expect(list.some((p) => p.broken)).toBe(false)
    } finally {
      await host.dispose()
    }
  }, 30000)
})

test("legacy settings stay intact and cannot start a partial Web import", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-legacy-guard-"))
  mkdirSync(join(home, "home"))
  const legacy = join(home, "home/settings.yaml")
  writeFileSync(legacy, "fixture-section: preserved\n")
  await expect(bootDshWeb({ home, port: 0 })).rejects.toThrow(/Legacy DSH settings require migration/)
  expect(readFileSync(legacy, "utf8")).toBe("fixture-section: preserved\n")
  const tools = await bootDshTools({ home, port: 0 })
  await tools.dispose()
}, 30000)
