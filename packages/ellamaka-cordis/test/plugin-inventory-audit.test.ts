import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { bootDshWeb } from "../src/dsh-web"

test("actual Web inventory has metadata for every global and shipped preset row without Node internals", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-inventory-audit-"))
  const host = await bootDshWeb({ home, port: 0, disablePtcRuntime: true })
  try {
    const inventory = await createRequire(import.meta.url)(
      "@deepseek-ai/dsh-host-plugin-inventory",
    ).readPluginInventory(host.ctx)
    const errors: string[] = []
    let rows = 0
    let titles = 0
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return
      const record = value as Record<string, unknown>
      if (typeof record.moduleName === "string") {
        rows++
        const meta = record.meta as { error?: string; title?: unknown } | undefined
        if (meta?.error) errors.push(record.moduleName + ": " + meta.error)
        if (meta?.title !== undefined) titles++
        if (["@deepseek-ai/dsh-persona", "@deepseek-ai/dsh-tool-fs"].includes(String(record.moduleName)))
          expect(meta?.title).toBeDefined()
      }
      for (const child of Object.values(record)) {
        if (Array.isArray(child)) for (const item of child) visit(item)
        else if (child && typeof child === "object") visit(child)
      }
    }
    visit(inventory)
    expect(rows).toBeGreaterThan(100)
    expect(errors).toEqual([])
    expect(titles).toBeGreaterThan(50)
    const manager = host.ctx.get("pluginManager") as {
      listBundles(): Promise<{ name: string; meta?: { title?: unknown; error?: string }; error?: unknown }[]>
    }
    const bundles = await manager.listBundles()
    expect(bundles.length).toBeGreaterThan(4)
    expect(bundles.filter((bundle) => bundle.meta?.error || bundle.error)).toEqual([])
    expect(bundles.filter((bundle) => bundle.name.startsWith("@deepseek-ai/") && !bundle.meta?.title)).toEqual([])
    expect(
      inventory.entries.filter(
        (entry: any) => entry.enabled && ["failed", "pending", "loading"].includes(entry.fiberPhase),
      ),
    ).toEqual([])
    expect(inventory.agentPresets.filter((preset: any) => preset.isDefault && preset.broken)).toEqual([])
  } finally {
    await host.dispose()
  }
}, 30000)
