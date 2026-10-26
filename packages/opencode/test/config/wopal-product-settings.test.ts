import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveDshProfileIntent } from "@/config/wopal-product-settings"
import { parseDshWebEnabled } from "@wopal/wopalspace"

describe("wopal.dsh.web.enabled", () => {
  test("defaults to enabled when absent", () => {
    expect(parseDshWebEnabled('{ "wopal": {} }')).toBeUndefined()
  })

  test("reads only the global Wopal product key", () => {
    expect(parseDshWebEnabled('{ "wopal": { "dsh": { "web": { "enabled": false } } } }')).toBe(false)
    expect(parseDshWebEnabled('{ /* comment */ "wopal": { "dsh": { "web": { "enabled": true } } } }')).toBe(true)
  })
})

describe("DSH profile intent", () => {
  async function withHome(enabled: boolean, run: (home: string) => Promise<void>) {
    const home = await mkdtemp(join(tmpdir(), "dsh-intent-"))
    try {
      await mkdir(join(home, "config"), { recursive: true })
      await writeFile(
        join(home, "config", "settings.jsonc"),
        JSON.stringify({ wopal: { dsh: { web: { enabled } } } }),
      )
      await run(home)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }

  test("web on + tools on requests both profiles", async () => {
    await withHome(true, async (home) => {
      expect(await resolveDshProfileIntent(home, {})).toEqual({
        web: true,
        tools: true,
        profiles: ["web", "ellamaka-tools"],
      })
    })
  })

  test("web off + tools on requests tools only", async () => {
    await withHome(false, async (home) => {
      expect(await resolveDshProfileIntent(home, {})).toEqual({
        web: false,
        tools: true,
        profiles: ["ellamaka-tools"],
      })
    })
  })

  test("web on + tools off requests web only", async () => {
    await withHome(true, async (home) => {
      expect(await resolveDshProfileIntent(home, { ELLAMAKA_DSH_TOOLS: "0" })).toEqual({
        web: true,
        tools: false,
        profiles: ["web"],
      })
    })
  })

  test("web off + tools off requests no DSH profile", async () => {
    await withHome(false, async (home) => {
      expect(await resolveDshProfileIntent(home, { ELLAMAKA_DSH_TOOLS: "0" })).toEqual({
        web: false,
        tools: false,
        profiles: [],
      })
    })
  })
})
