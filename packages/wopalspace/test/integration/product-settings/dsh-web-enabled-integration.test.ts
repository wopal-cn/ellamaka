import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProductSettingsError, updateDshWebEnabled } from "../../../src"

describe("Wopal product settings", () => {
  test("updates only the global DSH Web key while preserving comments and unknown fields", async () => {
    const home = await mkdtemp(join(tmpdir(), "wopal-settings-"))
    try {
      const config = join(home, "config")
      await mkdir(config, { recursive: true })
      const file = join(config, "settings.jsonc")
      await writeFile(
        file,
        `{
  // keep me
  "wopal": { "other": { "value": 7 } },
  "unknown": true,
}\n`,
      )

      expect(await updateDshWebEnabled({ wopalHome: home, enabled: false })).toEqual({
        changed: true,
        apply: "restart-required",
      })
      const text = await readFile(file, "utf8")
      expect(text).toContain("// keep me")
      expect(text).toContain('"unknown": true')
      expect(text).toContain('"other"')
      expect(text).toContain('"enabled": false')

      const unchanged = await readFile(file, "utf8")
      expect(await updateDshWebEnabled({ wopalHome: home, enabled: false })).toEqual({
        changed: false,
        apply: "restart-required",
      })
      // A no-op must not rewrite the file at all.
      expect(await readFile(file, "utf8")).toBe(unchanged)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test("rejects invalid JSONC as ProductSettingsError without replacing the file", async () => {
    const home = await mkdtemp(join(tmpdir(), "wopal-settings-broken-"))
    try {
      const config = join(home, "config")
      await mkdir(config, { recursive: true })
      const file = join(config, "settings.jsonc")
      await writeFile(file, '{ "broken": ')
      await expect(updateDshWebEnabled({ wopalHome: home, enabled: true })).rejects.toBeInstanceOf(ProductSettingsError)
      expect(await readFile(file, "utf8")).toBe('{ "broken": ')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
