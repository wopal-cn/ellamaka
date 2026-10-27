import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { updateDshWebEnabled } from "../../../src"

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

      expect(await updateDshWebEnabled({ wopalHome: home, enabled: false })).toEqual({
        changed: false,
        apply: "restart-required",
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
