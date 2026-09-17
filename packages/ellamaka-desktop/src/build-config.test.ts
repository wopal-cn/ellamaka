import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const root = join(import.meta.dir, "..")

describe("electron.vite.config.ts channel resolution", () => {
  test("consumes the shared channel resolver", async () => {
    const config = await Bun.file(join(root, "electron.vite.config.ts")).text()
    expect(config).toContain('import { resolveBuildChannel } from "@wopal/ellamaka-release/channel-resolve"')
    expect(config).toContain('resolveBuildChannel(process.env.ELLAMAKA_CHANNEL, "local")')
  })

  test("renderer section injects the ELLAMAKA_CHANNEL define", async () => {
    const config = await Bun.file(join(root, "electron.vite.config.ts")).text()
    // The renderer build is a separate define scope from main/preload:
    // without a renderer-section entry, import.meta.env.ELLAMAKA_CHANNEL in
    // renderer code (e.g. the Sentry integration filter) is never injected.
    const rendererSection = config.slice(config.indexOf("renderer:"))
    expect(rendererSection).toContain('"import.meta.env.ELLAMAKA_CHANNEL"')
  })

  test("has no residual local channel parsing", async () => {
    const config = await Bun.file(join(root, "electron.vite.config.ts")).text()
    expect(config).not.toContain('"prod"')
    expect(config).not.toContain('"latest"')
    expect(config).not.toContain("process.env.OPENCODE_CHANNEL")
  })
})

describe("electron-builder.config.ts channel resolution", () => {
  test("consumes the shared channel resolver in strict mode", async () => {
    const config = await Bun.file(join(root, "electron-builder.config.ts")).text()
    expect(config).toContain('import { resolveBuildChannel } from "@wopal/ellamaka-release/channel-resolve"')
    expect(config).toContain("resolveBuildChannel(process.env.ELLAMAKA_CHANNEL)")
    // Strict mode: no local fallback argument.
    expect(config).not.toContain("resolveBuildChannel(process.env.ELLAMAKA_CHANNEL, \"local\")")
    expect(config).not.toContain("process.env.OPENCODE_CHANNEL")
  })
})
