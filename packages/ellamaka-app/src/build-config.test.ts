import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const root = join(import.meta.dir, "..")

describe("ellamaka-app vite.js channel resolution", () => {
  test("consumes the shared channel resolver with a local dev fallback", async () => {
    const vite = await Bun.file(join(root, "vite.js")).text()
    expect(vite).toContain('import { resolveBuildChannel } from "@wopal/ellamaka-release/channel-resolve"')
    expect(vite).toContain('resolveBuildChannel(process.env.ELLAMAKA_CHANNEL, "local")')
    expect(vite).not.toContain("process.env.OPENCODE_CHANNEL")
  })

  test("has no residual legacy channel literals", async () => {
    const vite = await Bun.file(join(root, "vite.js")).text()
    expect(vite).not.toContain('"dev"')
    expect(vite).not.toContain('"prod"')
  })
})

describe("ellamaka-app ELLAMAKA_CHANNEL type domain", () => {
  test("env.d.ts declares the closed build channel vocabulary", async () => {
    const env = await Bun.file(join(root, "src/env.d.ts")).text()
    expect(env).toContain('readonly ELLAMAKA_CHANNEL?: "stable" | "beta" | "main" | "local"')
    expect(env).not.toMatch(/"dev"/)
    expect(env).not.toMatch(/"prod"/)
  })
})
